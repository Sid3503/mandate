import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Chip, Empty, Hash, Loading, Money, NoMoneyMoved, PageHead, PhaseChip, ProblemCard } from '../components/ui'
import { api } from '../lib/api'
import { relative } from '../lib/format'
import { dollars } from '../lib/money'
import { useCaptures, useIsOwner, useNames, useOnline, useProposals, useRefreshMoney, useWarrant } from '../lib/hooks'
import type { Proposal } from '../lib/types'
import { explain, isPayout, KIND, type Names } from '../lib/words'

export function Inbox() {
  const proposals = useProposals()
  const names = useNames()
  const warrant = useWarrant()
  const captures = useCaptures(proposals.data?.data)
  const [settledHere, setSettledHere] = useState<Record<string, Proposal>>({})
  const rows = proposals.data?.data ?? []
  const waiting = rows.filter((row) => row.phase === 'pending_approval' || settledHere[row.id])
  const ready = rows.filter((row) => ['locked', 'order_created', 'payout_sent', 'payout_unclaimed'].includes(row.phase) && !settledHere[row.id])
  const refused = rows.filter((row) => row.phase === 'denied').slice(0, 4)

  return (
    <div className="page">
      <PageHead
        eyebrow={new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
        title={<>Waiting for you <span className="count">{waiting.filter((row) => !settledHere[row.id]).length}</span></>}
      >
        <Link className="btn btn-ghost hide-phone" to="/new">New request</Link>
      </PageHead>

      {proposals.isLoading ? <Loading /> : null}
      <ProblemCard error={proposals.error} />

      {proposals.data && waiting.length === 0 ? (
        <div data-tour="empty"><Empty title="Nothing needs your tap">Requests at or above the automatic line land here. Everything else is settled or refused by the rules on its own.</Empty></div>
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

      {ready.length > 0 ? (
        <section className="section" data-tour="ready">
          <h2 className="section-title">Approved requests · what happens next</h2>
          <div className="list">
            {ready.map((row) => <Row key={row.id} proposal={row} names={names} />)}
          </div>
        </section>
      ) : null}

      {refused.length > 0 ? (
        <section className="section" data-tour="refused">
          <h2 className="section-title">Refused by the rules</h2>
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

function Row({ proposal, names }: { proposal: Proposal; names: Names }) {
  return (
    <Link to={`/p/${proposal.id}`} className="list-row">
      <span className={`kind kind-${proposal.kind}`}>{KIND[proposal.kind].arrow} {KIND[proposal.kind].short}</span>
      <span className="list-who">{names(proposal.payeeId)}<small>{proposal.description}</small></span>
      <Money cents={proposal.amountCents} />
      <PhaseChip phase={proposal.phase} kind={proposal.kind} />
      <span className="list-go" aria-hidden="true">→</span>
    </Link>
  )
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
  const approve = useMutation({ mutationFn: () => api.approve(proposal.id), onSuccess: (locked) => { onLocked(locked); void refresh() } })
  const reject = useMutation({ mutationFn: () => api.reject(proposal.id), onSuccess: () => void refresh() })
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
