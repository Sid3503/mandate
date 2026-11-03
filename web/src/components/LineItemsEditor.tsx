import { dollars, parseCents } from '../lib/money'
import type { LineItem } from '../lib/types'

/** One editable line, kept as text so a half-typed price is never rounded under the person's fingers. */
export type ItemRow = { key: number; description: string; quantity: string; price: string }
export const MAX_ROWS = 20
export const wholeQuantity = (text: string): number | null => (/^\d{1,3}$/.test(text.trim()) && Number(text) >= 1 ? Number(text) : null)

/** The next free key for a new row. */
export const nextRowKey = (rows: ItemRow[]): number => rows.reduce((max, row) => Math.max(max, row.key), 0) + 1

/** The rows as the server's line items, or null while any row is incomplete. */
export function rowsToItems(rows: ItemRow[]): LineItem[] | null {
  if (rows.length === 0) return null
  if (!rows.every((row) => row.description.trim() && wholeQuantity(row.quantity) !== null && (parseCents(row.price) ?? 0) > 0)) return null
  return rows.map((row) => ({ description: row.description.trim(), quantity: wholeQuantity(row.quantity)!, unitCents: parseCents(row.price)! }))
}

/**
 * The line-items editor of a bill: used by the request form and by the Invoices desk's draft card. The rows are the
 * caller's state; this only draws them. Fields listed in `flag` are highlighted with a one-line prompt.
 */
export function LineItemsEditor({ rows, onChange, currency, legend = <>Line items <span className="fine">(optional, signed into the lock)</span></>, flagged = false, flagText }: {
  rows: ItemRow[]
  onChange: (rows: ItemRow[]) => void
  currency: string
  legend?: React.ReactNode
  /** Highlight the editor, and say `flagText`, because the notes did not give what it needs. */
  flagged?: boolean
  flagText?: string
}) {
  const items = rowsToItems(rows)
  const subtotal = items ? items.reduce((sum, item) => sum + item.quantity * item.unitCents, 0) : null
  const set = (key: number, patch: Partial<ItemRow>) => onChange(rows.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  return (
    <fieldset className={`field line-items${flagged ? ' field-missing' : ''}`} data-testid="line-items">
      <legend>{legend}</legend>
      {rows.map((row, index) => (
        <div className="line-row" key={row.key}>
          <input aria-label={`Item ${index + 1} description`} value={row.description} maxLength={200} placeholder="What it is" onChange={(event) => set(row.key, { description: event.target.value })} />
          <input aria-label={`Item ${index + 1} quantity`} inputMode="numeric" value={row.quantity} placeholder="Qty" onChange={(event) => set(row.key, { quantity: event.target.value })} />
          <input aria-label={`Item ${index + 1} unit price`} inputMode="decimal" value={row.price} placeholder="Unit price" onChange={(event) => set(row.key, { price: event.target.value })} />
          <button type="button" className="btn btn-ghost btn-small" aria-label={`Remove item ${index + 1}`} onClick={() => onChange(rows.filter((item) => item.key !== row.key))}>Remove</button>
        </div>
      ))}
      {flagged && flagText ? <p className="missing-prompt" role="note">{flagText}</p> : null}
      <div className="row between wrap gap-s">
        <button type="button" className="btn btn-ghost btn-small" disabled={rows.length >= MAX_ROWS} onClick={() => onChange([...rows, { key: nextRowKey(rows), description: '', quantity: '1', price: '' }])}>Add a line item</button>
        {rows.length > 0 ? <strong className="mono" data-testid="line-subtotal">Subtotal {subtotal === null ? '—' : dollars(subtotal, currency)}</strong> : null}
      </div>
    </fieldset>
  )
}
