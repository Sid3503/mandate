const SECRET_FIELD = /(authorization|api[_-]?key|token|secret|password|cookie|pepper|master[_-]?key|credential)/i

/** Replace known secret values and secret-shaped fields. The canary list is exact strings, never patterns from the user. */
export function redactText(text: string, canaries: readonly string[] = []): string {
  let out = text
  for (const canary of canaries) {
    if (canary.length >= 8) out = out.split(canary).join('[redacted]')
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}/gi, 'Bearer [redacted]')
  out = out.replace(/(secret|token|api[_-]?key|password|pepper|master[_-]?key)(["']?\s*[:=]\s*["']?)([A-Za-z0-9+/=_-]{12,})/gi, '$1$2[redacted]')
  return out
}

/**
 * A request path with the secrets that travel in it taken out. A status link is its own proof: the token in
 * `/v1/share/<token>` and `/app/s/<token>` is the whole credential, so a log line that kept it would hand the link to
 * anyone who can read the logs. The same goes for a studio's own copy under `/w/<id>`. What stays is the shape.
 */
export function redactPath(path: string): string {
  return path
    .replace(/(\/v1\/share\/)[^/?#]+/g, '$1[redacted]')
    .replace(/(\/app\/s\/)[^/?#]+/g, '$1[redacted]')
}

export function redactValue(value: unknown, canaries: readonly string[] = []): unknown {
  if (typeof value === 'string') return redactText(value, canaries)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, canaries))
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_FIELD.test(key) ? '[redacted]' : redactValue(item, canaries)
  }
  return out
}
