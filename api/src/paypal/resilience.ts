import { PayPalError } from './port'

/**
 * How Mandate behaves when PayPal is slow or down.
 *
 * A call that is safe to repeat (a read, or a write that carries PayPal's own request id, so PayPal answers a repeat with
 * the first answer) is tried again after a short, jittered pause when the failure is the network or a 429 or a 5xx.
 * A call that is not safe to repeat is never repeated. A run of transient failures opens a breaker: for a short while the
 * next call fails at once with a plain "PayPal is not answering" instead of making a person wait through another
 * timeout, and one probe call decides whether PayPal is back. An answer from PayPal, even a refusal, counts as PayPal
 * being up. Pure and clock-injected, so it is tested without a network.
 */
export type UpstreamStatus = {
  circuit: 'closed' | 'open' | 'half_open'
  consecutiveFailures: number
  calls: number
  failures: number
  retries: number
  lastError: string | null
  lastOkAt: string | null
  lastFailureAt: string | null
  openUntil: string | null
}

export type GuardOptions = {
  failuresToOpen?: number
  cooldownMs?: number
  attempts?: number
  baseDelayMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export const isTransient = (error: unknown): boolean => {
  if (error instanceof PayPalError) return error.httpStatus === 429 || (error.httpStatus >= 500 && error.httpStatus !== 501)
  // Not a PayPal answer at all: a dropped connection, a timeout, DNS.
  return true
}

export class UpstreamGuard {
  private consecutive = 0
  private openedAt: number | null = null
  private probing = false
  private calls = 0
  private failures = 0
  private retries = 0
  private lastError: string | null = null
  private lastOk: number | null = null
  private lastFailure: number | null = null
  private readonly failuresToOpen: number
  private readonly cooldownMs: number
  private readonly attempts: number
  private readonly baseDelayMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number

  constructor(options: GuardOptions = {}) {
    this.failuresToOpen = options.failuresToOpen ?? 5
    this.cooldownMs = options.cooldownMs ?? 20_000
    this.attempts = options.attempts ?? 3
    this.baseDelayMs = options.baseDelayMs ?? 250
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.random = options.random ?? Math.random
  }

  private circuit(): 'closed' | 'open' | 'half_open' {
    if (this.openedAt === null) return 'closed'
    return this.now() - this.openedAt >= this.cooldownMs ? 'half_open' : 'open'
  }

  status(): UpstreamStatus {
    const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString())
    return { circuit: this.circuit(), consecutiveFailures: this.consecutive, calls: this.calls, failures: this.failures, retries: this.retries, lastError: this.lastError, lastOkAt: iso(this.lastOk), lastFailureAt: iso(this.lastFailure), openUntil: this.openedAt === null ? null : iso(this.openedAt + this.cooldownMs) }
  }

  /** Runs `fn`. `repeatable` says whether a failed attempt may be made again. `fn` may put `retryAfterMs` on an error it throws. */
  async run<T>(fn: () => Promise<T>, options: { repeatable: boolean }): Promise<T> {
    const circuit = this.circuit()
    if (circuit === 'open' || (circuit === 'half_open' && this.probing)) {
      throw new PayPalError(503, 'paypal_unavailable', null, 'PayPal has failed several times in a row, so Mandate is not calling it for a moment')
    }
    if (circuit === 'half_open') this.probing = true
    const attempts = options.repeatable ? this.attempts : 1
    let last: unknown
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      this.calls += 1
      try {
        const result = await fn()
        this.consecutive = 0
        this.openedAt = null
        this.probing = false
        this.lastOk = this.now()
        return result
      } catch (error) {
        last = error
        if (!isTransient(error)) {
          // PayPal answered (a refusal, a bad request): it is up. This is the caller's problem to handle.
          this.consecutive = 0
          this.openedAt = null
          this.probing = false
          this.lastOk = this.now()
          throw error
        }
        this.failures += 1
        this.consecutive += 1
        this.lastError = error instanceof PayPalError ? `${error.httpStatus} ${error.paypalName}` : (error as Error)?.name ?? 'network'
        this.lastFailure = this.now()
        if (this.consecutive >= this.failuresToOpen || this.probing) {
          this.openedAt = this.now()
          this.probing = false
          break
        }
        if (attempt < attempts) {
          this.retries += 1
          const asked = (error as { retryAfterMs?: number }).retryAfterMs
          const backoff = this.baseDelayMs * 2 ** (attempt - 1) + this.random() * this.baseDelayMs
          await this.sleep(Math.min(5_000, asked ?? backoff))
        }
      }
    }
    this.probing = false
    throw last
  }
}
