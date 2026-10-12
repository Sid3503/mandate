export type TenantHandle = {
  id: string
  fetch: (request: Request) => Promise<Response> | Response
  close: () => void
}

/**
 * At most `max` tenant apps stay open. One that has been idle for `idleMs` is closed on the next lookup.
 * The caller opens the database. This registry does not invent tenants.
 */
export class TenantRegistry {
  private readonly open = new Map<string, { handle: TenantHandle; last: number }>()

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
      return hit.handle
    }
    const handle = this.load(id)
    if (!handle) return null
    this.open.set(id, { handle, last: this.now() })
    while (this.open.size > this.max) {
      const oldest = [...this.open.entries()].sort((a, b) => a[1].last - b[1].last)[0]
      if (!oldest) break
      oldest[1].handle.close()
      this.open.delete(oldest[0])
    }
    return handle
  }

  drop(id: string): void {
    const hit = this.open.get(id)
    if (!hit) return
    hit.handle.close()
    this.open.delete(id)
  }

  evictIdle(): void {
    const at = this.now()
    for (const [id, hit] of this.open) {
      if (at - hit.last >= this.idleMs) {
        hit.handle.close()
        this.open.delete(id)
      }
    }
  }

  get size(): number {
    return this.open.size
  }
}
