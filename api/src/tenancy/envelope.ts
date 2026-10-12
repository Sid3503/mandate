import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

function keyBytes(master: string): Buffer {
  const raw = Buffer.from(master, 'base64')
  if (raw.length === 32) return raw
  return createHash('sha256').update(master).digest()
}

/** AES-256-GCM. The master key never goes in the database. */
export function seal(master: string, plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyBytes(master), iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, body]).toString('base64url')
}

export function openSeal(master: string, packed: string): string {
  const buf = Buffer.from(packed, 'base64url')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const body = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(master), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}
