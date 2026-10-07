import { session } from './session'

/**
 * Tells the server about an error that happened on a person's screen, so someone can see it. It never throws, never
 * blocks, sends at most a few a minute, and says the same thing only once. Without a key there is nobody to tell.
 */
const sent = new Map<string, number>()
let times: number[] = []

export const RELEASE = typeof __RELEASE__ === 'string' ? __RELEASE__ : 'dev'

export function reportClientError(scope: string, error: unknown, extra: { componentStack?: string } = {}): string {
  const reference = Math.random().toString(36).slice(2, 8).toUpperCase()
  try {
    const key = session.get()
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 480) || 'unknown error'
    const now = Date.now()
    times = times.filter((at) => now - at < 60_000)
    const signature = `${scope}:${message}`
    if (!key || times.length >= 5 || (sent.get(signature) ?? 0) > now - 60_000) return reference
    sent.set(signature, now)
    times.push(now)
    const stack = [error instanceof Error ? error.stack : '', extra.componentStack].filter(Boolean).join('\n').slice(0, 3_900)
    void fetch('/v1/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ scope: scope.toLowerCase().replace(/[^a-z0-9:_-]/g, '-').slice(0, 40), message, stack: stack || undefined, url: location.pathname, release: RELEASE }),
      keepalive: true,
    }).catch(() => undefined)
  } catch {
    // Reporting must never be the thing that fails.
  }
  return reference
}

/** A module that would not load: the page was built before a deploy that removed it. A reload fetches the new one. */
export function isChunkError(error: unknown): boolean {
  const text = `${(error as Error)?.name ?? ''} ${(error as Error)?.message ?? ''}`
  return /ChunkLoadError|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(text)
}
