/**
 * How each model is doing, and a circuit breaker on top. A model that has just failed several times in a row is not
 * asked again for a short while: the next call goes straight to the fallback instead of making a person wait through
 * a timeout that is going to happen anyway. After the cool-down one probe call is let through; if it works, the circuit
 * closes. Pure and clock-injected, so it is tested without a network.
 */
export type Circuit = 'closed' | 'open' | 'half_open'

export type ModelStats = {
  name: string
  calls: number
  failures: number
  consecutiveFailures: number
  p50Ms: number | null
  p95Ms: number | null
  circuit: Circuit
  openUntil: string | null
  lastError: string | null
  lastAt: string | null
  inputTokens: number
  outputTokens: number
}

type Entry = { ok: boolean; ms: number }
type State = { recent: Entry[]; consecutive: number; openedAt: number | null; probing: boolean; lastError: string | null; lastAt: number | null; inputTokens: number; outputTokens: number; calls: number; failures: number }

export type HealthOptions = { window?: number; failuresToOpen?: number; cooldownMs?: number }

const percentile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!
}

export class ModelHealth {
  private readonly models = new Map<string, State>()
  private readonly window: number
  private readonly failuresToOpen: number
  private readonly cooldownMs: number

  constructor(private readonly now: () => number = Date.now, options: HealthOptions = {}) {
    this.window = options.window ?? 50
    this.failuresToOpen = options.failuresToOpen ?? 3
    this.cooldownMs = options.cooldownMs ?? 30_000
  }

  private state(name: string): State {
    let state = this.models.get(name)
    if (!state) {
      state = { recent: [], consecutive: 0, openedAt: null, probing: false, lastError: null, lastAt: null, inputTokens: 0, outputTokens: 0, calls: 0, failures: 0 }
      this.models.set(name, state)
    }
    return state
  }

  circuit(name: string): Circuit {
    const state = this.state(name)
    if (state.openedAt === null) return 'closed'
    return this.now() - state.openedAt >= this.cooldownMs ? 'half_open' : 'open'
  }

  /** May a call go to this model right now? In the half-open state exactly one probe is allowed at a time. */
  allow(name: string): boolean {
    const circuit = this.circuit(name)
    if (circuit === 'closed') return true
    if (circuit === 'open') return false
    const state = this.state(name)
    if (state.probing) return false
    state.probing = true
    return true
  }

  success(name: string, ms: number, usage?: { inputTokens?: number; outputTokens?: number }): void {
    const state = this.state(name)
    state.calls += 1
    state.recent = [...state.recent, { ok: true, ms }].slice(-this.window)
    state.consecutive = 0
    state.openedAt = null
    state.probing = false
    state.lastAt = this.now()
    state.inputTokens += usage?.inputTokens ?? 0
    state.outputTokens += usage?.outputTokens ?? 0
  }

  failure(name: string, code: string, ms = 0): void {
    const state = this.state(name)
    state.calls += 1
    state.failures += 1
    state.recent = [...state.recent, { ok: false, ms }].slice(-this.window)
    state.consecutive += 1
    state.lastError = code
    state.lastAt = this.now()
    state.probing = false
    if (state.consecutive >= this.failuresToOpen || state.openedAt !== null) state.openedAt = this.now()
  }

  stats(): ModelStats[] {
    return [...this.models.entries()].map(([name, state]) => {
      const times = state.recent.filter((entry) => entry.ok).map((entry) => entry.ms)
      const circuit = this.circuit(name)
      return {
        name,
        calls: state.calls,
        failures: state.failures,
        consecutiveFailures: state.consecutive,
        p50Ms: percentile(times, 50),
        p95Ms: percentile(times, 95),
        circuit,
        openUntil: state.openedAt === null ? null : new Date(state.openedAt + this.cooldownMs).toISOString(),
        lastError: state.lastError,
        lastAt: state.lastAt === null ? null : new Date(state.lastAt).toISOString(),
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
      }
    })
  }
}
