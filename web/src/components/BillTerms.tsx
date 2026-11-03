import { Chip } from './ui'
import { dollars } from '../lib/money'
import type { LineItem } from '../lib/types'

/** Whole days past a due date (YYYY-MM-DD), counted in UTC like the server. Zero on the day itself and before it. */
export function daysOverdue(dueDate: string, now = new Date()): number {
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)
  const due = Date.parse(`${dueDate}T00:00:00Z`)
  return Number.isNaN(due) ? 0 : Math.max(0, Math.round((today - due) / 86_400_000))
}

const dayWords = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/**
 * What a bill says beyond its total: the items, the day it falls due and the note. Shown to the owner on the receipt
 * and to the client on their status page. `unpaid` turns a past due date into an "overdue by N days" chip.
 */
export function BillTerms({ lineItems, dueDate, customerNote, currency, unpaid = false }: { lineItems?: LineItem[] | null; dueDate?: string | null; customerNote?: string | null; currency: string; unpaid?: boolean }) {
  const late = dueDate && unpaid ? daysOverdue(dueDate) : 0
  if (!lineItems?.length && !dueDate && !customerNote) return null
  return (
    <div className="bill-terms" data-testid="bill-terms">
      {lineItems?.length ? (
        <table className="bill-items">
          <caption className="sr-only">Line items</caption>
          <thead><tr><th scope="col">Item</th><th scope="col" className="num">Qty</th><th scope="col" className="num">Unit</th><th scope="col" className="num">Amount</th></tr></thead>
          <tbody>
            {lineItems.map((item, index) => (
              <tr key={`${index}-${item.description}`}>
                <td>{item.description}</td>
                <td className="num mono">{item.quantity}</td>
                <td className="num mono">{dollars(item.unitCents, currency)}</td>
                <td className="num mono">{dollars(item.quantity * item.unitCents, currency)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><th scope="row" colSpan={3}>Total</th><td className="num mono">{dollars(lineItems.reduce((sum, item) => sum + item.quantity * item.unitCents, 0), currency)}</td></tr></tfoot>
        </table>
      ) : null}
      {dueDate ? (
        <p className="bill-due"><span>Due</span> <strong>{dayWords(dueDate)}</strong>{late > 0 ? <> <Chip tone="deny">Overdue by {late} day{late === 1 ? '' : 's'}</Chip></> : null}</p>
      ) : null}
      {customerNote ? <p className="bill-note"><span>Note for the client</span>{customerNote}</p> : null}
    </div>
  )
}
