import { useMutation } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Chip, GateChip, ProblemCard } from './ui'
import { api } from '../lib/api'
import { useAgentsOn, useOnline, useRefreshMoney, useSession } from '../lib/hooks'
import type { ClerkReply } from '../lib/types'

type Turn = { id: string; user: string; reply?: ClerkReply; pending?: boolean; error?: unknown }

/**
 * The conversation with the studio clerk, in one place. The Clerk screen and the Ask bar that opens from anywhere
 * both render this, so what you say and what comes back is the same thing either way.
 */
export function ClerkChat({ examples, autoFocus = false, placeholder = 'pay Priya her share for Northwind milestone 1 …', onAsked, tour = false, initial }: {
  examples: string[]
  autoFocus?: boolean
  placeholder?: string
  /** Called after each answer, so a page can refresh what the answer may have changed. */
  onAsked?: () => void
  tour?: boolean
  /** Something to send straight away, such as a suggestion the person clicked. */
  initial?: string
}) {
  const session = useSession()
  const agents = useAgentsOn()
  const online = useOnline()
  const refresh = useRefreshMoney()
  const [turns, setTurns] = useState<Turn[]>([])
  const [text, setText] = useState('')
  const [conversation, setConversation] = useState<string | undefined>()
  const end = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const inputId = useId()
  const sent = useRef<string | undefined>(undefined)

  const send = useMutation({
    mutationFn: (message: string) => api.clerk(message, conversation),
    onMutate: (message) => setTurns((current) => [...current, { id: crypto.randomUUID(), user: message, pending: true }]),
    onSuccess: (reply) => {
      setConversation(reply.conversationId)
      setTurns((current) => current.map((turn, index) => (index === current.length - 1 ? { ...turn, pending: false, reply } : turn)))
      void refresh()
      onAsked?.()
    },
    onError: (error) => setTurns((current) => current.map((turn, index) => (index === current.length - 1 ? { ...turn, pending: false, error } : turn))),
  })
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' }) }, [turns])
  useEffect(() => { if (autoFocus) area.current?.focus() }, [autoFocus])
  useEffect(() => {
    if (initial && agents && sent.current !== initial) {
      sent.current = initial
      send.mutate(initial)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, agents])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const message = text.trim()
    if (!message || send.isPending) return
    setText('')
    send.mutate(message)
  }

  return (
    <>
      {!agents && session.data ? (
        <div className="agents-off" role="status"><Chip tone="muted">agents off</Chip> No language model is configured on this server. Set <span className="mono">OLLAMA_API_KEY</span> to turn the clerk on. Everything else works without it.</div>
      ) : null}
      <div className="log" aria-live="polite" {...(tour ? { 'data-tour': 'clerk-log' } : {})}>
        {turns.length === 0 ? (
          <div className="chat-empty">
            <p><strong>Talk to it like a producer would.</strong> It reads what you write, looks up the job and the client payment, and asks the rules on your behalf.</p>
            <p className="fine">Try one of these. The rules, not the clerk, decide every answer.</p>
            <div className="chat-examples">
              {examples.map((example) => <button key={example} type="button" className="example" disabled={!agents || !online || send.isPending} onClick={() => send.mutate(example)}>{example}</button>)}
            </div>
          </div>
        ) : turns.map((turn) => <Exchange key={turn.id} turn={turn} />)}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={submit}>
        <label className="sr-only" htmlFor={inputId}>Message to the clerk</label>
        <textarea ref={area} id={inputId} rows={2} value={text} maxLength={4000} placeholder={placeholder} onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(event) } }} disabled={!agents} />
        <button type="submit" className="btn btn-ink" disabled={!agents || !online || !text.trim() || send.isPending}>{send.isPending ? 'Asking the rules…' : 'Send'}</button>
      </form>
    </>
  )
}

function Exchange({ turn }: { turn: Turn }) {
  const reply = turn.reply
  const asked = reply?.outcomes.filter((outcome) => outcome.tool === 'propose' && outcome.ok) ?? []
  return (
    <div className="exchange">
      <div className="bubble me"><span className="said">You</span>{turn.user}</div>
      {turn.pending ? <div className="bubble clerk thinking" role="status"><span className="said">Clerk</span><span className="dots" aria-label="The clerk is working"><i /><i /><i /></span></div> : null}
      {turn.error ? <div className="bubble clerk"><ProblemCard error={turn.error} /></div> : null}
      {reply ? (
        <div className="bubble clerk">
          <span className="said">Clerk</span>
          <p>{reply.reply}</p>
          {reply.guarded ? <p className="fine guard">The clerk’s own words were replaced with the rules’ answer, because they claimed something the rules did not say.</p> : null}
          {asked.map((outcome) => {
            const data = outcome.data as { proposalId: string; decision: 'DENY' | 'AUTO' | 'NEEDS_APPROVAL'; ruleCode: string; amount: string }
            return (
              <div key={data.proposalId} className="asked">
                <GateChip gate={data.decision} />
                <code>{data.ruleCode}</code>
                <span>{data.amount}</span>
                <Link className="link" to={`/p/${data.proposalId}`}>Open receipt →</Link>
                {data.decision === 'NEEDS_APPROVAL' ? <Link className="btn btn-lime btn-small" to="/">Review and approve</Link> : null}
                {data.decision === 'DENY' ? <span className="muted">$0 moved</span> : null}
              </div>
            )
          })}
          <p className="fine">Tools used: {reply.tools.map((item) => item.tool).join(' → ') || 'none'} · {(reply.ms / 1000).toFixed(1)}s</p>
        </div>
      ) : null}
    </div>
  )
}
