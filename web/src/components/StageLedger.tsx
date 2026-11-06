import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AllCommunityModule, ModuleRegistry, type CellValueChangedEvent, type ColDef, type ICellRendererParams } from 'ag-grid-community'
import { AgGridReact } from 'ag-grid-react'
import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ledgerGridTheme } from '../screens/Ledger'
import { useToast } from './Toast'
import { Chip, ProblemCard } from './ui'
import { request } from '../lib/api'
import { dollars, parseCents } from '../lib/money'
import { projectsApi, STAGE_WORDS, when, type StageStatus } from '../lib/projects'

ModuleRegistry.registerModules([AllCommunityModule])

/**
 * Every stage of every project, reconciled with PayPal's ids. Unpaid prices, names and dates are edited in place; an
 * edit is a plan change, so it goes back to the client to approve before they pay. A row's reminder is written by the
 * same desk the project page uses. CSV goes to the accountant.
 */

type Row = {
  projectId: string; stageId: string; client: string; project: string; stage: string; position: number
  amountCents: number; currency: string; dueDate: string; status: StageStatus; planStatus: string
  bucket: 'paid' | 'held' | 'overdue' | 'unpaid' | 'cancelled'; daysLate: number; paidOn: string | null
  paypalId: string | null; paypalIdKind: 'capture' | 'hold' | null; feeCents: number | null; editable: boolean; reminders: number
}

type Filter = 'all' | 'overdue' | 'unpaid' | 'held' | 'paid'

export default function StageLedger() {
  const client = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const grid = useRef<AgGridReact<Row>>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [shown, setShown] = useState<Row[]>([])
  const rows = useQuery({ queryKey: ['projects', 'ledger'], queryFn: () => request<{ data: Row[] }>('/v1/projects/ledger'), refetchInterval: 15_000 })
  const edit = useMutation({
    mutationFn: (input: { row: Row; patch: { title?: string; amountCents?: number; dueDate?: string } }) => request(`/v1/projects/${encodeURIComponent(input.row.projectId)}/stages/${encodeURIComponent(input.row.stageId)}`, { method: 'PATCH', body: input.patch }),
    onSuccess: (_done, input) => { toast({ title: 'Saved', body: input.row.planStatus === 'draft' ? 'The plan is not sent yet.' : `The plan goes back to ${input.row.client}: they approve the change before paying.` }); void client.invalidateQueries({ queryKey: ['projects'] }) },
    onError: () => void rows.refetch(),
  })
  const remind = useMutation({
    mutationFn: (row: Row) => projectsApi.remind(row.projectId, row.stageId),
    onSuccess: (made, row) => { void navigator.clipboard?.writeText(made.text).catch(() => undefined); toast({ title: `A ${made.tone} reminder for ${row.client} is copied`, body: made.mailto ? 'Paste it, or open it from the project page in your email.' : 'Paste it wherever you talk to the client.' }); void rows.refetch() },
  })
  const data = useMemo(() => (rows.data?.data ?? []).filter((row) => row.bucket !== 'cancelled' && (filter === 'all' || row.bucket === filter)), [rows.data, filter])
  const columns = useMemo<ColDef<Row>[]>(() => [
    { field: 'client', headerName: 'Client', filter: true, minWidth: 130 },
    { field: 'stage', headerName: 'Stage', editable: (p) => Boolean(p.data?.editable), cellClass: (p) => (p.data?.editable ? 'cell-editable' : ''), minWidth: 170, flex: 1 },
    // Edited in dollars, kept in cents: the editor shows 400.00, never 40000.
    { colId: 'amount', headerName: 'Amount', width: 118, type: 'rightAligned', editable: (p) => Boolean(p.data?.editable), cellClass: (p) => (p.data?.editable ? 'cell-editable grid-money' : 'grid-money'),
      valueGetter: (p) => (p.data ? (p.data.amountCents / 100).toFixed(2) : null), valueFormatter: (p) => (p.data ? dollars(p.data.amountCents, p.data.currency) : ''),
      valueSetter: (p) => { const cents = parseCents(String(p.newValue)); if (!p.data || cents === null || cents <= 0 || cents === p.data.amountCents) return false; p.data.amountCents = cents; return true } },
    { field: 'bucket', headerName: 'Status', width: 190, filter: true, cellRenderer: (p: ICellRendererParams<Row>) => p.data ? <Chip tone={p.data.bucket === 'overdue' ? 'deny' : STAGE_WORDS[p.data.status].tone}>{p.data.bucket === 'overdue' ? 'Overdue' : STAGE_WORDS[p.data.status].label}</Chip> : null },
    { field: 'dueDate', headerName: 'Due', width: 110, sort: 'asc', editable: (p) => Boolean(p.data?.editable), cellClass: (p) => (p.data?.editable ? 'cell-editable' : ''), valueFormatter: (p) => when(p.value as string),
      valueParser: (p) => (/^\d{4}-\d{2}-\d{2}$/.test(String(p.newValue)) ? p.newValue : p.oldValue) },
    { field: 'daysLate', headerName: 'Late', width: 80, valueFormatter: (p) => (p.value ? `${p.value}d` : ''), cellClass: 'late-cell' },
    { field: 'paidOn', headerName: 'Paid on', width: 110, valueFormatter: (p) => (p.value ? when(p.value as string) : '') },
    { field: 'paypalId', headerName: 'PayPal ID', width: 190, cellClass: 'grid-mono', valueFormatter: (p) => (p.value ? `${p.data?.paypalIdKind === 'hold' ? 'hold ' : ''}${p.value}` : '') },
    { headerName: '', width: 130, sortable: false, cellRenderer: (p: ICellRendererParams<Row>) => p.data && (p.data.bucket === 'overdue' || p.data.bucket === 'unpaid') && p.data.planStatus === 'agreed' ? <button type="button" className="btn btn-ghost btn-small" onClick={() => remind.mutate(p.data!)}>{p.data.reminders > 0 ? 'Remind again' : 'Remind'}</button> : null },
  ], [remind])
  const onEdit = (event: CellValueChangedEvent<Row>) => {
    if (!event.data || event.oldValue === event.newValue) return
    const field = event.colDef.field ?? event.colDef.colId
    const patch = field === 'stage' ? { title: String(event.newValue) } : field === 'amount' ? { amountCents: event.data.amountCents } : field === 'dueDate' ? { dueDate: String(event.newValue) } : null
    if (patch) edit.mutate({ row: event.data, patch })
  }
  const totals = shown.reduce((sum, row) => ({ cents: sum.cents + row.amountCents, paid: sum.paid + (row.bucket === 'paid' ? row.amountCents : 0) }), { cents: 0, paid: 0 })
  const currency = shown[0]?.currency ?? 'USD'
  return (
    <section className="panel section stage-ledger" data-testid="stage-ledger">
      <div className="row between wrap gap-s">
        <h2 className="section-title">Ledger</h2>
        <div className="row gap-s wrap">
          <input className="search" placeholder="Search clients or PayPal ids" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search" />
          <button type="button" className="btn btn-ghost btn-small" onClick={() => { grid.current?.api.exportDataAsCsv({ fileName: 'mandate-stages.csv' }); toast({ title: 'Ledger exported', body: `${shown.length} stages saved as mandate-stages.csv.`, tone: 'info', key: 'export-stages' }) }}>Export CSV</button>
        </div>
      </div>
      <p className="fine">Every stage across your projects, reconciled against PayPal: what is paid, what PayPal is holding while clients review, and what is still owed. Click a dotted cell to edit an unpaid price, name or due date; the change goes to the client to approve. Double-click a row to open its project.</p>
      <div className="row gap-s wrap" role="tablist" aria-label="Filter">
        {(['all', 'overdue', 'unpaid', 'held', 'paid'] as Filter[]).map((name) => <button key={name} type="button" role="tab" aria-selected={filter === name} className={`quick-chip${filter === name ? ' on' : ''}`} onClick={() => setFilter(name)}>{name === 'all' ? 'All' : name[0]!.toUpperCase() + name.slice(1)}</button>)}
      </div>
      <ProblemCard error={rows.error ?? edit.error ?? remind.error} />
      <div className="grid-wrap" style={{ height: Math.min(520, 96 + Math.max(1, data.length) * 44) }}>
        <AgGridReact<Row>
          ref={grid}
          theme={ledgerGridTheme}
          rowData={data}
          columnDefs={columns}
          quickFilterText={search}
          getRowId={(p) => p.data.stageId}
          onCellValueChanged={onEdit}
          // A double-click on a cell that can be edited is an edit; anywhere else it opens the project.
          onCellDoubleClicked={(event) => { const editable = typeof event.colDef.editable === 'function' ? event.colDef.editable(event as never) : event.colDef.editable; if (event.data && !editable) navigate(`/projects/${event.data.projectId}`) }}
          onModelUpdated={(event) => { const next: Row[] = []; event.api.forEachNodeAfterFilterAndSort((node) => { if (node.data) next.push(node.data) }); setShown(next) }}
          singleClickEdit
          stopEditingWhenCellsLoseFocus
          rowClassRules={{ 'row-overdue': (p) => p.data?.bucket === 'overdue' }}
        />
      </div>
      <p className="fine grid-total"><b>{shown.length} stage{shown.length === 1 ? '' : 's'}</b> · {dollars(totals.cents, currency)} · {dollars(totals.paid, currency)} paid, {dollars(totals.cents - totals.paid, currency)} open</p>
    </section>
  )
}
