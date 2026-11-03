import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { ColDef, ICellRendererParams } from 'ag-grid-community'
import { AgGridReact } from 'ag-grid-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ActivityTabs } from '../components/ActivityTabs'
import { Chip, Loading, Money, PageHead, ProblemCard } from '../components/ui'
import { api } from '../lib/api'
import { accountWords, purposeWords } from '../lib/books'
import { shortId, when } from '../lib/format'
import { useSession } from '../lib/hooks'
import { dollars } from '../lib/money'
import type { BooksTotals, JournalEntry, Posting } from '../lib/types'
import { ledgerGridTheme } from './Ledger'

type DetailRow = { id: string; detail: true; entry: JournalEntry }
type GridRow = JournalEntry | DetailRow

function isDetail(row: GridRow): row is DetailRow {
  return 'detail' in row && row.detail === true
}

function legSide(cents: number): 'Debit' | 'Credit' {
  return cents > 0 ? 'Debit' : 'Credit'
}

function Legs({ data }: { data?: DetailRow }) {
  if (!data) return null
  return (
    <div className="books-legs">
      {data.entry.postings.map((leg: Posting) => (
        <div key={`${leg.account}:${leg.amountCents}`} className="books-leg">
          <span>{accountWords(leg.account)}</span>
          <span>{legSide(leg.amountCents)}</span>
          <span>{dollars(Math.abs(leg.amountCents), data.entry.currency)}</span>
        </div>
      ))}
    </div>
  )
}

function Totals({ row }: { row: BooksTotals }) {
  const returned = row.refundsCents + row.reversalsCents
  return (
    <section className="totals books" aria-label={`${row.currency} books`}>
      <div className="total"><span>PayPal balance · {row.currency}</span><Money cents={row.cashCents} size="xl" currency={row.currency} /></div>
      <div className="total total-in"><span>In</span><Money cents={row.inCents} size="xl" currency={row.currency} /></div>
      <div className="total total-out"><span>Out</span><Money cents={row.outCents} size="xl" currency={row.currency} /></div>
      <div className="total"><span>Fees</span><Money cents={row.feesCents} size="xl" currency={row.currency} /></div>
      <div className="total"><span>Refunds and reversals</span><Money cents={returned} size="xl" currency={row.currency} /></div>
    </section>
  )
}

export function Books() {
  const session = useSession()
  const owner = session.data?.role === 'owner'
  const books = useQuery({ queryKey: ['books'], queryFn: api.books, enabled: owner })
  const journal = useInfiniteQuery({
    queryKey: ['books-journal'],
    queryFn: ({ pageParam }) => api.journal(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: owner,
  })
  const navigate = useNavigate()
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const entries = useMemo(() => journal.data?.pages.flatMap((page) => page.data) ?? [], [journal.data])
  const rows = useMemo<GridRow[]>(() => entries.flatMap((entry) => (open.has(entry.id) ? [entry, { id: `${entry.id}:legs`, detail: true as const, entry }] : [entry])), [entries, open])

  const columns = useMemo<ColDef<GridRow>[]>(() => [
    {
      headerName: '', width: 46, sortable: false,
      cellRenderer: (params: ICellRendererParams<GridRow>) => {
        if (!params.data || isDetail(params.data)) return null
        const id = params.data.id
        const expanded = open.has(id)
        return (
          <button type="button" className="books-expand" aria-expanded={expanded} aria-label={expanded ? 'Hide postings' : 'Show postings'} onClick={(event) => {
            event.stopPropagation()
            setOpen((prev) => {
              const next = new Set(prev)
              if (next.has(id)) next.delete(id)
              else next.add(id)
              return next
            })
          }}>{expanded ? '–' : '+'}</button>
        )
      },
    },
    { headerName: '#', width: 72, valueGetter: (params) => (params.data && !isDetail(params.data) ? params.data.seq : ''), sort: 'desc' },
    { headerName: 'When', width: 148, valueGetter: (params) => (params.data && !isDetail(params.data) ? when(params.data.createdAt) : '') },
    { headerName: 'What', flex: 1, minWidth: 160, valueGetter: (params) => (params.data && !isDetail(params.data) ? purposeWords(params.data.purpose) : '') },
    { headerName: 'For', flex: 1.2, minWidth: 180, valueGetter: (params) => (params.data && !isDetail(params.data) ? params.data.description ?? params.data.memo : '') },
    {
      headerName: 'Amount', width: 120, type: 'rightAligned', cellClass: 'grid-money',
      valueGetter: (params) => (params.data && !isDetail(params.data) ? dollars(params.data.deltaCents, params.data.currency) : ''),
    },
    {
      headerName: 'Hash', width: 110, cellClass: 'grid-mono',
      valueGetter: (params) => (params.data && !isDetail(params.data) ? params.data.hash.slice(0, 8) : ''),
      tooltipValueGetter: (params) => (params.data && !isDetail(params.data) ? params.data.hash : ''),
    },
    {
      headerName: '', width: 88, sortable: false,
      cellRenderer: (params: ICellRendererParams<GridRow>) => (params.data && !isDetail(params.data) ? <Link to={`/p/${params.data.proposalId}`} onClick={(event) => event.stopPropagation()}>Receipt</Link> : null),
    },
  ], [open])

  if (session.isLoading) return <div className="page page-wide"><Loading label="Opening the books" /></div>
  if (!owner) return <div className="page"><ActivityTabs /><PageHead eyebrow="Double-entry" title="Books" /><p className="muted">The books are the studio's own accounts, so they open with the owner key.</p></div>
  if (books.isLoading || journal.isLoading) return <div className="page page-wide"><ActivityTabs /><Loading label="Opening the books" /></div>

  const chain = books.data?.chain
  const verified = chain?.verified === true
  return (
    <div className="page page-wide">
      <ActivityTabs />
      <PageHead eyebrow="Double-entry · debits positive · one hash chain" title="Books">
        {chain ? <Chip tone={verified ? 'auto' : 'deny'}>{verified ? 'Chain verified' : `Broken at #${chain.brokenAt}`}</Chip> : null}
      </PageHead>
      <ProblemCard error={books.error ?? journal.error} />
      {(books.data?.totals.length ? books.data.totals : [{ currency: 'USD', cashCents: 0, inCents: 0, outCents: 0, feesCents: 0, refundsCents: 0, reversalsCents: 0 }]).map((row) => <Totals key={row.currency} row={row} />)}
      <section className="panel">
        <div className="row between">
          <h2 className="panel-title">Balances</h2>
          <span className="fine">{chain ? `${chain.entries} entries · head ${shortId(chain.head, 6)}` : ''}</span>
        </div>
        {books.data && books.data.balances.length > 0 ? (
          <div className="books-accounts">
            {books.data.balances.map((row) => (
              <div key={`${row.account}:${row.currency}`} className="books-account">
                <span>{accountWords(row.account)}</span>
                <span className="fine mono">{row.account}</span>
                <strong>{dollars(row.cents, row.currency)}</strong>
              </div>
            ))}
          </div>
        ) : <p className="muted">Nothing has been posted. The chain sits at the genesis hash.</p>}
      </section>
      <div className="grid-wrap" style={{ height: Math.min(720, 160 + rows.length * 46) }}>
        <AgGridReact<GridRow>
          theme={ledgerGridTheme}
          rowData={rows}
          columnDefs={columns}
          getRowId={(params) => params.data.id}
          isFullWidthRow={(params) => Boolean(params.rowNode.data && isDetail(params.rowNode.data))}
          fullWidthCellRenderer={Legs}
          getRowHeight={(params) => (params.data && isDetail(params.data) ? 16 + params.data.entry.postings.length * 28 : 46)}
          onRowClicked={(event) => event.data && !isDetail(event.data) && navigate(`/p/${event.data.proposalId}`)}
          headerHeight={40}
          animateRows={false}
          suppressCellFocus
          tooltipShowDelay={300}
          overlayNoRowsTemplate="The journal is empty."
        />
      </div>
      <div className="grid-foot">
        <span>{entries.length} journal lines, newest first</span>
        {journal.hasNextPage ? <button type="button" className="btn btn-ghost" onClick={() => void journal.fetchNextPage()} disabled={journal.isFetchingNextPage}>Load older</button> : <span>Start of the journal</span>}
      </div>
    </div>
  )
}
