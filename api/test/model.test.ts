import { describe, expect, it } from 'vitest'
import { buildModels } from '../src/agents/model'

describe('buildModels', () => {
  it('turns the agents off when there is no key', () => {
    expect(buildModels({})).toEqual({ primary: null, drafter: null, fallback: null })
  })

  it('defaults to the open-weights defaults on Ollama Cloud', () => {
    const models = buildModels({ OLLAMA_API_KEY: 'key' })
    expect(models.primary?.name).toBe('gpt-oss:20b')
    expect(models.primary?.provider).toBe('ollama')
    expect(models.drafter?.name).toBe('gemma4:31b')
    expect(models.fallback?.name).toBe('gemma4:31b')
  })

  it('honours AGENT_MODEL and DRAFTER_MODEL, and drops the fallback when they are the same model', () => {
    const models = buildModels({ OLLAMA_API_KEY: 'key', AGENT_MODEL: 'gemma4:31b', DRAFTER_MODEL: 'gemma4:31b' })
    expect(models.primary?.name).toBe('gemma4:31b')
    expect(models.drafter?.name).toBe('gemma4:31b')
    expect(models.fallback).toBeNull()
  })

  it('uses the drafter as the fallback when primary and drafter differ', () => {
    const models = buildModels({ OLLAMA_API_KEY: 'key', AGENT_MODEL: 'gpt-oss:20b' })
    expect(models.fallback?.name).toBe('gemma4:31b')
  })
})
