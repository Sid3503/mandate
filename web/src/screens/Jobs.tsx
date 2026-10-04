import { useQueries, useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { Empty, Loading, Money, PageHead, PhaseChip, ProblemCard } from '../components/ui'
import { api } from '../lib/api'
import { useIsOwner, useNames, useProposals } from '../lib/hooks'
import { dollars } from '../lib/money'
import type { Job, Proposal } from '../lib/types'
import type { Names } from '../lib/words'

export function Jobs() {
  const proposals = useProposals()
  const names = useNames()
  const ids = [...new Set((proposals.data?.data ?? []).map((row) => row.jobId).filter((id): id is string => Boolean(id)))]
  const jobs = useQueries({ queries: ids.map((jobId) => ({ queryKey: ['job', jobId], queryFn: () => api.job(jobId) })) })
  return (
    <div className="page">
      <PageHead eyebrow="Money in releases money out" title="Jobs">
        <Link className="btn btn-ghost" to="/new?kind=charge">Bill a client</Link>
      </PageHead>
      {proposals.isLoading ? <Loading /> : null}
      {proposals.data && ids.length === 0 ? <Empty title="No jobs yet">Bill a client for a job. Contractor payouts are funded from what that client actually paid.</Empty> : null}
      <div className="job-cards">
        {jobs.map((query, index) => query.data ? <JobCard key={ids[index]} job={query.data} names={names} /> : <Loading key={ids[index]} />)}
      </div>
    </div>
  )
}

function JobCard({ job, names }: { job: Job; names: Names }) {
  return (
    <Link to={`/jobs/${job.jobId}`} className="job-card">
      <div className="row between"><span className="mono small">{job.jobId}</span><span className="muted small">{job.charges.length} in · {job.payouts.length} out</span></div>
      <h3>{job.client?.displayName ?? names(job.charges[0]?.payeeId)}</h3>
      <Flow totals={job.totals} compact />
    </Link>
  )
}

export function Flow({ totals, compact = false }: { totals: Job['totals']; compact?: boolean }) {
  const base = Math.max(totals.inCents, totals.outCents + totals.heldCents, 1)
  const pct = (cents: number) => `${Math.max(0, (cents / base) * 100)}%`
  return (
    <div className={`flow-bars${compact ? ' compact' : ''}`}>
      <div className="flow-row"><span>In</span><div className="bar"><i className="bar-in" style={{ width: pct(totals.inCents) }} /></div><b>{dollars(totals.inCents)}</b></div>
      <div className="flow-row"><span>Out</span><div className="bar"><i className="bar-out" style={{ width: pct(totals.outCents) }} /><i className="bar-held" style={{ width: pct(totals.heldCents) }} /></div><b>{dollars(totals.outCents)}</b></div>
      {totals.heldCents > 0 ? <div className="flow-row"><span>Held</span><div className="bar"><i className="bar-held" style={{ width: pct(totals.heldCents) }} /></div><b>{dollars(totals.heldCents)}</b></div> : null}
      <div className="flow-row"><span>Kept</span><div className="bar"><i className="bar-kept" style={{ width: pct(totals.keptCents) }} /></div><b>{dollars(totals.keptCents)}</b></div>
    </div>
  )
}

export function JobScreen() {
  const { jobId = '' } = useParams()
  const job = useQuery({ queryKey: ['job', jobId], queryFn: () => api.job(jobId) })
  const names = useNames()
  const owner = useIsOwner()
  if (job.isLoading) return <div className="page"><Loading label="Opening job" /></div>
  if (!job.data) return <div className="page"><ProblemCard error={job.error} /></div>
  const data = job.data
  const share = data.contractorShareBps !== null ? `${data.contractorShareBps / 100}%` : '—'
  const payoutsFor = (charge: Proposal) => data.payouts.filter((payout) => payout.fundingCaptureId && payout.fundingCaptureId === charge.captureId)
  const unfunded = data.payouts.filter((payout) => !data.charges.some((charge) => charge.captureId && charge.captureId === payout.fundingCaptureId))

  return (
    <div className="page">
      <PageHead eyebrow={`Job · ${data.jobId}`} title={data.client?.displayName ?? 'Job'}>
        <Link className="btn btn-ghost" to={`/new?kind=charge&job=${encodeURIComponent(data.jobId)}`}>Bill the next milestone</Link>
      </PageHead>

      <section className="totals">
        <div className="total total-in"><span>Money in</span><Money cents={data.totals.inCents} size="xl" /></div>
        <div className="total total-out"><span>Money out</span><Money cents={data.totals.outCents} size="xl" /></div>
        <div className="total"><span>Held for payouts</span><Money cents={data.totals.heldCents} size="xl" /></div>
        <div className="total total-kept"><span>Kept by the studio</span><Money cents={data.totals.keptCents} size="xl" /></div>
      </section>
      <Flow totals={data.totals} />
      <p className="fine">Contractors are paid only from a client payment that settled on this job, up to {share} of it.</p>

      <section className="section">
        <h2 className="section-title">Client payments and what they fund</h2>
        <div className="stack-l">
          {data.charges.map((charge) => (
            <article key={charge.id} className="charge">
              <div className="charge-head">
                <Link to={`/p/${charge.id}`} className="charge-main">
                  <span className="kind kind-charge">↘ In</span>
                  <strong>{names(charge.payeeId)} · {charge.description}</strong>
                  <Money cents={charge.amountCents} size="lg" />
                </Link>
                <PhaseChip phase={charge.phase} />
              </div>
              <div className="charge-funds">
                {charge.phase === 'captured' ? (
                  <>
                    <span className="mono small">{charge.captureId}</span>
                    <span>can still fund <strong>{dollars(charge.fundableCents)}</strong></span>
                    {owner && charge.fundableCents > 0 ? <Link className="btn btn-lime" to={`/new?kind=payment&funding=${encodeURIComponent(charge.captureId ?? '')}`}>Pay a contractor from this</Link> : null}
                  </>
                ) : <span className="muted">Not settled yet, so it funds nothing.</span>}
              </div>
              {payoutsFor(charge).length > 0 ? (
                <ul className="payouts">
                  {payoutsFor(charge).map((payout) => (
                    <li key={payout.id}>
                      <Link to={`/p/${payout.id}`}>
                        <span className="kind kind-payment">↗ Out</span>
                        <span>{names(payout.payeeId)}</span>
                        <Money cents={payout.amountCents} />
                        <PhaseChip phase={payout.phase} />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      {unfunded.length > 0 ? (
        <section className="section">
          <h2 className="section-title">Payouts with nothing behind them</h2>
          <ul className="payouts">
            {unfunded.map((payout) => (
              <li key={payout.id}><Link to={`/p/${payout.id}`}><span className="kind kind-payment">↗ Out</span><span>{names(payout.payeeId)}</span><Money cents={payout.amountCents} /><PhaseChip phase={payout.phase} /></Link></li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.refunds.length > 0 ? (
        <section className="section">
          <h2 className="section-title">Refunds</h2>
          <ul className="payouts">
            {data.refunds.map((refund) => (
              <li key={refund.id}><Link to={`/p/${refund.id}`}><span className="kind kind-refund">↩ Refund</span><span>{names(refund.payeeId)}</span><Money cents={refund.amountCents} /><PhaseChip phase={refund.phase} /></Link></li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
