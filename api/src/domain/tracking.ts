/**
 * A carrier tracking link read off a proof URL. This is a pointer to a page, never a statement that a parcel
 * arrived. Mandate does not call UPS, FedEx, USPS or DHL, so `delivered` is always false: a URL cannot prove it.
 */

export type Carrier = 'ups' | 'fedex' | 'usps' | 'dhl'

export type TrackingLink = {
  carrier: Carrier
  /** The number the URL itself carries, when it carries one. Null when the page is a tracker with no number in it. */
  trackingNumber: string | null
  url: string
  /** Always false. A link is not a delivery. */
  delivered: false
}

const CARRIERS: Array<{ carrier: Carrier; host: RegExp }> = [
  { carrier: 'ups', host: /(^|\.)ups\.com$/i },
  { carrier: 'fedex', host: /(^|\.)fedex\.com$/i },
  { carrier: 'usps', host: /(^|\.)usps\.com$/i },
  { carrier: 'dhl', host: /(^|\.)dhl\.com$/i },
]

/** Query keys those four carriers put a tracking number in. */
const NUMBER_KEYS = ['tracknum', 'trackingnumber', 'tracking_number', 'tracking-number', 'trknbr', 'tracknumbers', 'piececode', 'trackingid', 'tracking-id', 'tLabels', 'tlabels']

const NUMBER = /^[A-Za-z0-9]{8,40}$/

/**
 * Classifies a proof URL as one of the four carriers, and pulls a tracking number out of it when the URL has one.
 * Anything else (a Figma file, a Drive link, a sentence) is not a tracking link and returns null. Delivery is never
 * inferred: the caller may cite the link, and may not say the parcel arrived.
 */
export function readTrackingLink(raw: string | null | undefined): TrackingLink | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const carrier = CARRIERS.find((item) => item.host.test(url.hostname))?.carrier
  if (!carrier) return null
  let trackingNumber: string | null = null
  for (const key of NUMBER_KEYS) {
    const value = url.searchParams.get(key)
    if (value && NUMBER.test(value)) {
      trackingNumber = value
      break
    }
  }
  if (!trackingNumber) {
    const last = url.pathname.split('/').filter(Boolean).at(-1) ?? ''
    if (NUMBER.test(last) && /\d/.test(last) && /[A-Za-z]/.test(last)) trackingNumber = last
  }
  return { carrier, trackingNumber, url: url.toString(), delivered: false }
}
