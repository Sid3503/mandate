import { useMutation } from '@tanstack/react-query'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useToast } from '../components/Toast'
import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAsk } from '../components/Ask'
import { BalanceNote } from '../components/PayPalFeatures'
import { Chip, Empty, Hash, Loading, Money, NoMoneyMoved, PageHead, ProblemCard } from '../components/ui'
import { api } from '../lib/api'
import { useQuery } from '@tanstack/react-query'
import { relative } from '../lib/format'
import { reviewKey, useLive, type ReviewState } from '../lib/live'
import { ToolTrail } from '../components/ToolTrail'
import { dollars } from '../lib/money'
import { useAgentsOn, useCaptures, useIsOwner, useNames, useOnline, useProposals, useRefreshMoney, useToday, useWarrant } from '../lib/hooks'
import type { Delivery, Proposal, Today as TodayData, TodayAction, TodayItem } from '../lib/types'
import { explain, isPayout, KIND, type Names } from '../lib/words'

const HOW: Record<NonNullable<TodayItem['how']>, { label: string; tone: 'auto' | 'ink' }> = {
  tap: { label: 'Your tap', tone: 'ink' },
  standing: { label: 'Standing rule · no tap', tone: 'auto' },
  billing: { label: 'Billing rule · no tap', tone: 'auto' },
  autopilot: { label: 'Autopilot · no tap', tone: 'auto' },
  auto: { label: 'Under the line · no tap', tone: 'auto' },
}

const KIND_LABEL: Record<TodayItem['kind'], { label: string; tone: 'deny' | 'need' | 'ink' | 'muted' | 'auto' }> = {
  approval: { label: 'Needs your tap', tone: 'need' },
  ready: { label: 'Ready to send', tone: 'ink' },
  unclaimed: { label: 'Unclaimed', tone: 'need' },
  held: { label: 'On hold', tone: 'need' },
  overdue: { label: 'Overdue', tone: 'deny' },
  autopilot_blocked: { label: 'Autopilot stopped', tone: 'deny' },
  dispute: { label: 'Disputed', tone: 'deny' },
  in_flight: { label: 'In flight', tone: 'muted' },
  done: { label: 'Done', tone: 'auto' },
  stopped: { label: 'Refused', tone: 'deny' },
}

export function Today() {
  const proposals = useProposals()
  const today = useToday()
  const names = useNames()
  const warrant = useWarrant()
  const captures = useCaptures(proposals.data?.data)
  const [settledHere, setSettledHere] = useState<Record<string, Proposal>>({})
  const rows = proposals.data?.data ?? []
  const waiting = rows.filter((row) => row.phase === 'pending_approval' || settledHere[row.id])
  const refused = rows.filter((row) => row.phase === 'denied').slice(0, 4)
  const data = today.data
  const attention = (data?.waiting ?? []).filter((item) => item.kind !== 'approval')
  const open = waiting.filter((row) => !settledHere[row.id]).length + attention.length

  return (
    <div className="page today">
      <PageHead
        eyebrow={new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
        title={<>Today <span className="count" aria-label={`${open} waiting for you`}>{open}</span></>}
      >
        <AskButton />
        <Link className="btn btn-ghost hide-phone" to="/new">New request</Link>
      </PageHead>

      {proposals.isLoading || today.isLoading ? <Loading /> : null}
      <ProblemCard error={proposals.error ?? today.error} />

      {data ? <MonthStrip data={data} /> : null}
      {data ? <WaitingOnClient data={data} /> : null}
      <TapToRule />
      {data && !data.setup.complete && data.setup.steps.filter((step) => step.done).length < 4 ? <Setup data={data} /> : null}

      <section className="section" data-tour="today-waiting" aria-labelledby="h-waiting">
        <h2 className="section-title" id="h-waiting">Waiting for you</h2>
        {proposals.data && today.data && waiting.length === 0 && attention.length === 0 ? (
          <div data-tour="empty"><Empty title="Nothing needs you">Requests at or above the automatic line land here, and so does anything that needs a decision, such as a payout on hold or an invoice that is overdue. Everything else is settled or refused by the rules on its own.</Empty></div>
        ) : null}
        <div className="approvals">
          {waiting.map((row) => (
            <ApprovalCard
              key={row.id}
              proposal={settledHere[row.id] ?? row}
              names={names}
              funding={row.fundingCaptureId ? captures.get(row.fundingCaptureId) ?? null : null}
              why={explain(row.clause, row, warrant.data, names)}
              onLocked={(locked) => setSettledHere((current) => ({ ...current, [locked.id]: locked }))}
            />
          ))}
        </div>
        {attention.length > 0 ? <ul className="items" aria-label="Needs your attention"><AnimatePresence initial={false}>{attention.map((item) => <ItemRow key={item.id} item={item} />)}</AnimatePresence></ul> : null}
      </section>

      {data && data.readyToBill.some((item) => item.delivery?.status !== 'awaiting') ? <ReadyToBill data={data} /> : null}

      {data && data.inFlight.length > 0 ? (
        <section className="section" data-tour="ready" aria-labelledby="h-flight">
          <h2 className="section-title" id="h-flight">In flight · nothing for you to do</h2>
          <p className="fine watcher" role="status">{data.watcher.lastLook ? <>Mandate asks PayPal about these {cadence(data.watcher.everySeconds)}. Last asked {relative(data.watcher.lastLook.at)}, looking at {data.watcher.lastLook.invoices} invoice{data.watcher.lastLook.invoices === 1 ? '' : 's'} and {data.watcher.lastLook.payouts} payout{data.watcher.lastLook.payouts === 1 ? '' : 's'}.</> : <>Mandate asks PayPal about these {cadence(data.watcher.everySeconds)}. It has not asked yet since the server started.</>} Pay an invoice and this page updates by itself the moment PayPal says it was paid.</p>
          <ul className="items"><AnimatePresence initial={false}>{data.inFlight.map((item) => <ItemRow key={item.id} item={item} />)}</AnimatePresence></ul>
        </section>
      ) : null}

      {data ? <Done data={data} /> : null}
      {data && !data.setup.complete && data.setup.steps.filter((step) => step.done).length >= 4 ? <Setup data={data} /> : null}

      {refused.length > 0 || (data?.stopped.count ?? 0) > 0 ? (
        <section className="section" data-tour="refused" aria-labelledby="h-stopped">
          <h2 className="section-title" id="h-stopped">Stopped by the rules{data && data.stopped.count > 0 ? <span className="section-note"> · {data.stopped.count} in 30 days, {dollars(data.stopped.cents)} kept safe</span> : null}</h2>
          <div className="refusals">
            {refused.map((row) => (
              <Link key={row.id} to={`/p/${row.id}`} className="refusal">
                <div className="row between">
                  <Chip tone="deny">{row.clause}</Chip>
                  <span className="muted small">{relative(row.createdAt)}</span>
                </div>
                <div className="refusal-what">
                  <strong>{KIND[row.kind].label} · {names(row.payeeId)}</strong>
                  <Money cents={row.amountCents} />
                </div>
                <p>{explain(row.clause, row, warrant.data, names)}</p>
                <NoMoneyMoved />
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}

function AskButton() {
  const ask = useAsk()
  const agents = useAgentsOn()
  return (
    <button type="button" className="btn btn-ink ask-button" data-tour="today-ask" onClick={() => ask.open()} disabled={!agents} title={agents ? 'Ask the clerk anything' : 'The clerk needs BEDROCK_API_KEY'}>
      Ask Mandate <kbd aria-hidden="true">⌘K</kbd>
    </button>
  )
}

/** The month in money PayPal confirmed, and how much of it ran without you. */
/** "You keep saying yes. Make it a rule." Offered only after a clear pattern; it opens the rules drafter with the words filled in, and nothing changes until the owner signs the draft. */
function TapToRule() {
  const owner = useIsOwner()
  const online = useOnline()
  const found = useQuery({ queryKey: ['suggestions'], queryFn: api.suggestions, enabled: owner && online, staleTime: 30_000, retry: false })
  const first = found.data?.suggestions[0]
  const taps = found.data?.taps
  if (!owner || !first) return null
  return (
    <section className="section tap-to-rule" aria-label="A rule worth making" data-testid="tap-to-rule">
      <div>
        <span className="eyebrow">You keep saying yes</span>
        <p>You have approved {first.payeeName}'s payouts from {first.clientName}'s money {first.approved} times ({dollars(first.totalCents)} in all, the largest {dollars(first.largestCents)}) and never said no.
          {taps && taps.thisMonth > 0 ? <> That is {taps.thisMonth} {taps.thisMonth === 1 ? 'tap' : 'taps'} this month.</> : null}</p>
        <p className="fine">Make it a rule and these payouts need no tap. You will see exactly what it allows before you sign anything.</p>
      </div>
      <Link className="btn btn-ink btn-small" to="/rules" state={{ draft: first.draft }}>Draft this rule</Link>
    </section>
  )
}

function MonthStrip({ data }: { data: TodayData }) {
  const month = data.month
  const stats = data.stats.last30Days
  const auto = data.automation
  if (!month) return null
  const used = month.capCents > 0 ? Math.min(100, Math.round((month.reservedCents / month.capCents) * 100)) : 0
  const on = [auto?.billSignedDeals ? 'bills signed-deal milestones when work is delivered' : null, auto?.payOnSettle ? 'pays contractors when the client pays' : null, auto?.remindUnpaidAfterDays ? `reminds unpaid invoices after ${auto.remindUnpaidAfterDays} days` : null].filter(Boolean)
  return (
    <section className="month" data-tour="today-month" aria-label={`${month.label} in money`}>
      <div className="month-nums">
        <div className="month-num in"><span className="eyebrow">{month.label} · in</span><Money cents={month.inCents} size="xl" currency={month.currency} /></div>
        <div className="month-num out"><span className="eyebrow">Out</span><Money cents={month.outCents} size="xl" currency={month.currency} /></div>
        <div className="month-num kept"><span className="eyebrow">Kept</span><Money cents={month.keptCents} size="xl" currency={month.currency} /></div>
      </div>
      <div className="month-facts">
        <p className="fine"><strong>Contractor cap:</strong> {dollars(month.reservedCents)} of {dollars(month.capCents)} used</p>
        <div className="cap-bar" role="img" aria-label={`${used}% of the monthly contractor cap is used`}><span style={{ width: `${used}%` }} /></div>
        <p className="fine">
          {stats.automaticShare !== null ? <><strong>{stats.automaticShare}%</strong> of the last {stats.requests} requests needed no tap{stats.refused > 0 ? <> · <strong>{stats.refused}</strong> refused</> : null}. </> : null}
          {on.length > 0 ? <>Autopilot {on.join(', ')}.</> : <>Autopilot is off. <Link to="/rules" className="link">Switch it on in Rules</Link>.</>}
        </p>
        <BalanceNote />
      </div>
    </section>
  )
}

function Setup({ data }: { data: TodayData }) {
  const done = data.setup.steps.filter((step) => step.done).length
  return (
    <section className="setup" data-tour="today-setup" aria-labelledby="h-setup">
      <div className="row between wrap gap-s"><h2 className="section-title" id="h-setup">Get set up</h2><span className="muted small">{done} of {data.setup.steps.length} done</span></div>
      <ol className="setup-steps">
        {data.setup.steps.map((step) => (
          <li key={step.id} className={step.done ? 'done' : ''}>
            <span className="step-mark" aria-hidden="true">{step.done ? '✓' : ''}</span>
            <div><Link to={step.href}><strong>{step.label}</strong></Link><span>{step.done ? 'Done' : step.hint}</span></div>
          </li>
        ))}
      </ol>
    </section>
  )
}

/** The next milestone of each signed deal. Paste the proof and press: with autopilot on, the invoice is on its way. */
/** A delivery the client's agent has not answered. It sits at the top, because until it is answered nothing else moves. */
function WaitingOnClient({ data }: { data: TodayData }) {
  const waiting = data.readyToBill.filter((item) => item.delivery?.status === 'awaiting')
  if (waiting.length === 0) return null
  const auto = data.clientAgent.mode === 'auto' && data.clientAgent.ready
  return (
    <section className="section waiting-client" data-tour="today-client" aria-labelledby="h-client">
      <h2 className="section-title" id="h-client">Waiting for the client</h2>
      <p className="fine" role="status">{auto ? 'The client’s agent reviews a delivery by itself, usually within a few seconds. When it accepts, the invoice goes out under your rule and this moves down to In flight.' : 'Nothing is billed until the client’s agent accepts. In production it calls decide_delivery on its own key; here you can run the hosted stand-in.'}</p>
      <ul className="items">
        {waiting.map((item) => <BillRow key={`${item.dealId}:${item.milestone}`} item={item} auto accept hosted={auto} />)}
      </ul>
    </section>
  )
}

function ReadyToBill({ data }: { data: TodayData }) {
  const auto = data.automation?.billSignedDeals ?? false
  return (
    <section className="section" data-tour="today-bill" aria-labelledby="h-bill">
      <h2 className="section-title" id="h-bill">Ready to bill</h2>
      <ul className="items">
        {data.readyToBill.filter((item) => item.delivery?.status !== 'awaiting').map((item) => <BillRow key={`${item.dealId}:${item.milestone}`} item={item} auto={auto} accept={data.automation?.requireAcceptance ?? false} />)}
      </ul>
    </section>
  )
}

function BillRow({ item, auto, accept, hosted = false }: { item: TodayData['readyToBill'][number]; auto: boolean; accept: boolean; hosted?: boolean }) {
  const owner = useIsOwner()
  const online = useOnline()
  const agents = useAgentsOn()
  const refresh = useRefreshMoney()
  const toast = useToast()
  const [link, setLink] = useState('')
  const delivery = item.delivery
  const deliver = useMutation({
    mutationFn: () => api.deliverMilestone(item.dealId, item.milestone, link.trim()),
    onSuccess: (made) => {
      setLink('')
      if (made.mode === 'awaiting') {
        toast({ title: `Sent to ${item.buyerName} to accept`, body: 'Nothing is billed until the client’s agent accepts this delivery.', tone: 'info' })
        return
      }
      const charge = made.charge
      toast(charge.gate === 'DENY'
        ? { title: 'Refused', body: `${charge.clause}. Nothing was billed.`, tone: 'bad' }
        : charge.phase === 'invoice_sent' || charge.phase === 'captured'
          ? { title: `Invoice sent to ${item.buyerName}`, body: `${dollars(item.amountCents)} for ${item.title}. It settles only when PayPal says it was paid.` }
          : { title: 'Billed', body: 'It is waiting for your tap.', tone: 'info' })
    },
    onSettled: () => void refresh(),
  })
  const live = useLive()
  const review = useMutation({
    mutationFn: () => api.reviewDelivery(item.dealId, item.milestone),
    onSuccess: (done) => live.connected ? undefined : toast(done.delivery.status === 'accepted'
      ? { title: `${item.buyerName}’s agent accepted it`, body: done.charge ? `The invoice for ${dollars(item.amountCents)} went out under your rule. No tap.` : 'Accepted and signed.' }
      : { title: `${item.buyerName}’s agent rejected it`, body: done.delivery.note ?? 'Nothing was billed.', tone: 'bad' }),
    onSettled: () => void refresh(),
  })
  const submit = (event: FormEvent) => { event.preventDefault(); if (link.trim()) deliver.mutate() }
  const waiting = delivery?.status === 'awaiting'
  const rejected = delivery?.status === 'rejected'
  return (
    <li className="item bill">
      <div className="item-main">
        <Chip tone="ink">Milestone {item.milestone + 1} of {item.total}</Chip>
        <strong>{item.buyerName} · {item.title}</strong>
        <Money cents={item.amountCents} currency={item.currency} />
      </div>
      {waiting ? (
        <>
          <p className="fine"><Chip tone="need">Waiting for {item.buyerName} to accept</Chip> Delivered with <a href={delivery.proofUrl} target="_blank" rel="noreferrer noopener">{delivery.proofUrl.replace(/^https:\/\/(www\.)?/, '')}</a>. Nothing is billed until the client’s own agent accepts it, and then the invoice goes out by itself.</p>
          <div className="row gap-s wrap">
            <ReviewProgress buyer={item.buyerName} delivery={delivery} hosted={hosted} />
            <button type="button" className="btn btn-ink btn-small" disabled={!owner || !online || !agents || review.isPending} onClick={() => review.mutate()} title={agents ? undefined : 'The client’s agent needs BEDROCK_API_KEY'}>{review.isPending ? `Asking ${item.buyerName}’s agent…` : hosted ? 'Nudge now' : `Ask ${item.buyerName}’s agent to review`}</button>
            <span className="fine">In production the client’s own agent calls <code>decide_delivery</code> on its own key. This runs the hosted stand-in.</span>
          </div>
          <ProblemCard error={review.error} />
        </>
      ) : (
        <>
          {rejected ? <p className="fine"><Chip tone="deny">{item.buyerName}’s agent rejected it</Chip> {delivery.note ?? ''} Deliver again with the right link.</p> : null}
          <p className="fine">{item.scope}. {accept ? `Your rule bills this once ${item.buyerName}’s own agent accepts the delivery: paste the proof and send it for acceptance.` : auto ? 'Your rule bills signed-deal milestones without a tap: paste the proof and press the button.' : 'You will approve it on this page next.'}</p>
          <form className="bill-form" onSubmit={submit}>
            <label className="sr-only" htmlFor={`proof-${item.dealId}-${item.milestone}`}>Link to the delivered work for {item.buyerName}, {item.title}</label>
            <input id={`proof-${item.dealId}-${item.milestone}`} type="url" required placeholder="https://… link to the delivered work" value={link} onChange={(event) => setLink(event.target.value)} />
            <button type="submit" className="btn btn-ink" disabled={!owner || !online || !link.trim() || deliver.isPending}>{deliver.isPending ? 'Sending…' : accept ? 'Delivered · send for acceptance' : 'Delivered · bill it'}</button>
          </form>
          <ProblemCard error={deliver.error} />
        </>
      )}
    </li>
  )
}

const cadence = (seconds: number) => (seconds <= 10 ? `every ${seconds} seconds while they are open` : 'every minute')

/**
 * What the client's agent is doing right now, as it happens: handed over, reviewing (with the clock), then the
 * decision, then the invoice. Every step shown is one the server actually reported; nothing here is a spinner for show.
 */
function ReviewProgress({ buyer, delivery, hosted }: { buyer: string; delivery: Delivery; hosted: boolean }) {
  const live = useLive()
  const found = live.reviews[reviewKey(delivery.dealId, delivery.milestone)]
  const since = Date.parse(delivery.createdAt)
  const review: ReviewState | undefined = found && found.at >= since - 2000 ? found : undefined
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.round((now - (review?.startedAt ?? since)) / 1000))
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  if (!hosted) return <p className="fine" role="status"><Chip tone="muted">Waiting for {buyer}’s own agent</Chip> It answers on its own key, from outside.</p>
  const failed = review?.stage === 'failed'
  const steps: Array<{ label: string; state: 'done' | 'active' | 'todo' | 'bad'; note?: string }> = [
    { label: 'Delivered and signed', state: 'done' },
    { label: review ? `${buyer}’s agent is reviewing the proof${review.model ? ` (${review.model})` : ''}` : `Handing it to ${buyer}’s agent`, state: failed ? 'bad' : 'active', note: failed ? review?.note ?? 'The review failed. Nothing was billed. Press Nudge now to try again.' : clock },
    { label: 'Decision, signed over this exact proof', state: 'todo' },
    { label: 'Invoice sent by your billing rule', state: 'todo' },
  ]
  return (
    <>
    <ol className="review-steps" role="status" aria-label={`${buyer}’s agent review`}>
      {steps.map((step) => (
        <li key={step.label} className={`review-step review-${step.state}`}>
          <span className="review-dot" aria-hidden="true" />
          <span>{step.label}</span>
          {step.note ? <span className="review-note mono">{step.note}</span> : null}
        </li>
      ))}
    </ol>
    {review && review.stream.calls.length > 0 ? <ToolTrail calls={review.stream.calls} title={`What ${buyer}’s agent did`} live={review.stage === 'started'} /> : null}
    </>
  )
}

function Done({ data }: { data: TodayData }) {
  const names = data.done.filter((item) => item.how && item.how !== 'tap').length
  return (
    <section className="section" data-tour="today-done" aria-labelledby="h-done">
      <h2 className="section-title" id="h-done">Done for you{data.done.length > 0 ? <span className="section-note"> · last 7 days, {names} of {data.done.length} with no tap</span> : null}</h2>
      {data.done.length === 0 ? <p className="muted">Nothing has settled this week yet. When it does, it shows here with how it was approved.</p> : <ul className="items"><AnimatePresence initial={false}>{data.done.map((item) => <ItemRow key={item.id} item={item} />)}</AnimatePresence></ul>}
    </section>
  )
}

/** One thing that needs attention, is in flight, or is done: words, the amount, and the buttons that act on it. */
function ItemRow({ item }: { item: TodayItem }) {
  const reduce = useReducedMotion()
  const owner = useIsOwner()
  const online = useOnline()
  const refresh = useRefreshMoney()
  const toast = useToast()
  const act = useMutation({
    mutationFn: (action: TodayAction) => {
      if (action === 'settle' || action === 'check') return api.capture(item.proposalId)
      if (action === 'remind') return api.remindInvoice(item.proposalId)
      if (action === 'cancel_payout') return api.cancelPayout(item.proposalId)
      if (action === 'approve') return api.approve(item.proposalId)
      if (action === 'reject') return api.reject(item.proposalId)
      return Promise.resolve(null)
    },
    onSuccess: (result, action) => {
      if (action === 'remind') toast({ title: 'Reminder sent', body: 'PayPal emailed the client about the invoice.', tone: 'info' })
      else if (action === 'cancel_payout') toast({ title: 'Payout cancelled', body: 'PayPal returned the money.', tone: 'info' })
      else if (result && 'phase' in result && result.phase === 'captured') toast({ title: `Settled ${dollars(result.amountCents)}`, body: 'PayPal confirmed it.' })
      else if (action === 'settle' || action === 'check') toast({ title: 'Checked with PayPal', body: 'Not settled yet. Nothing is counted as paid until PayPal says so.', tone: 'info' })
    },
    onSettled: () => void refresh(),
  })
  const label = KIND_LABEL[item.kind]
  const how = item.how ? HOW[item.how] : null
  const buttons = item.actions.filter((action) => action !== 'open')
  const disabled = !owner || !online || act.isPending
  return (
    <motion.li
      layout={!reduce}
      className={`item item-${item.kind}`}
      initial={reduce ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, x: 28, transition: { duration: 0.2 } }}
      transition={{ type: 'spring', stiffness: 420, damping: 36 }}
    >
      <div className="item-main">
        {how ? <Chip tone={how.tone}>{how.label}</Chip> : <Chip tone={label.tone}>{label.label}</Chip>}
        <Link to={`/p/${item.proposalId}`} className="item-title">{item.title}</Link>
        <Money cents={item.amountCents} currency={item.currency} />
        <span className="muted small">{relative(item.at)}</span>
      </div>
      <p className="fine">{item.detail}</p>
      {buttons.length > 0 ? (
        <div className="row gap-s wrap">
          {buttons.map((action) => (
            <button key={action} type="button" className={`btn btn-small ${action === 'settle' || action === 'approve' ? 'btn-ink' : 'btn-ghost'}`} disabled={disabled} onClick={() => act.mutate(action)}>
              {ACTION[action](item)}
            </button>
          ))}
          <Link className="link" to={`/p/${item.proposalId}`}>Open receipt →</Link>
        </div>
      ) : null}
      <ProblemCard error={act.error} />
    </motion.li>
  )
}

const ACTION: Record<Exclude<TodayAction, 'open'>, (item: TodayItem) => string> = {
  approve: (item) => `Approve ${dollars(item.amountCents)}`,
  reject: () => 'Reject',
  settle: (item) => (item.proposalKind === 'payment' ? `Send ${dollars(item.amountCents)}` : `Settle ${dollars(item.amountCents)}`),
  check: () => 'Check PayPal',
  remind: () => 'Send a reminder',
  cancel_payout: () => 'Cancel and return the money',
}

function ApprovalCard({ proposal, names, funding, why, onLocked }: {
  proposal: Proposal
  names: Names
  funding: Proposal | null
  why: string
  onLocked: (proposal: Proposal) => void
}) {
  const owner = useIsOwner()
  const online = useOnline()
  const refresh = useRefreshMoney()
  const toast = useToast()
  const approve = useMutation({ mutationFn: () => api.approve(proposal.id), onSuccess: (locked) => { onLocked(locked); toast({ title: `Approved ${dollars(locked.amountCents)}`, body: 'Locked and signed. Nothing has moved yet.' }); void refresh() } })
  const reject = useMutation({ mutationFn: () => api.reject(proposal.id), onSuccess: () => { toast({ title: 'Rejected', body: 'Nothing moved.', tone: 'info' }); void refresh() } })
  const locked = proposal.phase !== 'pending_approval'
  const kind = KIND[proposal.kind]
  const disabled = !owner || !online || approve.isPending || reject.isPending

  return (
    <article className={`approval${locked ? ' is-locked' : ''}`} aria-live="polite" data-tour="approval">
      <header className="approval-head">
        <span className={`kind kind-${proposal.kind}`}>{kind.arrow} {kind.label}</span>
        <span className="muted small">{relative(proposal.createdAt)}</span>
      </header>
      <div className="approval-amount">
        <span className="approval-to">{proposal.kind === 'charge' ? 'Bill' : proposal.kind === 'refund' ? 'Refund' : 'Pay'} {names(proposal.payeeId)}</span>
        <Money cents={proposal.amountCents} size="xl" />
        <span className="mono muted">{proposal.currency}</span>
      </div>
      <dl className="approval-facts">
        <div><dt>For</dt><dd>{proposal.category} · {proposal.description}</dd></div>
        <div><dt>Proof</dt><dd className="one-line">{proposal.evidenceUrl ? <a href={proposal.evidenceUrl} target="_blank" rel="noreferrer noopener">{proposal.evidenceUrl.replace(/^https:\/\/(www\.)?/, '')}</a> : '—'}</dd></div>
        {proposal.kind === 'payment' ? (
          <div><dt>Funded by</dt><dd>{funding ? <>{names(funding.payeeId)} <Money cents={funding.capturedAmountCents} size="sm" /> settled ✓</> : <span className="mono">{proposal.fundingCaptureId ?? 'none'}</span>}</dd></div>
        ) : null}
        {proposal.jobId ? <div className="opt"><dt>Job</dt><dd><Link to={`/jobs/${proposal.jobId}`} className="mono">{proposal.jobId}</Link></dd></div> : null}
        <div data-tour="approval-why"><dt>Why you?</dt><dd>{why}</dd></div>
        {proposal.prompt ? <div className="opt"><dt>Asked as</dt><dd className="quote">“{proposal.prompt}”</dd></div> : null}
      </dl>

      {locked ? (
        <div className="approval-locked">
          <div className="row between"><Chip tone="auto">Approved · locked</Chip><Link className="btn btn-ink" to={`/p/${proposal.id}`}>{isPayout(proposal) ? 'Send the payout →' : 'Settle →'}</Link></div>
          <div className="lock-line"><span className="eyebrow">Lock</span><Hash value={proposal.cartHash} reveal full /></div>
          <p className="fine">{isPayout(proposal)
            ? `${dollars(proposal.amountCents)} is locked for ${names(proposal.payeeId)} and not yet paid. Sending it uses PayPal Payouts, which pays ${names(proposal.payeeId)}’s own account.`
            : `The server can now settle exactly ${dollars(proposal.amountCents)}. Any other amount is refused.`}</p>
        </div>
      ) : (
        <div className="approval-actions">
          <button type="button" className="btn btn-lime btn-big" data-tour="approve" disabled={disabled} onClick={() => approve.mutate()}>
            {approve.isPending ? 'Locking…' : <>Approve <span className="money">{dollars(proposal.amountCents, proposal.currency)}</span></>}
          </button>
          <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => reject.mutate()}>{reject.isPending ? 'Rejecting…' : 'Reject'}</button>
          {!owner ? <p className="fine">This key can ask and read. Only the owner key can approve.</p> : null}
        </div>
      )}
      <ProblemCard error={approve.error ?? reject.error} />
    </article>
  )
}
