export function centsToPayPal(cents: number): string {
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
