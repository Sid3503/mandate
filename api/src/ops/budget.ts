export type BudgetCaps = {
  globalDailyTokens: number
  workspaceDailyTokens: number
  maxOutputTokens: number
  maxSteps: number
}

export type Usage = { calls: number; tokensIn: number; tokensOut: number }

const EMPTY: Usage = { calls: 0, tokensIn: 0, tokensOut: 0 }

/**
 * Counts model calls before they happen. A cap of 0 refuses every call. Tests pass a spy model and assert it is never asked.
 * Quick asks do not come through here.
 */
export class ModelBudget {
  private killed = false
  private readonly days = new Map<string, Usage>()
  warned = false

  constructor(
    private readonly caps: BudgetCaps,
    private readonly now: () => Date = () => new Date(),
    private readonly workspaceId = 'ws_default',
  ) {}

  kill(): void {
    this.killed = true
  }

  get stopped(): boolean {
    return this.killed
  }

  /** A reason to refuse, or null when a call may start. Does not count the call. */
  blocked(): string | null {
    if (this.killed) return 'AI is paused today. Quick asks still work.'
    const usage = this.usage()
    const spent = usage.tokensIn + usage.tokensOut
    if (this.caps.globalDailyTokens <= 0 || this.caps.workspaceDailyTokens <= 0) return 'AI is paused today. Quick asks still work.'
    if (spent >= this.caps.workspaceDailyTokens || spent >= this.caps.globalDailyTokens) return 'AI is paused today. Quick asks still work.'
    return null
  }

  /** Reserves one call. Returns the refusal message, or null after counting a nominal estimate. */
  reserve(): string | null {
    const reason = this.blocked()
    if (reason) return reason
    const usage = this.usage()
    usage.calls += 1
    const estimate = Math.min(500, this.caps.maxOutputTokens)
    usage.tokensOut += estimate
    const spent = usage.tokensIn + usage.tokensOut
    const cap = Math.min(this.caps.globalDailyTokens, this.caps.workspaceDailyTokens)
    if (!this.warned && cap > 0 && spent / cap >= 0.8) this.warned = true
    return null
  }

  correct(actualOut: number): void {
    const usage = this.usage()
    usage.tokensOut += Math.max(0, Math.min(actualOut, this.caps.maxOutputTokens))
  }

  snapshot(): Usage & { budgetPercent: number; killed: boolean; warned: boolean } {
    const usage = this.usage()
    const cap = Math.min(this.caps.globalDailyTokens, this.caps.workspaceDailyTokens)
    const spent = usage.tokensIn + usage.tokensOut
    return { ...usage, budgetPercent: cap <= 0 ? 100 : Math.min(100, Math.round((spent / cap) * 100)), killed: this.killed, warned: this.warned }
  }

  private usage(): Usage {
    const day = this.now().toISOString().slice(0, 10)
    const key = `${day}:${this.workspaceId}`
    const found = this.days.get(key)
    if (found) return found
    const created = { ...EMPTY }
    this.days.set(key, created)
    return created
  }
}

export const OPEN_CAPS: BudgetCaps = {
  globalDailyTokens: 10_000_000,
  workspaceDailyTokens: 1_000_000,
  maxOutputTokens: 4096,
  maxSteps: 8,
}
