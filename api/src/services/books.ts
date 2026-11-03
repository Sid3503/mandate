import { GENESIS_HASH, journalHash, type JournalEntryRow, type Posting, type Repo } from '../db/repo'
import { Problem } from '../http/problem'

/**
 * The books: the double-entry ledger, read back for people. Nothing here writes. The repo posts every entry inside the
 * same transaction as the money change it records; this service only sums the postings, walks the hash chain again
 * from the first entry, and pages the journal for the console.
 */

/** One currency's books in the words the owner uses: what is in PayPal, what came in, what went out, what PayPal kept. */
export type BooksTotals = {
  currency: string
  /** `paypal:balance`: the money the books say is in the PayPal account. */
  cashCents: number
  /** What clients paid (`income:client_payments`, a credit, shown positive). */
  inCents: number
  /** What contractors were paid (every `expense:payouts:<payee>`). */
  outCents: number
  /** What PayPal kept on captures and payouts (`expense:paypal_fees`). */
  feesCents: number
  /** Money sent back to clients as refunds (`income:refunds`). */
  refundsCents: number
  /** Client payments PayPal took back, such as chargebacks (`income:reversals`). */
  reversalsCents: number
}

export type BooksChain = {
  entries: number
  /** The hash of the newest entry, or the genesis hash when the journal is empty. */
  head: string
  verified: boolean
  /** The seq of the first entry that does not balance, is out of sequence, or does not hash to what it says. */
  brokenAt: number | null
}

export type BooksJournalEntry = {
  id: string
  seq: number
  proposalId: string
  purpose: string
  currency: string
  deltaCents: number
  memo: string
  prevHash: string
  hash: string
  createdAt: string
  postings: Posting[]
  /** What the request was, so a reader can tell entries apart without opening each receipt. Null if the row is gone. */
  kind: string | null
  payeeId: string | null
  description: string | null
}

type Entry = JournalEntryRow & { postings: Posting[] }

export class BooksService {
  constructor(private readonly repo: Repo) {}

  /** Every account's balance, the headline totals per currency, and whether the chain still checks out. */
  summary(): { balances: Array<{ account: string; currency: string; cents: number }>; totals: BooksTotals[]; chain: BooksChain } {
    const balances = this.repo.ledgerBalances()
    const byCurrency = new Map<string, BooksTotals>()
    for (const row of balances) {
      const totals = byCurrency.get(row.currency) ?? { currency: row.currency, cashCents: 0, inCents: 0, outCents: 0, feesCents: 0, refundsCents: 0, reversalsCents: 0 }
      if (row.account === 'paypal:balance') totals.cashCents += row.cents
      else if (row.account === 'income:client_payments') totals.inCents += -row.cents
      else if (row.account.startsWith('expense:payouts:')) totals.outCents += row.cents
      else if (row.account === 'expense:paypal_fees') totals.feesCents += row.cents
      else if (row.account === 'income:refunds') totals.refundsCents += row.cents
      else if (row.account === 'income:reversals') totals.reversalsCents += row.cents
      byCurrency.set(row.currency, totals)
    }
    return { balances, totals: [...byCurrency.values()], chain: verifyChain(this.repo.allJournal()) }
  }

  /**
   * The journal, newest first. A page ends at `limit` entries; the cursor is the seq of the last entry on the page, and
   * the next page starts just below it. With a proposal id it is that request's whole story instead, oldest first,
   * the order a receipt reads in.
   */
  journal(options: { limit: number; cursor?: string; proposalId?: string }): { data: BooksJournalEntry[]; nextCursor: string | null } {
    if (options.proposalId) {
      return { data: this.repo.journal(0, options.proposalId).map((entry) => this.view(entry)), nextCursor: null }
    }
    let below = Number.POSITIVE_INFINITY
    if (options.cursor !== undefined) {
      below = Number(options.cursor)
      if (!Number.isInteger(below) || below < 1) throw new Problem(400, 'books.cursor', 'That cursor is not a journal position', 'Pass back the nextCursor from the previous page.')
    }
    const newestFirst = this.repo.allJournal().filter((entry) => entry.seq < below).reverse()
    const page = newestFirst.slice(0, options.limit)
    const last = page[page.length - 1]
    return { data: page.map((entry) => this.view(entry)), nextCursor: newestFirst.length > options.limit && last ? String(last.seq) : null }
  }

  private view(entry: Entry): BooksJournalEntry {
    const row = this.repo.proposal(entry.proposal_id)
    return {
      id: entry.id,
      seq: entry.seq,
      proposalId: entry.proposal_id,
      purpose: entry.purpose,
      currency: entry.currency,
      deltaCents: entry.delta_cents,
      memo: entry.memo,
      prevHash: entry.prev_hash,
      hash: entry.hash,
      createdAt: entry.created_at,
      postings: entry.postings,
      kind: row?.kind ?? null,
      payeeId: row?.payee_id ?? null,
      description: row?.description ?? null,
    }
  }
}

/**
 * Walks the journal from the genesis hash and recomputes every entry's hash. The first entry whose legs do not sum
 * to zero, whose seq skips, or whose hash is not what its fields and the entry before it say, is where the chain broke.
 */
export function verifyChain(journal: Entry[]): BooksChain {
  let prev = GENESIS_HASH
  let brokenAt: number | null = null
  journal.forEach((entry, index) => {
    if (brokenAt !== null) return
    const sum = entry.postings.reduce((total, leg) => total + leg.amountCents, 0)
    const expected = journalHash(prev, { id: entry.id, seq: entry.seq, proposalId: entry.proposal_id, purpose: entry.purpose, currency: entry.currency, deltaCents: entry.delta_cents, memo: entry.memo, createdAt: entry.created_at }, entry.postings)
    if (sum !== 0 || entry.postings.length < 2 || entry.seq !== index + 1 || entry.prev_hash !== prev || entry.hash !== expected) brokenAt = entry.seq
    prev = entry.hash
  })
  const last = journal[journal.length - 1]
  return { entries: journal.length, head: last?.hash ?? GENESIS_HASH, verified: brokenAt === null, brokenAt }
}
