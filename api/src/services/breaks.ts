import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Repo, ProposalRow } from '../db/repo'
import { arrivedCents } from '../domain/phases'
import { detectBreaks, type Break, type BreakEventFact, type BreakSeverity } from '../domain/breaks'
import { Problem } from '../http/problem'
import { PayPalError } from '../paypal/port'
import { INFLIGHT_MS, type MandateService } from './mandate'
import { paypalProblem } from './paypalProblem'

/**
 * The Breaks desk's keeper. It gathers the facts (requests, their events, the journal, disputes, the owner's rules, and
 * on demand PayPal's own list), asks the pure rules in `domain/breaks.ts` what disagrees, and keeps the answer as rows:
 * a new disagreement opens a break, one that has gone away resolves it, one that comes back reopens it, and one the
 * owner dismissed stays quiet until its evidence changes. Every change is a row in the append-only `break_events`.
 *
 * It never moves money and never writes to a request. A fix may only call a safe existing service method (a re-read from
 * PayPal, a reminder, cancelling an unclaimed payout, crash recovery) or FILE A REFUND REQUEST through the normal propose
 * path as the autopilot, so the gate decides it exactly as it would anyone's. Nothing here captures, and nothing here
 * can approve.
 */

export type BreakState = 'open' | 'resolved' | 'dismissed'

type BreakRow = {
  key: string
  rule: string
  severity: BreakSeverity
  proposal_id: string | null
  title: string
  detail: string
  expected: string
  observed: string
  delta_cents: number | null
  first_seen_at: string
  last_seen_at: string
  resolved_at: string | null
  dismissed_at: string | null
  dismissed_by: string | null
  dismiss_note: string | null
  fingerprint: string | null
}

export type BreakView = {
  key: string
  rule: string
  severity: BreakSeverity
  proposalId: string | null
  title: string
  detail: string
  expected: string
  observed: string
  deltaCents: number | null
  state: BreakState
  firstSeenAt: string
  lastSeenAt: string
  resolvedAt: string | null
  dismissedAt: string | null
  dismissedBy: string | null
  dismissNote: string | null
  /** Open and a person has to act: no safe fix exists, or a filed fix is waiting for approval. */
  waitingOnYou: boolean
  fix: FixOffer | null
}

export type FixOffer = { action: FixAction; label: string; sentence: string }
type FixAction = 'file_refund' | 'refresh_capture' | 'refresh_refund' | 'refresh_invoice' | 'remind' | 'cancel_unclaimed' | 'recover_stalled'

/** What a fix may do, by rule. The sentence is shown on the button: it says what will happen and who decides. */
const FIXES: Record<string, FixOffer> = {
  'capture.duplicate': { action: 'file_refund', label: 'File a refund request', sentence: 'Files a refund request for the later payment, as the autopilot. Your rules decide: it may go ahead on its own, wait for your approval, or be refused. It never refunds without the gate.' },
  'capture.pending_stale': { action: 'refresh_capture', label: 'Re-read the capture', sentence: 'Asks PayPal about this capture again and records what it says. It cannot complete a capture by itself.' },
  'refund.pending_stale': { action: 'refresh_refund', label: 'Re-read the refund', sentence: 'Asks PayPal about this refund again and records what it says. It cannot send or change a refund.' },
  'payout.unclaimed_aging': { action: 'cancel_unclaimed', label: 'Cancel the unclaimed payout', sentence: 'Asks PayPal to cancel this unclaimed payout and return the money. PayPal refuses it while the batch is still processing; nothing changes then.' },
  'invoice.overdue': { action: 'remind', label: 'Send a reminder', sentence: 'Sends the client PayPal\'s own reminder for this invoice. It does not cancel it or change the amount.' },
  'invoice.stuck_draft': { action: 'refresh_invoice', label: 'Re-read the invoice', sentence: 'Asks PayPal about this invoice again and records what it says. It does not capture or settle anything itself.' },
  'settlement.short_aging': { action: 'refresh_invoice', label: 'Re-read the invoice', sentence: 'Asks PayPal whether the rest of the invoice has arrived and records it. Chasing the client for the rest is yours to do.' },
  'inflight.stalled': { action: 'recover_stalled', label: 'Recover stalled requests', sentence: 'Runs crash recovery: a request nothing was sent for goes back to where it was; one PayPal may already have paid is resumed with the same PayPal request id, so it cannot be paid twice. It covers every stalled request, not only this one.' },
}

export type ScanResult = {
  scannedAt: string
  detected: number
  opened: string[]
  resolved: string[]
  reopened: string[]
  /** Whether PayPal's own transaction list was compared: asked for and answered, not asked for, or asked for and unavailable. */
  paypal: 'checked' | 'skipped' | 'unavailable'
  paypalReason?: string
}

export type FixResult = {
  action: FixAction
  /** One sentence for the person: what was done and what happened. */
  statement: string
  /** For a refund request: what the gate decided. */
  gate?: string
  filedProposalId?: string
  phase?: string
  break: BreakView | null
}

const fingerprintOf = (found: Pick<Break, 'severity' | 'expected' | 'observed' | 'deltaCents'>): string =>
  createHash('sha256').update(JSON.stringify([found.severity, found.expected, found.observed, found.deltaCents])).digest('hex').slice(0, 32)

/** How often the sweep may rescan. A scan reads the whole ledger, so the sweep's few-second beat does not run it each time. */
const SCAN_EVERY_MS = 60_000

export class BreaksService {
  /** Called once for each critical break that opens (or reopens). The server hands the owner's notifier here. */
  onCritical: ((found: { key: string; title: string; eventId: number }) => void) | null = null
  private lastScanAt: string | null = null
  private lastPayPalAt: string | null = null
  private lastScanMs = 0

  constructor(
    private readonly db: DatabaseSync,
    private readonly repo: Repo,
    private readonly mandate: MandateService,
    private readonly now: () => Date,
  ) {}

  private iso(): string {
    return this.now().toISOString()
  }

  /** The sweep's entry: a scan at most once a minute, never with PayPal's slow transaction list, and never an error to the sweep. */
  async scanIfDue(): Promise<void> {
    if (Date.now() - this.lastScanMs < SCAN_EVERY_MS) return
    this.lastScanMs = Date.now()
    try {
      await this.scan(this.now(), { withPayPal: false })
    } catch {
      // A failed scan is retried at the next beat. It never reaches the sweep that called it.
    }
  }

  async scan(now: Date = this.now(), options: { withPayPal?: boolean } = {}): Promise<ScanResult> {
    // PayPal's list first: it is the slow part, and everything after it reads the ledger as one consistent moment.
    let activity: Awaited<ReturnType<MandateService['activity']>> | null = null
    let paypal: ScanResult['paypal'] = 'skipped'
    let paypalReason: string | undefined
    if (options.withPayPal) {
      try {
        activity = await this.mandate.activity(30)
        if (activity.available) paypal = 'checked'
        else {
          paypal = 'unavailable'
          paypalReason = activity.reason
        }
      } catch (error) {
        paypal = 'unavailable'
        paypalReason = error instanceof Problem ? error.detail : 'PayPal did not answer.'
      }
    }
    const events = new Map<string, BreakEventFact[]>()
    for (const row of this.db.prepare('SELECT proposal_id, type, created_at FROM events ORDER BY created_at ASC, rowid ASC').all() as Array<{ proposal_id: string; type: string; created_at: string }>) {
      const list = events.get(row.proposal_id)
      if (list) list.push(row)
      else events.set(row.proposal_id, [row])
    }
    const found = detectBreaks({
      now,
      proposals: this.repo.allProposals(),
      events,
      journal: this.repo.allJournal(),
      disputes: this.repo.listDisputes(500),
      automation: this.repo.latestWarrant()?.body.automation ?? null,
      activity: activity && activity.available ? activity : null,
      inflightMs: INFLIGHT_MS,
    })
    const result = this.keep(found, now.toISOString(), paypal === 'checked')
    this.lastScanAt = now.toISOString()
    if (paypal === 'checked') this.lastPayPalAt = this.lastScanAt
    return { scannedAt: this.lastScanAt, detected: found.length, ...result, paypal, ...(paypalReason ? { paypalReason } : {}) }
  }

  /** Writes what a scan found: opens, refreshes, reopens and resolves, with one history row for each change. */
  private keep(found: Break[], at: string, paypalChecked: boolean): { opened: string[]; resolved: string[]; reopened: string[] } {
    const opened: string[] = []
    const resolved: string[] = []
    const reopened: string[] = []
    const critical: Array<{ key: string; title: string; eventId: number }> = []
    const existing = new Map((this.db.prepare('SELECT * FROM breaks').all() as BreakRow[]).map((row) => [row.key, row]))
    const seen = new Set<string>()
    this.repo.transaction(() => {
      const event = (key: string, type: string, detail: string): number =>
        Number(this.db.prepare('INSERT INTO break_events (break_key, at, type, detail) VALUES (?, ?, ?, ?)').run(key, at, type, detail).lastInsertRowid)
      for (const item of found) {
        seen.add(item.key)
        const print = fingerprintOf(item)
        const row = existing.get(item.key)
        if (!row) {
          this.db.prepare('INSERT INTO breaks (key, rule, severity, proposal_id, title, detail, expected, observed, delta_cents, first_seen_at, last_seen_at, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)')
            .run(item.key, item.rule, item.severity, item.proposalId, item.title, item.detail, item.expected, item.observed, item.deltaCents, at, at)
          const id = event(item.key, 'opened', item.title)
          opened.push(item.key)
          if (item.severity === 'critical') critical.push({ key: item.key, title: item.title, eventId: id })
          continue
        }
        const refresh = () => this.db.prepare('UPDATE breaks SET severity = ?, title = ?, detail = ?, expected = ?, observed = ?, delta_cents = ?, last_seen_at = ? WHERE key = ?')
          .run(item.severity, item.title, item.detail, item.expected, item.observed, item.deltaCents, at, item.key)
        if (row.dismissed_at && !row.resolved_at) {
          // Dismissed: quiet, unless what it shows is not what the owner dismissed.
          if (row.fingerprint === print) {
            this.db.prepare('UPDATE breaks SET last_seen_at = ? WHERE key = ?').run(at, item.key)
            continue
          }
          refresh()
          this.db.prepare('UPDATE breaks SET dismissed_at = NULL, dismissed_by = NULL, dismiss_note = NULL, fingerprint = NULL WHERE key = ?').run(item.key)
          const id = event(item.key, 'reopened', 'The evidence changed after it was dismissed.')
          reopened.push(item.key)
          if (item.severity === 'critical') critical.push({ key: item.key, title: item.title, eventId: id })
        } else if (row.resolved_at) {
          refresh()
          this.db.prepare('UPDATE breaks SET resolved_at = NULL, dismissed_at = NULL, dismissed_by = NULL, dismiss_note = NULL, fingerprint = NULL WHERE key = ?').run(item.key)
          const id = event(item.key, 'reopened', 'It came back after it was resolved.')
          reopened.push(item.key)
          if (item.severity === 'critical') critical.push({ key: item.key, title: item.title, eventId: id })
        } else {
          refresh()
        }
      }
      for (const row of existing.values()) {
        if (seen.has(row.key) || row.resolved_at || row.dismissed_at) continue
        // A PayPal-only break is not judged when this scan did not look at PayPal.
        if (row.rule.startsWith('paypal.') && !paypalChecked) continue
        this.db.prepare('UPDATE breaks SET resolved_at = ? WHERE key = ?').run(at, row.key)
        event(row.key, 'resolved', 'It is no longer found.')
        resolved.push(row.key)
      }
    })
    // Told after the write is committed, once per opening.
    for (const item of critical) this.onCritical?.(item)
    return { opened, resolved, reopened }
  }

  private view(row: BreakRow): BreakView {
    const state: BreakState = row.resolved_at ? 'resolved' : row.dismissed_at ? 'dismissed' : 'open'
    const fix = FIXES[row.rule] ?? null
    let waiting = false
    if (state === 'open') {
      const filed = this.db.prepare(`SELECT detail FROM break_events WHERE break_key = ? AND type = 'fix_filed' ORDER BY id DESC LIMIT 1`).get(row.key) as { detail: string } | undefined
      const gate = filed ? (JSON.parse(filed.detail) as { gate?: string }).gate : undefined
      waiting = fix === null || gate === 'NEEDS_APPROVAL' || gate === 'DUAL_TAP'
    }
    return {
      key: row.key, rule: row.rule, severity: row.severity, proposalId: row.proposal_id, title: row.title, detail: row.detail,
      expected: row.expected, observed: row.observed, deltaCents: row.delta_cents, state,
      firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, resolvedAt: row.resolved_at, dismissedAt: row.dismissed_at,
      dismissedBy: row.dismissed_by, dismissNote: row.dismiss_note, waitingOnYou: waiting, fix: state === 'open' ? fix : null,
    }
  }

  list(filter: { state?: BreakState; severity?: BreakSeverity } = {}) {
    const all = (this.db.prepare(`SELECT * FROM breaks ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, first_seen_at DESC, key`).all() as BreakRow[]).map((row) => this.view(row))
    const open = all.filter((item) => item.state === 'open')
    const data = all.filter((item) => (!filter.state || item.state === filter.state) && (!filter.severity || item.severity === filter.severity))
    return {
      kpis: {
        open: open.length,
        moneyAtStakeCents: open.reduce((sum, item) => sum + Math.abs(item.deltaCents ?? 0), 0),
        waitingOnYou: open.filter((item) => item.waitingOnYou).length,
        resolved: all.filter((item) => item.state === 'resolved').length,
        dismissed: all.filter((item) => item.state === 'dismissed').length,
        /** What the nav badge shows: open critical and warning breaks. */
        attention: open.filter((item) => item.severity !== 'info').length,
        openCritical: open.filter((item) => item.severity === 'critical').length,
      },
      data,
      syncedAt: this.lastScanAt,
      paypalSyncedAt: this.lastPayPalAt,
    }
  }

  get(key: string) {
    const row = this.db.prepare('SELECT * FROM breaks WHERE key = ?').get(key) as BreakRow | undefined
    if (!row) throw new Problem(404, 'break.missing', 'Break not found', 'No break has that key.')
    const history = this.db.prepare('SELECT id, at, type, detail FROM break_events WHERE break_key = ? ORDER BY id').all(key) as Array<{ id: number; at: string; type: string; detail: string }>
    return { ...this.view(row), history, evidence: this.evidence(row) }
  }

  /** What stands behind a break: the request, the PayPal ids on it, the books entries and the last things that happened to it. */
  private evidence(row: BreakRow) {
    const request = row.proposal_id ? this.repo.proposal(row.proposal_id) : null
    const ids: Array<{ label: string; id: string }> = []
    if (request) {
      const labelled: Array<[string, string | null]> = [['PayPal order', request.order_id], ['PayPal capture', request.capture_id], ['PayPal refund', request.refund_id], ['PayPal invoice', request.invoice_id], ['PayPal payout batch', request.payout_batch_id], ['PayPal payout item', request.payout_item_id], ['PayPal payout transaction', request.payout_txn_id], ['Funded by capture', request.funding_capture_id], ['Refunds capture', request.parent_capture_id]]
      for (const [label, id] of labelled) if (id) ids.push({ label, id })
    }
    // A break about PayPal money Mandate does not know has the transaction id in its key.
    if (!request && row.rule === 'paypal.unknown_or_differs') ids.push({ label: 'PayPal transaction', id: row.key.slice(row.key.indexOf(':') + 1) })
    const books = request
      ? this.repo.journal(200, request.id).map((entry) => ({ seq: entry.seq, purpose: entry.purpose, deltaCents: entry.delta_cents, memo: entry.memo, at: entry.created_at, postings: entry.postings }))
      : []
    const events = request ? this.repo.eventsFor(request.id).slice(-12).map((event) => ({ type: event.type, at: event.created_at })) : []
    return {
      request: request ? { id: request.id, kind: request.kind, phase: request.phase, amountCents: request.amount_cents, currency: request.currency, arrivedCents: arrivedCents(request), jobId: request.job_id } : null,
      receiptPath: request ? `/p/${request.id}` : null,
      paypalIds: ids,
      books,
      events,
    }
  }

  dismiss(key: string, by: string, note: string): BreakView {
    const text = note.trim()
    if (!text) throw new Problem(400, 'request.invalid', 'A note is required', 'Say why this break is being dismissed. The note is kept with it.')
    const row = this.db.prepare('SELECT * FROM breaks WHERE key = ?').get(key) as BreakRow | undefined
    if (!row) throw new Problem(404, 'break.missing', 'Break not found', 'No break has that key.')
    if (row.resolved_at || row.dismissed_at) throw new Problem(409, 'break.state', 'Only an open break can be dismissed', `This break is already ${row.resolved_at ? 'resolved' : 'dismissed'}.`)
    const at = this.iso()
    this.repo.transaction(() => {
      this.db.prepare('UPDATE breaks SET dismissed_at = ?, dismissed_by = ?, dismiss_note = ?, fingerprint = ? WHERE key = ?').run(at, by, text.slice(0, 500), fingerprintOf({ severity: row.severity, expected: row.expected, observed: row.observed, deltaCents: row.delta_cents }), key)
      this.db.prepare('INSERT INTO break_events (break_key, at, type, detail) VALUES (?, ?, ?, ?)').run(key, at, 'dismissed', text.slice(0, 500))
    })
    return this.view(this.db.prepare('SELECT * FROM breaks WHERE key = ?').get(key) as BreakRow)
  }

  /**
   * Does the one safe thing the break's rule offers. Every action here is an existing service method that re-reads PayPal,
   * reminds, cancels an unclaimed payout, recovers a stalled request, or files a refund request that the gate decides.
   * A rule with no safe fix (money was taken back, the books drift, a dispute) refuses: a person decides those.
   */
  async fix(key: string, by: 'owner' = 'owner'): Promise<FixResult> {
    const row = this.db.prepare('SELECT * FROM breaks WHERE key = ?').get(key) as BreakRow | undefined
    if (!row) throw new Problem(404, 'break.missing', 'Break not found', 'No break has that key.')
    if (row.resolved_at || row.dismissed_at) throw new Problem(409, 'break.state', 'Only an open break can be fixed', `This break is already ${row.resolved_at ? 'resolved' : 'dismissed'}.`)
    const offer = FIXES[row.rule]
    if (!offer) throw new Problem(409, 'break.no_fix', 'No automatic fix for this break', 'This one needs a person to decide. Look at the evidence, then act on the request or dismiss it with a note.')
    const request = row.proposal_id ? this.repo.proposal(row.proposal_id) : null
    if (!request) throw new Problem(409, 'break.no_request', 'The request is gone', 'The request this break is about no longer exists.')
    let out: Omit<FixResult, 'break'>
    try {
      out = await this.run(offer.action, request, key, by)
    } catch (error) {
      if (error instanceof PayPalError) throw paypalProblem(error, 'to apply the fix', { proposalId: request.id })
      throw error
    }
    this.db.prepare('INSERT INTO break_events (break_key, at, type, detail) VALUES (?, ?, ?, ?)').run(key, this.iso(), 'fix_filed', JSON.stringify({ action: out.action, by, gate: out.gate ?? null, proposalId: out.filedProposalId ?? null, statement: out.statement }))
    // The fix may have cleared the break: look again (without PayPal's slow list) so the answer is current.
    await this.scan(this.now(), { withPayPal: false }).catch(() => undefined)
    return { ...out, break: this.db.prepare('SELECT * FROM breaks WHERE key = ?').get(key) ? this.view(this.db.prepare('SELECT * FROM breaks WHERE key = ?').get(key) as BreakRow) : null }
  }

  private async run(action: FixAction, request: ProposalRow, key: string, by: 'owner'): Promise<Omit<FixResult, 'break'>> {
    switch (action) {
      case 'file_refund': {
        if (!request.capture_id) throw new Problem(409, 'break.state', 'Nothing to refund', 'That payment has no PayPal capture to refund.')
        const rules = this.repo.latestWarrant()?.body
        const client = rules?.clients.find((party) => party.id === request.payee_id)
        // The refund goes through the front door as the autopilot: the gate decides it from the owner's rules, as for anyone.
        const filed = this.mandate.propose({
          kind: 'refund', payee: client?.displayName ?? request.payee_id ?? 'client', amountCents: arrivedCents(request), currency: request.currency,
          description: 'Refund the duplicate payment (filed by the Breaks desk)', parentCaptureId: request.capture_id,
          ...(request.job_id ? { jobId: request.job_id } : {}),
        }, `breaks-fix-${key}`, 'autopilot')
        const body = filed.body as { id?: string; gate?: string; phase?: string; clause?: string; detail?: string }
        const decided = body.gate === 'AUTO' ? 'The gate allowed it under your rules (the request is locked and follows the same path as any refund).' : body.gate === 'DENY' ? `The gate refused it: ${body.detail ?? body.clause ?? 'a rule says no'}.` : 'The gate needs your approval: it is waiting in your approvals.'
        return { action, statement: `${filed.replayed ? 'A refund request was already filed for this break. ' : 'Filed a refund request. '}${decided} Nothing was refunded by this button.`, gate: body.gate, filedProposalId: body.id, phase: body.phase }
      }
      case 'refresh_capture': {
        const result = await this.mandate.refreshCapture(request.capture_id ?? '', 'server')
        return { action, statement: result.refreshed ? 'Re-read the capture from PayPal and recorded what it says.' : 'Re-read the capture from PayPal: it has not changed.' }
      }
      case 'refresh_refund': {
        const result = await this.mandate.refreshRefund(request.id, 'server')
        return { action, statement: result.refreshed ? 'Re-read the refund from PayPal and recorded what it says.' : 'Re-read the refund from PayPal: it has not changed.' }
      }
      case 'refresh_invoice': {
        const result = await this.mandate.refreshInvoice(request.invoice_id ?? '', 'server')
        return { action, statement: result.refreshed ? 'Re-read the invoice from PayPal and recorded what it says.' : 'There is no invoice to re-read for this request.' }
      }
      case 'remind':
        await this.mandate.remindInvoice(request.id, by)
        return { action, statement: 'Sent the client PayPal\'s reminder for this invoice.' }
      case 'cancel_unclaimed':
        await this.mandate.cancelUnclaimedPayout(request.id)
        return { action, statement: 'Asked PayPal to cancel the unclaimed payout; the money returns to the studio.' }
      case 'recover_stalled': {
        const count = await this.mandate.recoverStalled()
        return { action, statement: count > 0 ? `Recovered ${count} stalled request${count === 1 ? '' : 's'}.` : 'Nothing was stalled long enough to recover yet.' }
      }
    }
  }
}
