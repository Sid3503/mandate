/**
 * A tiny in-process bus so the console hears about a change the moment it is written, instead of asking again every
 * few seconds. It carries no secrets and no authority: an event only says WHAT changed (a kind, an id, a status), and
 * the console then re-reads the real thing through the normal, authorised routes.
 */
export type LiveEvent =
  | { type: 'changed'; scope: 'ledger' | 'delivery' | 'deal' | 'rules' | 'safety'; what: string; id?: string; dealId?: string; milestone?: number; at: string }
  | { type: 'agent'; agent: 'reviewer'; dealId: string; milestone: number; call: { phase: 'start' | 'call' | 'end'; id: string; tool: string; source: 'code' | 'model'; input?: unknown; ok?: boolean; ms?: number; note?: string }; at: string }
  | { type: 'review'; stage: 'started' | 'decided' | 'failed'; dealId: string; milestone: number; model?: string; decision?: 'accepted' | 'rejected'; note?: string | null; ms?: number; at: string }

type Listener = (event: LiveEvent) => void

const listeners = new Set<Listener>()

export const live = {
  publish(event: LiveEvent) {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        // One broken connection never blocks a write.
      }
    }
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  count: () => listeners.size,
}

export const stamp = () => new Date().toISOString()
