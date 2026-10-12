export type RateClass = 'auth' | 'key-unlock' | 'ask' | 'write' | 'read'

export type RateDecision = { ok: true } | { ok: false; retryAfter: number }

type Bucket = { count: number; reset: number; lockedUntil: number }

/**
 * Token buckets with an injected clock. `auth` is 5 per minute per IP and 20 per hour per IP plus identifier.
 * The other classes are per principal per minute. A lockout is remembered until `lockedUntil`.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  take(input: { className: RateClass; ip: string; principal: string }): RateDecision {
    const at = this.now()
    if (input.className === 'auth') {
      const minute = this.hit(`auth:m:${input.ip}`, at, 60_000, 5)
      if (!minute.ok) return minute
      return this.hit(`auth:h:${input.ip}:${input.principal}`, at, 3_600_000, 20)
    }
    const limit = input.className === 'key-unlock' ? 10 : input.className === 'ask' ? 12 : input.className === 'write' ? 60 : 300
    const window = input.className === 'key-unlock' ? 60_000 : 60_000
    const key = input.className === 'key-unlock' ? `unlock:${input.ip}` : `${input.className}:${input.principal}`
    return this.hit(key, at, window, limit)
  }

  private hit(key: string, at: number, windowMs: number, limit: number): RateDecision {
    const current = this.buckets.get(key)
    if (current && current.lockedUntil > at) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((current.lockedUntil - at) / 1000)) }
    }
    if (!current || at >= current.reset) {
      this.buckets.set(key, { count: 1, reset: at + windowMs, lockedUntil: 0 })
      return { ok: true }
    }
    if (current.count >= limit) {
      current.lockedUntil = current.reset
      return { ok: false, retryAfter: Math.max(1, Math.ceil((current.reset - at) / 1000)) }
    }
    current.count += 1
    return { ok: true }
  }
}

export function rateClass(method: string, path: string): RateClass {
  if (path.startsWith('/auth/')) return 'auth'
  if (path === '/v1/session') return 'key-unlock'
  if (path === '/v1/ask' || path.startsWith('/v1/clerk')) return 'ask'
  if (method === 'GET' || method === 'HEAD') return 'read'
  return 'write'
}
