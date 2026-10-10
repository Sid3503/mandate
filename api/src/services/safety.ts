import { randomUUID } from 'node:crypto'
import type { Repo } from '../db/repo'
import { NOT_PAUSED, RefusalCounter, type PauseState } from '../domain/safety'
import type { Signer } from '../domain/signing'
import { live, stamp } from './live'

export type SafetyConfig = {
  /** Suspicious refusals from one asker, inside the window, that pause Mandate by themselves. 0 turns the breaker off. */
  tripAfter: number
  windowSeconds: number
}

export const DEFAULT_SAFETY: SafetyConfig = { tripAfter: 3, windowSeconds: 120 }

export type SafetyEventView = { id: string; at: string; type: 'paused' | 'resumed' | 'agent_suspended'; by: 'owner' | 'breaker'; reason: string | null; detail: string | null; signed: boolean }

/** The message each safety event signs, so the history of pauses can be shown to be the server's own. */
export const safetyMessage = (event: { id: string; at: string; type: string; by: string; reason: string | null }) => `safety:${event.id}:${event.type}:${event.by}:${event.at}:${event.reason ?? ''}`

/**
 * The pause, and the breaker that trips it. A pause is a row in the database, so it survives a restart; the counters that
 * watch for odd requests are in memory, so a restart starts them again. Every pause and resume is a signed, append-only
 * event with who and why, shown on the Proof page and checked by it.
 */
export class SafetyService {
  private readonly counter: RefusalCounter
  /** Set by the container: what to do for the autopilot the moment Mandate is resumed. */
  onResume: (() => Promise<void>) | null = null

  constructor(private readonly repo: Repo, private readonly signer: Signer, private readonly now: () => Date, readonly config: SafetyConfig = DEFAULT_SAFETY) {
    this.counter = new RefusalCounter(config.tripAfter, config.windowSeconds * 1000)
  }

  state(): PauseState {
    const row = this.repo.safetyState()
    if (!row) return NOT_PAUSED
    return { paused: row.paused === 1, reason: row.reason, since: row.since, by: row.by === 'owner' || row.by === 'breaker' ? row.by : null, epoch: row.epoch }
  }

  paused(): boolean {
    return this.state().paused
  }

  events(limit = 20): SafetyEventView[] {
    return this.repo.safetyEvents(limit).map((row) => ({ id: row.id, at: row.at, type: row.type as 'paused' | 'resumed' | 'agent_suspended', by: row.by as 'owner' | 'breaker', reason: row.reason, detail: row.detail, signed: this.signer.verify(safetyMessage(row), row.sig, row.key_id) }))
  }

  /** Pauses everything automatic. Pausing a paused Mandate changes nothing and writes nothing. */
  pause(by: 'owner' | 'breaker', reason: string | null, detail: string | null = null): PauseState {
    const before = this.state()
    if (before.paused) return before
    const at = this.now().toISOString()
    const text = reason?.trim().slice(0, 200) || (by === 'owner' ? 'Paused by the owner' : 'Paused by the breaker')
    this.repo.transaction(() => {
      this.repo.setSafetyState({ paused: true, reason: text, since: at, by, epoch: before.epoch })
      this.record('paused', by, text, detail, at)
    })
    this.counter.reset()
    live.publish({ type: 'changed', scope: 'safety', what: 'safety.paused', at: stamp() })
    return this.state()
  }

  /** Lets automatic things run again, then catches the autopilot up on what it was refused while paused. */
  async resume(by: 'owner' = 'owner'): Promise<PauseState> {
    const before = this.state()
    if (!before.paused) return before
    const at = this.now().toISOString()
    this.repo.transaction(() => {
      this.repo.setSafetyState({ paused: false, reason: null, since: null, by: null, epoch: before.epoch + 1 })
      this.record('resumed', by, before.reason, `was paused since ${before.since}`, at)
    })
    this.counter.reset()
    live.publish({ type: 'changed', scope: 'safety', what: 'safety.resumed', at: stamp() })
    await this.onResume?.().catch(() => undefined)
    return this.state()
  }

  /** Forgets the refusals counted so far. A demo reset starts from none. */
  forget(): void {
    this.counter.reset()
  }

  /** Called for every refusal an asker (not the owner) received. Three odd ones in two minutes pause Mandate. */
  noteRefusal(askerKey: string, clause: string): boolean {
    if (this.paused()) return false
    const tripped = this.counter.record(askerKey, clause, this.now().getTime())
    if (!tripped) return false
    const at = this.now().toISOString()
    if (askerKey.startsWith('agent:')) {
      const agentId = askerKey.slice('agent:'.length)
      this.repo.setAgentStatus(agentId, 'suspended', at)
      this.record('agent_suspended', 'breaker', `Agent ${agentId.slice(0, 8)} suspended`, `Rules that refused it: ${tripped.clauses.join(', ')}.`, at)
      live.publish({ type: 'changed', scope: 'safety', what: 'agent.suspended', at: stamp() })
      return true
    }
    const who = askerKey === 'proposer' ? 'the studio\'s key' : askerKey === 'autopilot' ? 'the autopilot' : askerKey
    this.pause('breaker', `${tripped.count} refusals from ${who} in ${Math.round(this.config.windowSeconds / 60)} minutes`, `Rules that refused them: ${tripped.clauses.join(', ')}.`)
    return true
  }

  private record(type: 'paused' | 'resumed' | 'agent_suspended', by: 'owner' | 'breaker', reason: string | null, detail: string | null, at: string): void {
    const id = randomUUID()
    const signed = this.signer.sign(safetyMessage({ id, at, type, by, reason }))
    this.repo.insertSafetyEvent({ id, at, type, by, reason, detail, sig: signed.signature, keyId: signed.keyId })
  }
}
