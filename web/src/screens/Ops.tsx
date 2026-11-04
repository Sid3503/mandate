import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ActivityTabs } from '../components/ActivityTabs'
import { Chip, Loading, PageHead, ProblemCard } from '../components/ui'
import { api } from '../lib/api'
import type { BreakRow } from '../lib/breaks'
import { disputesApi } from '../lib/disputes'
import { useIsOwner, useToday } from '../lib/hooks'
import { dollars } from '../lib/money'

const REFUND_RULES = new Set(['refund.not_made', 'refund.awaiting_owner', 'refund.pending_stale', 'refund.exceeds'])

/**
 * One page for the money that needs a person: open breaks, open disputes, refunds not yet made,
 * and whether the PayPal log is healthy. It only reads. The desks it links to are where anything is asked.
 */
export function Ops() {
  const owner = useIsOwner()
  const breaks = useQuery({ queryKey: ['breaks'], queryFn: () => api.breaks(), enabled: owner, refetchInterval: 30_000 })
  const disputes = useQuery({ queryKey: ['disputes'], queryFn: disputesApi.list, enabled: owner, refetchInterval: 60_000 })
  const log = useQuery({ queryKey: ['paypal-log'], queryFn: api.paypalLog, enabled: owner, refetchInterval: 30_000 })
  const today = useToday()
  if (!owner) return <div className="page"><ActivityTabs /><PageHead eyebrow="Money at risk" title="Owner only" /><p className="muted">This page reads the whole ledger, so it opens with the owner key.</p></div>
  if (breaks.isLoading || disputes.isLoading || log.isLoading) return <div className="page page-wide"><ActivityTabs /><Loading label="Opening money at risk" /></div>
  const open = (breaks.data?.data ?? []).filter((row) => row.state === 'open')
  const refunds = open.filter((row) => REFUND_RULES.has(row.rule))
  const openDisputes = (disputes.data?.data ?? []).filter((row) => row.status !== 'RESOLVED' && row.response !== 'sent')
  const trouble = (log.data?.counts.attemptsFailed ?? 0) + (log.data?.counts.attemptsUnknown ?? 0) + (log.data?.counts.webhooksFailed ?? 0) + (log.data?.counts.webhooksStuck ?? 0)
  const feed = [...open].sort((a, b) => severityRank(a) - severityRank(b) || Math.abs(b.deltaCents ?? 0) - Math.abs(a.deltaCents ?? 0)).slice(0, 8)
  return (
    <div className="page page-wide" data-testid="ops-desk">
      <ActivityTabs />
      <PageHead eyebrow="Breaks, disputes and refunds still open · nothing on this page moves money" title="Money at risk">
        <Link to="/breaks" className="btn">Open the Breaks desk</Link>
      </PageHead>
      <ProblemCard error={breaks.error ?? disputes.error ?? log.error} />
      <div className="breaks-kpis ops-kpis" data-testid="ops-kpis">
        <Kpi label="Open breaks" value={String(breaks.data?.kpis.open ?? 0)} />
        <Kpi label="Money at stake" value={dollars(breaks.data?.kpis.moneyAtStakeCents ?? 0)} />
        <Kpi label="Refunds not finished" value={String(refunds.length)} />
        <Kpi label="Disputes still to answer" value={String(openDisputes.length)} />
        <Kpi label="Waiting for your tap" value={String(today.data?.waiting.length ?? breaks.data?.kpis.waitingOnYou ?? 0)} />
        <Kpi label="PayPal log needs a look" value={String(trouble)} />
      </div>
      <div className="stack">
        <section className="panel" aria-label="What to look at">
          <h2 className="panel-title">Look at these first</h2>
          {feed.length === 0 ? <p className="fine">No open break. The books and the last PayPal compare agree on everything checked.</p> : (
            <ul className="ops-feed">
              {feed.map((row) => (
                <li key={row.key}>
                  <Link to={`/breaks?key=${encodeURIComponent(row.key)}`}>
                    <Chip tone={row.severity === 'critical' ? 'deny' : row.severity === 'warning' ? 'need' : 'muted'}>{row.severity}</Chip>{' '}
                    {row.title}
                    {row.deltaCents !== null ? <span className="muted"> · {dollars(Math.abs(row.deltaCents))}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel" aria-label="Disputes still to answer">
          <div className="row between"><h2 className="panel-title">Disputes</h2><Link to="/disputes">All disputes</Link></div>
          {openDisputes.length === 0 ? <p className="fine">No dispute is waiting for an answer. A person still approves every response that does get sent.</p> : (
            <ul className="ops-feed">
              {openDisputes.slice(0, 6).map((row) => (
                <li key={row.id}><Link to={`/disputes/${encodeURIComponent(row.id)}`}>{row.id}</Link> <span className="muted">{row.reason ?? row.status}{row.amountCents !== null ? ` · ${dollars(row.amountCents, row.currency ?? 'USD')}` : ''}</span></li>
              ))}
            </ul>
          )}
          <p className="fine">A response is written from the signed records. A tracking link can be cited. Arrival is never claimed from a URL, because Mandate does not ask the carrier. You approve the text before it is sent.</p>
        </section>
        <section className="panel" aria-label="PayPal log">
          <div className="row between"><h2 className="panel-title">PayPal log</h2><Link to="/ledger?tab=log">Open the log</Link></div>
          <p className="fine">{log.data?.counts.attempts ?? 0} money-moving calls, {log.data?.counts.webhooks ?? 0} webhook deliveries. {log.data?.webhookConfigured ? 'Deliveries are signature-checked.' : 'Webhook signing is not configured, so a delivery is re-read from PayPal before it changes a request.'} Reconcile on the Breaks desk compares 90 days, in the 31-day windows PayPal allows. The activity tab can look back 180.</p>
        </section>
      </div>
    </div>
  )
}

function severityRank(row: BreakRow): number {
  return row.severity === 'critical' ? 0 : row.severity === 'warning' ? 1 : 2
}

function Kpi({ label, value }: { label: string; value: string }) {
  return <div className="breaks-kpi"><span className="kv-k">{label}</span><strong>{value}</strong></div>
}
