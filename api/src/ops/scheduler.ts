import { existsSync, rmSync } from 'node:fs'
import type { ControlStore } from '../control/store'
import type { TenantRegistry } from '../tenancy/registry'

export type CleanupResult = {
  cleaned: string[]
  skipped: string[]
}

/**
 * Removes SQLite database file and WAL/SHM companion files from disk.
 */
export function removeDatabaseFiles(dbPath: string): void {
  if (!dbPath || dbPath === ':memory:') return
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const fullPath = dbPath + suffix
      if (existsSync(fullPath)) {
        rmSync(fullPath, { force: true })
      }
    } catch {
      // Best-effort removal
    }
  }
}

/**
 * P2.T9 / Appendix B Case 27: Cleanup job for expired demo workspaces.
 * Deletes only workspaces where mode = 'demo' and expires_at < now.
 * Evicts from tenant registry (closing SQLite handles), removes SQLite files from disk,
 * and deletes control store records (members, credentials, sessions, invites, external_refs, workspaces).
 * Preserves default, studio, and live workspaces unconditionally.
 */
export function cleanupExpiredDemos(deps: {
  control: ControlStore
  registry?: TenantRegistry | null
  now: string | Date
}): CleanupResult {
  const nowIso = typeof deps.now === 'string' ? deps.now : deps.now.toISOString()
  const expired = deps.control.expiredDemos(nowIso)
  const cleaned: string[] = []
  const skipped: string[] = []

  for (const ws of expired) {
    if (ws.mode !== 'demo') {
      skipped.push(ws.id)
      continue
    }

    // 1. Evict from registry (closes active SQLite connection)
    deps.registry?.drop(ws.id)

    // 2. Remove SQLite files from filesystem
    removeDatabaseFiles(ws.db_path)

    // 3. Delete from control database
    const ok = deps.control.deleteDemo(ws.id)
    if (ok) {
      cleaned.push(ws.id)
    } else {
      skipped.push(ws.id)
    }
  }

  return { cleaned, skipped }
}

/**
 * P2.T10: Background work without per-tenant timers.
 * A single scheduler visits only tenants that have open invoices or payouts.
 * For each tenant, calls the tenant's sweep handler to check PayPal status and progress workflows.
 */
export async function runTenantSchedulerSweep(deps: {
  control: ControlStore
  registry: TenantRegistry
}): Promise<{ swept: string[] }> {
  const workspaces = deps.control.activeRefWorkspaces()
  const swept: string[] = []

  for (const workspaceId of workspaces) {
    const handle = deps.registry.get(workspaceId)
    if (handle?.sweep) {
      try {
        await handle.sweep()
        swept.push(workspaceId)
      } catch {
        // Individual tenant sweep failure does not abort other tenants
      }
    }
  }

  return { swept }
}
