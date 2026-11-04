import { describe, expect, it } from 'vitest'
import { readTrackingLink } from '../src/domain/tracking'
import { activityWindows, PAYPAL_WINDOW_MS, RECONCILE_MAX_DAYS } from '../src/domain/windows'

const NOW = new Date('2026-10-30T12:00:00.000Z')

describe('a tracking link is a pointer, never a delivery', () => {
  it('reads the four carriers and a number when the URL carries one', () => {
    expect(readTrackingLink('https://www.ups.com/track?tracknum=1Z999AA10123456784')).toMatchObject({ carrier: 'ups', trackingNumber: '1Z999AA10123456784', delivered: false })
    expect(readTrackingLink('https://www.fedex.com/fedextrack/?trknbr=123456789012')).toMatchObject({ carrier: 'fedex', trackingNumber: '123456789012', delivered: false })
    expect(readTrackingLink('https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490')).toMatchObject({ carrier: 'usps', trackingNumber: '9400111899223197428490', delivered: false })
    expect(readTrackingLink('https://www.dhl.com/us-en/home/tracking.html?tracking-id=1234567890')).toMatchObject({ carrier: 'dhl', trackingNumber: '1234567890', delivered: false })
  })

  it('takes a number from the path when the query has none, and refuses a page that is not a carrier', () => {
    expect(readTrackingLink('https://www.ups.com/track/1Z999AA10123456784')).toMatchObject({ carrier: 'ups', trackingNumber: '1Z999AA10123456784', delivered: false })
    expect(readTrackingLink('https://www.fedex.com/wtrk/track/')).toMatchObject({ carrier: 'fedex', trackingNumber: null, delivered: false })
    expect(readTrackingLink('https://www.figma.com/file/northwind-logo')).toBeNull()
    expect(readTrackingLink('not a url')).toBeNull()
    expect(readTrackingLink(null)).toBeNull()
  })

  it('never reports the parcel as delivered, even when the URL says so', () => {
    const read = readTrackingLink('https://www.ups.com/track?tracknum=1Z999AA10123456784&status=delivered')
    expect(read?.delivered).toBe(false)
  })
})

describe('reconciliation windows stay inside what PayPal will answer', () => {
  it('uses one window for 30 days and several for 90 and 180, none longer than 31 days', () => {
    const spans = (days: number) => activityWindows(NOW, days).map((window) => window.end.getTime() - window.start.getTime())
    expect(spans(30)).toEqual([30 * 86_400_000])
    expect(spans(90)).toEqual([PAYPAL_WINDOW_MS, PAYPAL_WINDOW_MS, 28 * 86_400_000])
    expect(activityWindows(NOW, 180)).toHaveLength(6)
    expect(spans(180).every((span) => span <= PAYPAL_WINDOW_MS && span > 0)).toBe(true)
    expect(activityWindows(NOW, 400)).toHaveLength(activityWindows(NOW, RECONCILE_MAX_DAYS).length)
    const back = activityWindows(NOW, 90)
    expect(back[0]!.end.toISOString()).toBe(NOW.toISOString())
    expect(back.at(-1)!.start.toISOString()).toBe(new Date(NOW.getTime() - 90 * 86_400_000).toISOString())
    expect(back[0]!.start.toISOString()).toBe(back[1]!.end.toISOString())
  })
})
