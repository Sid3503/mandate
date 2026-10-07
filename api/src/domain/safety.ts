import { Clause, type Decision } from './gate'

/**
 * The emergency stop, as a rule the gate obeys.
 *
 * While Mandate is paused, nothing runs without a person. Anything an agent, a member of staff's key or the autopilot
 * asks for is refused with the reason written down. The owner can still act, but nothing the owner asks goes through
 * without their tap: an automatic decision becomes "waits for you". A refusal stays a refusal, with the rule that really
 * refused it. This is a pure function of the decision, the state and who asked, so it is tested as one.
 */
export type PauseState = {
  paused: boolean
  reason: string | null
  since: string | null
  /** Who paused it: the owner's button, or the breaker that watches for odd requests. */
  by: 'owner' | 'breaker' | null
  /** Counts resumes. A request asked on behalf of the autopilot carries it, so a refusal while paused is not replayed forever. */
  epoch: number
}

export const NOT_PAUSED: PauseState = { paused: false, reason: null, since: null, by: null, epoch: 0 }

export function applyPause(decision: Decision, pause: PauseState, actor: string): Decision {
  if (!pause.paused || decision.gate === 'DENY') return decision
  const why = pause.reason ? ` (${pause.reason})` : ''
  if (actor !== 'owner') {
    return { gate: 'DENY', clause: Clause.systemPaused, detail: `Mandate is paused${why}, so nothing automatic runs and no agent is served until the owner resumes it` }
  }
  if (decision.gate === 'AUTO') {
    return { gate: 'NEEDS_APPROVAL', clause: Clause.systemPaused, detail: `Mandate is paused${why}: nothing goes without the owner's tap` }
  }
  return decision
}

/**
 * Which refusals say "someone is trying something the rules never allow", as against "not yet" or "incomplete". Only the
 * first kind counts toward tripping the breaker: an agent that asks for a payout before the client has paid is early, not
 * hostile, and a missing proof link is a slip.
 */
const BENIGN = new Set(['funding.missing', 'evidence.missing', 'job.missing', 'deal.required', 'deal.unknown', 'shape.invalid', 'system.paused'])
export const isSuspiciousRefusal = (clause: string): boolean => !BENIGN.has(clause)

/** A sliding window of suspicious refusals per asker. Counters live in memory: a restart starts them again, which is the safe direction. */
export class RefusalCounter {
  private readonly seen = new Map<string, Array<{ at: number; clause: string }>>()

  constructor(readonly limit: number, readonly windowMs: number) {}

  /** Records one refusal. Returns what tripped the breaker, or null. */
  record(key: string, clause: string, at: number): { count: number; clauses: string[] } | null {
    if (this.limit <= 0 || !isSuspiciousRefusal(clause)) return null
    const recent = [...(this.seen.get(key) ?? []).filter((item) => at - item.at < this.windowMs), { at, clause }]
    this.seen.set(key, recent)
    if (recent.length < this.limit) return null
    this.seen.delete(key)
    return { count: recent.length, clauses: recent.map((item) => item.clause) }
  }

  reset(): void {
    this.seen.clear()
  }
}
