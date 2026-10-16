export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-mnd_session' : 'mnd_session'
}

export function writeSessionCookie(secure: boolean, token: string, maxAgeSeconds: number): string {
  const parts = [
    `${sessionCookieName(secure)}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearSessionCookie(secure: boolean): string {
  return writeSessionCookie(secure, '', 0)
}

export function readSessionCookie(header: string | undefined, secure: boolean): string | null {
  if (!header) return null
  const name = sessionCookieName(secure)
  for (const part of header.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=')
    if (rawKey === name) return rest.join('=') || null
  }
  return null
}

/** Cookie writes must come from our origin and name themselves. Bearer calls skip this. */
export function cookieWriteAllowed(headers: { get(name: string): string | null | undefined }, origins: string[]): boolean {
  const client = headers.get('x-mandate-client')
  if (client !== 'web') return false
  const origin = headers.get('origin')
  if (origin) return origins.includes(origin)
  return headers.get('sec-fetch-site') === 'same-origin'
}
