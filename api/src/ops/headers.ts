/** Headers added on every response. The console CSP stays the one in http/web.ts. Styles there still allow inline, because the data grid needs it. */
export function securityHeaders(cookieSecure: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'permissions-policy': 'publickey-credentials-get=(self), publickey-credentials-create=(self), camera=(), microphone=(), geolocation=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  }
  if (cookieSecure) headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains'
  return headers
}

/** CSP for JSON and auth routes. No scripts. The console sets its own policy on /app. */
export const API_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
