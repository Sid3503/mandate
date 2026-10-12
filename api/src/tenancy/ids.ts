import { randomBytes } from 'node:crypto'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** `ws_default`, or `ws_` plus 20 lowercase base32 characters. Anything else is rejected before a file is touched. */
export function isWorkspaceId(value: string): boolean {
  return value === 'ws_default' || /^ws_[a-z2-7]{20}$/.test(value)
}

export function newWorkspaceId(): string {
  const bytes = randomBytes(20)
  let out = 'ws_'
  for (let i = 0; i < 20; i += 1) out += ALPHABET[bytes[i]! % ALPHABET.length]
  return out
}
