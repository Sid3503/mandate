import { createHash, createHmac } from 'node:crypto'
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
  return createHmac('sha256', pepper).update(token).digest('hex')
}

export function machineKeyHash(token: string): string {
  return machineKeyHmac(token)
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
  if (token.length < 8) return
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

