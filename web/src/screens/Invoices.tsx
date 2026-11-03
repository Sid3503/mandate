import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ActivityTabs } from '../components/ActivityTabs'
import { NotesToInvoice } from '../components/NotesToInvoice'
import { Chip, Loading, PageHead, ProblemCard } from '../components/ui'
import { api } from '../lib/api'
import { when } from '../lib/format'
import { useIsOwner, useNarrow } from '../lib/hooks'
import type { InvoiceRow, InvoicesList, InvoiceStatus } from '../lib/invoices'
import { dollars } from '../lib/money'

const FILTERS: Array<{ id: 'all' | InvoiceStatus; label: string }> = [
  { id: 'all', label: 'All' }, { id: 'draft', label: 'Draft' }, { id: 'approved', label: 'Approved' }, { id: 'sent', label: 'Sent' },
  { id: 'part_paid', label: 'Part paid' }, { id: 'overdue', label: 'Overdue' }, { id: 'paid', label: 'Paid' },
  { id: 'cancelled', label: 'Cancelled' }, { id: 'declined', label: 'Declined' }, { id: 'reversed', label: 'Reversed' },
]
const WORDS: Record<InvoiceStatus, string> = { draft: 'Draft', approved: 'Approved', sent: 'Sent', part_paid: 'Part paid', paid: 'Paid', overdue: 'Overdue', cancelled: 'Cancelled', declined: 'Declined', reversed: 'Reversed' }
const TONE: Record<InvoiceStatus, 'deny' | 'auto' | 'need' | 'muted'> = { draft: 'muted', approved: 'muted', sent: 'need', part_paid: 'need', paid: 'auto', overdue: 'deny', cancelled: 'muted', declined: 'deny', reversed: 'deny' }

export function Invoices() {
  const owner = useIsOwner()
  const narrow = useNarrow()
  const [status, setStatus] = useState<'all' | InvoiceStatus>('all')
  const [query, setQuery] = useState('')
  const list = useQuery({
    queryKey: ['invoices', status, query.trim()],
    queryFn: () => api.invoices({ status: status === 'all' ? undefined : status, q: query.trim() || undefined }),
    enabled: owner,
    refetchInterval: 30_000,
    placeholderData: (previous) => previous,
  })
  // The job names the notes box suggests come from every bill, not only the filtered ones.
  const everything = useQuery({ queryKey: ['invoices', 'all', ''], queryFn: () => api.invoices(), enabled: owner && (status !== 'all' || query.trim() !== '') })
  const source = everything.data ?? list.data
  const jobIds = [...new Set((source?.data ?? []).map((row) => row.jobId).filter((id): id is string => Boolean(id)))]

  if (!owner) return <div className="page"><PageHead eyebrow="Owner only" title="Invoices" /><p className="fine">Only the owner can see the Invoices desk.</p></div>
  if (list.isLoading) return <div className="page"><Loading label="Opening the Invoices desk" /></div>
  const data = list.data
  const kpis = data?.kpis
  const currency = kpis?.currency ?? 'USD'

  return (
    <div className="page page-wide" data-testid="invoices-desk">
      <ActivityTabs />
      <PageHead eyebrow="Every bill, from the books · the rules decide, this desk only reads" title="Invoices" />
      <ProblemCard error={list.error} />
      <div className="breaks-kpis inv-kpis" data-testid="invoice-kpis">
        <Kpi label="Invoiced" value={dollars(kpis?.invoicedCents ?? 0, currency)} sub={`${kpis?.invoicedCount ?? 0} live or paid`} />
        <Kpi label="Paid" value={dollars(kpis?.paidCents ?? 0, currency)} sub="PayPal confirmed" />
        <Kpi label="Outstanding" value={dollars(kpis?.outstandingCents ?? 0, currency)} sub={`${kpis?.outstandingCount ?? 0} unpaid`} />
        <Kpi label="Overdue" value={`${kpis?.overdueCount ?? 0}`} sub={dollars(kpis?.overdueCents ?? 0, currency)} tone={kpis && kpis.overdueCount > 0 ? 'deny' : undefined} />
        <Kpi label="Average days to pay" value={kpis?.avgDaysToPay === null || kpis?.avgDaysToPay === undefined ? '—' : String(kpis.avgDaysToPay)} sub={kpis?.paidSample ? `from ${kpis.paidSample} paid` : 'nothing paid yet'} />
      </div>

      <div className="inv-side-by-side">
        <Outlook data={data} />
        <Guardrails data={data} />
      </div>

      <NotesToInvoice jobIds={jobIds} />

      <div className="grid-tools">
        <div className="chips-row" role="group" aria-label="Status">
          {FILTERS.map((item) => (
            <button key={item.id} type="button" aria-pressed={status === item.id} className={`filter${status === item.id ? ' on' : ''}`} onClick={() => setStatus(item.id)} data-testid={`filter-${item.id}`}>
              {item.label} <span className="mono">{data?.counts[item.id] ?? 0}</span>
            </button>
          ))}
        </div>
        <label className="field inv-search"><span className="sr-only">Search invoices</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search client, job or item" aria-label="Search invoices" data-testid="invoice-search" />
        </label>
      </div>

      {(data?.data.length ?? 0) === 0 ? (
        <div className="panel" data-testid="invoices-empty"><p className="fine">{data?.counts.all === 0 ? 'No bills yet. Draft one from notes above, or ask for one on the New request form.' : 'No invoice matches that filter.'}</p></div>
      ) : narrow ? (
        <ul className="inv-cards" data-testid="invoice-list">{data!.data.map((row) => <li key={row.id} className="panel inv-card"><Row row={row} card /></li>)}</ul>
      ) : (
        <div className="inv-table-wrap">
          <table className="bill-items inv-table" data-testid="invoice-table">
            <thead><tr><th>Client</th><th>Job</th><th className="num">Amount</th><th>Status</th><th>Due</th><th>Actions</th></tr></thead>
            <tbody>{data!.data.map((row) => <Row key={row.id} row={row} />)}</tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'deny' }) {
  return <div className="breaks-kpi"><span className="kv-k">{label}</span><strong className={tone === 'deny' ? 'kpi-bad' : undefined}>{value}</strong><span className="fine">{sub}</span></div>
}

function Outlook({ data }: { data: InvoicesList | undefined }) {
  const o = data?.outlook
  if (!o) return null
  const buckets = (['overdue', 'thisWeek', 'nextWeek', 'later'] as const).map((key) => ({ key, label: o.bucketLabels[key], ...o.buckets[key] }))
  return (
    <section className="panel" aria-labelledby="outlook-title" data-testid="cash-outlook">
      <h2 className="panel-title" id="outlook-title">Cash outlook</h2>
      <div className="kvs">
        <div className="kv"><span className="kv-k">PayPal balance</span><span className="kv-v">{o.balanceCents === null ? 'not read' : dollars(o.balanceCents, o.currency)}</span></div>
        <div className="kv"><span className="kv-k">+ Outstanding from clients</span><span className="kv-v">{dollars(o.outstandingCents, o.currency)}</span></div>
        <div className="kv"><span className="kv-k">− Approved payouts not yet paid</span><span className="kv-v">{dollars(o.committedPayoutsCents, o.currency)}</span></div>
        <div className="kv"><span className="kv-k">= Projected cash</span><span className="kv-v"><strong data-testid="projected-cash">{o.projectedCents === null ? `${dollars(o.netOfBooksCents, o.currency)} before the balance` : dollars(o.projectedCents, o.currency)}</strong></span></div>
      </div>
      <ul className="outlook-buckets" aria-label="When the outstanding money is due">
        {buckets.map((b) => <li key={b.key} className={b.key === 'overdue' && b.count > 0 ? 'late' : undefined}><span>{b.label}</span><strong className="mono">{dollars(b.cents, o.currency)}</strong><small>{b.count} invoice{b.count === 1 ? '' : 's'}</small></li>)}
      </ul>
      <p className="fine">{o.balanceNote}{o.balanceAsOf ? ` As of ${when(o.balanceAsOf)}.` : ''}</p>
      <p className="fine" data-testid="outlook-disclaimer"><strong>Advice, not a guarantee.</strong> {o.disclaimer}</p>
    </section>
  )
}

function Guardrails({ data }: { data: InvoicesList | undefined }) {
  const g = data?.guardrails
  return (
    <section className="panel" aria-labelledby="guard-title" data-testid="guardrails">
      <h2 className="panel-title" id="guard-title">What your rules allow here</h2>
      {g && g.hasRules ? <ul className="guard-list">{g.lines.map((line) => <li key={line.id}>{line.text}</li>)}</ul> : <p className="fine">No rules yet, so nothing can be billed.</p>}
      <Link to={g?.link ?? '/rules'} className="link">Change them in Rules →</Link>
    </section>
  )
}

/** One invoice, as a table row on a desktop and as the inside of a card on a phone. */
function Row({ row, card = false }: { row: InvoiceRow; card?: boolean }) {
  const client = useQueryClient()
  const [said, setSaid] = useState('')
  const [qr, setQr] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const refresh = () => { void client.invalidateQueries({ queryKey: ['invoices'] }); void client.invalidateQueries({ queryKey: ['today'] }); void client.invalidateQueries({ queryKey: ['proposals'] }) }
  const remind = useMutation({ mutationFn: () => api.remindInvoice(row.id), onSuccess: () => { setSaid('Reminder sent through PayPal.'); refresh() }, onError: (e) => setSaid(e instanceof Error ? e.message : 'The reminder did not go.') })
  const cancel = useMutation({ mutationFn: () => api.cancelInvoice(row.id), onSuccess: () => { setSaid('Invoice cancelled.'); setConfirm(false); refresh() }, onError: (e) => setSaid(e instanceof Error ? e.message : 'Could not cancel.') })
  const code = useQuery({ queryKey: ['invoice-qr', row.id], queryFn: () => api.invoiceQr(row.id), enabled: qr, staleTime: 10 * 60_000, retry: false })
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(row.payerUrl ?? '')
      setSaid('Payer link copied.')
    } catch {
      setSaid('Could not copy. Select the link on the receipt instead.')
    }
  }
  const late = row.status === 'overdue'
  const open = ['sent', 'part_paid', 'overdue'].includes(row.status)
  const amount = <>{dollars(row.amountCents, row.currency)}{row.paidCents > 0 && row.status !== 'paid' ? <small className="fine"> · {dollars(row.paidCents, row.currency)} paid</small> : null}</>
  const due = open || row.status === 'approved' ? (
    <span title={row.dueNote}>
      {row.dueDate}{row.dueSource === 'default' ? ' (estimated)' : ''}
      {late ? <strong className="overdue-by"> overdue by {row.daysOverdue} day{row.daysOverdue === 1 ? '' : 's'}</strong> : null}
    </span>
  ) : <span className="fine">{row.status === 'paid' && row.paidAt ? `paid ${row.paidAt.slice(0, 10)}` : '—'}</span>
  const actions = (
    <div className="inv-actions">
      <Link className="btn btn-ghost btn-small" to={`/p/${row.id}`} aria-label={`Open receipt for ${row.clientName} ${dollars(row.amountCents, row.currency)}`}>Open receipt</Link>
      {open && row.payerUrl ? <button type="button" className="btn btn-ghost btn-small" onClick={() => void copy()} aria-label={`Copy payer link for ${row.clientName}`}>Copy payer link</button> : null}
      {row.canRemind ? <button type="button" className="btn btn-ghost btn-small" disabled={remind.isPending} onClick={() => remind.mutate()} aria-label={`Remind ${row.clientName}`}>{remind.isPending ? 'Reminding…' : 'Remind'}</button> : null}
      {row.canRemind ? <button type="button" className="btn btn-ghost btn-small" aria-pressed={qr} onClick={() => setQr(!qr)} aria-label={`Show QR for ${row.clientName}`}>{qr ? 'Hide QR' : 'Show QR'}</button> : null}
      {row.canCancel ? (confirm
        ? <><button type="button" className="btn btn-small btn-ink" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Yes, cancel it</button><button type="button" className="btn btn-ghost btn-small" onClick={() => setConfirm(false)}>Keep it</button></>
        : <button type="button" className="btn btn-ghost btn-small" onClick={() => setConfirm(true)} aria-label={`Cancel invoice for ${row.clientName}`}>Cancel invoice</button>) : null}
      {qr && code.data ? <img className="invoice-qr" alt="QR code. Scanning it opens this invoice on PayPal." src={`data:image/png;base64,${code.data.image}`} width={120} height={120} /> : null}
      {qr && code.isError ? <span className="fine">The QR code could not be drawn.</span> : null}
      <span className="fine" role="status" aria-live="polite">{said}</span>
    </div>
  )
  const statusChip = <Chip tone={TONE[row.status]}>{WORDS[row.status]}</Chip>
  if (card) {
    return (
      <>
        <div className="row between gap-s"><strong>{row.clientName}</strong>{statusChip}</div>
        <div className="row between gap-s"><span className="mono">{amount}</span><span className="fine">{row.jobId ?? 'no job'}</span></div>
        <div>{due}</div>
        {actions}
      </>
    )
  }
  return (
    <tr data-testid="invoice-row" data-status={row.status}>
      <td><strong>{row.clientName}</strong><br /><small className="fine">{row.description}</small></td>
      <td className="mono">{row.jobId ?? '—'}</td>
      <td className="num mono">{amount}</td>
      <td>{statusChip}</td>
      <td>{due}</td>
      <td>{actions}</td>
    </tr>
  )
}
