import type { LedgerRow } from './rows'

export const GROUPS = ['reason', 'how', 'who', 'status', 'decision', 'direction', 'kind', 'day'] as const
export type GroupBy = (typeof GROUPS)[number]
export type TotalsArgs = { decision?: LedgerRow['decision']; direction?: LedgerRow['direction']; group_by?: GroupBy }

export type Totals = { requests: number; asked: number; refused: number; moneyIn: number; moneyOut: number; owed: number }
const cents = (value: number) => Math.round(value * 100)
const empty = (): Totals => ({ requests: 0, asked: 0, refused: 0, moneyIn: 0, moneyOut: 0, owed: 0 })

/**
 * What the analyst reads numbers from. Studio's own query tool is general and its schema is large; this is the small
 * question the owner actually asks ("how many, how much, of which kind") answered from the rows in this tab. It reads a
 * copy of the ledger and changes nothing. Sums are added in cents so a total never carries a rounding error.
 */
export function summarise(rows: LedgerRow[], args: TotalsArgs = {}): { total: Totals; groups: Array<Totals & { group: string }> } {
  const picked = rows.filter((row) => (!args.decision || row.decision === args.decision) && (!args.direction || row.direction === args.direction))
  const add = (into: Totals & Record<string, number>, row: LedgerRow) => {
    into.requests += 1
    into.asked += cents(row.amount)
    into.refused += cents(row.refused)
    into.moneyIn += cents(row.moneyIn)
    into.moneyOut += cents(row.moneyOut)
    into.owed += cents(row.owed)
  }
  const dollars = (t: Totals): Totals => ({ requests: t.requests, asked: t.asked / 100, refused: t.refused / 100, moneyIn: t.moneyIn / 100, moneyOut: t.moneyOut / 100, owed: t.owed / 100 })
  const total = empty()
  for (const row of picked) add(total as never, row)
  const by = new Map<string, Totals>()
  if (args.group_by) {
    for (const row of picked) {
      const key = String(row[args.group_by] ?? 'none')
      if (!by.has(key)) by.set(key, empty())
      add(by.get(key) as never, row)
    }
  }
  return { total: dollars(total), groups: [...by.entries()].sort((a, b) => b[1].requests - a[1].requests).slice(0, 25).map(([group, t]) => ({ group, ...dollars(t) })) }
}
