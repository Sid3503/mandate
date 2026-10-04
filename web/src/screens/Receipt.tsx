import { useMutation, useQuery } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Chip, GateChip, Hash, KV, Loading, Money, NoMoneyMoved, PageHead, PhaseChip, ProblemCard } from '../components/ui'
import { api, ApiError } from '../lib/api'
import { when } from '../lib/format'
import { useIsOwner, useNames, useOnline, useRefreshMoney, useVersions } from '../lib/hooks'
import { centsInput, dollars, parseCents } from '../lib/money'
import type { LedgerEvent, Packet, Warrant } from '../lib/types'
import { awaitingPayoutRail, EVENT, explain, KIND, type Names } from '../lib/words'

export function Receipt() {
  const { id = '' } = useParams()
  const packet = useQuery({ queryKey: ['packet', id], queryFn: () => api.packet(id) })
  const versions = useVersions()
  const names = useNames()
  if (packet.isLoading) return <div className="page"><Loading label="Opening receipt" /></div>
  if (!packet.data) return <div className="page"><ProblemCard error={packet.error} /></div>
  const data = packet.data
  const p = data.proposal
  const warrant = versions.data?.data.find((item) => item.version === p.warrantVersion)
  const kind = KIND[p.kind]
  const verb = p.kind === 'charge' ? 'from' : p.kind === 'refund' ? 'to' : 'to'

  return (
    <div className="page receipt">
      <PageHead eyebrow={`Receipt · ${kind.label} · rules v${p.warrantVersion}`} title={<>{dollars(p.amountCents, p.currency)} <span className="title-sub">{verb} {names(p.payeeId)}</span></>}>
        <PhaseChip phase={p.phase} kind={p.kind} />
      </PageHead>

      <div className="receipt-grid">
        <div className="stack-l">
          <section className="panel">
            <div className="row between"><h2 className="panel-title">The decision</h2><GateChip gate={p.gate} /></div>
            <p className="decision-words">{explain(p.clause, p, warrant, names)}</p>
            <p className="server-words"><span>Server · {p.clause}</span>{p.detail}</p>
            {p.gate === 'DENY' ? <NoMoneyMoved /> : null}
          </section>

          <Settle packet={data} warrant={warrant} names={names} />

          <section className="panel">
            <h2 className="panel-title">What was asked</h2>
            {data.prompt ? <p className="quote big">“{data.prompt}”</p> : <p className="muted">No sentence was recorded.</p>}
            <div className="kvs">
              <KV label="Kind">{kind.label}</KV>
              <KV label={p.kind === 'charge' ? 'Client' : 'Payee'}>{names(p.payeeId)}</KV>
              <KV label="Category">{p.category ?? '—'}</KV>
              <KV label="Description">{p.description}</KV>
              <KV label="Proof">{p.evidenceUrl ? <a href={p.evidenceUrl} target="_blank" rel="noreferrer noopener">{p.evidenceUrl}</a> : '—'}</KV>
              {p.jobId ? <KV label="Job"><Link to={`/jobs/${p.jobId}`} className="mono">{p.jobId}</Link></KV> : null}
              {p.parentCaptureId ? <KV label="Refunds capture" mono>{p.parentCaptureId}</KV> : null}
            </div>
          </section>
        </div>

        <div className="stack-l">
          <section className="panel panel-ink">
            <h2 className="panel-title">The lock</h2>
            <Hash value={p.cartHash} full />
            <p className="fine">SHA-256 over payee, cents, currency, category, proof{p.jobId ? ', job' : ''}{p.fundingCaptureId ? ' and funding capture' : ''}. Settlement recomputes it and refuses on any difference.</p>
            <div className="match">
              <div><span>Approved</span><Money cents={data.amounts.approvedCents} size="lg" /></div>
              <div><span>{p.kind === 'payment' ? 'Paid' : 'Settled'}</span><Money cents={data.amounts.capturedCents} size="lg" /></div>
              <div className={`match-flag${data.amounts.match ? ' ok' : ''}`}>{data.amounts.match === null ? (awaitingPayoutRail(p) ? 'reserved · not paid' : p.kind === 'payment' ? 'not paid' : 'not settled') : data.amounts.match ? 'cents match ✓' : 'mismatch'}</div>
            </div>
          </section>

          {data.funding ? (
            <section className="panel">
              <h2 className="panel-title">Funded by</h2>
              <div className="kvs">
                <KV label="Client">{names(data.funding.clientId)}</KV>
                <KV label="Settled">{dollars(data.funding.capturedCents)}</KV>
                <KV label="Capture" mono>{data.funding.captureId}</KV>
                <KV label="State">{data.funding.phase}</KV>
              </div>
              {data.funding.proposalId ? <Link className="btn btn-ghost" to={`/p/${data.funding.proposalId}`}>Open the client payment →</Link> : null}
            </section>
          ) : null}

          <section className="panel">
            <h2 className="panel-title">PayPal</h2>
            <div className="kvs">
              <KV label="Order" mono>{p.orderId ?? '—'}</KV>
              <KV label="Capture" mono>{p.captureId ?? '—'}</KV>
              {p.refundId ? <KV label="Refund" mono>{p.refundId}</KV> : null}
            </div>
            {(p.phase === 'captured' && p.kind !== 'refund') ? (
              <Link className="btn btn-ghost" to={`/new?kind=refund&parent=${encodeURIComponent(p.captureId ?? '')}`}>Propose a refund →</Link>
            ) : null}
          </section>

          <section className="panel">
            <div className="row between"><h2 className="panel-title">Timeline</h2><DownloadReceipt packet={data} /></div>
            <Timeline events={data.events} />
          </section>
        </div>
      </div>
    </div>
  )
}

function Timeline({ events }: { events: LedgerEvent[] }) {
  return (
    <ol className="timeline">
      {events.map((event) => {
        const refused = event.type.includes('refused') || event.type.includes('blocked')
        return (
          <li key={event.id} className={refused ? 'is-refused' : event.type === 'capture.completed' || event.type === 'proposal.approved' ? 'is-good' : ''}>
            <span className="tl-dot" aria-hidden="true" />
            <div>
              <div className="row between gap-s"><strong>{EVENT[event.type] ?? event.type}</strong><span className="mono muted small">{when(event.createdAt)}</span></div>
              <div className="tl-meta">
                {event.clause && (refused || event.type === 'proposal.created') ? <code>{event.clause}</code> : null}
                {typeof event.payload.actor === 'string' ? <span>by {event.payload.actor}</span> : null}
                {typeof event.payload.claimedAmountCents === 'number' ? <span>claimed {dollars(event.payload.claimedAmountCents)} · lock {dollars(Number(event.payload.lockedAmountCents))}</span> : null}
                {typeof event.payload.captureId === 'string' ? <span className="mono">{event.payload.captureId}</span> : null}
                {typeof event.payload.orderId === 'string' && event.type === 'order.created' ? <span className="mono">{event.payload.orderId}</span> : null}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function DownloadReceipt({ packet }: { packet: Packet }) {
  const download = () => {
    const blob = new Blob([JSON.stringify(packet, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `mandate-receipt-${packet.proposal.id}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }
  return <button type="button" className="link" onClick={download}>Download receipt</button>
}

function Settle({ packet, warrant, names }: { packet: Packet; warrant: Warrant | undefined; names: Names }) {
  const p = packet.proposal
  const owner = useIsOwner()
  const online = useOnline()
  const refresh = useRefreshMoney()
  const [claim, setClaim] = useState('')
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const settle = useMutation({ mutationFn: () => api.capture(p.id), onSettled: () => { setCheckedAt(new Date()); void refresh() } })
  const tamper = useMutation({
    mutationFn: (cents: number) => api.capture(p.id, cents),
    onSettled: () => void refresh(),
  })
  const settleable = p.phase === 'locked' || p.phase === 'order_created'
  if (!settleable) return null
  if (awaitingPayoutRail(p)) return <PayoutStatus packet={packet} warrant={warrant} names={names} />
  const pending = settle.error instanceof ApiError && settle.error.code === 'paypal.buyer_pending' ? settle.error : null
  const approveUrl = (pending?.body.approveUrl as string | undefined) ?? p.approveUrl ?? null
  const disabled = !owner || !online || settle.isPending
  const claimCents = parseCents(claim)
  const submitTamper = (event: FormEvent) => {
    event.preventDefault()
    if (claimCents !== null) tamper.mutate(claimCents)
  }
  const refusal = tamper.error instanceof ApiError ? tamper.error : null

  return (
    <section className="panel panel-lime">
      <div className="row between"><h2 className="panel-title">Settle with PayPal</h2><Chip tone="ink">{p.kind === 'refund' ? 'Payments v2 refund' : 'Orders v2'}</Chip></div>
      <p>
        PayPal will be asked for exactly <strong>{dollars(p.amountCents, p.currency)}</strong>
        {p.kind === 'charge' ? <> from {names(p.payeeId)}</> : p.kind === 'refund' ? <> back to {names(p.payeeId)}</> : <> for {names(p.payeeId)}</>}.
        The server reads the live PayPal order first and refuses if the amount, currency or reference differ from the lock.
      </p>
      {pending || (p.phase === 'order_created' && approveUrl) ? (
        <div className="buyer" aria-live="polite">
          <p><strong>Step 1 of 2 · the PayPal buyer approves.</strong> {p.kind === 'charge' ? `${names(p.payeeId)}’s account` : 'The buyer'} has to approve this ${dollars(p.amountCents)} order on PayPal. Mandate cannot do it for them.</p>
          <ol className="how">
            <li>Open PayPal with the button below (it opens a new tab).</li>
            <li>Sign in as the sandbox buyer and approve the order.</li>
            <li>Come back here and press <em>Check PayPal and settle</em>.</li>
          </ol>
          {approveUrl ? <a className="btn btn-ink" href={approveUrl} target="_blank" rel="noreferrer noopener">Open PayPal ↗</a> : null}
          {pending && !settle.isPending ? (
            <div className="still-waiting" role="status">
              <Chip tone="need">Still waiting</Chip>
              <span>Checked PayPal{checkedAt ? ` at ${checkedAt.toLocaleTimeString('en-US')}` : ''}. The buyer has not approved the order yet, so <strong>nothing was captured and $0 moved</strong>. Approve it on PayPal, then check again.</span>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="row gap-s wrap">
        <button type="button" className="btn btn-ink btn-big" disabled={disabled} onClick={() => settle.mutate()}>
          {settle.isPending ? 'Asking PayPal…' : pending || p.phase === 'order_created' ? 'Check PayPal and settle' : `Settle ${dollars(p.amountCents)}`}
        </button>
      </div>
      {!owner ? <p className="fine">Only the owner key can settle.</p> : null}
      {settle.error && !pending ? <ProblemCard error={settle.error} /> : null}

      <details className="tamper">
        <summary>Integrity check · try to settle a different amount</summary>
        <form onSubmit={submitTamper} className="row gap-s wrap">
          <label className="field field-inline">
            <span>Claimed amount</span>
            <span className="dollar-input"><span>$</span><input inputMode="decimal" value={claim} onChange={(event) => setClaim(event.target.value)} placeholder={centsInput(p.amountCents * 2 + 7000)} /></span>
          </label>
          <button type="submit" className="btn btn-ghost" disabled={!owner || !online || claimCents === null || tamper.isPending}>Send claim</button>
        </form>
        {refusal ? (
          <div className="refused-claim">
            <Chip tone="deny">{refusal.status} · {refusal.code}</Chip>
            <p>{explain(refusal.code, p, warrant, names)}</p>
            <p className="server-words"><span>Server</span>{refusal.detail}</p>
            <NoMoneyMoved />
          </div>
        ) : null}
        {tamper.isSuccess ? <p className="fine">The claim matched the lock, so it settled normally.</p> : null}
      </details>
    </section>
  )
}

/**
 * A contractor payout is approved and reserved, but Orders checkout can only collect money for the studio.
 * This panel says exactly where the money is, and offers no button that could send it the wrong way.
 */
function PayoutStatus({ packet, warrant, names }: { packet: Packet; warrant: Warrant | undefined; names: Names }) {
  const p = packet.proposal
  const owner = useIsOwner()
  const online = useOnline()
  const refresh = useRefreshMoney()
  const [claim, setClaim] = useState('')
  const tamper = useMutation({ mutationFn: (cents: number) => api.capture(p.id, cents), onSettled: () => void refresh() })
  const claimCents = parseCents(claim)
  const refusal = tamper.error instanceof ApiError ? tamper.error : null
  const funded = packet.funding
  const steps: Array<{ done: boolean; now?: boolean; title: string; body: string }> = [
    { done: true, title: 'Asked', body: packet.events[0]?.payload.actor === 'proposer' ? 'An agent’s key proposed this.' : 'Proposed with the owner key.' },
    { done: true, title: 'Rules checked', body: `${names(p.payeeId)} is on the rules, and ${dollars(p.amountCents)} is at or above the automatic line.` },
    { done: Boolean(funded && funded.phase === 'captured'), title: 'Funded by the client', body: funded ? `${names(funded.clientId)}’s ${dollars(funded.capturedCents)} payment settled, so this payout is covered.` : 'No client payment is cited.' },
    { done: true, title: 'Approved and locked', body: `Payee, ${dollars(p.amountCents)}, category, proof, job and funding are fixed in the lock.` },
    { done: false, now: true, title: 'Payout to ' + names(p.payeeId), body: 'Waiting for the contractor payout rail. It is not connected yet, so nothing has been sent.' },
    { done: false, title: 'Paid and receipted', body: 'Appears here with the PayPal payout id, and the cents are checked against the lock.' },
  ]

  return (
    <section className="panel panel-lime payout-status" aria-live="polite">
      <div className="row between"><h2 className="panel-title">Payout status</h2><Chip tone="need">Reserved · not paid</Chip></div>
      <p className="payout-lead">
        <strong>{dollars(p.amountCents, p.currency)} is approved and reserved for {names(p.payeeId)}, but it has not been sent.</strong>
      </p>
      <p>
        PayPal checkout is for taking money <em>in</em>. A buyer approving it would pay the studio’s own account, not {names(p.payeeId)}, so Mandate does not use it for contractors.
        This payout waits for PayPal Payouts, and nothing on this page can send it the wrong way.
      </p>
      <ol className="steps-list">
        {steps.map((step) => (
          <li key={step.title} className={step.done ? 'done' : step.now ? 'now' : ''}>
            <span className="step-mark" aria-hidden="true">{step.done ? '✓' : step.now ? '…' : ''}</span>
            <div><strong>{step.title}</strong><span>{step.body}</span></div>
          </li>
        ))}
      </ol>
      {p.phase === 'order_created' || p.orderId ? (
        <div className="buyer">
          <p><strong>An old PayPal checkout exists for this request.</strong> An earlier version opened Orders checkout for it. Ignore it and do not approve it in PayPal: it would charge a buyer, not pay {names(p.payeeId)}, and Mandate will not capture it.</p>
          <p className="mono small">Order {p.orderId}</p>
        </div>
      ) : null}
      <div className="row gap-s wrap">
        <Link className="btn btn-ink" to={p.jobId ? `/jobs/${p.jobId}` : '/jobs'}>See the job</Link>
        {funded?.proposalId ? <Link className="btn btn-ghost" to={`/p/${funded.proposalId}`}>Open the client payment →</Link> : null}
      </div>

      <details className="tamper">
        <summary>Integrity check · try to change the amount</summary>
        <form onSubmit={(event) => { event.preventDefault(); if (claimCents !== null) tamper.mutate(claimCents) }} className="row gap-s wrap">
          <label className="field field-inline">
            <span>Claimed amount</span>
            <span className="dollar-input"><span>$</span><input inputMode="decimal" value={claim} onChange={(event) => setClaim(event.target.value)} placeholder={centsInput(p.amountCents * 2 + 7000)} /></span>
          </label>
          <button type="submit" className="btn btn-ghost" disabled={!owner || !online || claimCents === null || tamper.isPending}>Send claim</button>
        </form>
        {refusal ? (
          <div className="refused-claim">
            <Chip tone="deny">{refusal.status} · {refusal.code}</Chip>
            <p>{refusal.code === 'cart.immutable' ? explain(refusal.code, p, warrant, names) : 'Same claim as the locked amount. The payout still waits for the Payouts rail.'}</p>
            <p className="server-words"><span>Server</span>{refusal.detail}</p>
            <NoMoneyMoved />
          </div>
        ) : null}
      </details>
    </section>
  )
}
