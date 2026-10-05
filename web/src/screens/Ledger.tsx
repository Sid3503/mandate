import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type ICellRendererParams } from 'ag-grid-community'
import { AgGridReact } from 'ag-grid-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { EnableSteps, useFeatures } from '../components/PayPalFeatures'
import { Chip, Loading, PageHead, ProblemCard } from '../components/ui'
import { api } from '../lib/api'
import { shortId, when } from '../lib/format'
import { useNames, useNarrow, useProposals, useWarrant } from '../lib/hooks'
import { dollars } from '../lib/money'
import type { ActivityRow, LedgerEvent, Proposal } from '../lib/types'
import { EVENT, explain, GATE, KIND, phaseInfo } from '../lib/words'

ModuleRegistry.registerModules([AllCommunityModule])

const theme = themeQuartz.withParams({
  fontFamily: 'Inter Variable, system-ui, sans-serif',
  headerFontFamily: 'JetBrains Mono Variable, ui-monospace, monospace',
  headerFontSize: 12,
  headerFontWeight: 700,
  fontSize: 14,
  backgroundColor: '#fffcf5',
  foregroundColor: '#050505',
  headerBackgroundColor: '#050505',
  headerTextColor: '#f3efe6',
  borderColor: '#cfc8b8',
  rowHoverColor: '#f6ffc7',
  selectedRowBackgroundColor: '#ecffa3',
  oddRowBackgroundColor: '#fffaf0',
  accentColor: '#050505',
  wrapperBorderRadius: 0,
  borderRadius: 0,
  spacing: 7,
})

type Preset = 'all' | 'refused' | 'waiting' | 'settled' | 'in' | 'out'
const PRESETS: Array<{ id: Preset; label: string; test: (row: Proposal) => boolean }> = [
  { id: 'all', label: 'Everything', test: () => true },
  { id: 'refused', label: 'Refused', test: (row) => row.gate === 'DENY' || row.phase === 'capture_refused' || row.phase === 'payout_failed' },
  { id: 'waiting', label: 'Waiting for you', test: (row) => row.phase === 'pending_approval' },
  { id: 'settled', label: 'Settled', test: (row) => row.phase === 'captured' || row.phase === 'refunded' },
  { id: 'in', label: 'Money in', test: (row) => row.kind === 'charge' },
  { id: 'out', label: 'Money out', test: (row) => row.kind === 'payment' },
]

function Tone({ value, tone }: { value: string; tone: 'deny' | 'auto' | 'need' | 'ink' | 'muted' }) {
  return <Chip tone={tone}>{value}</Chip>
}

export function Ledger() {
  const [tab, setTab] = useState<'requests' | 'events' | 'paypal'>('requests')
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Append-only · every attempt, including the refused ones" title="Ledger">
        <div className="segmented small" role="tablist" data-tour="ledger-tabs">
          <button type="button" role="tab" aria-selected={tab === 'requests'} className={tab === 'requests' ? 'on' : ''} onClick={() => setTab('requests')}>Requests</button>
          <button type="button" role="tab" aria-selected={tab === 'events'} className={tab === 'events' ? 'on' : ''} onClick={() => setTab('events')}>Events</button>
          <button type="button" role="tab" aria-selected={tab === 'paypal'} className={tab === 'paypal' ? 'on' : ''} onClick={() => setTab('paypal')}>PayPal activity</button>
        </div>
      </PageHead>
      {tab === 'requests' ? <Requests /> : tab === 'events' ? <Events /> : <PayPalActivity />}
    </div>
  )
}

function Requests() {
  const proposals = useProposals()
  const names = useNames()
  const warrant = useWarrant()
  const navigate = useNavigate()
  const narrow = useNarrow()
  const [preset, setPreset] = useState<Preset>('all')
  const [search, setSearch] = useState('')
  const rows = useMemo(() => (proposals.data?.data ?? []).filter(PRESETS.find((item) => item.id === preset)!.test), [proposals.data, preset])
  const refusedCents = (proposals.data?.data ?? []).filter((row) => row.gate === 'DENY').reduce((sum, row) => sum + row.amountCents, 0)

  const columns = useMemo<ColDef<Proposal>[]>(() => narrow ? [
    {
      headerName: 'Who · what', field: 'payeeId', flex: 1, minWidth: 150,
      getQuickFilterText: (params) => (params.data ? `${names(params.data.payeeId)} ${params.data.description} ${params.data.clause}` : ''),
      cellRenderer: (params: ICellRendererParams<Proposal>) => params.data ? (
        <span className="grid-two">
          <strong>{KIND[params.data.kind].arrow} {names(params.data.payeeId)}</strong>
          <span>{params.data.description}</span>
        </span>
      ) : null,
    },
    { headerName: 'USD', field: 'amountCents', width: 96, type: 'rightAligned', valueFormatter: (params) => dollars(params.value as number), cellClass: 'grid-money' },
    {
      headerName: 'Decision', field: 'gate', width: 118,
      cellRenderer: (params: ICellRendererParams<Proposal>) => params.data ? <Tone value={GATE[params.data.gate].label} tone={GATE[params.data.gate].tone} /> : null,
    },
    { headerName: 'When', field: 'createdAt', hide: true, sort: 'desc' },
  ] : [
    { headerName: 'When', field: 'createdAt', width: 132, sort: 'desc', valueFormatter: (params) => when(params.value as string) },
    { headerName: 'Who', field: 'payeeId', flex: 1, minWidth: 130, valueGetter: (params) => (params.data ? `${KIND[params.data.kind].arrow} ${names(params.data.payeeId)}` : '') },
    { headerName: 'What', field: 'description', flex: 1.3, minWidth: 160 },
    { headerName: 'USD', field: 'amountCents', width: 104, type: 'rightAligned', valueFormatter: (params) => dollars(params.value as number), cellClass: 'grid-money' },
    {
      headerName: 'Decision', field: 'gate', width: 124,
      cellRenderer: (params: ICellRendererParams<Proposal>) => params.data ? <Tone value={GATE[params.data.gate].label} tone={GATE[params.data.gate].tone} /> : null,
    },
    {
      headerName: 'Now', field: 'phase', width: 190,
      cellRenderer: (params: ICellRendererParams<Proposal>) => {
        if (params.data?.phase === 'denied') return <span className="muted">stored · not sent</span>
        const info = params.data ? phaseInfo(params.data.phase, params.data.kind) : undefined
        return info ? <Tone value={info.label} tone={info.tone} /> : params.data?.phase ?? null
      },
    },
    { headerName: 'Rule', field: 'clause', flex: 2, minWidth: 240, wrapText: true, autoHeight: true, cellClass: 'grid-wrap-text', tooltipValueGetter: (params) => params.data?.detail, valueGetter: (params) => params.data ? explain(params.data.clause, params.data, warrant.data, names) : '' },
    { headerName: 'Job', field: 'jobId', width: 160, hide: true, cellClass: 'grid-mono' },
    { headerName: 'Lock', field: 'cartHash', width: 132, hide: true, cellClass: 'grid-mono', valueFormatter: (params) => (params.value ? shortId(params.value as string, 6) : '—') },
  ], [names, warrant.data, narrow])

  if (proposals.isLoading) return <Loading />
  return (
    <>
      <div className="grid-tools">
        <div className="chips-row" role="group" aria-label="Show" data-tour="ledger-filters">
          {PRESETS.map((item) => (
            <button key={item.id} type="button" className={`filter${preset === item.id ? ' on' : ''}`} onClick={() => setPreset(item.id)}>{item.label}</button>
          ))}
        </div>
        <input className="search" data-tour="ledger-search" type="search" placeholder="Search names, rules, jobs…" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search the ledger" />
      </div>
      <ProblemCard error={proposals.error} />
      <div className="grid-wrap" data-tour="ledger-grid" style={{ height: Math.min(680, 140 + rows.length * 62) }}>
        <AgGridReact<Proposal>
          theme={theme}
          rowData={rows}
          columnDefs={columns}
          quickFilterText={search}
          getRowId={(params) => params.data.id}
          rowClassRules={{ 'row-refused': (params) => params.data?.gate === 'DENY' || params.data?.phase === 'capture_refused' }}
          onRowClicked={(event) => event.data && navigate(`/p/${event.data.id}`)}
          rowHeight={narrow ? 64 : 46}
          headerHeight={40}
          animateRows
          tooltipShowDelay={300}
          suppressCellFocus
          overlayNoRowsTemplate="Nothing here yet."
        />
      </div>
      <p className="grid-foot" data-tour="ledger-foot"><span>{rows.length} requests</span><span><strong>{dollars(refusedCents)}</strong> asked for and refused · PayPal never called for any of it</span></p>
    </>
  )
}

function Events() {
  const navigate = useNavigate()
  const events = useInfiniteQuery({
    queryKey: ['ledger'],
    queryFn: ({ pageParam }) => api.ledger(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  })
  const rows = useMemo(() => events.data?.pages.flatMap((page) => page.data) ?? [], [events.data])
  const columns = useMemo<ColDef<LedgerEvent>[]>(() => [
    { headerName: 'When', field: 'createdAt', width: 160, sort: 'desc', valueFormatter: (params) => when(params.value as string) },
    { headerName: 'Event', field: 'type', width: 220, valueFormatter: (params) => EVENT[params.value as string] ?? (params.value as string) },
    { headerName: 'Rule', field: 'clause', width: 200, cellClass: 'grid-mono' },
    { headerName: 'By', width: 110, valueGetter: (params) => (typeof params.data?.payload.actor === 'string' ? params.data.payload.actor : '') },
    { headerName: 'Request', field: 'proposalId', width: 150, cellClass: 'grid-mono', valueFormatter: (params) => shortId(params.value as string, 6) },
    { headerName: 'Details', flex: 1, minWidth: 260, cellClass: 'grid-mono', valueGetter: (params) => JSON.stringify(params.data?.payload ?? {}) },
  ], [])
  if (events.isLoading) return <Loading />
  return (
    <>
      <ProblemCard error={events.error} />
      <div className="grid-wrap" style={{ height: 640 }}>
        <AgGridReact<LedgerEvent>
          theme={theme}
          rowData={rows}
          columnDefs={columns}
          getRowId={(params) => params.data.id}
          rowClassRules={{ 'row-refused': (params) => Boolean(params.data?.type.includes('refused') || params.data?.type.includes('blocked')) }}
          onRowClicked={(event) => event.data && navigate(`/p/${event.data.proposalId}`)}
          rowHeight={42}
          headerHeight={40}
          animateRows={false}
          suppressCellFocus
        />
      </div>
      <div className="grid-foot">
        <span>{rows.length} events</span>
        {events.hasNextPage ? <button type="button" className="btn btn-ghost" onClick={() => void events.fetchNextPage()} disabled={events.isFetchingNextPage}>Load older</button> : <span>Start of the ledger</span>}
      </div>
    </>
  )
}

/** What PayPal says moved in the account over the last 30 days, lined up against this ledger. */
function PayPalActivity() {
  const navigate = useNavigate()
  const features = useFeatures()
  const activity = useQuery({ queryKey: ['paypal-activity'], queryFn: api.activity })
  const columns = useMemo<ColDef<ActivityRow>[]>(() => [
    { headerName: 'When', field: 'date', width: 160, sort: 'desc', valueFormatter: (params) => when(params.value as string) },
    { headerName: 'Amount', field: 'cents', width: 120, cellClass: 'grid-mono', valueFormatter: (params) => dollars(params.value as number) },
    { headerName: 'What PayPal calls it', flex: 1, minWidth: 220, valueGetter: (params) => params.data?.subject ?? params.data?.counterparty ?? params.data?.eventCode ?? '—' },
    { headerName: 'PayPal id', field: 'id', width: 190, cellClass: 'grid-mono' },
    {
      headerName: 'In the ledger?', width: 190,
      cellRenderer: (params: ICellRendererParams<ActivityRow>) => params.data?.proposalId ? <Chip tone="auto">Matched</Chip> : <Chip tone="deny">Not in Mandate</Chip>,
    },
  ], [])
  if (activity.isLoading) return <Loading label="Asking PayPal" />
  const data = activity.data
  if (!data || !data.available) {
    const feature = features.data?.features.find((item) => item.id === 'transactions')
    return (
      <section className="panel">
        <h2 className="panel-title">PayPal activity is off</h2>
        <p>{data?.reason ?? 'PayPal could not be read.'} When it is on, this tab lists everything PayPal shows in the account and flags money that moved without Mandate.</p>
        {feature && !feature.enabled ? <EnableSteps feature={feature} /> : null}
        <ProblemCard error={activity.error} />
      </section>
    )
  }
  return (
    <>
      <div className="grid-tools"><p className="fine">{data.matched} matched to a Mandate request · <strong>{data.unmatched}</strong> that Mandate has no record of ({dollars(data.unmatchedNetCents)} net) · last 30 days</p></div>
      <div className="grid-wrap" style={{ height: Math.min(640, 140 + data.rows.length * 46) }}>
        <AgGridReact<ActivityRow>
          theme={theme}
          rowData={data.rows}
          columnDefs={columns}
          getRowId={(params) => params.data.id}
          rowClassRules={{ 'row-refused': (params) => params.data?.proposalId === null }}
          onRowClicked={(event) => event.data?.proposalId && navigate(`/p/${event.data.proposalId}`)}
          rowHeight={44}
          headerHeight={40}
          suppressCellFocus
          overlayNoRowsTemplate="PayPal shows no activity in this window."
        />
      </div>
      <p className="fine">Read-only. Nothing on this tab moves money. A row marked Not in Mandate is money PayPal shows that no Mandate request created or recorded.</p>
    </>
  )
}
