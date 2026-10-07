import { useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useToast } from '../components/Toast'
import { emptyStream, fromAgentCall, reduceStream, type StreamState } from './agentStream'
import { session } from './session'

/** What the server said about the client's agent reviewing a delivery, as it happened. */
export type ReviewState = {
  stage: 'started' | 'decided' | 'failed'
  startedAt: number
  at: number
  model?: string
  decision?: 'accepted' | 'rejected'
  note?: string | null
  ms?: number
  /** The client agent's tool calls, as they happen. */
  stream: StreamState
}

type Live = { connected: boolean; reviews: Record<string, ReviewState> }
const LiveContext = createContext<Live>({ connected: false, reviews: {} })

export const reviewKey = (dealId: string, milestone: number) => `${dealId}:${milestone}`
export const useLive = () => useContext(LiveContext)

type ServerEvent =
  | { type: 'changed'; scope: 'ledger' | 'delivery' | 'deal' | 'rules' | 'safety'; what: string; id?: string; dealId?: string; milestone?: number }
  | { type: 'review'; stage: 'started' | 'decided' | 'failed'; dealId: string; milestone: number; model?: string; decision?: 'accepted' | 'rejected'; note?: string | null; ms?: number }
  | { type: 'agent'; agent: 'reviewer'; dealId: string; milestone: number; call: { phase: 'start' | 'call' | 'end'; id: string; tool: string; source: 'code' | 'model'; input?: unknown; ok?: boolean; ms?: number; note?: string } }
  | { type: 'hello' }

const KEYS: Record<string, string[][]> = {
  ledger: [['proposals'], ['today'], ['packet'], ['job'], ['ledger'], ['deals'], ['audit']],
  delivery: [['today'], ['deals'], ['proposals'], ['job']],
  deal: [['today'], ['deals'], ['job']],
  rules: [['warrant'], ['versions'], ['today'], ['party-rules']],
  safety: [['status'], ['safety'], ['today'], ['proposals'], ['audit'], ['deals']],
}

/**
 * Keeps the console current without anyone reloading it. The server pushes a small event whenever something is
 * written (a delivery, a decision, an invoice, a settlement); each event re-reads the affected screens through the
 * normal routes. Polling stays as the fallback, so a dropped connection costs seconds, not correctness.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const wasUp = useRef<boolean | null>(null)
  const [connected, setConnected] = useState(false)
  const [reviews, setReviews] = useState<Record<string, ReviewState>>({})

  useEffect(() => {
    const key = session.get()
    if (!key) return
    const abort = new AbortController()
    let pending = new Set<string>()
    let timer: number | undefined
    const flush = () => {
      timer = undefined
      const keys = pending
      pending = new Set()
      for (const item of keys) void client.invalidateQueries({ queryKey: JSON.parse(item) as string[] })
    }
    const refresh = (scope: string) => {
      for (const item of KEYS[scope] ?? []) pending.add(JSON.stringify(item))
      if (timer === undefined) timer = window.setTimeout(flush, 120)
    }

    const handle = (event: ServerEvent) => {
      if (event.type === 'hello') return
      if (event.type === 'agent') {
        setReviews((current) => {
          const id = reviewKey(event.dealId, event.milestone)
          const now = Date.now()
          const before = current[id] ?? { stage: 'started' as const, startedAt: now, at: now, stream: emptyStream }
          return { ...current, [id]: { ...before, at: now, stream: reduceStream(before.stream, fromAgentCall(event.call), now) } }
        })
        return
      }
      if (event.type === 'review') {
        setReviews((current) => {
          const id = reviewKey(event.dealId, event.milestone)
          const now = Date.now()
          const before = current[id]
          return { ...current, [id]: { stage: event.stage, startedAt: event.stage === 'started' ? now : before?.startedAt ?? now, at: now, model: event.model ?? before?.model, decision: event.decision, note: event.note, ms: event.ms, stream: event.stage === 'started' ? emptyStream : before?.stream ?? emptyStream } }
        })
        if (event.stage === 'decided') {
          toastRef.current(event.decision === 'accepted'
            ? { title: 'The client’s agent accepted the delivery', body: 'Signed. The invoice goes out under your rule, with no tap.' }
            : { title: 'The client’s agent rejected the delivery', body: event.note ?? 'Nothing was billed.', tone: 'bad' })
        }
        refresh('delivery')
        return
      }
      if (event.what === 'safety.paused') toastRef.current({ title: 'Mandate is paused', body: 'Nothing automatic runs and agents are refused until the owner resumes it.', tone: 'warn', key: 'safety', ms: 9000 })
      else if (event.what === 'safety.resumed') toastRef.current({ title: 'Mandate is running again', body: 'The autopilot caught up on what it was told to wait for.', key: 'safety' })
      else if (event.what === 'capture.completed') toastRef.current({ title: 'Money in', body: 'PayPal confirmed the payment. The receipt is settled.' })
      else if (event.what === 'payout.completed') toastRef.current({ title: 'Payout complete', body: 'PayPal confirmed the money reached the contractor.' })
      else if (event.what === 'invoice.sent') toastRef.current({ title: 'Invoice sent', body: 'PayPal emailed it to the client. It settles only when PayPal says it was paid.', tone: 'info' })
      refresh(event.scope)
    }

    const run = async () => {
      let wait = 1000
      while (!abort.signal.aborted) {
        try {
          const response = await fetch('/v1/stream', { headers: { accept: 'text/event-stream', authorization: `Bearer ${key}` }, cache: 'no-store', signal: abort.signal })
          if (response.status === 401 || response.status === 403) return
          if (!response.ok || !response.body) throw new Error(String(response.status))
          if (wasUp.current === false) toastRef.current({ title: 'Live again', body: 'Updates are arriving the moment they happen.', key: 'live', ms: 3200 })
          wasUp.current = true
          setConnected(true)
          wait = 1000
          // Anything that happened while we were not listening.
          for (const scope of Object.keys(KEYS)) refresh(scope)
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let split = buffer.indexOf('\n\n')
            while (split !== -1) {
              const block = buffer.slice(0, split)
              buffer = buffer.slice(split + 2)
              const data = /^data: (.*)$/m.exec(block)?.[1]
              if (data && data !== '{}') {
                try { handle(JSON.parse(data) as ServerEvent) } catch { /* a malformed event is ignored */ }
              }
              split = buffer.indexOf('\n\n')
            }
          }
        } catch {
          if (abort.signal.aborted) return
        }
        if (wasUp.current) toastRef.current({ title: 'Live updates paused', body: 'Reconnecting. The page still refreshes every few seconds.', tone: 'warn', key: 'live' })
        wasUp.current = false
        setConnected(false)
        await new Promise((resolve) => window.setTimeout(resolve, wait))
        wait = Math.min(wait * 2, 10_000)
      }
    }
    void run()
    return () => {
      abort.abort()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [client])

  const value = useMemo(() => ({ connected, reviews }), [connected, reviews])
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}
