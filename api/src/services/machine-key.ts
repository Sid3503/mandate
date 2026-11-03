import { createHash, pbkdf2Sync } from 'node:crypto'
import type { Repo } from '../db/repo'

let warnedPepper = false
const SAFE_PEPPER_FALLBACK = 'mandate_machine_key_safe_fallback_pepper'

export function getKeyPepper(): string {
  const pepper = process.env.KEY_PEPPER
  if (pepper && pepper.length > 0) return pepper
  if (!warnedPepper) {
    warnedPepper = true
    console.warn('[security] KEY_PEPPER is unset; using safe fallback. Set KEY_PEPPER in production.')
  }
  return SAFE_PEPPER_FALLBACK
}

export function resetPepperWarning(): void {
  warnedPepper = false
}

export function machineKeyHmac(token: string, pepper = getKeyPepper()): string {
  return pbkdf2Sync(token, pepper, 10_000, 32, 'sha256').toString('hex')
}

/**
 * The stored hash of a machine key. PBKDF2 is slow on purpose (it protects the hashes if the file leaks), which also
 * makes it the most expensive thing an unauthenticated caller can make the server do. One request used to run it two
 * or three times for the same key (the rate limiter, the studio router, the auth check). The answer depends only on
 * the key and the pepper, so the last few thousand answers are kept in memory, keyed by a SHA-256 of both, and every
 * later look-up of the same key in the same process is a map read. Nothing here outlives the process.
 */
const HASH_MEMO_MAX = 4_096
const hashMemo = new Map<string, string>()

export function machineKeyHash(token: string): string {
  const pepper = getKeyPepper()
  const memoKey = createHash('sha256').update(pepper).update('\n').update(token).digest('base64url')
  const hit = hashMemo.get(memoKey)
  if (hit !== undefined) {
    // Most recently used goes to the back, so the oldest unused answers are the ones dropped.
    hashMemo.delete(memoKey)
    hashMemo.set(memoKey, hit)
    return hit
  }
  const computed = machineKeyHmac(token, pepper)
  hashMemo.set(memoKey, computed)
  while (hashMemo.size > HASH_MEMO_MAX) hashMemo.delete(hashMemo.keys().next().value as string)
  return computed
}

/** True when this key's hash is already known in this process, so checking it again costs no PBKDF2 run. */
export function machineKeyHashKnown(token: string): boolean {
  return hashMemo.has(createHash('sha256').update(getKeyPepper()).update('\n').update(token).digest('base64url'))
}

/**
 * The only shape an older machine key ever had: the `mnd_ag_` or `mnd_cl_` prefix, then URL-safe characters (with an
 * optional studio id in front). Anything else can never match a legacy row, so it never pays for the legacy PBKDF2 runs.
 */
const LEGACY_SHAPE = /^mnd_(?:ag|cl)_[A-Za-z0-9_-]{8,200}$/

/** A client or agent key names its studio: `mnd_cl_ws_…_secret` or `mnd_ag_ws_…_secret`. */
export function workspaceFromMachineKey(token: string): string | null {
  const match = /^mnd_(?:cl|ag)_(ws_(?:default|[a-z2-7]{20}))_/.exec(token.trim())
  return match?.[1] ?? null
}

function plainHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Older rows stored a hash of the secret with the prefix left off, or with plain SHA-256 instead of HMAC.
 * The first accepted use rewrites that hash to the current HMAC-SHA256 hash. A revoked row is rewritten too,
 * so the refusal stays the same.
 */
export function acceptLegacyMachineKey(repo: Repo, token: string): void {
  if (token.length < 8 || token.length > 400) return
  const full = machineKeyHash(token)
  if (repo.getAgentByKeyHash(full) || repo.getClientKeyByKeyHash(full)) return

  // Check plain SHA-256 of the entire token
  const plain = plainHash(token)
  const agentByPlain = repo.getAgentByKeyHash(plain)
  if (agentByPlain) {
    repo.setAgentKeyHash(agentByPlain.id, full)
    return
  }
  const clientByPlain = repo.getClientKeyByKeyHash(plain)
  if (clientByPlain) {
    repo.setClientKeyHash(clientByPlain.id, full)
    return
  }

  // Check bare secret without prefix
  if (!LEGACY_SHAPE.test(token)) return
  if (token.startsWith('mnd_ag_')) {
    const rest = token.slice('mnd_ag_'.length)
    const suffix = rest.includes('_') ? rest.slice(rest.lastIndexOf('_') + 1) : rest
    const row = repo.getAgentByKeyHash(plainHash(rest))
      ?? repo.getAgentByKeyHash(plainHash(suffix))
      ?? repo.getAgentByKeyHash(machineKeyHash(rest))
      ?? repo.getAgentByKeyHash(machineKeyHash(suffix))
    if (row) repo.setAgentKeyHash(row.id, full)
    return
  }
  if (token.startsWith('mnd_cl_')) {
    const rest = token.slice('mnd_cl_'.length)
    const suffix = rest.includes('_') ? rest.slice(rest.lastIndexOf('_') + 1) : rest
    const row = repo.getClientKeyByKeyHash(plainHash(rest))
      ?? repo.getClientKeyByKeyHash(plainHash(suffix))
      ?? repo.getClientKeyByKeyHash(machineKeyHash(rest))
      ?? repo.getClientKeyByKeyHash(machineKeyHash(suffix))
    if (row) repo.setClientKeyHash(row.id, full)
  }
}

