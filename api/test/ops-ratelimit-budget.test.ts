import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ModelBudget, sqliteBudgetStore } from '../src/ops/budget'
import { RateLimiter, pruneBuckets, rateClass, type TimedBucket } from '../src/ops/ratelimit'
import { call, closeAll, harness, OWNER_KEY } from './support'
import { migrate, openDatabase } from '../src/db/database'
import { loadFlags } from '../src/flags'
import { ControlStore } from '../src/control/store'

afterEach(closeAll)

describe('RateLimiter rate classes', () => {
  it('enforces auth rate limits (5 per min, 20 per hour per principal)', () => {
    let now = 1000
    const limiter = new RateLimiter(() => now)
    const ip = '192.168.1.1'
    const principal = 'user_1'

    // 5 attempts allowed in first minute
    for (let i = 0; i < 5; i++) {
      expect(limiter.take({ className: 'auth', ip, principal })).toEqual({ ok: true })
    }
    // 6th attempt in same minute is rejected
    const blockedMin = limiter.take({ className: 'auth', ip, principal })
    expect(blockedMin.ok).toBe(false)

    // Advance past 1 minute window
    now += 61_000
    // Allowed again
    expect(limiter.take({ className: 'auth', ip, principal })).toEqual({ ok: true })
  })

  it('enforces key-unlock rate limit (10 per minute per IP)', () => {
    let now = 1000
    const limiter = new RateLimiter(() => now)
    const ip = '10.0.0.1'

    for (let i = 0; i < 10; i++) {
      expect(limiter.take({ className: 'key-unlock', ip, principal: '' })).toEqual({ ok: true })
    }
    const eleventh = limiter.take({ className: 'key-unlock', ip, principal: '' })
    expect(eleventh.ok).toBe(false)

    now += 60_000
    expect(limiter.take({ className: 'key-unlock', ip, principal: '' })).toEqual({ ok: true })
  })

  it('enforces ask rate limit (12 per minute per principal)', () => {
    let now = 1000
    const limiter = new RateLimiter(() => now)
    const principal = 'key_asker'

    for (let i = 0; i < 12; i++) {
      expect(limiter.take({ className: 'ask', ip: '1.2.3.4', principal })).toEqual({ ok: true })
    }
    const thirteenth = limiter.take({ className: 'ask', ip: '1.2.3.4', principal })
    expect(thirteenth.ok).toBe(false)
  })

  it('enforces write rate limit (60 per minute per principal)', () => {
    let now = 1000
    const limiter = new RateLimiter(() => now)
    const principal = 'writer'

    for (let i = 0; i < 60; i++) {
      expect(limiter.take({ className: 'write', ip: '1.1.1.1', principal })).toEqual({ ok: true })
    }
    const overflow = limiter.take({ className: 'write', ip: '1.1.1.1', principal })
    expect(overflow.ok).toBe(false)
  })

  it('enforces read rate limit (300 per minute per principal)', () => {
    let now = 1000
    const limiter = new RateLimiter(() => now)
    const principal = 'reader'

    for (let i = 0; i < 300; i++) {
      expect(limiter.take({ className: 'read', ip: '1.1.1.1', principal })).toEqual({ ok: true })
    }
    const overflow = limiter.take({ className: 'read', ip: '1.1.1.1', principal })
    expect(overflow.ok).toBe(false)
  })

  it('maps methods and paths to expected rate classes', () => {
    expect(rateClass('POST', '/auth/login')).toBe('auth')
    expect(rateClass('POST', '/v1/session')).toBe('key-unlock')
    expect(rateClass('POST', '/v1/ask')).toBe('ask')
    expect(rateClass('POST', '/v1/clerk/stream')).toBe('ask')
    expect(rateClass('GET', '/v1/proposals')).toBe('read')
    expect(rateClass('HEAD', '/v1/proposals')).toBe('read')
    expect(rateClass('POST', '/v1/proposals')).toBe('write')
    expect(rateClass('DELETE', '/v1/members/1')).toBe('write')
  })

  it('pruneBuckets removes expired and trims beyond maximum', () => {
    const map = new Map<string, TimedBucket>()
    map.set('a', { count: 1, reset: 1000 })
    map.set('b', { count: 1, reset: 2000 })
    map.set('c', { count: 1, reset: 3000 })

    pruneBuckets(map, 1500, 2)
    expect(map.has('a')).toBe(false)
    expect(map.has('b')).toBe(true)
    expect(map.has('c')).toBe(true)

    pruneBuckets(map, 1500, 1)
    expect(map.size).toBe(1)
    expect(map.has('c')).toBe(true)
  })
})

describe('Model budget and demo workspace model caps (case 28)', () => {
  it('budget 0 blocks model reservations while quick asks still work', async () => {
    const db = openDatabase(':memory:')
    const store = sqliteBudgetStore(db)
    const budget = new ModelBudget(
      { globalDailyTokens: 0, workspaceDailyTokens: 0, maxOutputTokens: 2048, maxSteps: 4 },
      () => new Date(),
      'ws_demo_test',
      store,
    )

    // Reserving model tokens returns refusal
    const reservation = budget.reserve()
    expect(reservation).toContain('AI is paused today. Quick asks still work.')
    expect(budget.blocked()).toContain('AI is paused today. Quick asks still work.')

    // Quick asks still work through API without model
    const { app } = harness({ budget })
    const quickRes = await call(app, 'POST', '/v1/ask', {
      key: OWNER_KEY,
      body: { quick: 'waiting' },
    })
    expect(quickRes.status).toBe(200)
    expect(quickRes.json.kind).toBe('answer')
    expect(quickRes.json.id).toBe('waiting')
    db.close()
  })

  it('enforces demo workspace model daily token cap', () => {
    const db = openDatabase(':memory:')
    const store = sqliteBudgetStore(db)
    const budget = new ModelBudget(
      { globalDailyTokens: 10_000_000, workspaceDailyTokens: 50_000, maxOutputTokens: 2048, maxSteps: 4 },
      () => new Date(),
      'ws_demo_cap',
      store,
    )

    expect(budget.blocked()).toBeNull()
    budget.reserve()
    // Simulate consuming 50_000 tokens
    budget.correct(25_000, 25_000)
    expect(budget.blocked()).toContain('AI is paused today. Quick asks still work.')
    db.close()
  })
})

describe('Demo start rate limit per IP per hour (case 26)', () => {
  it('sixth demo from one IP in an hour returns 429', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-demo-ratelimit-'))
    const template = join(dir, 'template.sqlite')
    const tdb = openDatabase(template)
    migrate(tdb)
    tdb.close()
    const controlDb = openDatabase(join(dir, 'control.sqlite'))
    const control = new ControlStore(controlDb, 'pepper-test')
    const MASTER = '0123456789abcdef0123456789abcdef'

    const flags = loadFlags({ FLAG_TENANCY: '1', DEMO_ENABLED: '1', DEMO_MAX_PER_IP_HOUR: '5' })
    const { app } = harness({ flags, control, masterKey: MASTER, demo: { root: dir, template } })

    for (let i = 0; i < 5; i++) {
      const res = await app.request('http://mandate.test/demo/start', {
        method: 'POST',
        headers: { 'x-forwarded-for': '198.51.100.42' },
      })
      expect(res.status).toBe(200)
    }

    const sixth = await app.request('http://mandate.test/demo/start', {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.42' },
    })
    expect(sixth.status).toBe(429)
    const body = await sixth.json()
    expect(body.title).toBe('Too many demos')
  })
})
