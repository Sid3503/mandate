import { describe, expect, it } from 'vitest'
import { buildModels, isBedrockName, withNoReasoning } from '../src/agents/model'

describe('which provider a model name belongs to', () => {
  it('sends inference-profile ids to Bedrock and everything else to Ollama', () => {
    expect(isBedrockName('us.openai.gpt-6-luna')).toBe(true)
    expect(isBedrockName('global.openai.gpt-6-sol')).toBe(true)
    expect(isBedrockName('gpt-oss:20b')).toBe(false)
    expect(isBedrockName('gemma4:31b')).toBe(false)
  })
})

describe('buildModels', () => {
  it('turns the agents off when there is no key', () => {
    expect(buildModels({})).toEqual({ primary: null, drafter: null, fallback: null })
  })

  it('defaults everything to Bedrock when it has a key', () => {
    const models = buildModels({ BEDROCK_API_KEY: 'key' })
    expect(models.primary?.name).toBe('us.openai.gpt-6-luna')
    expect(models.primary?.provider).toBe('bedrock')
    expect(models.drafter?.name).toBe('us.openai.gpt-6-luna')
    expect(models.fallback?.name).toBe('global.openai.gpt-6-sol')
  })

  it('keeps Ollama as the fallback when it also has a key', () => {
    const models = buildModels({ BEDROCK_API_KEY: 'key', OLLAMA_API_KEY: 'other' })
    expect(models.primary?.provider).toBe('bedrock')
    expect(models.fallback?.provider).toBe('ollama')
  })

  it('still works with only Ollama, as before', () => {
    const models = buildModels({ OLLAMA_API_KEY: 'other' })
    expect(models.primary?.name).toBe('gpt-oss:20b')
    expect(models.drafter?.name).toBe('gemma4:31b')
    expect(models.primary?.provider).toBe('ollama')
  })

  it('honours AGENT_MODEL and DRAFTER_MODEL on either provider', () => {
    const models = buildModels({ BEDROCK_API_KEY: 'key', OLLAMA_API_KEY: 'other', AGENT_MODEL: 'global.openai.gpt-6-sol', DRAFTER_MODEL: 'gemma4:31b' })
    expect(models.primary?.name).toBe('global.openai.gpt-6-sol')
    expect(models.drafter?.provider).toBe('ollama')
  })

  it('has no model for a name whose provider has no key', () => {
    expect(buildModels({ OLLAMA_API_KEY: 'other', AGENT_MODEL: 'us.openai.gpt-6-luna' }).primary).toBeNull()
  })
})

describe('Bedrock refuses function tools unless reasoning is off', () => {
  const seen: Array<Record<string, unknown>> = []
  const spy = (async (_input: unknown, init?: { body?: string }) => {
    seen.push(JSON.parse(init?.body ?? '{}'))
    return new Response('{}')
  }) as unknown as typeof fetch
  const send = (body: unknown) => withNoReasoning(spy)('https://example.test', { method: 'POST', body: JSON.stringify(body) })

  it('adds reasoning_effort none to a request that carries tools', async () => {
    await send({ model: 'm', tools: [{ type: 'function' }] })
    expect(seen.at(-1)).toMatchObject({ reasoning_effort: 'none' })
  })

  it('leaves a request without tools alone, and never overrides a choice', async () => {
    await send({ model: 'm', messages: [] })
    expect(seen.at(-1)).not.toHaveProperty('reasoning_effort')
    await send({ model: 'm', tools: [{ type: 'function' }], reasoning_effort: 'none' })
    expect(seen.at(-1)).toMatchObject({ reasoning_effort: 'none' })
  })
})
