import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * A tiny in-process bus so the console hears about a change the moment it is written, instead of asking again every
 * few seconds. It carries no secrets and no authority: an event only says WHAT changed (a kind, an id, a status), and
 * the console then re-reads the real thing through the normal, authorised routes.
 *
 * One process hosts many studios, so the bus is split by studio. A write does not say which studio it belongs to (the
 * ledger code publishes without one), so the studio comes from the work that is running: every request a studio's app
 * serves, and every background sweep of a studio, runs inside `inWorkspace(id, ...)`, and a publish is stamped with the
 * studio of whatever work made it. A listener only hears its own studio. Work that runs outside any studio's scope is
 * the default studio's, which is what the single-studio server has always been.
 */
export type LiveEvent =
  | { type: 'changed'; scope: 'ledger' | 'delivery' | 'deal' | 'rules' | 'safety' | 'agents'; what: string; id?: string; dealId?: string; milestone?: number; at: string }
  | { type: 'agent'; agent: 'reviewer'; dealId: string; milestone: number; call: { phase: 'start' | 'call' | 'end'; id: string; tool: string; source: 'code' | 'model'; input?: unknown; ok?: boolean; ms?: number; note?: string }; at: string }
  | { type: 'review'; stage: 'started' | 'decided' | 'failed'; dealId: string; milestone: number; model?: string; decision?: 'accepted' | 'rejected'; note?: string | null; ms?: number; at: string }

type Listener = (event: LiveEvent) => void

export const DEFAULT_WORKSPACE = 'ws_default'

const scope = new AsyncLocalStorage<string>()

/** Runs `fn` as work of studio `workspaceId`: anything it publishes, now or later in the same async chain, is that studio's. */
export function inWorkspace<T>(workspaceId: string, fn: () => T): T {
  return scope.run(workspaceId, fn)
}

/** The studio whose work is running now. Outside any studio's scope it is the default studio. */
export function currentWorkspace(): string {
  return scope.getStore() ?? DEFAULT_WORKSPACE
}

const listeners = new Map<Listener, string>()

export const live = {
  publish(event: LiveEvent, workspaceId: string = currentWorkspace()) {
    for (const [listener, wanted] of listeners) {
      if (wanted !== workspaceId) continue
      try {
        listener(event)
      } catch {
        // One broken connection never blocks a write.
      }
    }
  },
  /** Hears the events of one studio only. Leaving it out means the default studio. */
  subscribe(listener: Listener, workspaceId: string = DEFAULT_WORKSPACE): () => void {
    listeners.set(listener, workspaceId)
    return () => listeners.delete(listener)
  },
  count: () => listeners.size,
}

export const stamp = () => new Date().toISOString()
