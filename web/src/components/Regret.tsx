import { useMutation } from '@tanstack/react-query'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { useOnline, useRefreshMoney, useSession } from '../lib/hooks'
import { dollars } from '../lib/money'
import type { TodayItem } from '../lib/types'
import { Chip, ProblemCard, Spinner } from './ui'
import { useToast } from './Toast'

const clock = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Milliseconds until a moment, ticking, so a countdown stays true without a request. */
function useRemaining(until: string): number {
  const end = Date.parse(until)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (Date.now() >= end) {
      setNow(Date.now())
      return
    }
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [end])
  return Math.max(0, end - now)
}

/**
 * Money a rule you signed is about to send, held for the seconds your rules name so you can take it back. Nothing has
 * gone to PayPal while the clock runs. When it reaches zero the server sends it, and this moves down to In flight.
 */
export function RegretBand({ items }: { items: TodayItem[] }) {
  const role = useSession().data?.role
  if (items.length === 0) return null
  const canUndo = role === 'owner' || role === 'approver'
  return (
    <section className="regret" data-testid="regret-band" data-tour="today-regret" aria-labelledby="h-regret">
      <h2 className="section-title" id="h-regret">Sending soon · you can still take it back</h2>
      <ul className="items">
        <AnimatePresence initial={false}>
          {items.map((item) => <RegretRow key={item.id} item={item} canUndo={canUndo} />)}
        </AnimatePresence>
      </ul>
    </section>
  )
}

function RegretRow({ item, canUndo }: { item: TodayItem; canUndo: boolean }) {
  const reduce = useReducedMotion()
  const online = useOnline()
  const toast = useToast()
  const refresh = useRefreshMoney()
  const left = useRemaining(item.until ?? new Date(0).toISOString())
  const total = useRef(Math.max(1, Date.parse(item.until ?? '') - Date.parse(item.at)))
  const refreshed = useRef(false)
  const done = left <= 0
  useEffect(() => {
    // The moment the clock runs out, ask the server what happened rather than guess.
    if (done && !refreshed.current) {
      refreshed.current = true
      void refresh()
    }
  }, [done, refresh])
  const undo = useMutation({
    mutationFn: () => api.undo(item.proposalId),
    onSuccess: () => toast({ title: 'Taken back', body: `${dollars(item.amountCents, item.currency)} was never sent. PayPal was not called.`, tone: 'info' }),
    onSettled: () => void refresh(),
  })
  const share = Math.min(100, Math.max(0, (1 - left / total.current) * 100))
  return (
    <motion.li
      layout={!reduce}
      className="item item-regret"
      initial={reduce ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, x: 28, transition: { duration: 0.2 } }}
      data-testid="regret-item"
    >
      <div className="item-main">
        <Chip tone="auto">Your rule · no tap</Chip>
        <Link to={`/p/${item.proposalId}`} className="item-title">{item.title}</Link>
        <span className="regret-clock" aria-live="off" data-testid="regret-clock">{done ? 'Sending…' : `Sends in ${clock(left)}`}</span>
      </div>
      <div className="regret-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share)} aria-label="Time until it is sent"><span style={{ width: `${share}%` }} /></div>
      <p className="fine">{item.detail} Nothing has gone to PayPal yet.</p>
      {canUndo && !done ? (
        <div className="row gap-s wrap">
          <button type="button" className="btn btn-ink btn-small" disabled={!online || undo.isPending} onClick={() => undo.mutate()} data-testid="regret-undo">
            {undo.isPending ? <><Spinner />Taking it back…</> : `Undo ${dollars(item.amountCents, item.currency)}`}
          </button>
          <Link className="link" to={`/p/${item.proposalId}`}>Open receipt →</Link>
        </div>
      ) : null}
      <ProblemCard error={undo.error} />
    </motion.li>
  )
}
