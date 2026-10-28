#!/usr/bin/env tsx
/**
 * replay-verify.ts — Hash-chained ledger export verifier
 *
 * Usage:
 *   npx tsx scripts/replay-verify.ts                    # fetches from server
 *   npx tsx scripts/replay-verify.ts --file ledger.json # reads local file
 *   npx tsx scripts/replay-verify.ts --file ledger.json --keys keys.json
 *
 * What it does:
 *   1. Reads the ledger export (GET /v1/ledger/export or a local file)
 *   2. Verifies the Ed25519 signature over signedMessage
 *   3. Walks the chain: for each entry, recomputes hash(seq+proposalId+eventType+clause+at+prevHash)
 *      and verifies it matches the stored hash
 *   4. Reports the first break or "chain intact"
 *
 * Demo moment: export on the live instance, run this on a clean machine →
 * identical hashes prove the gate is a pure function and the ledger is tamper-evident.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { readFileSync } from 'node:fs'

const BASE_URL = process.env.API_URL ?? 'http://localhost:3000'
const API_KEY = process.env.API_KEY ?? ''

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

type LedgerEntry = {
  seq: number
  proposalId: string
  eventType: string
  clause: string
  at: string
  prevHash: string
  hash: string
}

type LedgerExport = {
  format: string
  generatedAt: string
  count: number
  entries: LedgerEntry[]
  signature: { signature: string; keyId: string; algorithm: string }
  signedMessage: string
}

type PublicKeyInfo = { keyId: string; publicKeyPem: string; publicKeyBase64Url: string }

function fromBase64Url(value: string): Buffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  return Buffer.from(padded, 'base64')
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((k) => [k, stable((value as Record<string, unknown>)[k])]))
  }
  return value
}

function entryHash(entry: Omit<LedgerEntry, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(entry)).digest('hex')
}

function verifyEd25519(message: string, signatureBase64Url: string, publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem)
    return cryptoVerify(null, Buffer.from(message, 'utf8'), key, fromBase64Url(signatureBase64Url))
  } catch {
    return false
  }
}

async function fetchExport(): Promise<LedgerExport> {
  const url = `${BASE_URL}/v1/ledger/export`
  const response = await fetch(url, { headers: API_KEY ? { 'x-api-key': API_KEY } : {} })
  if (!response.ok) throw new Error(`Server returned ${response.status}`)
  return response.json() as Promise<LedgerExport>
}

async function fetchKeys(): Promise<PublicKeyInfo[]> {
  const url = `${BASE_URL}/.well-known/mandate-keys.json`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not fetch public keys: ${response.status}`)
  const json = await response.json() as { data?: PublicKeyInfo[] }
  return json.data ?? []
}

async function main() {
  const args = process.argv.slice(2)
  const fileIdx = args.indexOf('--file')
  const keysIdx = args.indexOf('--keys')

  let ledger: LedgerExport
  let keys: PublicKeyInfo[]

  if (fileIdx !== -1) {
    const path = args[fileIdx + 1]
    if (!path) { console.error('--file requires a path'); process.exit(1) }
    ledger = JSON.parse(readFileSync(path, 'utf8')) as LedgerExport
  } else {
    console.log(`${DIM}Fetching ledger export from ${BASE_URL}/v1/ledger/export…${RESET}`)
    ledger = await fetchExport()
  }

  if (keysIdx !== -1) {
    const path = args[keysIdx + 1]
    if (!path) { console.error('--keys requires a path'); process.exit(1) }
    const raw = JSON.parse(readFileSync(path, 'utf8')) as PublicKeyInfo[] | { data: PublicKeyInfo[] }
    keys = Array.isArray(raw) ? raw : raw.data
  } else {
    console.log(`${DIM}Fetching public keys from ${BASE_URL}/.well-known/mandate-keys.json…${RESET}`)
    keys = await fetchKeys()
  }

  if (ledger.format !== 'mandate.ledger.v1') {
    console.error(`${RED}Not a mandate.ledger.v1 document (got: ${ledger.format})${RESET}`)
    process.exit(1)
  }

  // Step 1: verify the bundle signature
  const sigKey = keys.find((k) => k.keyId === ledger.signature.keyId)
  if (!sigKey) {
    console.log(`${RED}${BOLD}  ✗  SIGNATURE KEY NOT FOUND${RESET}`)
    console.log(`${RED}  Key ${ledger.signature.keyId} is not in the published key set.${RESET}`)
    process.exit(1)
  }

  const { entries, signature, signedMessage, ...bundleWithoutSig } = ledger
  const expectedMessage = `mandate:ledger:v1\n${ledger.generatedAt}\n${stableHash({ ...bundleWithoutSig, entries })}`
  const sigOk = verifyEd25519(signedMessage, signature.signature, sigKey.publicKeyPem)
  if (!sigOk || signedMessage !== expectedMessage) {
    console.log(`${RED}${BOLD}  ✗  BUNDLE SIGNATURE INVALID${RESET}`)
    console.log(`${RED}  The ledger export's signature does not verify. The export may have been tampered with.${RESET}`)
    process.exit(1)
  }
  console.log(`${GREEN}  ✓  Bundle signature valid (key ${sigKey.keyId})${RESET}`)

  // Step 2: walk the chain
  let prevHash = 'genesis'
  let broken = false
  for (const entry of ledger.entries) {
    const { hash, ...rest } = entry
    const computed = entryHash({ ...rest, prevHash })
    if (computed !== hash) {
      console.log()
      console.log(`${RED}${BOLD}  ✗  CHAIN BROKEN at entry ${entry.seq}${RESET}`)
      console.log(`${RED}  Expected hash: ${computed.slice(0, 16)}…${RESET}`)
      console.log(`${RED}  Stored hash:   ${hash.slice(0, 16)}…${RESET}`)
      console.log(`${RED}  Event: ${entry.eventType} on ${entry.proposalId} at ${entry.at}${RESET}`)
      broken = true
      break
    }
    prevHash = hash
  }

  if (!broken) {
    console.log()
    console.log(`${GREEN}${BOLD}  ✓  CHAIN INTACT${RESET}`)
    console.log(`${GREEN}  ${ledger.entries.length} entries verified. Ledger is tamper-evident.${RESET}`)
    console.log()
    console.log(`${DIM}  Generated  ${RESET}${ledger.generatedAt}`)
    console.log(`${DIM}  Entries    ${RESET}${ledger.count}`)
    console.log(`${DIM}  Final hash ${RESET}${prevHash.slice(0, 16)}…`)
    console.log()
  }

  process.exit(broken ? 1 : 0)
}

main().catch((error) => {
  console.error(`${RED}Error: ${String(error)}${RESET}`)
  process.exit(1)
})

