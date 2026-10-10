import { afterEach, describe, expect, it } from 'vitest'
import { call, closeAll, harness } from './support'

afterEach(closeAll)

const issue = (app: Parameters<typeof call>[0], body: unknown) => call(app, 'POST', '/v1/client-keys', { body })

describe('client keys', () => {
  it('issues a key bound to one client, shows it once, and lists it without the secret', async () => {
    const { app } = harness()
    const created = await issue(app, { name: 'Northwind buyer', partyId: 'client_northwind' })
    expect(created.status).toBe(201)
    expect(created.json.apiKey).toMatch(/^mnd_cl_[A-Za-z0-9_-]+$/)
    expect(created.json.key).toMatchObject({ name: 'Northwind buyer', partyId: 'client_northwind', status: 'active' })
    const list = await call(app, 'GET', '/v1/client-keys')
    expect(list.json).toHaveLength(1)
    expect(list.json[0]).toMatchObject({ name: 'Northwind buyer', partyId: 'client_northwind', status: 'active' })
    expect(JSON.stringify(list.json)).not.toContain(created.json.apiKey)
    expect(created.json.key).not.toHaveProperty('key_hash')
  })

  it('refuses a key for nobody: an unknown party, a nameless key, or anyone but the owner', async () => {
    const { app } = harness()
    expect((await issue(app, { name: 'Ghost', partyId: 'client_nowhere' })).status).toBe(404)
    expect((await issue(app, { name: '   ', partyId: 'client_northwind' })).status).toBe(400)
    expect((await issue(app, { name: 'Sneaky', partyId: 'client_northwind', extra: 1 })).status).toBe(400)
    expect((await call(app, 'GET', '/v1/client-keys', { key: 'mnd_cl_wrongwrongwrongwrongwrong12' })).status).toBe(401)
  })

  it('lets a client key be its own company and nobody else’s', async () => {
    const { app } = harness()
    // A second client on the warrant, so "another company" is real.
    const current = (await call(app, 'GET', '/v1/warrant')).json
    const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
    await call(app, 'PUT', '/v1/warrant', { body: { ...body, clients: [...body.clients, { id: 'client_harbor', displayName: 'Harbor Foods', email: 'ap@harbor.example', aliases: [] }] } })
    const northwind = (await issue(app, { name: 'Northwind buyer', partyId: 'client_northwind' })).json.apiKey
    const harbor = (await issue(app, { name: 'Harbor buyer', partyId: 'client_harbor' })).json.apiKey

    // Each key reads and writes its own sheet through `mine`.
    expect((await call(app, 'GET', '/v1/party-rules/mine', { key: northwind })).json.partyId).toBe('client_northwind')
    expect((await call(app, 'PUT', '/v1/party-rules/mine', { key: harbor, body: { maxTotalCents: 12_000 } })).json).toMatchObject({ partyId: 'client_harbor', maxTotalCents: 12_000 })
    // Neither key reaches the other's sheet, by id or by anything else.
    expect((await call(app, 'PUT', '/v1/party-rules/client_northwind', { key: harbor, body: { maxTotalCents: 1 } })).status).toBe(403)
    expect((await call(app, 'PUT', '/v1/party-rules/client_harbor', { key: northwind, body: { maxTotalCents: 1 } })).status).toBe(403)
    expect((await call(app, 'PUT', '/v1/party-rules/wnt_line_studio', { key: northwind, body: { minTotalCents: 1 } })).status).toBe(403)
    // A client key reads its own sheet and nothing else about the other company.
    expect((await call(app, 'GET', '/v1/party-rules', { key: northwind })).status).toBe(403)
  })

  it('revokes a key at once, and rotates it without a gap', async () => {
    const { app } = harness()
    const created = await issue(app, { name: 'Northwind buyer', partyId: 'client_northwind' })
    const first = created.json.apiKey as string
    expect((await call(app, 'GET', '/v1/party-rules/mine', { key: first })).status).toBe(200)

    const rotated = await call(app, 'POST', `/v1/client-keys/${created.json.key.id}/rotate`)
    expect(rotated.status).toBe(201)
    expect(rotated.json.apiKey).toMatch(/^mnd_cl_/)
    expect(rotated.json.apiKey).not.toBe(first)
    // The old key dies with the rotation; the new one already works.
    expect((await call(app, 'GET', '/v1/party-rules/mine', { key: first })).status).toBe(403)
    expect((await call(app, 'GET', '/v1/party-rules/mine', { key: rotated.json.apiKey })).status).toBe(200)

    await call(app, 'POST', `/v1/client-keys/${rotated.json.key.id}/revoke`)
    const dead = await call(app, 'GET', '/v1/party-rules/mine', { key: rotated.json.apiKey })
    expect(dead.status).toBe(403)
    expect(dead.json.code).toBe('client-key.revoked')
    expect((await call(app, 'POST', `/v1/client-keys/${rotated.json.key.id}/rotate`)).status).toBe(409)
    expect((await call(app, 'POST', '/v1/client-keys/nope/revoke')).status).toBe(404)
  })
})
