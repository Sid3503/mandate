import { randomUUID } from 'node:crypto'
import type { Repo } from '../db/repo'
import { NOT_PAUSED, RefusalCounter, type PauseState } from '../domain/safety'
import type { Signer } from '../domain/signing'
import { live, stamp } from './live'

export type SafetyConfig = {
  /** Suspicious refusals from one asker, inside the window, that pause Mandate by themselves. 0 turns the breaker off. */
  tripAfter: number
  windowSeconds: number
  /** Unknown payee attempts inside window that pause Mandate. */
  unknownPayeeTripAfter: number
  unknownPayeeWindowSeconds: number
  /** Rate limit per minute from one agent before suspending it. */
  agentRateLimitPerMinute: number
  /** Consecutive autopilot failures before pausing autopilot. */
  autopilotFailureTripAfter: number
}

export const DEFAULT_SAFETY: SafetyConfig = {
  tripAfter: 3,
  windowSeconds: 120,
  unknownPayeeTripAfter: 2,
  unknownPayeeWindowSeconds: 600,
  agentRateLimitPerMinute: 20,
  autopilotFailureTripAfter: 3,
}

export type SafetyEventView = { id: string; at: string; type: 'paused' | 'resumed' | 'agent_suspended' | 'autopilot_paused' | 'autopilot_resumed'; by: 'owner' | 'breaker'; reason: string | null; detail: string | null; signed: boolean }

/** The message each safety event signs, so the history of pauses can be shown to be the server's own. */
export const safetyMessage = (event: { id: string; at: string; type: string; by: string; reason: string | null }) => `safety:${event.id}:${event.type}:${event.by}:${event.at}:${event.reason ?? ''}`

/**
 * The pause, and the breaker that trips it. A pause is a row in the database, so it survives a restart; the counters that
 * watch for odd requests are in memory, so a restart starts them again. Every pause and resume is a signed, append-only
 * event with who and why, shown on the Proof page and checked by it.
 */
export class SafetyService {
  private counter: RefusalCounter
  private unknownPayeeCounter: RefusalCounter
  private readonly agentRequests = new Map<string, number[]>()
  private consecutiveAutopilotFailures = 0
  config: SafetyConfig
  /** Set by the container: what to do for the autopilot the moment Mandate is resumed. */
  onResume: (() => Promise<void>) | null = null

  constructor(private readonly repo: Repo, private readonly signer: Signer, private readonly now: () => Date, initialConfig: Partial<SafetyConfig> = {}) {
    const persisted = repo.safetyConfig<SafetyConfig>()
    this.config = {
      ...DEFAULT_SAFETY,
      ...(persisted ?? {}),
      ...initialConfig,
    }
    this.counter = new RefusalCounter(this.config.tripAfter, this.config.windowSeconds * 1000)
    this.unknownPayeeCounter = new RefusalCounter(this.config.unknownPayeeTripAfter, this.config.unknownPayeeWindowSeconds * 1000)
  }

  updateConfig(patch: Partial<SafetyConfig>): SafetyConfig {
    this.config = { ...this.config, ...patch }
    this.repo.setSafetyConfig(this.config)
    this.counter = new RefusalCounter(this.config.tripAfter, this.config.windowSeconds * 1000)
    this.unknownPayeeCounter = new RefusalCounter(this.config.unknownPayeeTripAfter, this.config.unknownPayeeWindowSeconds * 1000)
    return this.config
  }

  state(): PauseState {
    const row = this.repo.safetyState()
    if (!row) return NOT_PAUSED
    return {
      paused: row.paused === 1,
      reason: row.reason,
      since: row.since,
      by: row.by === 'owner' || row.by === 'breaker' ? row.by : null,
      epoch: row.epoch,
      autopilotPaused: row.autopilot_paused === 1,
    }
  }

  paused(): boolean {
    return this.state().paused
  }

  isAutopilotPaused(): boolean {
    const s = this.state()
    return s.paused || Boolean(s.autopilotPaused)
  }

  events(limit = 20): SafetyEventView[] {
    return this.repo.safetyEvents(limit).map((row) => ({ id: row.id, at: row.at, type: row.type as SafetyEventView['type'], by: row.by as 'owner' | 'breaker', reason: row.reason, detail: row.detail, signed: this.signer.verify(safetyMessage(row), row.sig, row.key_id) }))
  }

  /** Pauses everything automatic. Pausing a paused Mandate changes nothing and writes nothing. */
  pause(by: 'owner' | 'breaker', reason: string | null, detail: string | null = null): PauseState {
    const before = this.state()
    if (before.paused) return before
    const at = this.now().toISOString()
    const text = reason?.trim().slice(0, 200) || (by === 'owner' ? 'Paused by the owner' : 'Paused by the breaker')
    this.repo.transaction(() => {
      this.repo.setSafetyState({ paused: true, reason: text, since: at, by, epoch: before.epoch, autopilotPaused: before.autopilotPaused })
      this.record('paused', by, text, detail, at)
    })
    this.counter.reset()
    live.publish({ type: 'changed', scope: 'safety', what: 'safety.paused', at: stamp() })
    return this.state()
  }

  /** Pauses only the autopilot. Pausing an already-paused autopilot changes nothing. */
  pauseAutopilot(by: 'owner' | 'breaker', reason: string | null = null): PauseState {
    const before = this.state()
    if (before.autopilotPaused) return before
    const at = this.now().toISOString()
    const text = reason?.trim().slice(0, 200) || (by === 'owner' ? 'Autopilot paused by the owner' : 'Autopilot paused by the breaker')
    this.repo.transaction(() => {
      this.repo.setSafetyState({ ...before, autopilotPaused: true })
      this.record('autopilot_paused', by, text, null, at)
    })
    live.publish({ type: 'changed', scope: 'safety', what: 'autopilot.paused', at: stamp() })
    return this.state()
  }

  /** Resumes only the autopilot. */
  async resumeAutopilot(by: 'owner' = 'owner'): Promise<PauseState> {
    const before = this.state()
    if (!before.autopilotPaused) return before
    const at = this.now().toISOString()
    this.repo.transaction(() => {
      this.repo.setSafetyState({ ...before, autopilotPaused: false })
      this.record('autopilot_resumed', by, null, null, at)
    })
    this.consecutiveAutopilotFailures = 0
    live.publish({ type: 'changed', scope: 'safety', what: 'autopilot.resumed', at: stamp() })
    await this.onResume?.().catch(() => undefined)
    return this.state()
  }

  /** Lets automatic things run again, then catches the autopilot up on what it was refused while paused. */
  async resume(by: 'owner' = 'owner'): Promise<PauseState> {
    const before = this.state()
    if (!before.paused) return before
    const at = this.now().toISOString()
    this.repo.transaction(() => {
      this.repo.setSafetyState({ paused: false, reason: null, since: null, by: null, epoch: before.epoch + 1, autopilotPaused: false })
      this.record('resumed', by, before.reason, `was paused since ${before.since}`, at)
    })
    this.counter.reset()
    this.unknownPayeeCounter.reset()
    this.agentRequests.clear()
    this.consecutiveAutopilotFailures = 0
    live.publish({ type: 'changed', scope: 'safety', what: 'safety.resumed', at: stamp() })
    await this.onResume?.().catch(() => undefined)
    return this.state()
  }

  /** Forgets the refusals counted so far. A demo reset starts from none. */
  forget(): void {
    this.counter.reset()
    this.unknownPayeeCounter.reset()
    this.agentRequests.clear()
    this.consecutiveAutopilotFailures = 0
  }

  /** Called for every refusal an asker (not the owner) received. */
  noteRefusal(askerKey: string, clause: string): boolean {
    if (this.paused()) return false
    if (!askerKey.startsWith('agent:') && clause === 'payee.unknown') {
      const trippedPayee = this.unknownPayeeCounter.record('payee.unknown', clause, this.now().getTime())
      if (trippedPayee) {
        this.pause('breaker', `${trippedPayee.count} unknown payee attempts in ${Math.round(this.config.unknownPayeeWindowSeconds / 60)} minutes`, `Rules that refused it: ${trippedPayee.clauses.join(', ')}.`)
        return true
      }
    }
    if (askerKey === 'autopilot') {
      this.noteAutopilotFailure(clause)
    }
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

  /** Counts requests from an agent key within 1 minute. Suspends the agent key when exceeding agentRateLimitPerMinute. */
  noteAgentRequest(agentId: string): boolean {
    if (this.config.agentRateLimitPerMinute <= 0) return false
    const now = this.now().getTime()
    const windowMs = 60_000
    const timestamps = (this.agentRequests.get(agentId) ?? []).filter((t) => now - t < windowMs)
    timestamps.push(now)
    this.agentRequests.set(agentId, timestamps)
    if (timestamps.length > this.config.agentRateLimitPerMinute) {
      const at = this.now().toISOString()
      this.repo.setAgentStatus(agentId, 'suspended', at)
      this.record('agent_suspended', 'breaker', `Agent ${agentId.slice(0, 8)} suspended for rate limit`, `${this.config.agentRateLimitPerMinute} requests in one minute limit exceeded.`, at)
      live.publish({ type: 'changed', scope: 'safety', what: 'agent.suspended', at: stamp() })
      return true
    }
    return false
  }

  /** Consecutive failures from the autopilot. When reaching autopilotFailureTripAfter, pauses the autopilot. */
  noteAutopilotFailure(reason: string): boolean {
    if (this.config.autopilotFailureTripAfter <= 0) return false
    this.consecutiveAutopilotFailures++
    if (this.consecutiveAutopilotFailures >= this.config.autopilotFailureTripAfter) {
      this.pauseAutopilot('breaker', `${this.consecutiveAutopilotFailures} autopilot failures in a row: ${reason}`)
      return true
    }
    return false
  }

  noteAutopilotSuccess(): void {
    this.consecutiveAutopilotFailures = 0
  }

  private record(type: SafetyEventView['type'], by: 'owner' | 'breaker', reason: string | null, detail: string | null, at: string): void {
    const id = randomUUID()
    const signed = this.signer.sign(safetyMessage({ id, at, type, by, reason }))
    this.repo.insertSafetyEvent({ id, at, type, by, reason, detail, sig: signed.signature, keyId: signed.keyId })
  }
}
