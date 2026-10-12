/** The client address. X-Forwarded-For is trusted only when the server says it sits behind a proxy. */
export function clientIp(headers: { get(name: string): string | null | undefined }, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = headers.get('x-forwarded-for') ?? ''
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first.slice(0, 80)
  }
  return 'direct'
}
