import type { RulesDraft, Warrant } from './types'

/**
 * Unpublished work on the rules, kept for this browser tab so that leaving the screen, reloading or a dropped
 * connection never loses what the owner was writing. It is only ever a draft: nothing here is live, signed or
 * sent anywhere until the owner publishes, and the server refuses a publish that started from an old version.
 */
export type RulesBody = Omit<Warrant, 'id' | 'version' | 'createdAt'>
export type RulesWip = {
  /** The live version this work started from. If the rules move on, the work is stale and is set aside. */
  baseVersion: number
  instruction: string
  result: RulesDraft | null
  /** The editor's fields, once the owner opened the editor. */
  body: RulesBody | null
  at: number
}

const KEY = 'mandate.rules.wip'

export const wip = {
  read(): RulesWip | null {
    try {
      const raw = sessionStorage.getItem(KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as RulesWip
      return typeof parsed.baseVersion === 'number' ? parsed : null
    } catch {
      return null
    }
  },
  write(next: RulesWip | null): void {
    try {
      if (!next || (!next.body && !next.result && next.instruction.trim() === '')) sessionStorage.removeItem(KEY)
      else sessionStorage.setItem(KEY, JSON.stringify({ ...next, at: Date.now() }))
    } catch {
      // Storage can be full or blocked; the draft then lives only on screen, as before.
    }
  },
  clear(): void {
    try {
      sessionStorage.removeItem(KEY)
    } catch {
      // Nothing to clear.
    }
  },
}
