import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootSafety, openProduct } from '../src/boot'
import { ControlStore } from '../src/control/store'
import { migrate, openDatabase, seed } from '../src/db/database'
import { Repo } from '../src/db/repo'
import { loadFlags } from '../src/flags'
import { runTenantSchedulerSweep } from '../src/ops/scheduler'
import { inWorkspace, live, type LiveEvent } from '../src/services/live'
import { acceptLegacyMachineKey, machineKeyHashKnown } from '../src/services/machine-key'
import { seal } from '../src/tenancy/envelope'
import { TenantRegistry, type TenantHandle } from '../src/tenancy/registry'
import { closeAll, NOW } from './support'

afterEach(() => {
  vi.restoreAllMocks()
  closeAll()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('tenant registry reference counting', () => {
  function fakeTenant(id: string, closed: string[], work: Map<string, Promise<void>>): TenantHandle {
    return {
      id,
      fetch: async () => {
        await (work.get(id) ?? Promise.resolve())
        return new Response('ok')
      },
      close: () => { closed.push(id) },
      sweep: async () => { await (work.get(id) ?? Promise.resolve()) },
    }
  }

  it('evicts a busy studio from the list but closes its database only when its last request is done', async () => {
    const closed: string[] = []
    const work = new Map<string, Promise<void>>()
    const registry = new TenantRegistry((id) => fakeTenant(id, closed, work), 1)
    const gate = deferred()
    work.set('ws_a', gate.promise)
    const running = registry.get('ws_a')!.fetch(new Request('http://mandate.test/v1/warrant'))
    await Promise.resolve()
    expect(registry.inUse('ws_a')).toBe(1)
    registry.get('ws_b')
    expect(registry.size).toBe(1)
    // Evicted, but still serving: not closed under the running request.
    expect(closed).toEqual([])
    gate.resolve()
    const response = await running
    expect(closed).toEqual([])
    expect(await response.text()).toBe('ok')
    // The body has been read, so the last user let go.
    expect(closed).toEqual(['ws_a'])
  })

  it('holds a sweep the same way, and does not treat a busy studio as idle', async () => {
    let at = 0
    const closed: string[] = []
    const work = new Map<string, Promise<void>>()
    const registry = new TenantRegistry((id) => fakeTenant(id, closed, work), 10, 1_000, () => at)
    const gate = deferred()
    work.set('ws_a', gate.promise)
    const sweeping = registry.get('ws_a')!.sweep!()
    at = 5_000
    registry.evictIdle()
    expect(registry.size).toBe(1)
    registry.drop('ws_a')
    expect(closed).toEqual([])
    gate.resolve()
    await sweeping
    expect(closed).toEqual(['ws_a'])
  })

  it('closes everything at shutdown, retired entries included', async () => {
    const closed: string[] = []
    const work = new Map<string, Promise<void>>()
    const registry = new TenantRegistry((id) => fakeTenant(id, closed, work), 1)
    const gate = deferred()
    work.set('ws_a', gate.promise)
    void registry.get('ws_a')!.fetch(new Request('http://mandate.test/'))
    await Promise.resolve()
    registry.get('ws_b')
    registry.closeAll()
    expect(closed.sort()).toEqual(['ws_a', 'ws_b'])
    gate.resolve()
  })
})

describe('tenant scheduler sweep', () => {
  function control() {
    const db = openDatabase(':memory:')
    const store = new ControlStore(db, 'pepper-sweep')
    store.ensureDefault(':memory:', NOW.toISOString())
    return { db, store }
  }

  it('skips a run while the previous one is still going', async () => {
    const { db, store } = control()
    store.insertWorkspace({ id: 'ws_aaaaaaaaaaaaaaaaaaaa', slug: 'a', name: 'A', mode: 'studio', paypal_mode: 'fake', db_path: '/nowhere', status: 'active', created_at: NOW.toISOString(), expires_at: null, last_active_at: NOW.toISOString(), signing_key_sealed: 'x' })
    store.rememberRef('payout', 'BATCH-1', 'ws_aaaaaaaaaaaaaaaaaaaa')
    const gate = deferred()
    let sweeps = 0
    const registry = new TenantRegistry((id) => ({ id, fetch: () => new Response(''), close: () => undefined, sweep: async () => { sweeps += 1; await gate.promise } }))
    const first = runTenantSchedulerSweep({ control: store, registry })
    const second = await runTenantSchedulerSweep({ control: store, registry })
    expect(second).toEqual({ swept: [], skipped: true })
    gate.resolve()
    expect((await first).swept).toEqual(['ws_aaaaaaaaaaaaaaaaaaaa'])
    expect(sweeps).toBe(1)
    // Once it is done, the next run goes ahead.
    expect((await runTenantSchedulerSweep({ control: store, registry })).swept).toEqual(['ws_aaaaaaaaaaaaaaaaaaaa'])
    db.close()
  })

  it('forgets the PayPal ids of studios that no longer exist, and keeps the default studio\'s', async () => {
    const { db, store } = control()
    store.rememberRef('invoice', 'INV-GONE', 'ws_gonegonegonegonegone')
    store.rememberRef('invoice', 'INV-HOME', 'ws_default')
    const registry = new TenantRegistry(() => null)
    const result = await runTenantSchedulerSweep({ control: store, registry })
    expect(result.pruned).toBe(1)
    expect(store.workspaceForRef('invoice', 'INV-GONE')).toBeNull()
    expect(store.workspaceForRef('invoice', 'INV-HOME')).toBe('ws_default')
    db.close()
  })
})

describe('live bus scoping for background work', () => {
  it('stamps what a studio\'s sweep publishes with that studio', () => {
    const seen: Record<string, LiveEvent[]> = { a: [], d: [] }
    const offA = live.subscribe((event) => seen.a!.push(event), 'ws_aaaaaaaaaaaaaaaaaaaa')
    const offD = live.subscribe((event) => seen.d!.push(event))
    inWorkspace('ws_aaaaaaaaaaaaaaaaaaaa', () => live.publish({ type: 'changed', scope: 'ledger', what: 'from-a', at: NOW.toISOString() }))
    live.publish({ type: 'changed', scope: 'ledger', what: 'from-default', at: NOW.toISOString() })
    offA()
    offD()
    const whats = (events: LiveEvent[]) => events.map((event) => (event.type === 'changed' ? event.what : ''))
    expect(whats(seen.a!)).toEqual(['from-a'])
    expect(whats(seen.d!)).toEqual(['from-default'])
  })
})

describe('boot safety', () => {
  it('refuses the fake PayPal login in production and allows it elsewhere', () => {
    const flags = loadFlags({ PAYPAL_LOGIN_ENABLED: '1' })
    expect(() => bootSafety({ nodeEnv: 'production', flags, env: { KEY_PEPPER: 'x'.repeat(32) }, databasePath: '/data/mandate.sqlite' })).toThrow(/PAYPAL_LOGIN_ENABLED/)
    expect(() => openProduct({ databasePath: ':memory:', flags, env: {}, publicUrl: 'https://mandate.example', now: () => NOW, nodeEnv: 'production' })).toThrow(/PAYPAL_LOGIN_ENABLED/)
    expect(bootSafety({ nodeEnv: 'test', flags, env: {}, databasePath: ':memory:' }).warnings).toEqual([])
  })

  it('warns in production about a missing KEY_PEPPER and a ledger under /tmp, without failing', () => {
    const flags = loadFlags({})
    const { warnings } = bootSafety({ nodeEnv: 'production', flags, env: {}, databasePath: '/tmp/mandate.sqlite' })
    expect(warnings.some((line) => line.includes('KEY_PEPPER'))).toBe(true)
    expect(warnings.some((line) => line.includes('/tmp'))).toBe(true)
    expect(bootSafety({ nodeEnv: 'production', flags, env: { KEY_PEPPER: 'p'.repeat(32) }, databasePath: '/var/data/mandate.sqlite' }).warnings).toEqual([])
    const logged: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => { logged.push(String(line)) })
    const product = openProduct({ databasePath: ':memory:', flags, env: {}, publicUrl: 'https://mandate.example', now: () => NOW, nodeEnv: 'production' })
    product.close()
    expect(logged.some((line) => line.includes('KEY_PEPPER'))).toBe(true)
  })
})

describe('a studio\'s own app is rate limited', () => {
  it('counts requests the main app hands to a studio', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-hardening-tenant-'))
    const master = Buffer.alloc(32, 3).toString('base64')
    const product = openProduct({
      databasePath: join(dir, 'mandate.sqlite'),
      flags: loadFlags({ FLAG_TENANCY: '1', DEMO_ENABLED: '1' }),
      env: { MASTER_KEY: master, KEY_PEPPER: 'pepper-pepper-pepper-32' },
      publicUrl: 'http://127.0.0.1:8787',
      now: () => NOW,
      nodeEnv: 'test',
      rateLimitPerMinute: 2,
    })
    try {
      const id = 'ws_cccccccccccccccccccc'
      const dbPath = join(dir, 'ws', `${id}.sqlite`)
      copyFileSync(product.demo!.template, dbPath)
      const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
      product.control!.insertWorkspace({ id, slug: id, name: 'Demo', mode: 'demo', paypal_mode: 'fake', db_path: dbPath, status: 'active', created_at: NOW.toISOString(), expires_at: null, last_active_at: NOW.toISOString(), signing_key_sealed: seal(master, pem) })
      const tenant = product.registry!.get(id)!
      const statuses: number[] = []
      for (let i = 0; i < 3; i += 1) {
        const response = await tenant.fetch(new Request('http://mandate.test/v1/warrant', { headers: { authorization: 'Bearer mnd_ag_ws_cccccccccccccccccccc_notarealkeyatall' } }))
        statuses.push(response.status)
        await response.text()
      }
      expect(statuses.slice(0, 2).every((status) => status === 401)).toBe(true)
      expect(statuses[2]).toBe(429)
    } finally {
      product.close()
    }
  })
})

describe('legacy machine keys', () => {
  it('never runs the legacy hash look-ups for a key that is not legacy-shaped', () => {
    const db = openDatabase(':memory:')
    migrate(db)
    seed(db, NOW)
    const repo = new Repo(db)
    const odd = 'mnd_ag_has spaces and !punctuation'
    acceptLegacyMachineKey(repo, odd)
    expect(machineKeyHashKnown(odd.slice('mnd_ag_'.length))).toBe(false)
    const shaped = 'mnd_ag_legacyshapedsecret1234'
    acceptLegacyMachineKey(repo, shaped)
    expect(machineKeyHashKnown(shaped.slice('mnd_ag_'.length))).toBe(true)
    db.close()
  })
})

describe('backup and restore of the whole data root', () => {
  const root = resolve(__dirname, '../..')
  const backupScript = join(root, 'scripts/db-backup.mjs')
  const restoreScript = join(root, 'scripts/db-restore.mjs')

  function dataRoot() {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-hardening-backup-'))
    const data = join(dir, 'data')
    const main = join(data, 'mandate.sqlite')
    const ledger = openDatabase(main)
    migrate(ledger)
    ledger.exec("INSERT INTO proposals (id, warrant_id, warrant_version, kind, amount_cents, currency, description, gate, clause, detail, phase, created_at, updated_at) VALUES ('p_main', 'w1', 1, 'payment', 100, 'USD', 'd', 'AUTO', 'c', 'd', 'locked', 'now', 'now')")
    ledger.close()
    const control = new DatabaseSync(join(data, 'control.sqlite'))
    control.exec("CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('control')")
    control.close()
    execFileSync('mkdir', ['-p', join(data, 'ws')])
    const studio = new DatabaseSync(join(data, 'ws', 'ws_aaaaaaaaaaaaaaaaaaaa.sqlite'))
    studio.exec("CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('studio')")
    studio.close()
    writeFileSync(join(data, 'signing-key.pem'), 'PEM-KEY')
    return { dir, data, main }
  }

  it('copies every sqlite file and the key, with a manifest of checksums, and restores them all', () => {
    const { dir, data, main } = dataRoot()
    const out = join(dir, 'offsite')
    const printed = execFileSync('node', [backupScript, main, '--out', out], { cwd: dir, encoding: 'utf8' }).trim()
    const folder = resolve(printed, '..')
    const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as { main: string; files: Array<{ path: string; sha256: string }> }
    expect(manifest.main).toBe('mandate.sqlite')
    expect(manifest.files.map((file) => file.path).sort()).toEqual(['control.sqlite', 'mandate.sqlite', 'signing-key.pem', join('ws', 'ws_aaaaaaaaaaaaaaaaaaaa.sqlite')].sort())
    expect(manifest.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true)

    // Change the live data, leave a stale write-ahead log behind, then restore the folder.
    const studioPath = join(data, 'ws', 'ws_aaaaaaaaaaaaaaaaaaaa.sqlite')
    const studio = new DatabaseSync(studioPath)
    studio.exec("UPDATE marker SET v = 'changed'")
    studio.close()
    writeFileSync(`${main}-wal`, 'stale')
    writeFileSync(`${main}-shm`, 'stale')
    writeFileSync(join(data, 'signing-key.pem'), 'OTHER')
    execFileSync('node', [restoreScript, folder, '--yes'], { cwd: dir, env: { ...process.env, DATABASE_PATH: main }, encoding: 'utf8' })
    expect(existsSync(`${main}-wal`)).toBe(false)
    expect(existsSync(`${main}-shm`)).toBe(false)
    const back = new DatabaseSync(studioPath)
    expect((back.prepare('SELECT v FROM marker').get() as { v: string }).v).toBe('studio')
    back.close()
    expect(readFileSync(join(data, 'signing-key.pem'), 'utf8')).toBe('PEM-KEY')
    const ledger = new DatabaseSync(main)
    expect(ledger.prepare("SELECT id FROM proposals WHERE id = 'p_main'").get()).toBeTruthy()
    ledger.close()
  })

  it('refuses a backup whose checksum does not match, and leaves the current data alone', () => {
    const { dir, data, main } = dataRoot()
    const printed = execFileSync('node', [backupScript, main, '--out', join(dir, 'offsite')], { cwd: dir, encoding: 'utf8' }).trim()
    const folder = resolve(printed, '..')
    writeFileSync(join(folder, 'signing-key.pem'), 'TAMPERED')
    writeFileSync(join(data, 'signing-key.pem'), 'CURRENT')
    expect(() => execFileSync('node', [restoreScript, folder, '--yes'], { cwd: dir, env: { ...process.env, DATABASE_PATH: main }, encoding: 'utf8', stdio: 'pipe' })).toThrow()
    expect(readFileSync(join(data, 'signing-key.pem'), 'utf8')).toBe('CURRENT')
  })
})
