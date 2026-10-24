/**
 * Currencies PayPal takes in whole units only (no decimals at all): an amount of "100.00" JPY is refused. Amounts are
 * still kept in hundredths everywhere in Mandate; these are simply always whole.
 * https://developer.paypal.com/reference/currency-codes/
 */
export const WHOLE_UNIT_CURRENCIES = new Set(['HUF', 'JPY', 'TWD'])

/** True when an amount can be paid in this currency: whole units for a currency that has no decimals. */
export const payableIn = (cents: number, currency: string) => !WHOLE_UNIT_CURRENCIES.has(currency.toUpperCase()) || cents % 100 === 0

export function centsToPayPal(cents: number, currency = 'USD'): string {
  if (WHOLE_UNIT_CURRENCIES.has(currency.toUpperCase())) {
    if (cents % 100 !== 0) throw new Error(`${currency} has no decimals: ${cents} hundredths is not a whole amount`)
    return String(cents / 100)
  }
  const negative = cents < 0
  const absolute = Math.abs(cents)
  const dollars = Math.floor(absolute / 100)
  const fraction = String(absolute % 100).padStart(2, '0')
  return `${negative ? '-' : ''}${dollars}.${fraction}`
}

export function payPalToCents(value: string): number {
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(value)
  if (!match) throw new Error(`invalid PayPal amount: ${value}`)
  const negative = match[1] === '-'
  const dollars = Number(match[2])
  const fraction = Number((match[3] ?? '').padEnd(2, '0'))
  const cents = dollars * 100 + fraction
  return negative ? -cents : cents
}

/**
 * A money amount PayPal states, in cents, or null when it states nothing. PayPal writes a money object bare in one
 * place and as `{ amount: money }` in another, so both are read. A `percent` alone is deliberately ignored: a
 * percentage is not a number of cents, and this server does not do its own arithmetic to invent one.
 */
export function moneyCents(value: unknown): number | null {
  if (value === null || typeof value !== 'object') return null
  const entry = value as { amount?: unknown; value?: unknown }
  const nested = (entry.amount ?? {}) as { value?: unknown }
  const raw = typeof nested.value === 'string' ? nested.value : typeof entry.value === 'string' ? entry.value : null
  return raw === null ? null : payPalToCents(raw)
}
