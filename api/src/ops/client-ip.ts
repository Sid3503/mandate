import { isIP } from 'node:net'

/** How many proxy hops may append to X-Forwarded-For. Empty or garbage stays 1. Never more than 8. */
export function proxyHops(value: string | undefined): number {
  if (value === undefined || value === '') return 1
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) return 1
  return Math.min(parsed, 8)
}

/**
 * The client address used for limits.
 * With the proxy flag off, X-Forwarded-For is ignored.
 * With it on, the client is `hops` places from the right (1 is the rightmost, the address one proxy appends).
 * A short list, or a chosen entry that is not an IP, is `direct` so a forged label cannot open a new bucket.
 * IPv6 addresses share a bucket per /64.
 */
export function clientIp(headers: { get(name: string): string | null | undefined }, trustProxy: boolean, hops = 1): string {
  if (!trustProxy) return 'direct'
  const hopCount = proxyHops(String(hops))
  const parts = (headers.get('x-forwarded-for') ?? '').split(',').map((part) => part.trim()).filter(Boolean)
  if (parts.length < hopCount) return 'direct'
  const chosen = parts[parts.length - hopCount] ?? ''
  return canonical(chosen)
}

function canonical(entry: string): string {
  const kind = isIP(entry)
  if (kind === 4) return entry
  if (kind !== 6) return 'direct'
  const groups = expandIpv6(entry)
  if (!groups) return 'direct'
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`
}

/** Eight groups, or null. A dotted tail is expanded first so a mixed address still groups by /64. */
function expandIpv6(address: string): number[] | null {
  let input = address.split('%')[0] ?? ''
  if (input.includes('.')) {
    const last = input.lastIndexOf(':')
    const v4 = input.slice(last + 1).split('.')
    if (v4.length !== 4) return null
    const nums = v4.map((part) => Number(part))
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    const hi = ((nums[0] ?? 0) << 8) | (nums[1] ?? 0)
    const lo = ((nums[2] ?? 0) << 8) | (nums[3] ?? 0)
    input = `${input.slice(0, last + 1)}${hi.toString(16)}:${lo.toString(16)}`
  }
  const halves = input.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  if (halves.length === 1 && left.length !== 8) return null
  const missing = 8 - left.length - right.length
  if (missing < 0) return null
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  if (groups.length !== 8) return null
  const parsed = groups.map((group) => (/^[0-9a-fA-F]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN))
  if (parsed.some((n) => Number.isNaN(n))) return null
  return parsed
}
