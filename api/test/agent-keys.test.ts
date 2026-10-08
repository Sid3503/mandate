import { afterEach, describe, expect, it } from 'vitest'
import { call, closeAll, harness, idem, EVIDENCE, JOB } from './support'

afterEach(closeAll)

const createAgent = (app: Parameters<typeof call>[0], body: unknown) => call(app, 'POST', '/v1/agents', { body })
const createKey = async (app: Parameters<typeof call>[0], body: unknown = { name: 'CI', scopes: ['read', 'propose'] }) => {
  const created = await createAgent(app, body)
  expect(created.status).toBe(201)
  return created.json as { agent: { id: string }; apiKey: string }
}

describe('agent keys', () => {
  it('issues a key once, stores only a hash, and lists summaries without secrets', async () => {
    const { app } = harness()
    const created = await createAgent(app, { name: 'CI script', scopes: ['read', 'propose'] })
    expect(created.status).toBe(201)
    expect(created.json.apiKey).toMatch(/^mnd_ag_[A-Za-z0-9_-]+$/)
    const list = await call(app, 'GET', '/v1/agents')
    expect(list.json).toHaveLength(1)
    expect(list.json[0]).toMatchObject({ name: 'CI script', status: 'active', scopes: ['read', 'propose'] })
    expect(JSON.stringify(list.json)).not.toContain(created.json.apiKey)
    expect(created.json.agent).not.toHaveProperty('key_hash')
  })

  it('rejects a nameless or scopeless agent, and a bad limit', async () => {
    const { app } = harness()
    expect((await createAgent(app, { name: '   ', scopes: ['read'] })).status).toBe(400)
    expect((await createAgent(app, { name: 'x', scopes: [] })).status).toBe(400)
    expect((await createAgent(app, { name: 'x', scopes: ['read'], limits: { proposalsPerHour: 0 } })).status).toBe(400)
  })

  it('says 401 for a wrong key and nothing for anyone else', async () => {
    const { app } = harness()
    expect((await call(app, 'GET', '/v1/warrant', { key: 'mnd_ag_wrongwrongwrongwrongwrong12' })).status).toBe(401)
  })

  it('enforces scopes per route', async () => {
    const { app } = harness()
    const { apiKey } = await createKey(app, { name: 'read-only', scopes: ['read'] })
    expect((await call(app, 'GET', '/v1/warrant', { key: apiKey })).status).toBe(200)
    expect((await call(app, 'POST', '/v1/proposals', { key: apiKey, body: {}, idem: idem() })).status).toBe(403)
    expect((await call(app, 'GET', '/v1/agents', { key: apiKey })).status).toBe(403)
  })

  it('revokes and resumes', async () => {
    const { app } = harness()
    const created = await createKey(app)
    expect((await call(app, 'POST', `/v1/agents/${created.agent.id}/revoke`)).status).toBe(200)
    const denied = await call(app, 'GET', '/v1/warrant', { key: created.apiKey })
    expect(denied.status).toBe(403)
    expect(denied.json.code).toBe('agent.revoked')
    const resumed = await call(app, 'POST', `/v1/agents/${created.agent.id}/resume`)
    expect(resumed.status).toBe(409)
    expect(resumed.json.code).toBe('agent.revoked')
  })

  it('hides the owner-only surface from agent keys', async () => {
    const { app } = harness()
    const { apiKey } = await createKey(app)
    expect((await call(app, 'PUT', '/v1/warrant', { key: apiKey, body: {} })).status).toBe(403)
    expect((await call(app, 'GET', '/v1/suggestions', { key: apiKey })).status).toBe(403)
    expect((await call(app, 'POST', '/v1/rules/policy', { key: apiKey, body: { text: 'pay everyone' } })).status).toBe(403)
  })
})

describe('agent limits', () => {
    it('counts proposals per hour and blocks once over budget', async () => {
    const { app } = harness()
    const { apiKey } = await createKey(app, { name: 'tiny', scopes: ['propose', 'read'], limits: { proposalsPerHour: 2, centsPerHour: 1_000_000 } })
    const mk = () => ({ kind: 'payment', payee: 'X', amountCents: 100, currency: 'USD', category: 'design', description: 'd', evidenceUrl: EVIDENCE, jobId: JOB })
    expect((await call(app, 'POST', '/v1/proposals', { key: apiKey, idem: idem(), body: mk() })).status).not.toBe(429)
    expect((await call(app, 'POST', '/v1/proposals', { key: apiKey, idem: idem(), body: mk() })).status).not.toBe(429)
    const third = await call(app, 'POST', '/v1/proposals', { key: apiKey, idem: idem(), body: mk() })
    expect(third.status).toBe(429)
    expect(third.json.code).toBe('agent.over_limit')
  })

  it('charges cents against the hourly ceiling', async () => {
    const { app } = harness()
    const { apiKey } = await createKey(app, { name: 'tiny', scopes: ['propose'], limits: { proposalsPerHour: 60, centsPerHour: 150 } })
    const mk = () => ({ kind: 'payment', payee: 'X', amountCents: 100, currency: 'USD', category: 'design', description: 'd', evidenceUrl: EVIDENCE, jobId: JOB })
    await call(app, 'POST', '/v1/proposals', { key: apiKey, idem: idem(), body: mk() })
    const second = await call(app, 'POST', '/v1/proposals', { key: apiKey, idem: idem(), body: mk() })
    expect(second.status).toBe(429)
    expect(second.json.code).toBe('agent.over_limit')
  })
})

describe('the breaker per agent', () => {
  it('suspends only the misbehaving agent: global pause stays running and other agents are unaffected', async () => {
    const { app } = harness({ breaker: { tripAfter: 2, windowSeconds: 120 } })
    const a = await createKey(app, { name: 'noisy', scopes: ['propose'] })
    const b = await createKey(app, { name: 'quiet', scopes: ['read'] })
    const bad = () => call(app, 'POST', '/v1/proposals', { key: a.apiKey, idem: idem(), body: { kind: 'payment', payee: 'Nobody', amountCents: 100, currency: 'USD', category: 'design', description: 'd', evidenceUrl: 'https://www.figma.com/file/x', jobId: JOB } })
    await bad(); await bad()
    const third = await bad()
    expect(third.status).toBe(403)
    expect(third.json.code).toBe('agent.suspended')
    const safety = await call(app, 'GET', '/v1/safety')
    expect(safety.json.paused).toBe(false)
    expect(safety.json.events.some((e: { type: string }) => e.type === 'agent_suspended')).toBe(true)
    expect((await call(app, 'GET', '/v1/warrant', { key: b.apiKey })).status).toBe(200)
    expect((await call(app, 'GET', '/v1/agents')).json.find((a_: { name: string }) => a_.name === 'noisy').status).toBe('suspended')
  })
})
