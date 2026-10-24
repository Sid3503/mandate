import type { PartyRules, Side } from './deal'

/**
 * How a negotiation is played, as pure functions. No model, no database.
 *
 * The protocol is the alternating-offers protocol used by automated-negotiation research (Rubinstein 1982; the
 * Stacked Alternating Offers Protocol of the ANAC competition): on its turn a side may make an offer, accept the
 * other side's standing offer, or walk away. A deal exists only when one side ACCEPTS the other's exact, still-open
 * offer — the "mirror image" rule of contract law — never because a referee noticed that two numbers overlap.
 *
 * Strategy lives in code and the model only talks (the split CICERO, OG-Narrator and anchor-and-resume negotiators
 * use, because language models anchor on the first offer, concede without reciprocity and get arithmetic wrong):
 *
 * - Each side has a private walk-away (its reservation: the studio's floor, the client's ceiling) and a private
 *   target (its aspiration). Its offers move from the target towards the walk-away on a time-dependent curve
 *   (Faratin, Sierra & Jennings 1998): `firm` holds and concedes late (Boulware), `flexible` concedes early.
 * - Acceptance follows AC_next with an AC_time fallback (Baarslag et al. 2014): accept when the other side's offer is
 *   at least as good as what I would offer next, or when it is my last move and the offer is inside my mandate.
 * - An offer may never be worse for the other side than the same side's previous offer (no taking back a
 *   concession), never outside the side's own mandate, and a side runs out of offers at the deadline.
 */

export type Style = 'firm' | 'balanced' | 'flexible'
export const STYLES: readonly Style[] = ['firm', 'balanced', 'flexible']

/** β in Faratin's decision function: below 1 concedes late, above 1 concedes early. */
const BETA: Record<Style, number> = { firm: 0.45, balanced: 1, flexible: 2.2 }

export type Seat = {
  side: Side
  /** The walk-away: the least the seller takes, the most the buyer pays. */
  reservationCents: number
  /** What the side hopes for. Better for it than the walk-away. */
  targetCents: number
  style: Style
}

/** The most offers either side may make in one negotiation. The deadline is known to both, as in real bargaining. */
export const MAX_OFFERS_PER_SIDE = 8
export const DEFAULT_OFFERS_PER_SIDE = 4

/**
 * A side's seat at the table, from its price sheet. A sheet with no target hopes for 25% better than its walk-away,
 * which is said wherever the target is shown, never presented as a number the company chose.
 */
export function seatOf(rules: PartyRules): Seat & { targetChosen: boolean } {
  const side: Side = rules.role
  const reservationCents = side === 'seller' ? rules.minTotalCents! : rules.maxTotalCents!
  const chosen = rules.targetTotalCents
  const fallback = side === 'seller' ? Math.round(reservationCents * 1.25) : Math.round(reservationCents * 0.75)
  const targetCents = chosen ?? fallback
  return { side, reservationCents, targetCents, style: rules.style ?? 'balanced', targetChosen: chosen !== undefined }
}

/** True when `a` is at least as good as `b` for this side. */
export const atLeastAsGood = (side: Side, a: number, b: number) => (side === 'seller' ? a >= b : a <= b)

/** True when a price is inside this side's mandate: the seller at or above its floor, the buyer at or below its ceiling. */
export const insideMandate = (seat: Seat, cents: number) => atLeastAsGood(seat.side, cents, seat.reservationCents)

/** A round step for prices, so offers read like a person's ($365, not $363.33), sized to the range being bargained. */
export function priceStep(spanCents: number): number {
  const span = Math.abs(spanCents)
  if (span >= 1_000_000) return 10_000
  if (span >= 100_000) return 2_500
  if (span >= 10_000) return 500
  if (span >= 2_000) return 100
  return 1
}

/**
 * Faratin's time-dependent offer for this side's `index`-th offer (0 is the opening) out of `offers`.
 * α(t) = t^(1/β); the offer is target − α·(target − walk-away) for the seller, mirrored for the buyer. Rounded to a
 * person's step, and never past the walk-away. The last offer is the walk-away itself: a side's final word.
 */
export function plannedOffer(seat: Seat, index: number, offers: number): number {
  const span = seat.targetCents - seat.reservationCents
  if (span === 0) return seat.reservationCents
  const t = offers <= 1 ? 1 : Math.min(1, Math.max(0, index / (offers - 1)))
  const alpha = Math.pow(t, 1 / BETA[seat.style])
  const raw = seat.targetCents - alpha * span
  const step = priceStep(span)
  const rounded = Math.round(raw / step) * step
  // Rounding must never cross the walk-away, nor go beyond the target.
  const low = Math.min(seat.targetCents, seat.reservationCents)
  const high = Math.max(seat.targetCents, seat.reservationCents)
  return Math.min(high, Math.max(low, rounded))
}

export type Move = { side: Side; action: 'offer' | 'accept' | 'walk_away'; totalCents?: number; final?: boolean }

/** The offers one side has made, oldest first. */
export const offersBy = (moves: Move[], side: Side) => moves.filter((move) => move.side === side && move.action === 'offer')

/** How many offers this side may still make. A final offer leaves none. */
export function offersLeft(moves: Move[], side: Side, perSide: number): number {
  const mine = offersBy(moves, side)
  if (mine.some((move) => move.final)) return 0
  return Math.max(0, perSide - mine.length)
}

/** The other side's offer that is open for this side to accept, if any: the last move, when it was the other's offer. */
export function standingOffer(moves: Move[], side: Side): Move | null {
  const last = moves[moves.length - 1]
  return last && last.action === 'offer' && last.side !== side ? last : null
}

export type Advice = {
  /** What the code recommends this move. */
  action: 'offer' | 'accept' | 'walk_away'
  /** The price to offer when the action is `offer`. */
  offerCents: number | null
  /** The range a counter-offer must fall in: no worse for the other side than the side's last offer, no further than the plan. */
  range: { fromCents: number; toCents: number } | null
  /** Whether the standing offer may be accepted at all: it is inside this side's mandate. */
  mayAccept: boolean
  /** Offers left after this one, if this move is an offer. */
  offersLeftAfter: number
  /** One sentence a person can read: why this is the recommendation. Says no private number. */
  why: string
}

/**
 * What this side should do now, under its own mandate. The private numbers are used, never stated: `why` speaks of
 * the plan and the other side's offer, not of the walk-away or the target.
 */
export function advise(seat: Seat, moves: Move[], perSide: number): Advice {
  const mine = offersBy(moves, seat.side)
  const left = offersLeft(moves, seat.side, perSide)
  const standing = standingOffer(moves, seat.side)
  const mayAccept = standing?.totalCents !== undefined && insideMandate(seat, standing.totalCents)
  const previous = mine[mine.length - 1]?.totalCents
  const planned = left > 0 ? plannedOffer(seat, mine.length, perSide) : null
  // The plan may not be worse for the other side than what this side already offered: a concession is never taken back.
  const next = planned === null ? null : previous === undefined ? planned : (atLeastAsGood(seat.side, previous, planned) ? planned : previous)
  const range = next === null ? null : { fromCents: previous ?? next, toCents: next }
  const after = Math.max(0, left - 1)

  if (standing && mayAccept && (next === null || atLeastAsGood(seat.side, standing.totalCents!, next))) {
    return {
      action: 'accept', offerCents: null, range, mayAccept, offersLeftAfter: left,
      why: next === null
        ? 'You have no offers left and their offer is inside your mandate: accepting closes the deal.'
        : 'Their offer is at least as good as what you would offer next, so countering can only cost you.',
    }
  }
  if (standing?.final && !mayAccept) {
    return { action: 'walk_away', offerCents: null, range, mayAccept, offersLeftAfter: left, why: 'They made their final offer and it is outside your mandate. There is no deal to be had here.' }
  }
  if (next === null) {
    return mayAccept
      ? { action: 'accept', offerCents: null, range: null, mayAccept, offersLeftAfter: 0, why: 'You have no offers left and their offer is inside your mandate.' }
      : { action: 'walk_away', offerCents: null, range: null, mayAccept, offersLeftAfter: 0, why: 'You have no offers left and their offer is outside your mandate.' }
  }
  return {
    action: 'offer', offerCents: next, range, mayAccept, offersLeftAfter: after,
    why: !standing
      ? 'You open. An ambitious first offer anchors the bargaining.'
      : mine.length === 0
        ? 'This is your opening offer. Anchor from your own target, not from their number.'
      : after === 0
        ? 'This is your last offer: it is your final word.'
        : 'Their offer is worse than your plan for this round. Counter, conceding no faster than your plan.',
  }
}

export type OfferCheck = { ok: true } | { ok: false; code: string; detail: string }

/**
 * Whether this side may make this offer now. Own mandate, the deadline, and no taking back a concession. The other
 * side's limits are not consulted: an offer they cannot accept is still a legal offer, as at any real table.
 */
export function checkOffer(seat: Seat, moves: Move[], perSide: number, totalCents: number): OfferCheck {
  if (offersLeft(moves, seat.side, perSide) === 0) {
    return { ok: false, code: 'negotiation.no_offers_left', detail: 'You have no offers left. Accept their offer or walk away.' }
  }
  if (!insideMandate(seat, totalCents)) {
    return { ok: false, code: seat.side === 'seller' ? 'deal.under_seller_minimum' : 'deal.over_buyer_limit', detail: seat.side === 'seller' ? 'That is below the least your company takes for this job.' : 'That is above the most your company pays for this job.' }
  }
  const previous = offersBy(moves, seat.side).at(-1)?.totalCents
  if (previous !== undefined && !atLeastAsGood(seat.side, previous, totalCents)) {
    return { ok: false, code: 'negotiation.regressive', detail: 'An offer cannot be worse for them than your last one: a concession is not taken back.' }
  }
  return { ok: true }
}

export type Ending = 'agreed' | 'walked_away' | 'expired' | 'stalled'

/**
 * Whether the negotiation has ended by itself after the last move. Agreement and walking away are moves; these are
 * the endings nobody chose: the side to move has no offers left and cannot accept (the deadline), or neither side
 * has conceded for two rounds (a stalemate).
 */
export function endedBy(moves: Move[], perSide: number, mayAccept: (side: Side, cents: number) => boolean): Ending | null {
  const last = moves[moves.length - 1]
  if (!last) return null
  if (last.action === 'accept') return 'agreed'
  if (last.action === 'walk_away') return 'walked_away'
  const toMove: Side = last.side === 'seller' ? 'buyer' : 'seller'
  if (offersLeft(moves, toMove, perSide) === 0 && !mayAccept(toMove, last.totalCents!)) return 'expired'
  const held = (side: Side) => {
    const mine = offersBy(moves, side)
    return mine.length >= 3 && mine.at(-1)!.totalCents === mine.at(-2)!.totalCents && mine.at(-2)!.totalCents === mine.at(-3)!.totalCents
  }
  if (held('seller') && held('buyer')) return 'stalled'
  return null
}

export type Outcome = {
  side: Side
  priceCents: number
  /** Distance from the walk-away, in the side's favour. */
  marginCents: number
  /** 0 at the walk-away, 100 at the target; above 100 beat the target. */
  towardTargetPct: number
  verdict: 'beat_target' | 'met_target' | 'good' | 'fair' | 'at_limit'
  /** One sentence, in the side's own terms. It names the side's own walk-away and target, so it is shown only to that side. */
  summary: string
}

const money = (cents: number, currency: string) => new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100)

/**
 * How good the agreed price was for one side, against its own walk-away and target. Measuring against the target
 * gets better deals, measuring against the walk-away leaves people satisfied (Galinsky, Mussweiler & Medvec 2002), so
 * the summary says both.
 */
export function outcomeFor(seat: Seat, priceCents: number, currency: string, targetChosen = true): Outcome {
  const marginCents = seat.side === 'seller' ? priceCents - seat.reservationCents : seat.reservationCents - priceCents
  const span = Math.abs(seat.targetCents - seat.reservationCents)
  const towardTargetPct = span === 0 ? 100 : Math.round((marginCents / span) * 100)
  const verdict = towardTargetPct > 100 ? 'beat_target' : towardTargetPct === 100 ? 'met_target' : towardTargetPct >= 50 ? 'good' : towardTargetPct > 0 ? 'fair' : 'at_limit'
  const limit = seat.side === 'seller' ? 'the least you take' : 'the most you pay'
  const target = targetChosen ? `your target of ${money(seat.targetCents, currency)}` : `the ${money(seat.targetCents, currency)} you could have hoped for (no target was set)`
  const summary = marginCents <= 0
    ? `${money(priceCents, currency)} is exactly ${limit}: a deal, with nothing to spare.`
    : `${money(priceCents, currency)} is ${money(marginCents, currency)} ${seat.side === 'seller' ? 'above' : 'under'} ${limit} (${money(seat.reservationCents, currency)}), ${towardTargetPct >= 100 ? `and reached ${target}` : `${towardTargetPct}% of the way to ${target}`}.`
  return { side: seat.side, priceCents, marginCents, towardTargetPct, verdict, summary }
}

/**
 * Fairness, for a viewer allowed to see both sides (a demo where one person plays both chairs). With price as the one
 * issue and linear gains, the Nash bargaining solution is the middle of the overlap.
 */
export function fairness(seller: Seat, buyer: Seat, priceCents: number): { zone: { minCents: number; maxCents: number }; sellerSharePct: number; nashCents: number } | null {
  const min = seller.reservationCents
  const max = buyer.reservationCents
  if (min > max) return null
  const sellerSharePct = max === min ? 50 : Math.round(((priceCents - min) / (max - min)) * 100)
  return { zone: { minCents: min, maxCents: max }, sellerSharePct, nashCents: Math.round((min + max) / 2) }
}

/** Splits a total into `count` milestones in whole cents. The last one takes the remainder, so they always add up. */
export function splitMilestones(totalCents: number, titles: string[]): Array<{ title: string; amountCents: number }> {
  const count = Math.max(1, titles.length)
  const each = Math.floor(totalCents / count)
  return titles.map((title, index) => ({ title, amountCents: index === count - 1 ? totalCents - each * (count - 1) : each }))
}
