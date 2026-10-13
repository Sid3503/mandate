import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { loadFlags } from '../src/flags'
import { rateClass } from '../src/ops/ratelimit'
import { call, closeAll, harness, idem, EVIDENCE, JOB, NOW, STUDIO_KEY } from './support'

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

  it('upgrades an old mnd_ag_ secret and keeps the same agent', async () => {
    const { app } = harness()
    const created = await createKey(app)
    const upgraded = await call(app, 'POST', `/v1/agents/${created.agent.id}/upgrade`)
    expect(upgraded.status).toBe(200)
    expect(upgraded.json.apiKey).toMatch(/^mnd_ag_[A-Za-z0-9_-]+$/)
    expect(upgraded.json.apiKey).not.toBe(created.apiKey)
    expect(upgraded.json.agent.id).toBe(created.agent.id)
    expect(JSON.stringify((await call(app, 'GET', '/v1/agents')).json)).not.toContain(upgraded.json.apiKey)
    expect((await call(app, 'GET', '/v1/warrant', { key: created.apiKey })).status).toBe(401)
    expect((await call(app, 'GET', '/v1/warrant', { key: upgraded.json.apiKey })).status).toBe(200)
    expect((await call(app, 'POST', `/v1/agents/${created.agent.id}/upgrade`, { key: STUDIO_KEY })).status).toBe(403)
    expect((await call(app, 'POST', `/v1/agents/${created.agent.id}/upgrade`, { key: upgraded.json.apiKey })).status).toBe(403)
    expect((await call(app, 'POST', `/v1/agents/${randomUUID()}/upgrade`)).status).toBe(404)
  })

  it('accepts a legacy hash of the secret without the prefix, then stores the whole key', async () => {
    const { app, repo } = harness()
    const secret = 'legacyagentsecretlegacyagent'
    const apiKey = `mnd_ag_${secret}`
    const id = randomUUID()
    repo.createAgent({
      id,
      name: 'Legacy',
      scopes_json: JSON.stringify(['read']),
      limits_json: JSON.stringify({ proposalsPerHour: 10, centsPerHour: 100000 }),
      status: 'active',
      key_hash: createHash('sha256').update(secret).digest('hex'),
      created_at: NOW.toISOString(),
      last_seen_at: null,
    })
    expect((await call(app, 'GET', '/v1/warrant', { key: apiKey })).status).toBe(200)
    expect(repo.getAgent(id)?.key_hash).toBe(createHash('sha256').update(apiKey).digest('hex'))
    expect((await call(app, 'GET', '/v1/warrant', { key: apiKey })).status).toBe(200)
  })

  it('requires a passkey before an upgrade when the rule is on', async () => {
    const { app, repo } = harness({ flags: loadFlags({ REQUIRE_PASSKEY_FOR_MONEY: '1' }) })
    const id = randomUUID()
    repo.createAgent({
      id,
      name: 'Legacy',
      scopes_json: JSON.stringify(['read']),
      limits_json: JSON.stringify({ proposalsPerHour: 10, centsPerHour: 100000 }),
      status: 'active',
      key_hash: createHash('sha256').update('mnd_ag_alreadywhole').digest('hex'),
      created_at: NOW.toISOString(),
      last_seen_at: null,
    })
    const blocked = await call(app, 'POST', `/v1/agents/${id}/upgrade`)
    expect(blocked.status).toBe(401)
    expect(blocked.json.title).toBe('Sign this with your passkey')
  })

  it('counts agent upgrade in the write rate-limit class', async () => {
    expect(rateClass('POST', '/v1/agents/someone/upgrade')).toBe('write')
    const { app } = harness({ classedRates: true, rateLimitPerMinute: 100 })
    let status = 0
    for (let i = 0; i < 61; i += 1) status = (await call(app, 'POST', '/v1/agents/someone/upgrade')).status
    expect(status).toBe(429)
  })

  it('creates an agent with an expiry date, and refuses an expired key with 403 agent.expired', async () => {
    const { app, setNow } = harness()
    const created = await createAgent(app, { name: 'Temporary auditor', scopes: ['read'], expiryDays: 30 })
    expect(created.status).toBe(201)
    expect(created.json.agent.expiresAt).toBeTruthy()
    const expiry = new Date(created.json.agent.expiresAt)
    expect(expiry.getTime()).toBeGreaterThan(NOW.getTime())

    // Active before expiry
    expect((await call(app, 'GET', '/v1/warrant', { key: created.json.apiKey })).status).toBe(200)

    // Move clock past expiry
    setNow(new Date(expiry.getTime() + 1000))
    const expired = await call(app, 'GET', '/v1/warrant', { key: created.json.apiKey })
    expect(expired.status).toBe(403)
    expect(expired.json.code).toBe('agent.expired')
  })

  it('rejects agent creation by non-owner or with bad expiry', async () => {
    const { app } = harness()
    const forbidden = await call(app, 'POST', '/v1/agents', { key: STUDIO_KEY, body: { name: 'Sneaky', scopes: ['read'] } })
    expect(forbidden.status).toBe(403)
    const badExpiry = await createAgent(app, { name: 'Bad expiry', scopes: ['read'], expiryDays: -5 })
    expect(badExpiry.status).toBe(400)
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

describe('agent scorecard', () => {
  it('rejects scorecard requests from non-owner or for unknown agent', async () => {
    const { app } = harness()
    const { apiKey, agent } = await createKey(app)
    expect((await call(app, 'GET', `/v1/agents/${randomUUID()}/scorecard`)).status).toBe(404)
    expect((await call(app, 'GET', `/v1/agents/${agent.id}/scorecard`, { key: apiKey })).status).toBe(403)
  })

  it('tracks requests, auto approvals, needs-tap, and refusals in the scorecard', async () => {
    const { app } = harness()
    const { apiKey, agent } = await createKey(app, { name: 'Auditor', scopes: ['read', 'propose'] })

    const initial = await call(app, 'GET', `/v1/agents/${agent.id}/scorecard`)
    expect(initial.status).toBe(200)
    expect(initial.json).toMatchObject({
      agentId: agent.id,
      name: 'Auditor',
      status: 'active',
      requests: 0,
      auto: 0,
      needsTap: 0,
      refusals: 0,
      breakerTripped: false,
    })

    const currentWarrant = (await call(app, 'GET', '/v1/warrant')).json
    const { id: _id, version: _version, createdAt: _createdAt, ...body } = currentWarrant
    await call(app, 'PUT', '/v1/warrant', { body: { ...body, fundingRequired: false, standing: [] } })

    const autoProp = await call(app, 'POST', '/v1/proposals', {
      key: apiKey,
      idem: idem(),
      body: { kind: 'payment', payee: 'Priya', amountCents: 100, currency: 'USD', category: 'design', description: 'Small icon', evidenceUrl: EVIDENCE, jobId: JOB },
    })
    expect(autoProp.status).toBe(201)
    expect(autoProp.json.gate).toBe('AUTO')

    const tapProp = await call(app, 'POST', '/v1/proposals', {
      key: apiKey,
      idem: idem(),
      body: { kind: 'payment', payee: 'Priya', amountCents: 5000, currency: 'USD', category: 'design', description: 'Full logo suite', evidenceUrl: EVIDENCE, jobId: JOB },
    })
    expect(tapProp.status).toBe(201)
    expect(tapProp.json.gate).toBe('NEEDS_APPROVAL')

    const denyProp = await call(app, 'POST', '/v1/proposals', {
      key: apiKey,
      idem: idem(),
      body: { kind: 'payment', payee: 'Unknown Random Person', amountCents: 100, currency: 'USD', category: 'design', description: 'Invalid', evidenceUrl: EVIDENCE, jobId: JOB },
    })
    expect(denyProp.status).toBe(201)
    expect(denyProp.json.gate).toBe('DENY')

    const card = await call(app, 'GET', `/v1/agents/${agent.id}/scorecard`)
    expect(card.status).toBe(200)
    expect(card.json).toMatchObject({
      agentId: agent.id,
      name: 'Auditor',
      status: 'active',
      requests: 3,
      auto: 1,
      needsTap: 1,
      refusals: 1,
      breakerTripped: false,
    })

    const list = await call(app, 'GET', '/v1/agents')
    const found = list.json.find((a: { id: string }) => a.id === agent.id)
    expect(found.scorecard).toMatchObject({
      requests: 3,
      auto: 1,
      needsTap: 1,
      refusals: 1,
      breakerTripped: false,
    })
  })

  it('reflects breaker trip and resumption in scorecard', async () => {
    const { app } = harness({ breaker: { tripAfter: 2, windowSeconds: 120 } })
    const { apiKey, agent } = await createKey(app, { name: 'Flaky', scopes: ['propose'] })

    const bad = () => call(app, 'POST', '/v1/proposals', {
      key: apiKey,
      idem: idem(),
      body: { kind: 'payment', payee: 'Nobody', amountCents: 100, currency: 'USD', category: 'design', description: 'd', evidenceUrl: EVIDENCE, jobId: JOB },
    })

    await bad()
    await bad()
    const third = await bad()
    expect(third.status).toBe(403)
    expect(third.json.code).toBe('agent.suspended')

    const trippedCard = await call(app, 'GET', `/v1/agents/${agent.id}/scorecard`)
    expect(trippedCard.status).toBe(200)
    expect(trippedCard.json).toMatchObject({
      status: 'suspended',
      refusals: 2,
      breakerTripped: true,
    })

    const resumed = await call(app, 'POST', `/v1/agents/${agent.id}/resume`)
    expect(resumed.status).toBe(200)
    expect(resumed.json.status).toBe('active')
    expect(resumed.json.scorecard.breakerTripped).toBe(false)
  })
})

