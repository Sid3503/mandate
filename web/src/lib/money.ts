/** Integer cents to "$90.00". No floating point on the way out. */
export function dollars(cents: number | null | undefined, currency = 'USD'): string {
  if (cents === null || cents === undefined) return '—'
  const sign = cents < 0 ? '−' : ''
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100).toLocaleString('en-US')
  const frac = String(abs % 100).padStart(2, '0')
  const symbol = currency === 'USD' ? '$' : `${currency} `
  return `${sign}${symbol}${whole}.${frac}`
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
