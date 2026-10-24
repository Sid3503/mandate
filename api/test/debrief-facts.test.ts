import { describe, expect, it } from 'vitest'
import { movedBy } from '../src/agents/service'

// The moves of a live run: the studio opened at its target, the client at its own, and the studio accepted.
const moves = [
  { side: 'seller' as const, action: 'offer', totalCents: 420_000 },
  { side: 'buyer' as const, action: 'offer', totalCents: 200_000 },
  { side: 'seller' as const, action: 'offer', totalCents: 360_000 },
  { side: 'buyer' as const, action: 'offer', totalCents: 215_000 },
  { side: 'seller' as const, action: 'offer', totalCents: 300_000 },
  { side: 'buyer' as const, action: 'offer', totalCents: 272_500 },
  { side: 'seller' as const, action: 'accept', totalCents: 272_500 },
]

describe('the facts a debrief reasons from', () => {
  it('counts the accepting side’s last step as a concession', () => {
    const lines = movedBy(moves, 'seller', 240_000, 4, 'USD').join('\n')
    expect(lines).toContain('Your opening was $4,200, $1,800 above your walk-away.')
    expect(lines).toContain('Your concessions, in order: $600, $600, $275 (in all $1,475).')
    expect(lines).toContain('Their concessions, in order: $150, $575 (in all $725).')
    expect(lines).toContain('Offers you had left at the end: 1 of 4.')
  })

  it('measures a buyer’s opening below its walk-away', () => {
    const lines = movedBy(moves, 'buyer', 380_000, 4, 'USD').join('\n')
    expect(lines).toContain('Your opening was $2,000, $1,800 below your walk-away.')
    expect(lines).toContain('Your concessions, in order: $150, $575 (in all $725).')
  })
})
