import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AllCommunityModule, ModuleRegistry, type ColDef, type ICellRendererParams } from 'ag-grid-community'
import { AgGridReact } from 'ag-grid-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ActivityTabs } from '../components/ActivityTabs'
import { Chip, Loading, PageHead, ProblemCard } from '../components/ui'
import { api } from '../lib/api'
import type { BreakDetail, BreakRow, BreakSeverity, BreakState } from '../lib/breaks'
import { when } from '../lib/format'
import { useIsOwner, useNarrow } from '../lib/hooks'
import { dollars } from '../lib/money'
import { ledgerGridTheme } from './Ledger'

ModuleRegistry.registerModules([AllCommunityModule])

const SEVERITIES: Array<{ id: 'all' | BreakSeverity; label: string }> = [
  { id: 'all', label: 'All' }, { id: 'critical', label: 'Critical' }, { id: 'warning', label: 'Warning' }, { id: 'info', label: 'Info' },
]
const STATES: Array<{ id: BreakState; label: string }> = [
  { id: 'open', label: 'Open' }, { id: 'resolved', label: 'Resolved' }, { id: 'dismissed', label: 'Dismissed' },
]
const SEVERITY_TONE: Record<BreakSeverity, 'deny' | 'need' | 'muted'> = { critical: 'deny', warning: 'need', info: 'muted' }

/** "3 min ago", re-read every half minute so the sentence stays true while the page is open. */
function useAgo(iso: string | null): string {
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => tick((value) => value + 1), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  if (!iso) return 'not synced yet'
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (seconds < 45) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`
  return `${Math.round(seconds / 86_400)} d ago`
}

const signed = (cents: number | null): string => (cents === null ? '—' : `${cents > 0 ? '+' : cents < 0 ? '-' : ''}${dollars(Math.abs(cents))}`)

export function Breaks() {
  const owner = useIsOwner()
  const client = useQueryClient()
  const [params, setParams] = useSearchParams()
  const selected = params.get('key')
  const [severity, setSeverity] = useState<'all' | BreakSeverity>('all')
  const [state, setState] = useState<BreakState>('open')
  const narrow = useNarrow()
  const list = useQuery({ queryKey: ['breaks'], queryFn: () => api.breaks(), enabled: owner, refetchInterval: 30_000 })
  const [status, setStatus] = useState('')
  const scan = useMutation({
    mutationFn: api.scanBreaks,
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ['breaks'] })
      void client.invalidateQueries({ queryKey: ['break'] })
      const paypal = result.paypal === 'checked' ? 'PayPal compared.' : result.paypal === 'unavailable' ? `PayPal could not be compared${result.paypalReason ? `: ${result.paypalReason}` : '.'}` : ''
      setStatus(`Reconciled. ${result.opened.length} new, ${result.resolved.length} resolved, ${result.reopened.length} reopened. ${paypal}`.trim())
    },
    onError: (error) => setStatus(`Reconcile failed. ${error instanceof Error ? error.message : ''}`),
  })
  const rows = useMemo(() => (list.data?.data ?? []).filter((row) => row.state === state && (severity === 'all' || row.severity === severity)), [list.data, severity, state])
  const select = (key: string | null) => setParams(key ? { key } : {}, { replace: true })
  const ago = useAgo(list.data?.paypalSyncedAt ?? list.data?.syncedAt ?? null)

  const columns = useMemo<ColDef<BreakRow>[]>(() => {
    const severityCol: ColDef<BreakRow> = { headerName: 'Severity', field: 'severity', width: 110, cellRenderer: (p: ICellRendererParams<BreakRow>) => p.data ? <Chip tone={SEVERITY_TONE[p.data.severity]}>{p.data.severity}</Chip> : null }
    const what: ColDef<BreakRow> = {
      headerName: 'What', field: 'title', flex: 2, minWidth: 200, wrapText: true, autoHeight: true,
      cellRenderer: (p: ICellRendererParams<BreakRow>) => p.data ? <button type="button" className="link-button" onClick={() => select(p.data!.key)} aria-label={`Open break: ${p.data.title}`}>{p.data.title}</button> : null,
    }
    const delta: ColDef<BreakRow> = { headerName: 'Delta', field: 'deltaCents', width: 110, type: 'rightAligned', valueFormatter: (p) => signed(p.value as number | null), cellClass: 'grid-money' }
    const stateCol: ColDef<BreakRow> = { headerName: 'State', field: 'state', width: 120, valueGetter: (p) => (p.data ? (p.data.state === 'open' && p.data.waitingOnYou ? 'waiting on you' : p.data.state) : '') }
    if (narrow) return [severityCol, what, delta]
    return [
      severityCol, what,
      { headerName: 'Expected', field: 'expected', flex: 1, minWidth: 140, wrapText: true, autoHeight: true },
      { headerName: 'Observed', field: 'observed', flex: 1, minWidth: 140, wrapText: true, autoHeight: true },
      delta, stateCol,
    ]
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow])

  if (!owner) return <div className="page"><PageHead eyebrow="Owner only" title="Breaks" /><p className="fine">Only the owner can see where the books and PayPal disagree.</p></div>
  if (list.isLoading) return <div className="page"><Loading label="Opening the Breaks desk" /></div>
  const kpis = list.data?.kpis

  return (
    <div className="page page-wide" data-testid="breaks-desk">
      <ActivityTabs />
      <PageHead eyebrow="Your books, checked against PayPal · a fix only asks, your rules decide" title="Breaks">
        <div className="row gap-s" style={{ alignItems: 'center' }}>
          <span className="fine" data-testid="synced">Synced {ago}. Reconcile compares 90 days, in the 31-day windows PayPal allows.</span>
          <button type="button" className="btn" disabled={scan.isPending} onClick={() => scan.mutate()}>{scan.isPending ? 'Reconciling…' : 'Reconcile now'}</button>
        </div>
      </PageHead>
      <p className="fine breaks-status" role="status" aria-live="polite" data-testid="scan-status">{scan.isPending ? 'Reconciling with PayPal. Its report can lag by hours.' : status}</p>
      <ProblemCard error={list.error} />
      <div className="breaks-kpis" data-testid="breaks-kpis">
        <Kpi label="Open breaks" value={String(kpis?.open ?? 0)} />
        <Kpi label="Money at stake" value={dollars(kpis?.moneyAtStakeCents ?? 0)} />
        <Kpi label="Waiting on you" value={String(kpis?.waitingOnYou ?? 0)} />
        <Kpi label="Resolved" value={String(kpis?.resolved ?? 0)} />
      </div>
      <div className="grid-tools">
        <div className="chips-row" role="group" aria-label="Severity">
          {SEVERITIES.map((item) => <button key={item.id} type="button" aria-pressed={severity === item.id} className={`filter${severity === item.id ? ' on' : ''}`} onClick={() => setSeverity(item.id)}>{item.label}</button>)}
        </div>
        <div className="chips-row" role="group" aria-label="State">
          {STATES.map((item) => <button key={item.id} type="button" aria-pressed={state === item.id} className={`filter${state === item.id ? ' on' : ''}`} onClick={() => setState(item.id)}>{item.label}</button>)}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="panel" data-testid="breaks-empty"><p className="fine">{state === 'open' ? 'No open breaks. The books and PayPal agree on everything checked.' : `Nothing ${state} here.`}</p></div>
      ) : (
        <div className="grid-wrap" style={{ height: Math.min(560, 100 + rows.length * 70) }}>
          <AgGridReact<BreakRow>
            theme={ledgerGridTheme}
            rowData={rows}
            columnDefs={columns}
            getRowId={(params) => params.data.key}
            onRowClicked={(event) => event.data && select(event.data.key)}
            rowHeight={narrow ? 64 : 56}
            headerHeight={40}
            suppressCellFocus={false}
            overlayNoRowsTemplate="Nothing to show."
          />
        </div>
      )}
      {selected ? <Detail breakKey={selected} onClose={() => select(null)} /> : null}
    </div>
  )
}

function Kpi({ label, value }: { label: string; value: string }) {
  return <div className="breaks-kpi"><span className="kv-k">{label}</span><strong>{value}</strong></div>
}

function Detail({ breakKey, onClose }: { breakKey: string; onClose: () => void }) {
  const client = useQueryClient()
  const detail = useQuery({ queryKey: ['break', breakKey], queryFn: () => api.breakDetail(breakKey) })
  const [note, setNote] = useState('')
  const [said, setSaid] = useState('')
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['breaks'] })
    void client.invalidateQueries({ queryKey: ['break', breakKey] })
  }
  const fix = useMutation({
    mutationFn: () => api.fixBreak(breakKey),
    onSuccess: (result) => { setSaid(result.statement); refresh(); void client.invalidateQueries({ queryKey: ['today'] }) },
    onError: (error) => setSaid(error instanceof Error ? error.message : 'The fix did not run.'),
  })
  const dismiss = useMutation({
    mutationFn: () => api.dismissBreak(breakKey, note),
    onSuccess: () => { setSaid('Dismissed. It stays quiet until what it shows changes.'); setNote(''); refresh() },
    onError: (error) => setSaid(error instanceof Error ? error.message : 'Could not dismiss.'),
  })
  if (detail.isLoading) return <section className="panel breaks-detail"><Loading label="Opening the break" /></section>
  if (detail.error || !detail.data) return <section className="panel breaks-detail"><ProblemCard error={detail.error} /><button type="button" className="btn btn-ghost" onClick={onClose}>Close</button></section>
  const item: BreakDetail = detail.data
  const open = item.state === 'open'
  return (
    <section className="panel breaks-detail" data-testid="break-detail" aria-label="Break detail">
      <div className="row between">
        <h2 className="panel-title">{item.title}</h2>
        <div className="row gap-s"><Chip tone={SEVERITY_TONE[item.severity]}>{item.severity}</Chip><Chip tone="muted">{item.state}</Chip><button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close</button></div>
      </div>
      <p>{item.detail}</p>
      <div className="kvs">
        <div className="kv"><span className="kv-k">Expected</span><span className="kv-v">{item.expected}</span></div>
        <div className="kv"><span className="kv-k">Observed</span><span className="kv-v">{item.observed}</span></div>
        <div className="kv"><span className="kv-k">Delta</span><span className="kv-v">{signed(item.deltaCents)}</span></div>
        <div className="kv"><span className="kv-k">First seen</span><span className="kv-v">{when(item.firstSeenAt)}</span></div>
        {item.dismissNote ? <div className="kv"><span className="kv-k">Dismissed</span><span className="kv-v">{item.dismissedBy}: {item.dismissNote}</span></div> : null}
      </div>
      <h3 className="panel-title">Evidence</h3>
      <div className="kvs">
        {item.evidence.request ? <div className="kv"><span className="kv-k">Request</span><span className="kv-v">{item.evidence.request.kind} · {item.evidence.request.phase} · {dollars(item.evidence.request.amountCents, item.evidence.request.currency)} {item.evidence.receiptPath ? <Link to={item.evidence.receiptPath} data-testid="break-receipt-link">Open the receipt →</Link> : null}</span></div> : null}
        {item.evidence.paypalIds.map((entry) => <div className="kv" key={`${entry.label}:${entry.id}`}><span className="kv-k">{entry.label}</span><span className="kv-v mono">{entry.id}</span></div>)}
        {item.evidence.books.map((entry) => <div className="kv" key={entry.seq}><span className="kv-k">Books #{entry.seq}</span><span className="kv-v"><Link to="/books">{entry.purpose.replace('_', ' ')}</Link> · {dollars(entry.deltaCents)} · {entry.memo}</span></div>)}
        {item.evidence.request && item.evidence.books.length === 0 ? <div className="kv"><span className="kv-k">Books</span><span className="kv-v">No journal entries for this request.</span></div> : null}
      </div>
      {open ? (
        <>
          {item.fix ? (
            <div className="breaks-fix">
              <button type="button" className="btn" disabled={fix.isPending} onClick={() => fix.mutate()} data-testid="break-fix">{fix.isPending ? 'Working…' : item.fix.label}</button>
              <p className="fine">{item.fix.sentence}</p>
            </div>
          ) : <p className="fine" data-testid="break-no-fix">No automatic fix: this one needs you. Look at the evidence, act on the request, or dismiss it with a note.</p>}
          <form className="breaks-dismiss" onSubmit={(event) => { event.preventDefault(); if (note.trim()) dismiss.mutate() }}>
            <label className="field"><span>Dismiss with a note</span><textarea rows={2} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why this is not a problem" /></label>
            <button type="submit" className="btn btn-ghost" disabled={!note.trim() || dismiss.isPending} data-testid="break-dismiss">Dismiss</button>
          </form>
        </>
      ) : null}
      <p className="fine" role="status" aria-live="polite" data-testid="break-said">{said}</p>
      <h3 className="panel-title">History</h3>
      <ul className="breaks-history">{item.history.map((entry) => <li key={entry.id}><span className="mono">{when(entry.at)}</span> {entry.type}{entry.detail && !entry.detail.startsWith('{') ? ` · ${entry.detail}` : ''}</li>)}</ul>
    </section>
  )
}
