import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { BalanceNote } from '../components/PayPalFeatures'
import { Signature } from '../components/Signature'
import { useToast } from '../components/Toast'
import { Chip, GateChip, Hash, KV, Loading, Money, NoMoneyMoved, PageHead, PhaseChip, ProblemCard } from '../components/ui'
import { api, ApiError } from '../lib/api'
import { when } from '../lib/format'
import { useIsOwner, useNames, useOnline, useRefreshMoney, useVersions } from '../lib/hooks'
import { centsInput, dollars, parseCents } from '../lib/money'
import type { LedgerEvent, Packet, Warrant } from '../lib/types'
import { AGENT_LABEL, EVENT, explain, isPayout, KIND, type Names } from '../lib/words'

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
      <PageHead eyebrow={`Receipt · ${kind.label} · rules v${p.warrantVersion}`} title={<>{dollars(p.amountCents, p.currency)} <span className="title-sub">{p.payeeId ? `${verb} ${names(p.payeeId)}` : 'to an account not on the rules'}</span></>}>
        <PhaseChip phase={p.phase} kind={p.kind} />
      </PageHead>

      <div className="receipt-grid">
        <div className="stack-l">
          <section className="panel" data-tour="receipt-decision">
            <div className="row between"><h2 className="panel-title">The decision</h2><GateChip gate={p.gate} /></div>
            <p className="decision-words">{explain(p.clause, p, warrant, names)}</p>
            <p className="server-words"><span>Server · {p.clause}</span>{p.detail}</p>
            {p.gate === 'DENY' ? <NoMoneyMoved /> : null}
            {p.gate === 'DENY' && data.whatWouldPass && data.whatWouldPass.length > 0 ? (
              <div className="would-pass" data-testid="would-pass">
                <strong>What would pass</strong>
                <ul>{data.whatWouldPass.map((option) => <li key={option.text}>{option.text}{option.tested ? <span className="fine"> Tested against the rules.</span> : null}</li>)}</ul>
              </div>
            ) : null}
          </section>

          {data.dispute ? (
            <section className="panel panel-warn" role="alert">
              <div className="row between"><h2 className="panel-title">Disputed at PayPal</h2><Chip tone="deny">{data.dispute.status.replaceAll('_', ' ').toLowerCase()}</Chip></div>
              <p><strong>{isPayout(p) ? 'The client payment behind this payout is under dispute.' : 'The client has disputed this payment.'}</strong>{data.dispute.reason ? ` Reason: ${data.dispute.reason.replaceAll('_', ' ').toLowerCase()}.` : ''}</p>
              <p className="fine">{isPayout(p) ? 'Mandate will not send money that may be taken back. The payout waits until PayPal resolves the dispute.' : 'Payouts that depend on this payment are held until PayPal resolves the dispute.'}</p>
            </section>
          ) : null}

          {isPayout(p) ? <PayoutPanel packet={data} warrant={warrant} names={names} /> : <Settle packet={data} warrant={warrant} names={names} />}

          <section className="panel" data-tour="receipt-asked">
            <h2 className="panel-title">What was asked</h2>
            {data.prompt ? <p className="quote big">“{data.prompt}”</p> : <p className="muted">No sentence was recorded.</p>}
            {data.agentRun ? <AgentTrace run={data.agentRun} /> : null}
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
          <section className="panel panel-ink" data-tour="receipt-lock">
            <h2 className="panel-title">The lock</h2>
            <Hash value={p.cartHash} full />
            <p className="fine">SHA-256 over payee, cents, currency, category, proof{p.jobId ? ', job' : ''}{p.fundingCaptureId ? ' and funding capture' : ''}. Settlement recomputes it and refuses on any difference.</p>
            {p.cartHash ? <div className="panel-ink-sig"><Signature kind="lock" id={p.id} signature={p.lockSignature} keyId={p.lockKeyId} receipt={data} /></div> : null}
            <div className="match">
              <div><span>Approved</span><Money cents={data.amounts.approvedCents} size="lg" /></div>
              <div><span>{p.kind === 'payment' ? 'Paid' : 'Settled'}</span><Money cents={data.amounts.capturedCents} size="lg" /></div>
              <div className={`match-flag${data.amounts.match ? ' ok' : ''}`}>{data.amounts.match === null ? (p.kind === 'payment' ? 'not paid' : 'not settled') : data.amounts.match ? 'cents match ✓' : 'mismatch'}</div>
            </div>
          </section>

          {data.funding ? (
            <section className="panel" data-tour="receipt-funding">
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

          <section className="panel" data-tour="receipt-paypal">
            <h2 className="panel-title">PayPal</h2>
            <div className="kvs">
              {p.kind === 'payment' ? (
                <>
                  <KV label="Payout batch" mono>{data.payout?.batchId ?? '—'}</KV>
                  <KV label="Transaction" mono>{data.payout?.transactionId ?? '—'}</KV>
                  <KV label="PayPal says">{data.payout?.status ?? 'not sent'}</KV>
                  {data.payout?.feeCents != null ? <KV label="PayPal fee">{dollars(data.payout.feeCents)} (charged to the studio)</KV> : null}
                </>
              ) : (
                <>
                  {data.invoice ? <KV label="Invoice" mono>{data.invoice.id}</KV> : <KV label="Order" mono>{p.orderId ?? '—'}</KV>}
                  {data.invoice ? <KV label="Invoice is">{data.invoice.status ?? '—'}</KV> : null}
                  <KV label="Capture" mono>{p.captureId ?? '—'}</KV>
                </>
              )}
              {p.refundId ? <KV label="Refund" mono>{p.refundId}</KV> : null}
            </div>
            {(p.phase === 'captured' && p.kind !== 'refund') ? (
              <Link className="btn btn-ghost" to={`/new?kind=refund&parent=${encodeURIComponent(p.captureId ?? '')}`}>Propose a refund →</Link>
            ) : null}
          </section>

          <section className="panel" data-tour="receipt-timeline">
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
          <li key={event.id} className={refused ? 'is-refused' : event.type === 'capture.completed' || event.type === 'payout.completed' || event.type === 'invoice.sent' || event.type === 'proposal.approved' ? 'is-good' : event.type === 'payout.failed' ? 'is-refused' : ''}>
            <span className="tl-dot" aria-hidden="true" />
            <div>
              <div className="row between gap-s"><strong>{EVENT[event.type] ?? event.type}</strong><span className="mono muted small">{when(event.createdAt)}</span></div>
              <div className="tl-meta">
                {event.clause && (refused || event.type === 'proposal.created') ? <code>{event.clause}</code> : null}
                {typeof event.payload.actor === 'string' ? <span>by {event.payload.actor}</span> : null}
                {typeof event.payload.claimedAmountCents === 'number' ? <span>claimed {dollars(event.payload.claimedAmountCents)} · lock {dollars(Number(event.payload.lockedAmountCents))}</span> : null}
                {typeof event.payload.captureId === 'string' ? <span className="mono">{event.payload.captureId}</span> : null}
                {typeof event.payload.orderId === 'string' && event.type === 'order.created' ? <span className="mono">{event.payload.orderId}</span> : null}
                {event.type.startsWith('payout.') && typeof event.payload.status === 'string' ? <span>PayPal: {event.payload.status}</span> : null}
                {event.type.startsWith('payout.') && typeof event.payload.batchId === 'string' ? <span className="mono">{event.payload.batchId}</span> : null}
                {typeof event.payload.error === 'string' ? <span>{event.payload.error}</span> : null}
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
  const toast = useToast()
  const settle = useMutation({ mutationFn: () => api.capture(p.id), onSuccess: (done) => { if (done.phase === 'captured') toast({ title: `Settled ${dollars(done.amountCents)}`, body: 'PayPal confirmed it. The cents match the lock.' }); else if (done.phase === 'invoice_sent') toast({ title: 'Invoice sent', body: 'It settles when the client pays it.', tone: 'info' }) }, onSettled: () => { setCheckedAt(new Date()); void refresh() } })
  const tamper = useMutation({
    mutationFn: (cents: number) => api.capture(p.id, cents),
    onSettled: () => void refresh(),
  })
  // PayPal sends the buyer back here after they approve. Settle at once, so nobody has to find the button.
  const [params, setParams] = useSearchParams()
  const returned = params.get('paypal')
  const auto = useRef(false)
  useEffect(() => {
    if (returned !== 'return' || auto.current || !owner || p.phase !== 'order_created') return
    auto.current = true
    settle.mutate(undefined, { onSettled: () => setParams({}, { replace: true }) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returned, owner, p.phase])
  const settleable = p.phase === 'locked' || p.phase === 'order_created' || p.phase === 'invoice_draft' || p.phase === 'invoice_sent'
  if (!settleable) return null
  if (p.phase === 'invoice_draft' || p.phase === 'invoice_sent') return <InvoicePanel packet={packet} names={names} />
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
    <section className="panel panel-lime" data-tour="receipt-action">
      <div className="row between"><h2 className="panel-title">Settle with PayPal</h2><Chip tone="ink">{p.kind === 'refund' ? 'Payments v2 refund' : 'Orders v2 · money in'}</Chip></div>
      {p.clause === 'standing.billing' ? <p className="standing-note" role="status"><Chip tone="auto">Billing rule</Chip> Your rule for signed-deal milestones covers this, so Mandate sends the invoice itself. If it is still here, PayPal could not be reached or the client has not approved the checkout, and it retries every minute.</p> : null}
      <p>
        PayPal will be asked for exactly <strong>{dollars(p.amountCents, p.currency)}</strong>
        {p.kind === 'charge' ? <> from {names(p.payeeId)}</> : <> back to {names(p.payeeId)}</>}.
        The server reads the live PayPal order first and refuses if the amount, currency or reference differ from the lock.
      </p>
      {returned === 'cancel' && p.phase === 'order_created' ? (
        <div className="still-waiting" role="status"><Chip tone="need">Not approved</Chip><span>You left PayPal without approving, so <strong>nothing was captured and $0 moved</strong>. Open PayPal again when you are ready.</span></div>
      ) : null}
      {pending || (p.phase === 'order_created' && approveUrl) ? (
        <div className="buyer" aria-live="polite">
          <p><strong>Step 1 of 2 · the PayPal buyer approves.</strong> {p.kind === 'charge' ? `${names(p.payeeId)}’s account` : 'The buyer'} has to approve this {dollars(p.amountCents)} order on PayPal. Mandate cannot do it for them.</p>
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
 * Money out. A contractor is paid through PayPal Payouts, straight to their own PayPal account, never through
 * Orders checkout (which would pay the studio). The panel follows the payout from locked to paid.
 */
function PayoutPanel({ packet, warrant, names }: { packet: Packet; warrant: Warrant | undefined; names: Names }) {
  const p = packet.proposal
  const owner = useIsOwner()
  const online = useOnline()
  const refresh = useRefreshMoney()
  const [claim, setClaim] = useState('')
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const toast = useToast()
  const send = useMutation({ mutationFn: () => api.capture(p.id), onSuccess: (done) => { if (done.phase === 'captured') toast({ title: `Paid ${dollars(done.amountCents)}`, body: 'PayPal confirmed it reached the account.' }); else if (done.phase === 'payout_sent') toast({ title: 'Sent to PayPal', body: 'Not paid until PayPal says so.', tone: 'info' }) }, onSettled: () => { setCheckedAt(new Date()); void refresh() } })
  const cancel = useMutation({ mutationFn: () => api.reject(p.id), onSuccess: () => toast({ title: 'Payout cancelled', body: 'Nothing was sent.', tone: 'info' }), onSettled: () => void refresh() })
  const returnMoney = useMutation({ mutationFn: () => api.cancelPayout(p.id), onSuccess: () => toast({ title: 'Payout cancelled', body: 'PayPal returned the money. Nothing is counted as paid.', tone: 'info' }), onSettled: () => void refresh() })
  const tamper = useMutation({ mutationFn: (cents: number) => api.capture(p.id, cents), onSettled: () => void refresh() })
  const viaStanding = p.clause === 'standing.matched'
  const unsent = p.phase === 'locked' || p.phase === 'order_created' || p.phase === 'capture_inflight'
  const atPayPal = p.phase === 'payout_sent' || p.phase === 'payout_unclaimed'
  if (!unsent && !atPayPal && p.phase !== 'payout_failed' && p.phase !== 'captured') return null

  const who = names(p.payeeId)
  const receiver = packet.payout?.receiver ?? packet.payee?.email ?? null
  const funded = packet.funding
  const failure = [...packet.events].reverse().find((event) => event.type === 'payout.failed')
  const reason = typeof failure?.payload.error === 'string' ? failure.payload.error : p.payoutStatus ?? 'unknown'
  const claimCents = parseCents(claim)
  const refusal = tamper.error instanceof ApiError ? tamper.error : null
  const disabled = !owner || !online || send.isPending || cancel.isPending
  const chip = p.phase === 'captured' ? { tone: 'auto' as const, label: 'Paid' }
    : p.phase === 'payout_failed' ? { tone: 'deny' as const, label: 'Payout failed' }
    : p.phase === 'payout_unclaimed' ? { tone: 'need' as const, label: 'Sent · unclaimed' }
    : p.phase === 'payout_sent' ? { tone: 'need' as const, label: 'Sent · PayPal processing' }
    : { tone: 'ink' as const, label: 'Ready to send' }
  const sent = Boolean(p.payoutBatchId)
  const waitingNote = viaStanding && unsent ? [...packet.events].reverse().find((event) => event.type === 'standing.waiting') : undefined
  const paid = p.phase === 'captured'
  const steps: Array<{ state: 'done' | 'now' | 'todo'; title: string; body: string }> = [
    { state: 'done', title: 'Asked', body: packet.events[0]?.payload.actor === 'autopilot' ? 'Autopilot asked, because the client’s payment settled and your standing rule covers this payout.' : packet.events[0]?.payload.actor === 'proposer' ? 'An agent’s key proposed this.' : 'Proposed with the owner key.' },
    { state: 'done', title: 'Rules checked', body: viaStanding ? `${who} is covered by a standing rule you signed, and every other rule passed.` : `${who} is on the rules, and ${dollars(p.amountCents)} is at or above the automatic line.` },
    { state: funded && funded.phase === 'captured' ? 'done' : 'todo', title: 'Funded by the client', body: funded ? `${names(funded.clientId)}’s ${dollars(funded.capturedCents)} payment settled, so this payout is covered.` : 'No client payment is cited.' },
    { state: 'done', title: viaStanding ? 'Locked under your standing rule · no tap' : 'Approved and locked', body: `Payee, ${dollars(p.amountCents)}, category, proof, job and funding are fixed in the lock.` },
    { state: sent ? 'done' : 'now', title: `Sent to ${who} through PayPal Payouts`, body: sent ? `PayPal batch ${p.payoutBatchId}.` : `Not sent yet. Press send below${receiver ? ` to pay ${receiver}` : ''}.` },
    { state: paid ? 'done' : sent && p.phase !== 'payout_failed' ? 'now' : 'todo', title: 'Paid and receipted', body: paid ? `PayPal says SUCCESS. Transaction ${p.payoutTransactionId ?? '—'}, and the cents match the lock.` : p.phase === 'payout_failed' ? `PayPal did not pay it (${reason}).` : 'Appears here when PayPal confirms the money reached the account.' },
  ]

  return (
    <section className="panel panel-lime payout-status" aria-live="polite" data-tour="receipt-action">
      <div className="row between"><h2 className="panel-title">{paid ? 'Paid' : unsent ? 'Send the payout' : 'Payout status'}</h2><Chip tone={chip.tone}>{chip.label}</Chip></div>
      {paid ? (
        <p className="payout-lead"><strong>{dollars(p.amountCents, p.currency)} reached {who}’s PayPal account{receiver ? ` (${receiver})` : ''}.</strong> PayPal confirmed it as SUCCESS and the cents match the lock.</p>
      ) : p.phase === 'payout_failed' ? (
        <>
          <p className="payout-lead"><strong>PayPal did not pay {who}.</strong></p>
          <p>PayPal reported <code>{reason}</code>. Nothing is counted as paid and the reservation is released, so this can be proposed again.</p>
        </>
      ) : p.phase === 'payout_unclaimed' ? (
        <>
          <p className="payout-lead"><strong>Sent, but {who} has not received it.</strong></p>
          <p>PayPal found no account for {receiver ?? 'that email'}. It holds the {dollars(p.amountCents)} for the receiver to claim, so Mandate does not count it as paid. Correct the payee’s PayPal email in the rules and ask again, or press check if they sign up.</p>
        </>
      ) : p.phase === 'payout_sent' ? (
        <>
          <p className="payout-lead"><strong>PayPal has the payout and is still processing it.</strong></p>
          <p>It is not paid until PayPal says so. Press check to ask PayPal again. This page never guesses.</p>
        </>
      ) : (
        <>
          <p className="payout-lead"><strong>Send exactly {dollars(p.amountCents, p.currency)} to {who}{receiver ? `’s PayPal account (${receiver})` : ''}.</strong></p>
          {viaStanding ? (
            <p className="standing-note" role="status">
              <Chip tone="auto">Standing rule</Chip> Mandate sends this itself, without a tap{waitingNote ? <>, but it is held for now: <strong>{String(waitingNote.payload.code ?? 'waiting')}</strong>. It tries again every minute</> : null}. You can also send it now.
            </p>
          ) : null}
          <p>
            This uses PayPal Payouts, which pays {who}’s own account. PayPal checkout is for taking money <em>in</em>: a buyer approving it would pay the studio, so Mandate never uses it for a contractor.
            The server sends the locked cents and reads the result back from PayPal before it says paid.
          </p>
        </>
      )}
      <ol className="steps-list">
        {steps.map((step) => (
          <li key={step.title} className={step.state === 'done' ? 'done' : step.state === 'now' ? 'now' : ''}>
            <span className="step-mark" aria-hidden="true">{step.state === 'done' ? '✓' : step.state === 'now' ? '…' : ''}</span>
            <div><strong>{step.title}</strong><span>{step.body}</span></div>
          </li>
        ))}
      </ol>
      {p.orderId && !sent ? (
        <div className="buyer">
          <p><strong>An old PayPal checkout exists for this request.</strong> An earlier version opened Orders checkout for it. Do not approve it in PayPal: it would charge a buyer, not pay {who}. Mandate will never capture it. Sending the payout ignores it, and cancelling this payout voids it.</p>
          <p className="mono small">Order {p.orderId}</p>
        </div>
      ) : null}
      {unsent ? <BalanceNote needCents={p.amountCents} /> : null}
      {unsent || atPayPal ? (
        <div className="row gap-s wrap">
          <button type="button" className="btn btn-ink btn-big" disabled={disabled} onClick={() => send.mutate()}>
            {send.isPending ? 'Asking PayPal…' : atPayPal ? 'Check PayPal' : `Send ${dollars(p.amountCents)} to ${who}`}
          </button>
          {unsent ? <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => cancel.mutate()}>{cancel.isPending ? 'Cancelling…' : 'Cancel this payout'}</button> : null}
          {p.phase === 'payout_unclaimed' ? <button type="button" className="btn btn-ghost" disabled={disabled || returnMoney.isPending} onClick={() => returnMoney.mutate()}>{returnMoney.isPending ? 'Asking PayPal…' : 'Cancel and return the money'}</button> : null}
          {!owner ? <p className="fine">Only the owner key can send or cancel.</p> : null}
        </div>
      ) : (
        <div className="row gap-s wrap">
          <Link className="btn btn-ink" to={p.jobId ? `/jobs/${p.jobId}` : '/jobs'}>See the job</Link>
          {funded?.proposalId ? <Link className="btn btn-ghost" to={`/p/${funded.proposalId}`}>Open the client payment →</Link> : null}
        </div>
      )}
      {atPayPal && checkedAt && send.isSuccess && !send.isPending ? (
        <div className="still-waiting" role="status">
          <Chip tone="need">{p.phase === 'payout_unclaimed' ? 'Still unclaimed' : 'Still processing'}</Chip>
          <span>Checked PayPal at {checkedAt.toLocaleTimeString('en-US')}. PayPal says <strong>{p.payoutStatus ?? 'PENDING'}</strong>.</span>
        </div>
      ) : null}
      <ProblemCard error={send.error ?? cancel.error} />

      {unsent ? (
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
              <p>{explain(refusal.code, p, warrant, names)}</p>
              <p className="server-words"><span>Server</span>{refusal.detail}</p>
              <NoMoneyMoved />
            </div>
          ) : null}
          {tamper.isSuccess ? <p className="fine">The claim matched the lock, so the payout was sent normally.</p> : null}
        </details>
      ) : null}
    </section>
  )
}

/** A client charge billed as a PayPal invoice. It is settled only when PayPal says the client paid it. */
function InvoicePanel({ packet, names }: { packet: Packet; names: Names }) {
  const p = packet.proposal
  const online = useOnline()
  const refresh = useRefreshMoney()
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const toast = useToast()
  const check = useMutation({ mutationFn: () => api.capture(p.id), onSuccess: (done) => { if (done.phase === 'captured') toast({ title: `Paid ${dollars(done.amountCents)}`, body: 'PayPal says the client paid the invoice.' }) }, onSettled: () => { setCheckedAt(new Date()); void refresh() } })
  const owner = useIsOwner()
  const remind = useMutation({ mutationFn: () => api.remindInvoice(p.id), onSuccess: () => toast({ title: 'Reminder sent', body: 'PayPal emailed the client about the invoice.', tone: 'info' }), onSettled: () => void refresh() })
  const voidIt = useMutation({ mutationFn: () => api.cancelInvoice(p.id), onSuccess: () => toast({ title: 'Invoice cancelled', body: 'It can no longer be paid. The milestone can be billed again.', tone: 'info' }), onSettled: () => void refresh() })
  const url = packet.invoice?.url ?? p.invoiceUrl
  return (
    <section className="panel panel-lime" data-tour="receipt-action" aria-live="polite">
      <div className="row between"><h2 className="panel-title">Waiting for {names(p.payeeId)} to pay</h2><Chip tone="need">Invoice {packet.invoice?.status?.toLowerCase() ?? 'sent'}</Chip></div>
      <p className="payout-lead"><strong>PayPal sent {names(p.payeeId)} an invoice for {dollars(p.amountCents, p.currency)}.</strong></p>
      <p>It is settled only when PayPal says the client paid exactly that amount. Nothing on this page can mark it paid.</p>
      <div className="row gap-s wrap">
        {url ? <a className="btn btn-ink" href={url} target="_blank" rel="noreferrer noopener">Open the invoice ↗</a> : null}
        <button type="button" className="btn btn-ghost" disabled={!owner || !online || check.isPending} onClick={() => check.mutate()}>{check.isPending ? 'Asking PayPal…' : 'Check PayPal'}</button>
        {p.phase === 'invoice_sent' ? <button type="button" className="btn btn-ghost" disabled={!owner || !online || remind.isPending} onClick={() => remind.mutate()}>{remind.isPending ? 'Sending…' : 'Send a reminder'}</button> : null}
        {p.phase === 'invoice_sent' ? <button type="button" className="btn btn-ghost" disabled={!owner || !online || voidIt.isPending} onClick={() => voidIt.mutate()}>{voidIt.isPending ? 'Cancelling…' : 'Cancel this invoice'}</button> : null}
      </div>
      {checkedAt && check.isSuccess && !check.isPending && p.phase !== 'captured' ? (
        <div className="still-waiting" role="status"><Chip tone="need">Still waiting</Chip><span>Checked PayPal at {checkedAt.toLocaleTimeString('en-US')}. The invoice has not been paid in full, so <strong>nothing is settled and $0 moved</strong>.</span></div>
      ) : null}
      <ProblemCard error={check.error ?? remind.error ?? voidIt.error} />
    </section>
  )
}

/** The chat behind a request an agent asked for: who said what, and every tool the agent used. */
function AgentTrace({ run }: { run: NonNullable<Packet['agentRun']> }) {
  const owner = useIsOwner()
  const [open, setOpen] = useState(false)
  const trace = useQuery({ queryKey: ['agent-run', run.id], queryFn: () => api.agentRun(run.id), enabled: open && owner })
  return (
    <div className="agent-trace" data-tour="receipt-agent">
      <div className="row between wrap gap-s"><span className="eyebrow">Asked through the {AGENT_LABEL[run.agent] ?? run.agent}</span><Chip tone="muted">{run.model}</Chip></div>
      <p className="fine">The agent’s reply: {run.output ?? '—'}</p>
      {owner ? <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide every step' : 'Show every step the agent took'}</button> : null}
      {open ? (
        <ol className="trace">
          {(trace.data?.trace ?? []).flatMap((step, index) => [
            ...step.toolCalls.map((call, i) => <li key={`c${index}${i}`}><b>asked</b> <code>{call.tool}</code> <span className="mono small">{JSON.stringify(call.input).slice(0, 160)}</span></li>),
            ...step.toolResults.map((result, i) => <li key={`r${index}${i}`} className={result.ok ? '' : 'bad'}><b>{result.ok ? 'rules said' : 'error'}</b> <span className="mono small">{JSON.stringify(result.output).slice(0, 200)}</span></li>),
          ])}
        </ol>
      ) : null}
    </div>
  )
}
