import { describe, expect, it } from 'vitest'
import { cardAuthDecision } from '../src/domain/cardAuth'

describe('the 3-D Secure decision follows PayPal\'s table of recommended actions', () => {
  const row = (liabilityShift: string | null, enrollment: string | null, status: string | null) => cardAuthDecision({ liabilityShift, enrollment, status }).action
  it.each([
    ['POSSIBLE', 'Y', 'Y', 'capture'],
    ['POSSIBLE', 'Y', 'A', 'capture'],
    ['YES', 'Y', 'Y', 'capture'],
    ['NO', 'Y', 'N', 'refuse'],
    ['NO', 'Y', 'R', 'refuse'],
    ['NO', 'Y', 'U', 'retry'],
    ['UNKNOWN', 'Y', 'U', 'retry'],
    ['UNKNOWN', 'Y', 'C', 'retry'],
    ['NO', 'Y', null, 'retry'],
    ['NO', 'N', null, 'capture'],
    ['NO', 'U', null, 'capture'],
    ['NO', 'B', null, 'capture'],
    ['UNKNOWN', 'U', null, 'retry'],
    ['UNKNOWN', null, null, 'retry'],
  ])('liability %s, enrolled %s, authenticated %s: %s', (shift, enrolled, status, action) => {
    expect(row(shift, enrolled, status)).toBe(action)
  })

  it('captures a card for which no check was asked, and says the issuer did not take the liability', () => {
    expect(cardAuthDecision(null)).toMatchObject({ action: 'capture', liabilityShifted: false })
    expect(cardAuthDecision({ liabilityShift: 'POSSIBLE', enrollment: 'Y', status: 'Y' })).toMatchObject({ liabilityShifted: true })
  })
})
