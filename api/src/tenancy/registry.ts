export type TenantHandle = {
  id: string
  fetch: (request: Request) => Promise<Response> | Response
  close: () => void
  sweep?: () => Promise<void>
}

type Entry = {
  /** What the studio's loader built. Only the registry calls it directly. */
  inner: TenantHandle
  /** What callers get: the same handle, with every fetch and sweep counted while it runs. */
  outer: TenantHandle
  last: number
  /** Requests and sweeps using the studio's database right now. A response body still streaming counts as one. */
  refs: number
  /** Taken out of the registry. Its database is closed as soon as the last user lets go. */
  retired: boolean
  closed: boolean
}

/**
 * At most `max` tenant apps stay open. One that has been idle for `idleMs` is closed on the next lookup.
 * The caller opens the database. This registry does not invent tenants.
 *
 * Closing a studio's database while one of its requests (or a background sweep) is still using it would fail that work
 * halfway, with whatever it had written so far. So every fetch and sweep that goes through a handle holds a reference
 * until it is done, a streamed response until its body has been read to the end or abandoned, and eviction only takes
 * the studio out of the list: the database itself is closed when the last reference is let go. A later lookup of the
 * same studio opens a fresh one.
 */
export class TenantRegistry {
  private readonly open = new Map<string, Entry>()
  /** Evicted entries still in use. Kept so a shutdown can close them too. */
  private readonly retiring = new Set<Entry>()

  constructor(
    private readonly load: (id: string) => TenantHandle | null,
    private readonly max = 50,
    private readonly idleMs = 10 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(id: string): TenantHandle | null {
    this.evictIdle()
    const hit = this.open.get(id)
    if (hit) {
      hit.last = this.now()
      return hit.outer
    }
    const handle = this.load(id)
    if (!handle) return null
    const entry = this.wrap(handle)
    this.open.set(id, entry)
    while (this.open.size > this.max) {
      // The least recently used studio that nobody is using goes first; a busy one is only retired, never cut off.
      const oldest = [...this.open.entries()].sort((a, b) => a[1].last - b[1].last)[0]
      if (!oldest) break
      this.retire(oldest[0], oldest[1])
    }
    return entry.outer
  }

  drop(id: string): void {
    const hit = this.open.get(id)
    if (!hit) return
    this.retire(id, hit)
  }

  evictIdle(): void {
    const at = this.now()
    for (const [id, hit] of this.open) {
      // A studio with a request still running is not idle, whatever its last lookup says.
      if (hit.refs === 0 && at - hit.last >= this.idleMs) this.retire(id, hit)
    }
  }

  /** How many requests and sweeps are using this studio's database now. Zero for a studio that is not open. */
  inUse(id: string): number {
    return this.open.get(id)?.refs ?? 0
  }

  /** Shutdown: closes every database this registry opened, in use or not. Nothing may be served after this. */
  closeAll(): void {
    for (const [id, entry] of this.open) {
      this.open.delete(id)
      this.closeEntry(entry)
    }
    for (const entry of this.retiring) this.closeEntry(entry)
    this.retiring.clear()
  }

  get size(): number {
    return this.open.size
  }

  private retire(id: string, entry: Entry): void {
    this.open.delete(id)
    entry.retired = true
    if (entry.refs === 0) this.closeEntry(entry)
    else this.retiring.add(entry)
  }

  private closeEntry(entry: Entry): void {
    if (entry.closed) return
    entry.closed = true
    this.retiring.delete(entry)
    try {
      entry.inner.close()
    } catch {
      // Already closed.
    }
  }

  private wrap(inner: TenantHandle): Entry {
    const entry = { inner, last: this.now(), refs: 0, retired: false, closed: false } as Entry
    const acquire = (): (() => void) => {
      entry.refs += 1
      let released = false
      return () => {
        if (released) return
        released = true
        entry.refs -= 1
        if (entry.refs === 0 && entry.retired) this.closeEntry(entry)
      }
    }
    entry.outer = {
      id: inner.id,
      close: () => {
        if (this.open.get(inner.id) === entry) this.retire(inner.id, entry)
      },
      fetch: async (request) => {
        const release = acquire()
        let response: Response
        try {
          response = await inner.fetch(request)
        } catch (error) {
          release()
          throw error
        }
        return holdUntilRead(response, release)
      },
      sweep: inner.sweep
        ? async () => {
            const release = acquire()
            try {
              await inner.sweep!()
            } finally {
              release()
            }
          }
        : undefined,
    }
    return entry
  }
}

/**
 * A streamed answer (the live feed, the clerk) keeps reading the studio's database after the handler has returned, so
 * the reference is held until the body is finished or the client goes away. An answer with no body lets go at once.
 */
function holdUntilRead(response: Response, release: () => void): Response {
  if (!response.body) {
    release()
    return response
  }
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          release()
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (error) {
        release()
        controller.error(error)
      }
    },
    async cancel(reason) {
      release()
      await reader.cancel(reason).catch(() => undefined)
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
