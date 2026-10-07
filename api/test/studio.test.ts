import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { runStudioTurn, StudioTurnSchema, toMessages, type StudioEvent } from '../src/agents/studio'
import { scriptedModel } from './mockModel'
import { BUYER_KEY, call, closeAll, harness, OWNER_KEY, STUDIO_KEY } from './support'

afterEach(closeAll)

const sse = (text: string) => text.split('\n\n').filter(Boolean).map((block) => ({ name: /^event: (.*)$/m.exec(block)?.[1] ?? '', data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}') as Record<string, any> }))
const user = (text: string) => ({ id: 'u1', kind: 'input', type: 'message', role: 'user', status: 'completed', content: [{ type: 'text', text }] })
const TOOLS = [{ name: 'add_page_filter', description: 'Filter the page', parameters: { type: 'object', properties: { field: { type: 'string' }, value: { type: 'string' } }, required: ['field', 'value'] } }]
const post = (app: Parameters<typeof call>[0], body: unknown, key = OWNER_KEY) => (app as { request: (input: string, init?: RequestInit) => Response | Promise<Response> }).request('http://mandate.test/v1/studio/turn', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('the dashboard agent\'s conversation, as the model sees it', () => {
  it('turns Studio\'s items into messages: text, a tool call with its result, and a result that arrives separately', () => {
    const messages = toMessages([
      user('show what the rules refused'),
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Looking.' }] },
      { type: 'function_call', callId: 'c1', name: 'execute_query', arguments: '{"q":1}', result: '{"rows":3}' },
      { type: 'function_call', callId: 'c2', name: 'add_page_filter', arguments: '{"field":"decision","value":"DENY"}' },
      { type: 'function_call_output', callId: 'c2', output: 'ok' },
      { type: 'reasoning', summary: [] },
    ])
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool'])
    expect(messages[1]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool-call', toolCallId: 'c1', toolName: 'execute_query', input: { q: 1 } }] })
    expect(messages[4]).toMatchObject({ role: 'tool', content: [{ toolCallId: 'c2', toolName: 'add_page_filter', output: { type: 'text', value: 'ok' } }] })
  })

  it('survives arguments that are not JSON', () => {
    expect(toMessages([{ type: 'function_call', callId: 'x', name: 't', arguments: '{oops' }])[0]).toMatchObject({ content: [{ type: 'tool-call', input: {} }] })
  })
})

describe('one turn of the dashboard agent', () => {
  it('streams the model\'s words and the tool call it wants made, and runs nothing', async () => {
    const model = scriptedModel(() => ({ tools: [{ tool: 'add_page_filter', input: { field: 'decision', value: 'DENY' } }] }))
    const seen: StudioEvent[] = []
    const turn = StudioTurnSchema.parse({ input: [user('show what the rules refused')], instructions: 'You build dashboards.', tools: TOOLS })
    const done = await runStudioTurn({ model, turn, onEvent: (event) => seen.push(event) })
    expect(seen.map((event) => event.type)).toEqual(['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END'])
    expect(done.output).toEqual([expect.objectContaining({ type: 'function_call', name: 'add_page_filter', arguments: '{"field":"decision","value":"DENY"}' })])
    expect(done.status).toBe('completed')
    // One model call: a tool with no `execute` is never run here, so there is no second round.
    expect(model.calls()).toBe(1)
  })

  it('streams words as a message', async () => {
    const seen: StudioEvent[] = []
    const done = await runStudioTurn({ model: scriptedModel(() => ({ text: 'Three requests were refused.' })), turn: StudioTurnSchema.parse({ input: [user('what was refused?')] }), onEvent: (event) => seen.push(event) })
    expect(seen[0]).toMatchObject({ type: 'TEXT_MESSAGE_START' })
    expect(seen.filter((event) => event.type === 'TEXT_MESSAGE_CONTENT').map((event) => (event as { delta: string }).delta).join('')).toBe('Three requests were refused.')
    expect(done.output[0]).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Three requests were refused.' }] })
    expect(done.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 })
  })

  it('has no path to PayPal: the module imports the model library and nothing of Mandate\'s', () => {
    const source = readFileSync(new URL('../src/agents/studio.ts', import.meta.url), 'utf8')
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((match) => match[1])
    expect(imports.sort()).toEqual(['../http/problem', './model', 'ai', 'zod'])
  })
})

describe('POST /v1/studio/turn', () => {
  it('is for the owner only', async () => {
    const { app } = harness({ model: scriptedModel(() => ({ text: 'hi' })) })
    for (const key of [STUDIO_KEY, BUYER_KEY]) expect((await post(app, { input: [user('hi')] }, key)).status).toBe(403)
    expect((await post(app, { input: [user('hi')] })).status).toBe(200)
  })

  it('streams events, then the finished turn', async () => {
    const { app } = harness({ model: scriptedModel(({ round }) => (round === 0 ? { tool: 'add_page_filter', input: { field: 'decision', value: 'DENY' } } : { text: 'done' })) })
    const response = await post(app, { input: [user('filter to refused')], instructions: 'x', tools: TOOLS, toolChoice: 'auto' })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const seen = sse(await response.text())
    expect(seen.map((event) => event.name)).toEqual(['ai', 'ai', 'ai', 'complete'])
    expect(seen.at(-1)!.data).toMatchObject({ status: 'completed', output: [{ type: 'function_call', name: 'add_page_filter' }], model: 'scripted-model' })
  })

  it('refuses a malformed, oversized or odd request before any model is asked', async () => {
    const model = scriptedModel(() => ({ text: 'never' }))
    const { app } = harness({ model })
    expect((await post(app, { input: 'nope' })).status).toBe(400)
    expect((await post(app, { input: [user('x')], tools: [{ name: 'bad name!', description: 'x', parameters: {} }] })).status).toBe(400)
    const huge = await post(app, { input: [user('x'.repeat(700_000))] })
    expect(huge.status).toBe(413)
    expect(model.calls()).toBe(0)
  })

  it('says so, in the stream, when the model fails, and when agents are off', async () => {
    const broken = harness({ model: scriptedModel(() => ({ fail: true, message: 'bad request shape' })) })
    const seen = sse(await (await post(broken.app, { input: [user('hi')] })).text())
    expect(seen.at(-1)).toMatchObject({ name: 'error', data: { code: 'agent.model_error' } })
    const off = harness({ model: null })
    const none = await post(off.app, { input: [user('hi')] })
    expect(sse(await none.text()).at(-1)).toMatchObject({ name: 'error', data: { code: 'agents.unconfigured' } })
  })

  it('writes the turn to the agent runs, so "what did it do?" has an answer', async () => {
    const { app } = harness({ model: scriptedModel(() => ({ text: 'hello' })) })
    await (await post(app, { input: [user('hi')] })).text()
    const runs = (await call(app, 'GET', '/v1/agent-runs')).json.data
    expect(runs[0]).toMatchObject({ agent: 'studio', status: 'ok' })
  })
})
