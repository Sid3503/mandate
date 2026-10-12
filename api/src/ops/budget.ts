import type { DatabaseSync } from 'node:sqlite'

export type BudgetCaps = {
  globalDailyTokens: number
  workspaceDailyTokens: number
  maxOutputTokens: number
  maxSteps: number
}

export type Usage = { calls: number; tokensIn: number; tokensOut: number }

const EMPTY: Usage = { calls: 0, tokensIn: 0, tokensOut: 0 }

/** A provider usage field may be a number or `{ total }`. Anything else counts as zero. */
export function usageTokens(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value))
  if (value && typeof value === 'object' && 'total' in value) {
    const total = (value as { total?: unknown }).total
    if (typeof total === 'number' && Number.isFinite(total)) return Math.max(0, Math.floor(total))
  }
  return 0
}

export type BudgetStore = {
  read(day: string, workspaceId: string): Usage | null
  write(day: string, workspaceId: string, usage: Usage): void
  killed(): boolean
  setKilled(killed: boolean): void
}

/** Daily counters and the kill switch on the ledger database, so a restart keeps them. */
export function sqliteBudgetStore(db: DatabaseSync): BudgetStore {
  db.exec(`CREATE TABLE IF NOT EXISTS model_budget (
    day TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    calls INTEGER NOT NULL,
    tokens_in INTEGER NOT NULL,
    tokens_out INTEGER NOT NULL,
    PRIMARY KEY (day, workspace_id)
  );
  CREATE TABLE IF NOT EXISTS model_budget_kill (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    killed INTEGER NOT NULL
  );`)
  const read = db.prepare('SELECT calls, tokens_in, tokens_out FROM model_budget WHERE day = ? AND workspace_id = ?')
  const write = db.prepare(`INSERT INTO model_budget (day, workspace_id, calls, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (day, workspace_id) DO UPDATE SET calls = excluded.calls, tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out`)
  const readKill = db.prepare('SELECT killed FROM model_budget_kill WHERE id = 1')
  const writeKill = db.prepare('INSERT INTO model_budget_kill (id, killed) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET killed = excluded.killed')
  return {
    read(day, workspaceId) {
      const row = read.get(day, workspaceId) as { calls: number; tokens_in: number; tokens_out: number } | undefined
      return row ? { calls: row.calls, tokensIn: row.tokens_in, tokensOut: row.tokens_out } : null
    },
    write(day, workspaceId, usage) {
      write.run(day, workspaceId, usage.calls, usage.tokensIn, usage.tokensOut)
    },
    killed() {
      const row = readKill.get() as { killed: number } | undefined
      return row?.killed === 1
    },
    setKilled(killed) {
      writeKill.run(killed ? 1 : 0)
    },
  }
}

/**
 * Counts model calls before they happen. A cap of 0 refuses every call. Tests pass a spy model and assert it is never asked.
 * `reserve` holds a 500 token estimate. `correct` replaces that estimate with the provider's real usage.
 * Quick asks do not come through here.
 */
export class ModelBudget {
  private killed = false
  private pending = 0
  private readonly days = new Map<string, Usage>()
  warned = false

  constructor(
    private readonly caps: BudgetCaps,
    private readonly now: () => Date = () => new Date(),
    private readonly workspaceId = 'ws_default',
    private readonly store: BudgetStore | null = null,
  ) {
    this.killed = store?.killed() ?? false
  }

  /** Ops kill switch. Survives a restart when a store is attached. */
  kill(): void {
    this.killed = true
    this.store?.setKilled(true)
  }

  /** Clears an ops kill, including the stored row. The next process is not stuck. */
  resume(): void {
    this.killed = false
    this.store?.setKilled(false)
  }

  /** This process only. Used when the model flag is off, so a later boot with the flag on is not stuck. */
  pause(): void {
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
    this.pending += estimate
    this.touch(usage)
    const spent = usage.tokensIn + usage.tokensOut
    const cap = Math.min(this.caps.globalDailyTokens, this.caps.workspaceDailyTokens)
    if (!this.warned && cap > 0 && spent / cap >= 0.8) this.warned = true
    return null
  }

  /**
   * Replaces one reserved estimate with the provider's real input and output totals.
   * A 0/0 report keeps the estimate, so a missing usage field cannot wipe the counter.
   */
  correct(actualIn: number, actualOut: number): void {
    const inn = Math.max(0, Math.floor(actualIn))
    const out = Math.max(0, Math.floor(actualOut))
    if (inn === 0 && out === 0) return
    const usage = this.usage()
    const estimate = Math.min(this.pending, Math.min(500, this.caps.maxOutputTokens))
    usage.tokensOut = Math.max(0, usage.tokensOut - estimate)
    this.pending -= estimate
    usage.tokensIn += inn
    usage.tokensOut += out
    this.touch(usage)
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
    const stored = this.store?.read(day, this.workspaceId)
    const created = stored ? { ...stored } : { ...EMPTY }
    this.days.set(key, created)
    return created
  }

  private touch(usage: Usage): void {
    const day = this.now().toISOString().slice(0, 10)
    this.store?.write(day, this.workspaceId, usage)
  }
}

export const OPEN_CAPS: BudgetCaps = {
  globalDailyTokens: 500_000,
  workspaceDailyTokens: 30_000,
  maxOutputTokens: 4096,
  maxSteps: 8,
}

function tokenCap(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) return fallback
  return parsed
}

/** Defaults are the public-demo caps. A higher number is an env var, not a code change. */
export function capsFromEnv(env: NodeJS.ProcessEnv): BudgetCaps {
  return {
    globalDailyTokens: tokenCap(env.MODEL_GLOBAL_DAILY_TOKENS, OPEN_CAPS.globalDailyTokens),
    workspaceDailyTokens: tokenCap(env.MODEL_WORKSPACE_DAILY_TOKENS, OPEN_CAPS.workspaceDailyTokens),
    maxOutputTokens: OPEN_CAPS.maxOutputTokens,
    maxSteps: OPEN_CAPS.maxSteps,
  }
}
