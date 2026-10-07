import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useEffect, useState } from 'react'
import type { ToolCallView } from '../lib/agentStream'
import { inputFacts, outputLine, toolGlyph, toolLabel } from '../lib/tools'
import { Chip } from './ui'

const TONE = { good: 'auto', need: 'need', deny: 'deny', muted: 'muted', bad: 'deny' } as const

/** A clock that ticks once a second while something is running, so a slow step shows life instead of a frozen card. */
function useTick(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

const pretty = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
const seconds = (ms: number) => (ms < 950 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`)

/**
 * Every tool an AI layer calls, drawn as a slip in a ledger: what it was doing (in words), the few facts it was given,
 * the rules' one-line answer, how long it took, and the raw call for anyone who wants to read it. Cards arrive one at a
 * time as the server reports them, so a person watches the work happen instead of waiting on a spinner.
 */
export function ToolTrail({ calls, title = 'What the AI did', live = false }: { calls: ToolCallView[]; title?: string; live?: boolean }) {
  const reduce = useReducedMotion()
  const running = calls.some((call) => call.status === 'preparing' || call.status === 'running')
  const now = useTick(running)
  if (calls.length === 0) return null
  const total = calls.reduce((sum, call) => sum + (call.ms ?? 0), 0)
  return (
    <section className={`tooltrail${live && running ? ' is-live' : ''}`} aria-label={title}>
      <header className="tt-head">
        <span className="eyebrow">{title}</span>
        <span className="tt-count mono">{calls.length} step{calls.length === 1 ? '' : 's'}{total > 0 ? ` · ${seconds(total)} in tools` : ''}</span>
      </header>
      <ol className="tt-list">
        <AnimatePresence initial={false}>
          {calls.map((call) => <Row key={call.key} call={call} now={now} reduce={Boolean(reduce)} />)}
        </AnimatePresence>
      </ol>
    </section>
  )
}

function Row({ call, now, reduce }: { call: ToolCallView; now: number; reduce: boolean }) {
  const finished = call.status === 'ok' || call.status === 'error'
  const facts = inputFacts(call.tool, call.input)
  const answer = finished ? (call.note && call.source === 'code' ? { tone: call.status === 'ok' ? ('good' as const) : ('deny' as const), text: call.note } : outputLine(call.tool, call.output, call.status === 'ok')) : null
  const elapsed = finished ? call.ms : Math.max(0, now - call.startedAt)
  return (
    <motion.li
      layout={!reduce}
      className={`tt-row tt-${call.status}`}
      initial={reduce ? false : { opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
    >
      <span className="tt-glyph" aria-hidden="true">{finished ? (call.status === 'ok' ? '✓' : '✕') : <i className="tt-pulse" />}</span>
      <div className="tt-body">
        <div className="tt-title">
          <span className="tt-mark" aria-hidden="true">{toolGlyph(call.tool)}</span>
          <strong>{toolLabel(call.tool, finished)}</strong>
          <span className={`tt-source tt-source-${call.source}`}>{call.source === 'code' ? 'code' : 'model'}</span>
          <code className="tt-name">{call.tool}</code>
          {elapsed !== undefined ? <span className="tt-time mono">{finished ? seconds(elapsed) : `${(elapsed / 1000).toFixed(1)} s`}</span> : null}
        </div>
        {facts.length > 0 ? (
          <ul className="tt-facts" aria-label="What it was given">
            {facts.map((fact) => <li key={fact.k}><span>{fact.k}</span>{fact.v}</li>)}
          </ul>
        ) : call.status === 'preparing' ? <span className="tt-wait">Choosing what to ask…</span> : null}
        {answer ? <div className="tt-answer"><Chip tone={TONE[answer.tone]}>{answer.text}</Chip></div> : null}
        {!finished ? <span className="tt-bar" aria-hidden="true" /> : null}
        {finished && (call.input !== undefined || call.output !== undefined) ? (
          <details className="tt-raw">
            <summary>Show the call</summary>
            {call.input !== undefined ? <><span className="eyebrow">Given</span><pre>{pretty(call.input)}</pre></> : null}
            {call.output !== undefined ? <><span className="eyebrow">Answer</span><pre>{pretty(call.output)}</pre></> : null}
          </details>
        ) : null}
      </div>
    </motion.li>
  )
}

export type StageView = { key: string; label: string; detail?: string; state: 'done' | 'active' | 'retry' }

/** The same slip, for work that is stages and not tool calls (making a draft of the rules). */
export function StageTrail({ stages, title }: { stages: StageView[]; title: string }) {
  const reduce = useReducedMotion()
  if (stages.length === 0) return null
  const active = stages.some((stage) => stage.state === 'active')
  return (
    <section className={`tooltrail${active ? ' is-live' : ''}`} aria-label={title}>
      <header className="tt-head"><span className="eyebrow">{title}</span></header>
      <ol className="tt-list">
        <AnimatePresence initial={false}>
          {stages.map((stage) => (
            <motion.li key={stage.key} layout={!reduce} className={`tt-row tt-${stage.state === 'done' ? 'ok' : stage.state === 'retry' ? 'error' : 'running'}`} initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 34 }}>
              <span className="tt-glyph" aria-hidden="true">{stage.state === 'done' ? '✓' : stage.state === 'retry' ? '↻' : <i className="tt-pulse" />}</span>
              <div className="tt-body">
                <div className="tt-title"><strong>{stage.label}</strong></div>
                {stage.detail ? <span className="tt-wait">{stage.detail}</span> : null}
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
    </section>
  )
}
