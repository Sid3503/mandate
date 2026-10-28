#!/usr/bin/env tsx
/**
 * verify-receipt.ts — CLI receipt verifier
 *
 * Usage:
 *   npx tsx scripts/verify-receipt.ts <proposalId>
 *   npx tsx scripts/verify-receipt.ts --file receipt.json
 *   npx tsx scripts/verify-receipt.ts --file receipt.json --keys keys.json
 *
 * What it does:
 *   1. Reads the receipt (from the server or a file)
 *   2. Fetches /.well-known/mandate-keys.json (or reads from --keys)
 *   3. Finds the key whose keyId matches the receipt's lockKeyId
 *   4. Reconstructs lockMessage = "mandate:lock:v1\n{proposalId}\n{cartHash}"
 *   5. Verifies the Ed25519 signature
 *   6. Prints GENUINE or TAMPERED in large coloured text
 *
 * The key is NEVER read from the receipt. It is read from the public keys endpoint.
 * This is the design invariant: anyone can re-sign a tampered receipt with their own key
 * and embed it. The fingerprint in the receipt only has meaning against the canonical
 * key at /.well-known/mandate-keys.json.
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { readFileSync } from 'node:fs'

const BASE_URL = process.env.API_URL ?? 'http://localhost:3000'
const API_KEY = process.env.API_KEY ?? ''

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

type Receipt = {
  format: string
  proposalId: string
  cartHash: string
  lockKeyId: string
  lockSignature: string
  lockMessage: string
  issuedAt: string
  amountCents: number
  currency: string
  gate: string
  clause: string
  publicKeysUrl: string
}

type PublicKeyInfo = {
  keyId: string
  algorithm: string
  publicKeyPem: string
  publicKeyBase64Url: string
  current: boolean
}

function fromBase64Url(value: string): Buffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  return Buffer.from(padded, 'base64')
}

async function fetchReceipt(proposalId: string): Promise<Receipt> {
  const url = `${BASE_URL}/v1/proposals/${proposalId}/receipt`
  const response = await fetch(url, { headers: API_KEY ? { 'x-api-key': API_KEY } : {} })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Server returned ${response.status}: ${body}`)
  }
  return response.json() as Promise<Receipt>
}

async function fetchKeys(keysUrl: string): Promise<PublicKeyInfo[]> {
  const response = await fetch(keysUrl)
  if (!response.ok) throw new Error(`Could not fetch public keys from ${keysUrl}: ${response.status}`)
  const json = await response.json() as { data?: PublicKeyInfo[] } | PublicKeyInfo[]
  const arr = Array.isArray(json) ? json : json.data
  if (!Array.isArray(arr)) throw new Error('Public keys response is not an array')
  return arr
}

function verifyEd25519(message: string, signatureBase64Url: string, publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem)
    const sigBuffer = fromBase64Url(signatureBase64Url)
    return cryptoVerify(null, Buffer.from(message, 'utf8'), key, sigBuffer)
  } catch (error) {
    console.error(`${DIM}Crypto error: ${String(error)}${RESET}`)
    return false
  }
}

function printResult(genuine: boolean, receipt: Receipt, keyId: string) {
  console.log()
  if (genuine) {
    console.log(`${GREEN}${BOLD}  ✓  GENUINE${RESET}`)
    console.log(`${GREEN}  The receipt is authentic and unmodified.${RESET}`)
  } else {
    console.log(`${RED}${BOLD}  ✗  TAMPERED${RESET}`)
    console.log(`${RED}  The receipt has been modified or the signature is invalid.${RESET}`)
  }
  console.log()
  console.log(`${DIM}  Proposal  ${RESET}${receipt.proposalId}`)
  console.log(`${DIM}  Amount    ${RESET}${(receipt.amountCents / 100).toFixed(2)} ${receipt.currency}`)
  console.log(`${DIM}  Gate      ${RESET}${receipt.gate} (${receipt.clause})`)
  console.log(`${DIM}  Issued    ${RESET}${receipt.issuedAt}`)
  console.log(`${DIM}  Key used  ${RESET}${keyId}`)
  console.log(`${DIM}  Cart hash ${RESET}${receipt.cartHash.slice(0, 16)}…`)
  console.log()
}

async function main() {
  const args = process.argv.slice(2)
  let receipt: Receipt
  let keysFile: string | null = null

  const fileIdx = args.indexOf('--file')
  const keysIdx = args.indexOf('--keys')

  if (keysIdx !== -1) keysFile = args[keysIdx + 1] ?? null

  if (fileIdx !== -1) {
    const path = args[fileIdx + 1]
    if (!path) { console.error('--file requires a path'); process.exit(1) }
    receipt = JSON.parse(readFileSync(path, 'utf8')) as Receipt
  } else if (args[0] && !args[0].startsWith('--')) {
    receipt = await fetchReceipt(args[0])
  } else {
    console.error('Usage: verify-receipt.ts <proposalId> | --file <path>')
    process.exit(1)
  }

  if (receipt.format !== 'mandate.receipt.v1') {
    console.error(`${RED}Not a mandate.receipt.v1 document (got: ${receipt.format})${RESET}`)
    process.exit(1)
  }

  let keys: PublicKeyInfo[]
  if (keysFile) {
    keys = JSON.parse(readFileSync(keysFile, 'utf8')) as PublicKeyInfo[]
    if (!Array.isArray(keys)) keys = (keys as { data?: PublicKeyInfo[] }).data ?? []
  } else {
    console.log(`${DIM}Fetching public keys from ${receipt.publicKeysUrl}…${RESET}`)
    keys = await fetchKeys(receipt.publicKeysUrl)
  }

  const key = keys.find((k) => k.keyId === receipt.lockKeyId)
  if (!key) {
    console.log()
    console.log(`${RED}${BOLD}  ✗  KEY NOT FOUND${RESET}`)
    console.log(`${RED}  The receipt names key ${receipt.lockKeyId}, which is not in the published key set.`)
    console.log(`  Someone may have re-signed this receipt with their own key.${RESET}`)
    console.log()
    process.exit(1)
  }

  // Reconstruct the signed message independently — never trust the receipt's own lockMessage field
  const reconstructed = `mandate:lock:v1\n${receipt.proposalId}\n${receipt.cartHash}`
  if (reconstructed !== receipt.lockMessage) {
    console.log(`${RED}${BOLD}  ✗  MESSAGE MISMATCH${RESET}`)
    console.log(`${RED}  The lockMessage in the receipt does not match what we reconstructed.${RESET}`)
    console.log(`${DIM}  Reconstructed: ${reconstructed}${RESET}`)
    console.log(`${DIM}  In receipt:    ${receipt.lockMessage}${RESET}`)
    process.exit(1)
  }

  const genuine = verifyEd25519(reconstructed, receipt.lockSignature, key.publicKeyPem)
  printResult(genuine, receipt, key.keyId)
  process.exit(genuine ? 0 : 1)
}

main().catch((error) => {
  console.error(`${RED}Error: ${String(error)}${RESET}`)
  process.exit(1)
})

