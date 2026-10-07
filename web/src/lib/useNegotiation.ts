import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, type NegotiationEvent } from './api'
import { reduceStream, type ToolCallView } from './agentStream'
import type { Deal } from './types'

export type Seat = 'seller' | 'buyer'
export type LiveTurn =
  | { turn: number; side: Seat; status: 'thinking'; startedAt: number; calls: ToolCallView[] }
  | { turn: number; side: Seat; status: 'offered'; deal: Deal; ms: number; calls: ToolCallView[] }
  | { turn: number; side: Seat; status: 'failed'; error: string }

export type Negotiation = {
  phase: 'idle' | 'running' | 'done' | 'stopped' | 'failed'
  studio: string
  client: string
  model: string
  maxOffers: number
  turns: LiveTurn[]
  agreedDealId: string | null
  error: unknown
  /** Milliseconds since the run began. Ticks while running, so the screen shows life even while a model thinks. */
  elapsedMs: number
}

const IDLE: Negotiation = { phase: 'idle', studio: 'Studio', client: 'Client', model: '', maxOffers: 4, turns: [], agreedDealId: null, error: null, elapsedMs: 0 }

/** Runs a negotiation and keeps a live picture of it: who is thinking, each offer, the verdict, the end. */
export function useNegotiation(onFinished: () => void) {
  const [state, setState] = useState<Negotiation>(IDLE)
  const controller = useRef<AbortController | null>(null)
  const started = useRef(0)
  const finished = useRef(onFinished)
  finished.current = onFinished

  useEffect(() => {
    if (state.phase !== 'running') return
    const timer = window.setInterval(() => setState((current) => (current.phase === 'running' ? { ...current, elapsedMs: Date.now() - started.current } : current)), 250)
    return () => window.clearInterval(timer)
  }, [state.phase])

  useEffect(() => () => controller.current?.abort(), [])

  const apply = useCallback((event: NegotiationEvent) => {
    setState((current) => {
      switch (event.type) {
        case 'start': return { ...current, studio: event.studio, client: event.client, model: event.model, maxOffers: event.maxOffers }
        case 'turn_start': return { ...current, turns: [...current.turns, { turn: event.turn, side: event.side, status: 'thinking', startedAt: Date.now(), calls: [] }] }
        case 'turn': return { ...current, turns: current.turns.map((item) => (item.turn === event.turn ? { turn: event.turn, side: event.side, status: 'offered', deal: event.deal, ms: event.ms, calls: item.status === 'thinking' ? item.calls : [] } : item)) }
        case 'turn_tool': return { ...current, turns: current.turns.map((item) => {
          if (item.turn !== event.turn || item.status !== 'thinking') return item
          const mapped = event.phase === 'start' ? { type: 'tool_start' as const, id: event.id, tool: event.tool } : event.phase === 'call' ? { type: 'tool_call' as const, id: event.id, tool: event.tool, input: event.input } : { type: 'tool_end' as const, id: event.id, tool: event.tool, ok: event.ok !== false, ms: event.ms }
          return { ...item, calls: reduceStream({ calls: item.calls, text: '', retracted: null, seq: item.calls.length }, mapped).calls }
        }) }
        case 'turn_error': return { ...current, turns: current.turns.map((item) => (item.turn === event.turn ? { turn: event.turn, side: event.side, status: 'failed', error: event.error } : item)) }
        case 'done': return { ...current, phase: event.stopped ? 'stopped' : 'done', agreedDealId: event.dealId, elapsedMs: Date.now() - started.current }
        case 'error': return { ...current, phase: 'failed', error: new ApiError(0, event.code, event.message, event.message, {}) }
      }
    })
  }, [])

  const start = useCallback(async () => {
    controller.current?.abort()
    const next = new AbortController()
    controller.current = next
    started.current = Date.now()
    setState({ ...IDLE, phase: 'running' })
    try {
      await api.streamNegotiation(apply, next.signal)
      setState((current) => (current.phase === 'running' ? { ...current, phase: next.signal.aborted ? 'stopped' : 'done' } : current))
    } catch (error) {
      setState((current) => ({ ...current, phase: 'failed', error }))
    } finally {
      finished.current()
    }
  }, [apply])

  const stop = useCallback(() => {
    controller.current?.abort()
    setState((current) => (current.phase === 'running' ? { ...current, phase: 'stopped' } : current))
  }, [])

  const reset = useCallback(() => setState(IDLE), [])
  return { state, start, stop, reset }
}
