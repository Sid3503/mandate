/**
 * Integer cents to "$90.00", or the same in the studio's own currency ("€90.00", "₹1,250.00", "¥9,000"). USD keeps
 * its exact long-standing shape; every other currency is written the way the reader's locale writes it, with that
 * currency's own number of decimals. The cents stay integers until this, the very last step.
 */
export function dollars(cents: number | null | undefined, currency = 'USD'): string {
  if (cents === null || cents === undefined) return '—'
  if (currency === 'USD') {
    const sign = cents < 0 ? '−' : ''
    const abs = Math.abs(cents)
    const whole = Math.floor(abs / 100).toLocaleString('en-US')
    const frac = String(abs % 100).padStart(2, '0')
    return `${sign}$${whole}.${frac}`
  }
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100).replace('-', '−')
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`
  }
}

/** Parses "90", "90.5", "1,250.00" into integer cents without floats. Returns null when it is not money. */
export function parseCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '')
  const match = /^(\d{1,9})(?:\.(\d{0,2}))?$/.exec(cleaned)
  if (!match) return null
  const whole = Number(match[1])
  const frac = Number((match[2] ?? '').padEnd(2, '0') || '0')
  return whole * 100 + frac
}

export function centsInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}

/** A whole amount without the cents ("$18", "€1,900"), in the studio's currency, for short labels. */
export function wholeMoney(cents: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat(currency === 'USD' ? 'en-US' : undefined, { style: 'currency', currency, minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 }).format(cents / 100)
  } catch {
    return dollars(cents, currency)
  }
}

/**
 * A lookalike of someone the studio really pays: "P. Shah" for Priya Shah, "M. Silva" for Mateo Silva. The classic
 * invoice fraud, built from the studio's own people so every studio sees the attack in its own names.
 */
export function lookalikeOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean)
  return words.length > 1 ? `${words[0]![0]}. ${words.slice(1).join(' ')}` : `${name} Payments Ltd`
}
