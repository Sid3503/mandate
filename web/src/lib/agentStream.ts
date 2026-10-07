/**
 * The live picture of an AI run, built from the events the server sends: each tool call (announced, called with its
 * arguments, answered with its time) and the model's words as they are written. It is a plain reducer, so the same
 * code draws the clerk, the reviewer and the negotiators.
 *
 * A model can reuse a tool call id from one step to the next, so a call is matched to the most recent UNFINISHED call
 * with that id, and every call gets its own key.
 */
export type ToolCallView = {
  key: string
  id: string
  tool: string
  status: 'preparing' | 'running' | 'ok' | 'error'
  source: 'model' | 'code'
  input?: unknown
  output?: unknown
  ms?: number
  note?: string
  startedAt: number
}

export type RetractReason = 'money_claim' | 'unsupported_amount'

export type StreamState = { calls: ToolCallView[]; text: string; retracted: RetractReason | null; seq: number }
export const emptyStream: StreamState = { calls: [], text: '', retracted: null, seq: 0 }

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'retract'; reason: RetractReason }
  | { type: 'tool_start'; id: string; tool: string; source?: 'model' | 'code' }
  | { type: 'tool_call'; id: string; tool: string; input?: unknown; source?: 'model' | 'code' }
  | { type: 'tool_end'; id: string; tool: string; ok: boolean; output?: unknown; ms?: number; note?: string; source?: 'model' | 'code' }

const open = (call: ToolCallView) => call.status === 'preparing' || call.status === 'running'

export function reduceStream(state: StreamState, event: StreamEvent, now = Date.now()): StreamState {
  switch (event.type) {
    case 'text':
      return state.retracted ? state : { ...state, text: state.text + event.delta }
    case 'retract':
      return { ...state, text: '', retracted: event.reason }
    case 'tool_start':
      return { ...state, seq: state.seq + 1, calls: [...state.calls, { key: `${state.seq + 1}:${event.id}`, id: event.id, tool: event.tool, status: 'preparing', source: event.source ?? 'model', startedAt: now }] }
    case 'tool_call': {
      const index = findOpen(state.calls, event.id)
      if (index === -1) return { ...state, seq: state.seq + 1, calls: [...state.calls, { key: `${state.seq + 1}:${event.id}`, id: event.id, tool: event.tool, status: 'running', source: event.source ?? 'model', input: event.input, startedAt: now }] }
      return { ...state, calls: state.calls.map((call, i) => (i === index ? { ...call, status: 'running', input: event.input } : call)) }
    }
    case 'tool_end': {
      const index = findOpen(state.calls, event.id)
      const finished = event.ok ? 'ok' : 'error'
      if (index === -1) return { ...state, seq: state.seq + 1, calls: [...state.calls, { key: `${state.seq + 1}:${event.id}`, id: event.id, tool: event.tool, status: finished, source: event.source ?? 'model', output: event.output, ms: event.ms, note: event.note, startedAt: now }] }
      return { ...state, calls: state.calls.map((call, i) => (i === index ? { ...call, status: finished, output: event.output, ms: event.ms, note: event.note } : call)) }
    }
  }
}

function findOpen(calls: ToolCallView[], id: string): number {
  for (let i = calls.length - 1; i >= 0; i -= 1) if (calls[i]!.id === id && open(calls[i]!)) return i
  return -1
}

/** The reviewer's events arrive on the console's live stream in a slightly different shape. */
export function fromAgentCall(call: { phase: 'start' | 'call' | 'end'; id: string; tool: string; source: 'code' | 'model'; input?: unknown; ok?: boolean; ms?: number; note?: string }): StreamEvent {
  if (call.phase === 'start') return { type: 'tool_start', id: call.id, tool: call.tool, source: call.source }
  if (call.phase === 'call') return { type: 'tool_call', id: call.id, tool: call.tool, input: call.input, source: call.source }
  return { type: 'tool_end', id: call.id, tool: call.tool, ok: call.ok !== false, ms: call.ms, note: call.note, source: call.source }
}
