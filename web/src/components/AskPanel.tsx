import { useMutation } from '@tanstack/react-query'
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Chip, GateChip, Money, ProblemCard } from './ui'
import { Settle, StreamText } from './StreamText'
import { ToolTrail } from './ToolTrail'
import { emptyStream, reduceStream, type StreamEvent, type StreamState } from '../lib/agentStream'
import { useToast } from './Toast'
import { api, ApiError } from '../lib/api'
import { useAgentsOn, useOnline, useProposals, useNames, useRefreshMoney, useSession } from '../lib/hooks'
import { dollars } from '../lib/money'
import type { AskRoute, ClerkReply, QuickId } from '../lib/types'

type Outcome = { proposalId: string; decision: 'DENY' | 'AUTO' | 'NEEDS_APPROVAL'; ruleCode: string; amount: string; inPlainWords: string; moneyMoved: string; whatWouldPass?: string[] }

type Turn = {
  id: string
  user: string
  pending: boolean
  route?: AskRoute
  stream: StreamState
  cards: Outcome[]
  reply?: ClerkReply
  error?: unknown
  handoff?: boolean
}

const QUICK: Array<{ id: QuickId; label: string }> = [
  { id: 'waiting', label: 'What is waiting for me?' },
  { id: 'inflight', label: 'What is in flight?' },
  { id: 'ready', label: 'What can I bill?' },
  { id: 'refused', label: 'What was refused?' },
  { id: 'month', label: 'This month' },
  { id: 'done', label: 'What was done for me?' },
  { id: 'autopilot', label: 'Is autopilot on?' },
]

const GO: Array<{ label: string; to: string; words: string }> = [
  { label: 'Today', to: '/', words: 'today home waiting' },
  { label: 'Jobs', to: '/jobs', words: 'jobs money in out kept' },
  { label: 'Deals', to: '/deals', words: 'deals negotiate agree' },
  { label: 'Rules', to: '/rules', words: 'rules standing autopilot cap limit draft' },
  { label: 'Ledger', to: '/ledger', words: 'ledger history events requests' },
  { label: 'Proof', to: '/proof', words: 'proof audit verify check ledger' },
  { label: 'Verify a receipt', to: '/verify', words: 'verify receipt signature check browser' },
  { label: 'System', to: '/system', words: 'system paypal features tools balance disputes' },
  { label: 'New request form', to: '/new', words: 'new request form pay bill refund' },
]


/**
 * Ask Mandate, in one place. The Ask dialog and the Ask screen both render this.
 *
 * A sentence takes one of four roads, chosen by code on the server before any model is involved:
 *   an answer from the ledger (no model, no key), a card with a button for the owner to press, a hand-off to the rules
 *   drafter, or the clerk, whose steps and whose rules-answer appear as they happen. The model never gets more power
 *   on any of them: it can ask, and a person presses the button that does anything.
 */
export function AskPanel({ examples = [], autoFocus = false, placeholder = 'Say what you want done…', tour = false, initial, context, onLeave }: {
  examples?: string[]
  autoFocus?: boolean
  placeholder?: string
  tour?: boolean
  initial?: string
  context?: { jobId?: string; proposalId?: string }
  /** Called when a road leaves the panel (the drafter hand-off, a link), so a dialog can close itself. */
  onLeave?: () => void
}) {
  const session = useSession()
  const agents = useAgentsOn()
  const online = useOnline()
  const refresh = useRefreshMoney()
  const toast = useToast()
  const navigate = useNavigate()
  const proposals = useProposals()
  const names = useNames()
  const [turns, setTurns] = useState<Turn[]>([])
  const [text, setText] = useState('')
  const [picked, setPicked] = useState(-1)
  const [conversation, setConversation] = useState<string | undefined>()
  const end = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const inputId = useId()
  const sent = useRef<string | undefined>(undefined)
  const busy = turns.some((turn) => turn.pending)

  const patch = (id: string, change: Partial<Turn>) => setTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, ...change } : turn)))

  const ask = async (message: string, quick?: QuickId) => {
    const id = crypto.randomUUID()
    setTurns((current) => [...current, { id, user: message, pending: true, stream: emptyStream, cards: [] }])
    try {
      const route = await api.ask(quick ? { quick } : { message, context: context?.jobId ? { jobId: context.jobId } : undefined })
      if (route.kind === 'answer' || route.kind === 'action') return patch(id, { pending: false, route })
      if (route.kind === 'handoff') {
        patch(id, { pending: false, route, handoff: true })
        navigate('/rules', { state: { draft: route.text } })
        onLeave?.()
        return
      }
      if (!agents) return patch(id, { pending: false, error: new ApiError(503, 'agents.unconfigured', 'No language model is configured', 'Questions about the ledger work without one (try “What is waiting for me?”). To ask the clerk to file a request, set BEDROCK_API_KEY.', {}) })
      patch(id, { route })
      await api.streamClerk({ message, conversationId: conversation, context }, (event) => {
        if (event.type === 'step') {
          // The rules' own answer, as soon as the tool returns it, before the model has finished talking.
          setTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, cards: [...turn.cards, ...event.outcomes.map((item) => item as Outcome)] } : turn)))
        } else if (event.type === 'retract') {
          toast({ title: 'Took back a reply', body: 'The words claimed something the rules did not say. Only the rules\' answer stands.', tone: 'warn', key: 'retract' })
          setTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, stream: reduceStream(turn.stream, event as StreamEvent) } : turn)))
        } else if (event.type === 'text' || event.type === 'tool_start' || event.type === 'tool_call' || event.type === 'tool_end') {
          setTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, stream: reduceStream(turn.stream, event as StreamEvent) } : turn)))
        } else if (event.type === 'done') {
          setConversation(event.reply.conversationId)
          patch(id, { pending: false, reply: event.reply })
          const first = event.reply.outcomes.find((item) => item.tool === 'propose' && item.ok)?.data as { decision?: string; ruleCode?: string; amount?: string } | undefined
          if (first?.decision === 'NEEDS_APPROVAL') toast({ title: 'Waiting for your tap', body: `${first.amount} is at or above the no-tap line.`, tone: 'warn', action: { label: 'Review and approve', onClick: () => { navigate('/'); onLeave?.() } }, key: 'ask-outcome' })
          else if (first?.decision === 'AUTO') toast({ title: 'Inside your rules', body: `${first.amount} goes through with no tap.`, key: 'ask-outcome' })
          else if (first?.decision === 'DENY') toast({ title: 'Refused by the rules', body: `${first.ruleCode}. Nothing moved.`, tone: 'info', key: 'ask-outcome' })
          if (event.reply.fellBack) toast({ title: 'Answered by the backup model', body: 'The main model failed or is cooling off. The rules decided the same way.', tone: 'warn', key: 'fallback' })
          void refresh()
        } else if (event.type === 'error') {
          patch(id, { pending: false, error: new ApiError(502, event.code, 'The clerk could not finish', event.message, {}) })
        }
      })
    } catch (error) {
      patch(id, { pending: false, error })
    }
  }

  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' }) }, [turns])
  useEffect(() => { if (autoFocus) area.current?.focus() }, [autoFocus])
  useEffect(() => {
    if (initial && sent.current !== initial) { sent.current = initial; void ask(initial) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial])

  // The palette: things you can jump to, found as you type. It needs no model.
  const suggestions = useMemo(() => {
    const q = text.trim().toLowerCase()
    if (q.length < 2 || q.length > 40) return []
    const pages = GO.filter((item) => `${item.label} ${item.words}`.toLowerCase().includes(q)).map((item) => ({ key: `go:${item.to}`, label: `Go to ${item.label}`, to: item.to }))
    const receipts = (proposals.data?.data ?? [])
      .filter((row) => `${names(row.payeeId)} ${row.description} ${dollars(row.amountCents)} ${row.jobId ?? ''}`.toLowerCase().includes(q))
      .slice(0, 4)
      .map((row) => ({ key: `p:${row.id}`, label: `Receipt: ${row.kind === 'charge' ? 'bill' : row.kind === 'refund' ? 'refund' : 'pay'} ${names(row.payeeId)} ${dollars(row.amountCents)}`, to: `/p/${row.id}` }))
    return [...pages, ...receipts].slice(0, 6)
  }, [text, proposals.data, names])
  useEffect(() => setPicked(-1), [text])

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    const message = text.trim()
    if (!message || busy) return
    if (picked >= 0 && suggestions[picked]) {
      navigate(suggestions[picked]!.to)
      onLeave?.()
      return
    }
    setText('')
    void ask(message)
  }
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'ArrowDown' && suggestions.length > 0) { event.preventDefault(); setPicked((current) => Math.min(suggestions.length - 1, current + 1)) }
    else if (event.key === 'ArrowUp' && suggestions.length > 0) { event.preventDefault(); setPicked((current) => Math.max(-1, current - 1)) }
    else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit() }
  }

  return (
    <>
      {!agents && session.data ? (
        <div className="agents-off" role="status"><Chip tone="muted">no model</Chip> Questions about the ledger, and jumping around, work without a language model. To have the clerk file a request, set <span className="mono">BEDROCK_API_KEY</span>.</div>
      ) : null}
      <div className="log" aria-live="polite" {...(tour ? { 'data-tour': 'clerk-log' } : {})}>
        {turns.length === 0 ? (
          <div className="chat-empty">
            <p><strong>Say it in a sentence.</strong> Questions about your money are answered straight from the ledger. “The concepts are delivered” prepares a button for you. A pay or bill request goes to the clerk, and the rules answer.</p>
            <div className="chat-examples quick" role="group" aria-label="Quick questions">
              {QUICK.map((item) => <button key={item.id} type="button" className="example quick-chip" disabled={busy || !online} onClick={() => { void ask(item.label, item.id) }}>{item.label}</button>)}
            </div>
            {examples.length > 0 ? (
              <>
                <p className="fine">Or try one of these with the clerk. The rules, not the clerk, decide every answer.</p>
                <div className="chat-examples">
                  {examples.map((example) => <button key={example} type="button" className="example" disabled={busy || !online} onClick={() => { void ask(example) }}>{example}</button>)}
                </div>
              </>
            ) : null}
          </div>
        ) : turns.map((turn) => <Exchange key={turn.id} turn={turn} onLeave={onLeave} />)}
        <div ref={end} />
      </div>
      {suggestions.length > 0 ? (
        <ul className="palette" role="listbox" aria-label="Jump to">
          {suggestions.map((item, index) => (
            <li key={item.key} role="option" aria-selected={index === picked} className={index === picked ? 'on' : ''}>
              <button type="button" tabIndex={-1} onClick={() => { navigate(item.to); onLeave?.() }}>{item.label}</button>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="composer" onSubmit={submit}>
        <label className="sr-only" htmlFor={inputId}>Message to the clerk</label>
        <textarea ref={area} id={inputId} rows={2} value={text} maxLength={4000} placeholder={placeholder} onChange={(event) => setText(event.target.value)} onKeyDown={onKey} />
        <button type="submit" className="btn btn-ink" disabled={!online || !text.trim() || busy}>{busy ? 'Working…' : picked >= 0 ? 'Open' : 'Send'}</button>
      </form>
    </>
  )
}

function Exchange({ turn, onLeave }: { turn: Turn; onLeave?: () => void }) {
  const route = turn.route
  const reply = turn.reply
  return (
    <div className="exchange">
      <div className="bubble me"><span className="said">You</span>{turn.user}</div>
      {turn.pending && turn.stream.calls.length === 0 && turn.cards.length === 0 && !turn.stream.text ? <div className="bubble clerk thinking" role="status"><span className="said">Mandate</span><span className="dots" aria-label="Working on it"><i /><i /><i /></span></div> : null}
      {turn.error ? <div className="bubble clerk"><ProblemCard error={turn.error} /></div> : null}
      {turn.handoff ? <div className="bubble clerk"><span className="said">Mandate</span><p>That sounds like a change to the rules, not a payment, so I am handing it to the rules drafter. You will read exactly what it changes before anything is published.</p></div> : null}
      {route?.kind === 'answer' ? <AnswerCard route={route} onLeave={onLeave} /> : null}
      {route?.kind === 'action' ? <ActionCard route={route} /> : null}
      {turn.stream.calls.length > 0 || turn.cards.length > 0 || reply || turn.stream.text ? (
        <div className="bubble clerk">
          <span className="said">Clerk</span>
          <ToolTrail calls={turn.stream.calls} title="What the clerk did" live={turn.pending} />
          {turn.cards.map((card) => <ResultCard key={card.proposalId} card={card} />)}
          {turn.pending && turn.stream.text ? <StreamText text={turn.stream.text} streaming /> : null}
          {turn.pending && !turn.stream.text && turn.stream.calls.length > 0 && !turn.stream.calls.some((call) => call.status === 'preparing' || call.status === 'running') ? <p className="fine" role="status">Waiting for the clerk’s words…</p> : null}
          {turn.stream.retracted ? <p className="retract-note" role="status">Taken back: those words {turn.stream.retracted === 'money_claim' ? 'claimed money had moved, which the clerk can never know' : 'stated a figure nobody supplied'}. Only the rules’ answer stands.</p> : null}
          {reply ? (
            <Settle id={reply.runId}>
              <p>{reply.reply}</p>
              {reply.guarded ? <p className="fine guard">The clerk’s own words were replaced with the rules’ answer, because they claimed something the rules did not say.</p> : null}
              <p className="fine">{reply.tools.length} tool call{reply.tools.length === 1 ? '' : 's'} · {(reply.ms / 1000).toFixed(1)}s · <span className="mono">{reply.model}</span>{reply.fellBack ? ' · answered by the fallback model' : ''}</p>
            </Settle>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** The rules' own answer to a request, shown before the model has finished talking. */
function ResultCard({ card }: { card: Outcome }) {
  return (
    <div className="asked result-card">
      <div className="row gap-s wrap">
        <GateChip gate={card.decision} />
        <code>{card.ruleCode}</code>
        <span>{card.amount}</span>
        <Link className="link" to={`/p/${card.proposalId}`}>Open receipt →</Link>
        {card.decision === 'NEEDS_APPROVAL' ? <Link className="btn btn-lime btn-small" to="/">Review and approve</Link> : null}
        {card.decision === 'DENY' ? <span className="muted">$0 moved</span> : null}
      </div>
      <p className="fine">{card.inPlainWords}</p>
      {card.whatWouldPass && card.whatWouldPass.length > 0 ? (
        <div className="would-pass">
          <strong>What would pass</strong>
          <ul>{card.whatWouldPass.map((line) => <li key={line}>{line}</li>)}</ul>
        </div>
      ) : null}
    </div>
  )
}

function AnswerCard({ route, onLeave }: { route: Extract<AskRoute, { kind: 'answer' }>; onLeave?: () => void }) {
  return (
    <div className="bubble clerk answer-card">
      <span className="said">From the ledger · no model</span>
      <p><strong>{route.title}</strong></p>
      {route.lines.length > 0 ? <ul className="answer-lines">{route.lines.map((line, index) => <li key={index}>{line}</li>)}</ul> : null}
      <div className="row gap-s wrap">{route.links.map((link) => <Link key={link.to} className="link" to={link.to} onClick={onLeave}>{link.label} →</Link>)}</div>
    </div>
  )
}

/** "The work is delivered": the app prepares the card; the owner presses the button. The model is not involved. */
function ActionCard({ route }: { route: Extract<AskRoute, { kind: 'action' }> }) {
  const owner = useSession().data?.role === 'owner'
  const online = useOnline()
  const refresh = useRefreshMoney()
  const toast = useToast()
  const [link, setLink] = useState(route.proofUrl ?? '')
  const [done, setDone] = useState<Record<string, string>>({})
  const deliver = useMutation({
    mutationFn: (choice: { dealId: string; milestone: number }) => api.deliverMilestone(choice.dealId, choice.milestone, link.trim()),
    onSuccess: (made, choice) => {
      const line = made.mode === 'awaiting' ? 'Sent to the client to accept. Nothing is billed until their agent accepts.' : made.charge.gate === 'DENY' ? `Refused: ${made.charge.clause}. Nothing was billed.` : made.charge.phase === 'invoice_sent' ? 'Invoice sent. It settles only when PayPal says it was paid.' : 'Billed. It is waiting for your tap on Today.'
      setDone((current) => ({ ...current, [`${choice.dealId}:${choice.milestone}`]: line }))
      toast({ title: 'Delivered', body: line, tone: 'info' })
    },
    onSettled: () => void refresh(),
  })
  return (
    <div className="bubble clerk action-card" data-testid="action-card">
      <span className="said">Prepared for you · nothing has been sent</span>
      <p>{route.choices.length > 1 ? 'Which one is delivered?' : 'Mark this milestone as delivered?'} <span className="fine">You press the button; Ask only prepared it.</span></p>
      {route.note ? <p className="fine" role="status">{route.note}</p> : null}
      <label className="field">
        <span>Link to the delivered work</span>
        <input type="url" value={link} placeholder="https://… link to the delivered work" onChange={(event) => setLink(event.target.value)} />
      </label>
      <ul className="answer-lines">
        {route.choices.map((choice) => {
          const key = `${choice.dealId}:${choice.milestone}`
          return (
            <li key={key}>
              <div className="row between gap-s wrap">
                <span><strong>{choice.buyerName} · {choice.title}</strong> <Money cents={choice.amountCents} currency={choice.currency} /> <span className="muted small">milestone {choice.milestone + 1}</span></span>
                {done[key] ? <span className="fine">{done[key]}</span> : <button type="button" className="btn btn-ink btn-small" disabled={!owner || !online || !link.trim() || deliver.isPending} onClick={() => deliver.mutate(choice)}>{deliver.isPending ? 'Sending…' : 'Deliver'}</button>}
              </div>
            </li>
          )
        })}
      </ul>
      <ProblemCard error={deliver.error} />
    </div>
  )
}
