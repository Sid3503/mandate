import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { SecretString } from '../src/ops/secret'
import { call, closeAll, harness, OWNER_KEY } from './support'

afterEach(closeAll)

describe('boot secrets in SecretString', () => {
  it('wraps boot secrets in SecretString and redacts on inspect/stringify', () => {
    const config = loadConfig({
      API_KEY: 'a'.repeat(20),
      PROPOSER_KEY: 'b'.repeat(20),
      BUYER_AGENT_KEY: 'c'.repeat(20),
      SIGNING_KEY: 'test_signing_key_material',
      PAYPAL_CLIENT_ID: 'client_id_test',
      PAYPAL_CLIENT_SECRET: 'secret_test_12345',
      OLLAMA_API_KEY: 'ollama_secret_key',
    })

    expect(config.secrets.apiKey).toBeInstanceOf(SecretString)
    expect(config.secrets.apiKey.reveal()).toBe('a'.repeat(20))
    expect(config.secrets.apiKey.toString()).toBe('[redacted]')
    expect(config.secrets.apiKey.toJSON()).toBe('[redacted]')
    expect(JSON.stringify(config.secrets)).not.toContain('a'.repeat(20))
    expect(JSON.stringify(config.secrets)).not.toContain('secret_test_12345')
    expect(JSON.stringify(config.secrets)).not.toContain('ollama_secret_key')

    expect(config.secrets.proposerKey?.reveal()).toBe('b'.repeat(20))
    expect(config.secrets.buyerAgentKey?.reveal()).toBe('c'.repeat(20))
    expect(config.secrets.signingKey?.reveal()).toBe('test_signing_key_material')
    expect(config.secrets.paypalClientSecret?.reveal()).toBe('secret_test_12345')
    expect(config.secrets.ollamaApiKey?.reveal()).toBe('ollama_secret_key')
  })
})

describe('real /readyz readiness endpoint', () => {
  it('returns 200 JSON status with datastore checks directly without redirect', async () => {
    const { app } = harness()
    const readyz = await call(app, 'GET', '/readyz')
    expect(readyz.status).toBe(200)
    expect(readyz.json.status).toBe('pass')
    expect(readyz.json.checks['sqlite:read'][0].status).toBe('pass')

    const ready = await call(app, 'GET', '/ready')
    expect(ready.status).toBe(200)
    expect(ready.json).toEqual(readyz.json)
  })
})

describe('SSE stream caps', () => {
  it('rejects with 429 when stream connections exceed maximum cap', async () => {
    const { app } = harness()
    const readers = []
    try {
      for (let i = 0; i < 50; i++) {
        const res = await app.request('http://mandate.test/v1/stream', { headers: { authorization: `Bearer ${OWNER_KEY}` } })
        expect(res.status).toBe(200)
        readers.push(res.body!.getReader())
      }
      const overflow = await app.request('http://mandate.test/v1/stream', { headers: { authorization: `Bearer ${OWNER_KEY}` } })
      expect(overflow.status).toBe(429)
      const body = await overflow.json()
      expect(body.title).toContain('Stream cap reached')
    } finally {
      for (const r of readers) {
        await r.cancel()
      }
    }
  })
})
