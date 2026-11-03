import type { Job, Proposal, Warrant } from '../lib/types'
import { dollars } from '../lib/money'
import { fundedPhase, type Names } from '../lib/words'

/** Payout phases that hold money: approved, sending, sent, unclaimed, or held on a mismatch. Paid is counted apart. */
const HELD = new Set(['locked', 'order_created', 'capture_inflight', 'payout_sent', 'payout_unclaimed', 'mismatch_hold'])

type Segment = { key: string; label: string; cents: number; tone: 'paid' | 'held' | 'planned' | 'fee' | 'kept' | 'short'; detail: string }

/**
 * Where one client payment went, as one bar: each contractor's share (paid, on its way, or still owed under a standing
 * rule), what PayPal kept as its fee, and what the studio keeps. A payment that funds a whole crew reads at a glance.
 *
 * Every contractor is paid by a payout of their own, each gated, locked and signed on its own, and each its own PayPal
 * batch: one payout that fails or is returned never holds up, or undoes, anyone else's.
 */
export function CrewSplit({ charge, payouts, warrant, names, clientId }: { charge: Job['charges'][number]; payouts: Proposal[]; warrant: Warrant | undefined; names: Names; clientId: string | null }) {
  if (!fundedPhase(charge.phase)) return null
  const arrived = charge.settledCents ?? charge.capturedAmountCents ?? charge.amountCents
  if (arrived <= 0) return null
  const fee = charge.captureFeeCents ?? 0
  const byPayee = new Map<string, { paid: number; held: number }>()
  for (const payout of payouts) {
    const id = payout.payeeId ?? 'unknown'
    const entry = byPayee.get(id) ?? { paid: 0, held: 0 }
    if (payout.phase === 'captured') entry.paid += payout.capturedAmountCents ?? payout.amountCents
    else if (HELD.has(payout.phase)) entry.held += payout.amountCents
    byPayee.set(id, entry)
  }
  // What a standing rule still owes from this payment: its share of what arrived, less what it already asked for.
  const owed = new Map<string, number>()
  for (const rule of warrant?.standing ?? []) {
    if (!clientId || !rule.clientIds.includes(clientId)) continue
    const share = Math.floor((arrived * (rule.shareBps ?? warrant!.contractorShareBps)) / 10_000)
    const asked = (byPayee.get(rule.payeeId)?.paid ?? 0) + (byPayee.get(rule.payeeId)?.held ?? 0)
    if (share - asked > 0) owed.set(rule.payeeId, (owed.get(rule.payeeId) ?? 0) + share - asked)
  }
  const segments: Segment[] = []
  for (const [payeeId, entry] of byPayee) {
    if (entry.paid > 0) segments.push({ key: `${payeeId}-paid`, label: names(payeeId), cents: entry.paid, tone: 'paid', detail: 'paid' })
    if (entry.held > 0) segments.push({ key: `${payeeId}-held`, label: names(payeeId), cents: entry.held, tone: 'held', detail: 'on its way' })
  }
  for (const [payeeId, cents] of owed) segments.push({ key: `${payeeId}-owed`, label: names(payeeId), cents, tone: 'planned', detail: 'owed by a standing rule' })
  if (fee > 0) segments.push({ key: 'fee', label: 'PayPal fee', cents: fee, tone: 'fee', detail: 'reported by PayPal' })
  const spoken = segments.reduce((sum, item) => sum + item.cents, 0)
  const kept = arrived - spoken
  segments.push({ key: 'kept', label: kept < 0 ? 'Studio is short' : 'Studio keeps', cents: Math.abs(kept), tone: kept < 0 ? 'short' : 'kept', detail: kept < 0 ? 'more went out than came in' : 'after everyone is paid' })
  const total = Math.max(arrived, spoken)
  const crew = new Set([...byPayee.keys(), ...owed.keys()]).size
  return (
    <figure className="crew-split" data-testid="crew-split" aria-label={`Where ${dollars(arrived)} went`}>
      <figcaption className="row between wrap gap-s">
        <span className="eyebrow">Where {dollars(arrived)} went{crew > 1 ? ` · split across ${crew} contractors` : ''}</span>
      </figcaption>
      <div className="crew-bar" role="img" aria-label={segments.map((item) => `${item.label} ${item.detail}: ${dollars(item.cents)}`).join('; ')}>
        {segments.filter((item) => item.cents > 0).map((item) => (
          <i key={item.key} className={`crew-${item.tone}`} style={{ flexGrow: item.cents / total }} title={`${item.label} · ${item.detail} · ${dollars(item.cents)}`} />
        ))}
      </div>
      <ul className="crew-legend">
        {segments.filter((item) => item.cents > 0).map((item) => (
          <li key={item.key}><i className={`crew-swatch crew-${item.tone}`} aria-hidden="true" /><span>{item.label}</span><small>{item.detail}</small><b>{dollars(item.cents)}</b></li>
        ))}
      </ul>
    </figure>
  )
}
