import type { AgWidgetFormParams, AgWidgetParams, AgWidgetsConfig } from 'ag-studio'
import { createWidgets } from 'ag-studio-react'
import { useEffect, useState } from 'react'
import { accountWords, purposeWords } from '../lib/books'
import { dollars } from '../lib/money'
import type { Books, JournalEntry } from '../lib/types'

/** What the control room hands Studio beside the ledger rows. Widgets only display it. */
export type StudioBooksContext = {
  /** Changes when the ledger rows change, so a widget re-reads. */
  signature: string
  books: Books | null
  journal: JournalEntry[]
}

const PAYMENTS = 'ledger.moneyIn'
const PAYOUTS = 'ledger.payouts'
const FEES = 'ledger.fees'
const REASON = 'ledger.reason'
const DECISION = 'ledger.decision'
const REFUSED = 'ledger.refused'
const COUNT = 'ledger.id'

const flowIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 12h16M14 7l5 5-5 5" fill="none" stroke="#050505" stroke-width="2"/></svg>'
const wallIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 5h18v14H3z M3 10h18 M3 15h18 M9 5v14 M15 5v14" fill="none" stroke="#050505" stroke-width="1.6"/></svg>'
const chainIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M8 12a4 4 0 0 1 4-4h2M16 12a4 4 0 0 1-4 4h-2" fill="none" stroke="#050505" stroke-width="2"/></svg>'

function readNumber(row: Record<string, unknown>, fieldId: string): number {
  const direct = row[fieldId]
  if (typeof direct === 'number') return direct
  const tail = fieldId.slice(fieldId.lastIndexOf('.') + 1)
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== 'number') continue
    if (key === tail || key.endsWith(`.${tail}`) || key.endsWith(`_${tail}`) || key.includes(fieldId)) return value
  }
  return 0
}

function readText(row: Record<string, unknown>, fieldId: string): string {
  const direct = row[fieldId]
  if (direct === null || direct === undefined) {
    const tail = fieldId.slice(fieldId.lastIndexOf('.') + 1)
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'string' && (key === tail || key.endsWith(`.${tail}`) || key.includes(fieldId))) return value
    }
    return ''
  }
  return String(direct)
}

type FlatRows = { results: { rows: Record<string, unknown>[] } }

/** Studio's query type is the hydrated field, not the `{ id, aggregation }` reference a widget sends. */
function flatRows(widgetApi: AgWidgetParams['widgetApi'], fields: Array<{ id: string; aggregation?: 'sum' | 'count' }>): Promise<FlatRows> {
  const getData = widgetApi.getData as (query: { fields: typeof fields }) => Promise<FlatRows>
  return getData({ fields })
}

function contextOf(params: AgWidgetParams): StudioBooksContext {
  const context = params.context as StudioBooksContext | undefined
  return context ?? { signature: '', books: null, journal: [] }
}

/** Client payments, then contractor payouts, fees, and what stayed. Sums respect the page filter. */
function MoneyFlowWidget(params: AgWidgetParams) {
  const { widgetApi } = params
  const { signature } = contextOf(params)
  const [figures, setFigures] = useState<{ payments: number; payouts: number; fees: number; kept: number } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    let gone = false
    widgetApi.setDisplayState('loading', { prominent: false })
    void flatRows(widgetApi, [
      { id: PAYMENTS, aggregation: 'sum' },
      { id: PAYOUTS, aggregation: 'sum' },
      { id: FEES, aggregation: 'sum' },
    ]).then((response) => {
      if (gone) return
      const row = response.results?.rows?.[0] ?? {}
      const payments = readNumber(row, PAYMENTS)
      const payouts = readNumber(row, PAYOUTS)
      const fees = readNumber(row, FEES)
      setFigures({ payments, payouts, fees, kept: payments - payouts - fees })
      setProblem(null)
      widgetApi.setDisplayState('displayed')
    }).catch(() => {
      if (gone) return
      setProblem('The ledger copy could not be summed.')
      widgetApi.setDisplayState('displayed')
    })
    return () => { gone = true }
  }, [widgetApi, signature])
  const steps = figures ? [
    { label: 'Client payments', amount: figures.payments, kept: false },
    { label: 'Contractor payouts', amount: figures.payouts, kept: false },
    { label: 'Fees', amount: figures.fees, kept: false },
    { label: 'Kept', amount: figures.kept, kept: true },
  ] : []
  return (
    <div className="mandate-widget">
      {problem ? <p className="fine">{problem}</p> : null}
      <div className="money-flow">
        {steps.map((step) => (
          <div key={step.label} className={step.kept ? 'money-flow-step kept' : 'money-flow-step'}>
            <span>{step.label}</span>
            <strong>{dollars(Math.round(step.amount * 100))}</strong>
          </div>
        ))}
      </div>
      <p className="fine">Confirmed money only. Kept is client payments minus contractor payouts and PayPal fees. A page filter narrows it.</p>
    </div>
  )
}

/** One tile per rule that refused money: how many times, and the dollars asked for. */
function RefusalWallWidget(params: AgWidgetParams) {
  const { widgetApi } = params
  const { signature } = contextOf(params)
  const [tiles, setTiles] = useState<Array<{ rule: string; count: number; dollars: number }>>([])
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    let gone = false
    widgetApi.setDisplayState('loading', { prominent: false })
    void flatRows(widgetApi, [
      { id: REASON },
      { id: DECISION },
      { id: COUNT, aggregation: 'count' },
      { id: REFUSED, aggregation: 'sum' },
    ]).then((response) => {
      if (gone) return
      const next = (response.results?.rows ?? [])
        .filter((row) => readText(row, DECISION) === 'DENY')
        .map((row) => ({ rule: readText(row, REASON) || 'no rule', count: readNumber(row, COUNT), dollars: readNumber(row, REFUSED) }))
        .filter((tile) => tile.count > 0)
        .sort((a, b) => b.dollars - a.dollars || b.count - a.count)
      setTiles(next)
      setProblem(null)
      widgetApi.setDisplayState(next.length ? 'displayed' : 'noData')
    }).catch(() => {
      if (gone) return
      setProblem('The refusals could not be read.')
      widgetApi.setDisplayState('displayed')
    })
    return () => { gone = true }
  }, [widgetApi, signature])
  return (
    <div className="mandate-widget">
      {problem ? <p className="fine">{problem}</p> : null}
      <div className="refusal-wall">
        {tiles.map((tile) => (
          <div key={tile.rule} className="refusal-tile">
            <code>{tile.rule}</code>
            <b>{dollars(Math.round(tile.dollars * 100))}</b>
            <span className="fine">{tile.count} {tile.count === 1 ? 'request' : 'requests'} stopped</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The hash chain, re-walked by the books API, and the newest journal lines. */
function BooksIntegrityWidget(params: AgWidgetParams) {
  const { widgetApi } = params
  const { books, journal } = contextOf(params)
  useEffect(() => {
    // Our own sentence covers a missing read. Studio's no-data overlay would hide it.
    widgetApi.setDisplayState('displayed')
  }, [widgetApi, books])
  if (!books) return <div className="mandate-widget"><p className="fine">The books have not answered on this read.</p></div>
  const chain = books.chain
  return (
    <div className="mandate-widget">
      <div className="books-widget-head">
        <strong>{chain.verified ? 'Chain verified' : `Broken at #${chain.brokenAt}`}</strong>
        <span className="fine">{chain.entries} entries · {chain.head.slice(0, 8)}</span>
      </div>
      {journal.length === 0 ? <p className="fine">No journal lines yet.</p> : journal.map((entry) => (
        <div key={entry.id} className="books-widget-row">
          <span>#{entry.seq}</span>
          <span>{purposeWords(entry.purpose)}{entry.description ? ` · ${entry.description}` : ''}</span>
          <span>{dollars(entry.deltaCents, entry.currency)}</span>
        </div>
      ))}
      {books.balances.length > 0 ? <p className="fine">{books.balances.map((row) => `${accountWords(row.account)} ${dollars(row.cents, row.currency)}`).join(' · ')}</p> : null}
    </div>
  )
}

/**
 * Mandate widgets for the control room. Registered through `createWidgets` from `ag-studio-react`
 * (https://www.ag-grid.com/studio/react/custom-widgets/). Each one only displays a copy.
 * The registry generic only accepts extra widget types once a custom registry is declared, so the
 * call is checked as the widget definitions above and then handed to Studio.
 */
function plainForm(params: AgWidgetFormParams) {
  return params.createDefaults({ dataMappingItems: [] })
}

export function mandateWidgets(config: AgWidgetsConfig): AgWidgetsConfig {
  return createWidgets({
    additionalTypes: [
      {
        id: 'money-flow',
        label: 'Money flow',
        icon: flowIcon,
        form: plainForm,
        comp: MoneyFlowWidget,
        defaultSize: { width: 640, height: 220 },
        minSize: { width: 280, height: 140 },
        ai: {
          label: 'Money flow',
          description: 'Four stages of confirmed money: client payments, contractor payouts, PayPal fees, and what was kept. Needs no field mapping. It sums ledger.moneyIn, ledger.payouts and ledger.fees, and a page filter narrows those sums.',
          usage: 'Use when the owner asks where client money went, or to show payments, payouts, fees and kept together. Do not use it for a single request or for refusals.',
          configuration: 'Place it with no data mapping. Do not invent fields. The title may be set. Kept is payments minus payouts minus fees.',
        },
      },
      {
        id: 'refusal-wall',
        label: 'Refusal wall',
        icon: wallIcon,
        form: plainForm,
        comp: RefusalWallWidget,
        defaultSize: { width: 480, height: 220 },
        minSize: { width: 240, height: 140 },
        ai: {
          label: 'Refusal wall',
          description: 'One tile per rule code that refused money, with how many requests it stopped and the dollars asked for. Needs no field mapping. It groups ledger.reason where ledger.decision is DENY and sums ledger.refused.',
          usage: 'Use when the owner asks which rules stopped money. Do not use it for money that was paid.',
          configuration: 'Place it with no data mapping. Tiles are the rule codes themselves.',
        },
      },
      {
        id: 'books-integrity',
        label: 'Books integrity',
        icon: chainIcon,
        form: plainForm,
        comp: BooksIntegrityWidget,
        defaultSize: { width: 720, height: 240 },
        minSize: { width: 320, height: 140 },
        ai: {
          label: 'Books integrity',
          description: 'Whether the double-entry hash chain still verifies, the head hash, and the newest journal lines. It reads the books copy already loaded for this page. It has no ledger fields. If that copy is missing, it says the books have not answered.',
          usage: 'Use when the owner asks if the books are intact, or wants the chain and the last journal lines. Do not use it to sum the ledger.',
          configuration: 'Place it with no data mapping and no filters. The chain status comes from the books API, not from a field.',
        },
      },
    ],
    menu: [...config.menu, { label: 'Mandate', widgetIds: ['money-flow', 'refusal-wall', 'books-integrity'] }],
  } as never) as AgWidgetsConfig
}
