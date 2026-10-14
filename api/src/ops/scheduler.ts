import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ControlStore } from '../control/store'
import type { TenantRegistry } from '../tenancy/registry'
import type { Repo } from '../db/repo'

export type CleanupResult = {
  cleaned: string[]
  skipped: string[]
  authEventsTrimmed: number
  logsTrimmed: number
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
 * P12.T5: Trims auth events older than 90 days from the control database.
 */
export function trimAuthEvents(deps: {
  control: ControlStore
  now: string | Date
  retentionDays?: number
}): number {
  const nowDate = typeof deps.now === 'string' ? new Date(deps.now) : deps.now
  const days = deps.retentionDays ?? 90
  const cutoffIso = new Date(nowDate.getTime() - days * 86_400_000).toISOString()
  return deps.control.trimAuthEvents(cutoffIso)
}

/**
 * P12.T5: Trims log files and client error logs older than 14 days.
 */
export function trimLogs(deps: {
  control?: ControlStore
  registry?: TenantRegistry | null
  repo?: Repo | null
  logDir?: string
  now: string | Date
  retentionDays?: number
}): number {
  const nowDate = typeof deps.now === 'string' ? new Date(deps.now) : deps.now
  const days = deps.retentionDays ?? 14
  const cutoffIso = new Date(nowDate.getTime() - days * 86_400_000).toISOString()
  const cutoffMs = nowDate.getTime() - days * 86_400_000
  let count = 0

  // 1. Trim file logs in logDir if specified or ./logs
  const logDir = deps.logDir ?? (existsSync('logs') ? 'logs' : undefined)
  if (logDir && existsSync(logDir)) {
    try {
      const files = readdirSync(logDir)
      for (const file of files) {
        if (!file.endsWith('.log')) continue
        const full = join(logDir, file)
        try {
          const stats = statSync(full)
          if (stats.mtimeMs < cutoffMs) {
            rmSync(full, { force: true })
            count += 1
          }
        } catch {
          // Best-effort file removal
        }
      }
    } catch {
      // Best-effort directory read
    }
  }

  // 2. Trim client error logs from repository if provided
  if (deps.repo) {
    try {
      count += deps.repo.trimClientErrors(cutoffIso)
    } catch {
      // Best-effort
    }
  }

  return count
}

/**
 * P2.T9 / Appendix B Case 27: Cleanup job for expired demo workspaces.
 * Deletes only workspaces where mode = 'demo' and expires_at < now.
 * Evicts from tenant registry (closing SQLite handles), removes SQLite files from disk,
 * and deletes control store records (members, credentials, sessions, invites, external_refs, workspaces).
 * Preserves default, studio, and live workspaces unconditionally.
 *
 * P12.T5: Trims auth events at 90 days and logs at 14 days.
 */
export function cleanupExpiredDemos(deps: {
  control: ControlStore
  registry?: TenantRegistry | null
  repo?: Repo | null
  logDir?: string
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

  // 4. P12.T5: Trim auth events older than 90 days and logs older than 14 days
  const authEventsTrimmed = trimAuthEvents({ control: deps.control, now: deps.now, retentionDays: 90 })
  const logsTrimmed = trimLogs({
    control: deps.control,
    registry: deps.registry,
    repo: deps.repo,
    logDir: deps.logDir,
    now: deps.now,
    retentionDays: 14,
  })

  return { cleaned, skipped, authEventsTrimmed, logsTrimmed }
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
