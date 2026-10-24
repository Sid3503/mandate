import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { advise, atLeastAsGood, checkOffer, endedBy, fairness, insideMandate, outcomeFor, plannedOffer, priceStep, seatOf, splitMilestones, type Move, type Seat } from '../src/domain/negotiation'
import { DEMO_BUYER_RULES, DEMO_SELLER_RULES } from '../src/domain/deal'

const studio: Seat = { side: 'seller', reservationCents: 25_000, targetCents: 40_000, style: 'balanced' }
const client: Seat = { side: 'buyer', reservationCents: 40_000, targetCents: 20_000, style: 'balanced' }
const offer = (side: Seat['side'], totalCents: number, final = false): Move => ({ side, action: 'offer', totalCents, final })

describe('the concession curve', () => {
  it('opens at the target, ends at the walk-away, and moves the right way in between', () => {
    expect(plannedOffer(studio, 0, 4)).toBe(40_000)
    expect(plannedOffer(studio, 3, 4)).toBe(25_000)
    expect(plannedOffer(client, 0, 4)).toBe(20_000)
    expect(plannedOffer(client, 3, 4)).toBe(40_000)
    // Firm concedes later than balanced, flexible earlier.
    const at = (style: Seat['style']) => plannedOffer({ ...studio, style }, 1, 4)
    expect(at('firm')).toBeGreaterThan(at('balanced'))
    expect(at('flexible')).toBeLessThan(at('balanced'))
  })

  it('never crosses the walk-away or passes the target, for any seat and any round', () => {
    fc.assert(fc.property(
      fc.integer({ min: 100, max: 10_000_000 }), fc.integer({ min: 0, max: 10_000_000 }), fc.constantFrom('firm', 'balanced', 'flexible'), fc.boolean(), fc.integer({ min: 2, max: 8 }), fc.integer({ min: 0, max: 7 }),
      (reservation, spread, style, selling, offers, index) => {
        const seat: Seat = selling
          ? { side: 'seller', reservationCents: reservation, targetCents: reservation + spread, style }
          : { side: 'buyer', reservationCents: reservation + spread, targetCents: reservation, style }
        const planned = plannedOffer(seat, Math.min(index, offers - 1), offers)
        expect(insideMandate(seat, planned)).toBe(true)
        expect(atLeastAsGood(seat.side, seat.targetCents, planned)).toBe(true)
      },
    ))
  })

  it('rounds to a step a person would use', () => {
    expect(priceStep(15_000)).toBe(500)
    expect(priceStep(500)).toBe(1)
    expect(plannedOffer(client, 1, 4) % 500).toBe(0)
  })
})

describe('the reference move', () => {
  it('plays the demo sheets to $300: 400, 200, 350, 265, 300, accepted', () => {
    const seller = seatOf(DEMO_SELLER_RULES)
    const buyer = seatOf(DEMO_BUYER_RULES)
    const moves: Move[] = []
    for (let turn = 0; turn < 8; turn += 1) {
      const seat = turn % 2 === 0 ? seller : buyer
      const advice = advise(seat, moves, 4)
      if (advice.action === 'accept') { moves.push({ side: seat.side, action: 'accept', totalCents: moves.at(-1)!.totalCents }); break }
      moves.push(offer(seat.side, advice.offerCents!))
    }
    expect(moves.map((move) => `${move.side[0]}:${move.action}:${move.totalCents}`)).toEqual(['s:offer:40000', 'b:offer:20000', 's:offer:35000', 'b:offer:26500', 's:offer:30000', 'b:accept:30000'])
  })

  it('says why, without naming a private number', () => {
    const advice = advise(studio, [offer('seller', 40_000), offer('buyer', 20_000)], 4)
    expect(advice.action).toBe('offer')
    expect(advice.why).not.toMatch(/\d/)
    expect(advice.mayAccept).toBe(false)
  })

  it('walks away from a final offer outside the mandate', () => {
    expect(advise(studio, [offer('seller', 40_000), offer('buyer', 20_000, true)], 4).action).toBe('walk_away')
  })

  it('accepts on its last move when the standing offer is inside the mandate', () => {
    const moves = [offer('seller', 40_000), offer('buyer', 20_000), offer('seller', 30_000), offer('buyer', 22_000), offer('seller', 28_000), offer('buyer', 24_000), offer('seller', 26_000), offer('buyer', 25_500)]
    expect(advise(studio, moves, 4)).toMatchObject({ action: 'accept', mayAccept: true })
  })
})

describe('the rules of the table', () => {
  it('refuses an offer past the walk-away, a concession taken back, and an offer after the deadline', () => {
    expect(checkOffer(studio, [], 4, 24_000)).toMatchObject({ ok: false, code: 'deal.under_seller_minimum' })
    expect(checkOffer(studio, [offer('seller', 30_000), offer('buyer', 20_000)], 4, 31_000)).toMatchObject({ ok: false, code: 'negotiation.regressive' })
    expect(checkOffer(studio, [offer('seller', 30_000), offer('buyer', 20_000)], 4, 30_000)).toEqual({ ok: true })
    expect(checkOffer(studio, [offer('seller', 30_000, true), offer('buyer', 20_000)], 4, 29_000)).toMatchObject({ ok: false, code: 'negotiation.no_offers_left' })
  })

  it('ends at the deadline when the side to move can neither offer nor accept, and on a three-round stalemate', () => {
    const may = (side: Seat['side'], cents: number) => insideMandate(side === 'seller' ? studio : client, cents)
    expect(endedBy([offer('seller', 45_000), offer('buyer', 20_000), offer('seller', 44_000), offer('buyer', 21_000)], 2, may)).toBe('expired')
    expect(endedBy([offer('seller', 45_000), offer('buyer', 20_000), offer('seller', 44_000), offer('buyer', 30_000)], 2, may)).toBeNull()
    const held = [offer('seller', 45_000), offer('buyer', 20_000), offer('seller', 45_000), offer('buyer', 20_000), offer('seller', 45_000), offer('buyer', 20_000)]
    expect(endedBy(held, 4, may)).toBe('stalled')
  })
})

describe('how good the deal was, for each side', () => {
  it('measures against the walk-away and the target, in the side\'s own terms', () => {
    expect(outcomeFor(studio, 30_000, 'USD')).toMatchObject({ marginCents: 5_000, towardTargetPct: 33, verdict: 'fair' })
    expect(outcomeFor(client, 30_000, 'USD')).toMatchObject({ marginCents: 10_000, towardTargetPct: 50, verdict: 'good' })
    expect(outcomeFor(studio, 45_000, 'USD').verdict).toBe('beat_target')
    expect(outcomeFor(studio, 25_000, 'USD').verdict).toBe('at_limit')
    expect(outcomeFor(studio, 30_000, 'EUR').summary).toContain('€')
  })

  it('places the price in the overlap, for a viewer who may see both sides', () => {
    expect(fairness(studio, client, 30_000)).toEqual({ zone: { minCents: 25_000, maxCents: 40_000 }, sellerSharePct: 33, nashCents: 32_500 })
    expect(fairness({ ...studio, reservationCents: 50_000 }, client, 30_000)).toBeNull()
  })

  it('splits a total into milestones that always add up', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 100_000_000 }), fc.integer({ min: 1, max: 12 }), (total, count) => {
      const parts = splitMilestones(total, Array.from({ length: count }, (_, index) => `M${index + 1}`))
      expect(parts.reduce((sum, part) => sum + part.amountCents, 0)).toBe(total)
    }))
  })
})
