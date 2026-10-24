import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, type NegotiationEvent, type NegotiationRequest } from './api'
import { reduceStream, type ToolCallView } from './agentStream'
import type { Deal, NegotiationDebrief, NegotiationView } from './types'

export type Seat = 'seller' | 'buyer'
export type MoveAction = 'offer' | 'accept' | 'walk_away'
export type LiveTurn =
  | { turn: number; side: Seat; status: 'thinking'; startedAt: number; calls: ToolCallView[] }
  | { turn: number; side: Seat; status: 'moved'; action: MoveAction; deal: Deal | null; totalCents: number | null; message: string | null; final: boolean; assessment: string | null; ms: number; calls: ToolCallView[] }
  | { turn: number; side: Seat; status: 'failed'; error: string; detail: string | null }

export type Negotiation = {
  phase: 'idle' | 'running' | 'done' | 'stopped' | 'failed'
  threadId: string | null
  studio: string
  client: string
  scope: string
  currency: string
  model: string
  offersPerSide: number
  /** Who speaks for each seat: Mandate's negotiator, or the client itself. */
  seats: { seller: 'agent' | 'client'; buyer: 'agent' | 'client' }
  turns: LiveTurn[]
  /** The side the run stopped to wait for: a client that negotiates for itself. */
  waitingFor: Seat | null
  debriefs: Partial<Record<Seat, NegotiationDebrief>>
  /** The negotiation as the server last told it, once the run is over: every move, how it ended, each visible outcome. */
  result: NegotiationView | null
  agreedDealId: string | null
  error: unknown
  /** Milliseconds since the run began. Ticks while running, so the screen shows life even while a model thinks. */
  elapsedMs: number
}

const IDLE: Negotiation = { phase: 'idle', threadId: null, studio: 'Studio', client: 'Client', scope: '', currency: 'USD', model: '', offersPerSide: 4, seats: { seller: 'agent', buyer: 'agent' }, turns: [], waitingFor: null, debriefs: {}, result: null, agreedDealId: null, error: null, elapsedMs: 0 }

/** Runs a negotiation and keeps a live picture of it: who is thinking, each move, the end, and each side's debrief. */
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
    setState((current): Negotiation => {
      switch (event.type) {
        case 'start': return { ...current, threadId: event.threadId, studio: event.studio, client: event.client, scope: event.scope, currency: event.currency, model: event.model, offersPerSide: event.offersPerSide, seats: event.seats }
        case 'turn_start': return { ...current, turns: [...current.turns, { turn: event.turn, side: event.side, status: 'thinking', startedAt: Date.now(), calls: [] }] }
        case 'turn': return {
          ...current,
          turns: current.turns.map((item) => (item.turn === event.turn
            ? { turn: event.turn, side: event.side, status: 'moved', action: event.action, deal: event.deal, totalCents: event.deal?.terms.totalCents ?? null, message: event.message, final: event.final, assessment: event.assessment, ms: event.ms, calls: item.status === 'thinking' ? item.calls : [] }
            : item)),
        }
        case 'turn_tool': return { ...current, turns: current.turns.map((item) => {
          if (item.turn !== event.turn || item.status !== 'thinking') return item
          const mapped = event.phase === 'start' ? { type: 'tool_start' as const, id: event.id, tool: event.tool } : event.phase === 'call' ? { type: 'tool_call' as const, id: event.id, tool: event.tool, input: event.input } : { type: 'tool_end' as const, id: event.id, tool: event.tool, ok: event.ok !== false, ms: event.ms, output: event.output }
          return { ...item, calls: reduceStream({ calls: item.calls, text: '', retracted: null, seq: item.calls.length }, mapped).calls }
        }) }
        case 'turn_error': return { ...current, turns: current.turns.map((item) => (item.turn === event.turn ? { turn: event.turn, side: event.side, status: 'failed', error: event.error, detail: event.detail } : item)) }
        case 'waiting': return { ...current, waitingFor: event.side }
        case 'debrief': return { ...current, debriefs: { ...current.debriefs, [event.side]: event.debrief } }
        case 'done': return { ...current, phase: event.stopped ? 'stopped' : 'done', agreedDealId: event.dealId, result: event.negotiation, elapsedMs: Date.now() - started.current }
        case 'error': return { ...current, phase: 'failed', error: new ApiError(0, event.code, event.message, event.message, {}) }
      }
    })
  }, [])

  const start = useCallback(async (request: NegotiationRequest = {}) => {
    controller.current?.abort()
    const next = new AbortController()
    controller.current = next
    started.current = Date.now()
    setState({ ...IDLE, phase: 'running' })
    try {
      await api.streamNegotiation(apply, next.signal, request)
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
