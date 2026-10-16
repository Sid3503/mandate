import { afterEach, describe, expect, it } from 'vitest'
import { defaultFlags, loadFlags } from '../src/flags'
import { call, closeAll, harness, OWNER_KEY, STUDIO_KEY } from './support'

afterEach(closeAll)

describe('flags', () => {
  it('stays off unless the environment turns a flag on', () => {
    const flags = defaultFlags()
    expect(flags.tenancy).toBe(false)
    expect(flags.passkeys).toBe(false)
    expect(flags.demoEnabled).toBe(false)
    expect(flags.invites).toBe(false)
    expect(flags.requirePasskeyForMoney).toBe(false)
    expect(flags.paypalLogin).toBe(false)
    expect(flags.legacyOwnerKeyEnabled).toBe(true)
    expect(flags.modelEnabled).toBe(true)
    expect(flags.demoTtlHours).toBe(24)
    expect(flags.newPayeeWaitHours).toBe(24)
  })

  it('reads an explicit on and an explicit off', () => {
    const flags = loadFlags({ FLAG_TENANCY: '1', MODEL_ENABLED: '0', DEMO_TTL_HOURS: '3' })
    expect(flags.tenancy).toBe(true)
    expect(flags.modelEnabled).toBe(false)
    expect(flags.demoTtlHours).toBe(3)
  })

  it('refuses a flag value that is not on or off, and does not echo it', () => {
    expect(() => loadFlags({ FLAG_PASSKEYS: 'maybe-not-a-switch' })).toThrow(/invalid flag: FLAG_PASSKEYS/)
  })

  it('shows flags to the owner and refuses a proposer', async () => {
    const { app } = harness({ flags: loadFlags({ FLAG_TENANCY: 'on' }) })
    const owner = await call(app, 'GET', '/v1/flags')
    expect(owner.status).toBe(200)
    expect(owner.json.tenancy).toBe(true)
    expect(owner.json.passkeys).toBe(false)
    const staff = await call(app, 'GET', '/v1/flags', { key: STUDIO_KEY })
    expect(staff.status).toBe(403)
    const stranger = await call(app, 'GET', '/v1/flags', { key: 'not-a-real-key-000000' })
    expect(stranger.status).toBe(401)
    expect(JSON.stringify(stranger.json)).not.toContain(OWNER_KEY)
  })
})
