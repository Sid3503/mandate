import { describe, expect, it } from 'vitest'
import { emptyStream, fromAgentCall, reduceStream, type StreamEvent } from '../../web/src/lib/agentStream'
import { inputFacts, outputLine, toolLabel } from '../../web/src/lib/tools'

const run = (events: StreamEvent[]) => events.reduce((state, event, index) => reduceStream(state, event, 1000 + index), emptyStream)

describe('the live picture of an AI run', () => {
  it('follows a call from announced, to called with arguments, to answered', () => {
    const state = run([
      { type: 'tool_start', id: 'call_0', tool: 'propose' },
      { type: 'tool_call', id: 'call_0', tool: 'propose', input: { payee: 'Priya', amountCents: 9000 } },
      { type: 'tool_end', id: 'call_0', tool: 'propose', ok: true, output: { decision: 'DENY', ruleCode: 'funding.missing' }, ms: 412 },
    ])
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0]).toMatchObject({ status: 'ok', tool: 'propose', ms: 412, input: { payee: 'Priya' } })
  })

  it('keeps two calls apart when the model reuses the same call id in two steps', () => {
    const state = run([
      { type: 'tool_start', id: 'call_0', tool: 'get_jobs' },
      { type: 'tool_call', id: 'call_0', tool: 'get_jobs', input: {} },
      { type: 'tool_end', id: 'call_0', tool: 'get_jobs', ok: true, output: { jobs: [] }, ms: 5 },
      { type: 'tool_start', id: 'call_0', tool: 'propose' },
      { type: 'tool_call', id: 'call_0', tool: 'propose', input: { payee: 'Priya' } },
    ])
    expect(state.calls.map((call) => `${call.tool}:${call.status}`)).toEqual(['get_jobs:ok', 'propose:running'])
    expect(new Set(state.calls.map((call) => call.key)).size).toBe(2)
  })

  it('shows failures as failures, and starts a card for an answer that was never announced', () => {
    const state = run([{ type: 'tool_end', id: 'x', tool: 'propose', ok: false, output: { error: { code: 'propose.invalid', message: 'bad field' } } }])
    expect(state.calls[0]).toMatchObject({ status: 'error' })
    expect(outputLine('propose', state.calls[0]!.output, false)).toEqual({ tone: 'bad', text: 'bad field' })
  })

  it('builds the words, and throws them away when they are taken back', () => {
    const words = run([{ type: 'text', delta: 'I ' }, { type: 'text', delta: 'have paid ' }])
    expect(words.text).toBe('I have paid ')
    const retracted = reduceStream(words, { type: 'retract', reason: 'money_claim' })
    expect(retracted).toMatchObject({ text: '', retracted: 'money_claim' })
    expect(reduceStream(retracted, { type: 'text', delta: 'more' }).text).toBe('')
  })

  it('reads the reviewer\'s live events the same way, and marks the code step as code', () => {
    const state = run([
      fromAgentCall({ phase: 'start', id: 'check-1', tool: 'proof_check', source: 'code' }),
      fromAgentCall({ phase: 'end', id: 'check-1', tool: 'proof_check', source: 'code', ok: false, ms: 0, note: 'the site\'s home page, not a specific file' }),
    ])
    expect(state.calls[0]).toMatchObject({ source: 'code', status: 'error', note: expect.stringContaining('home page') })
  })
})

describe('how a tool call is said in words', () => {
  it('names tools, shows the few arguments that matter, and reduces the answer to a line and a tone', () => {
    expect(toolLabel('propose', false)).toBe('Filing the request with the rules')
    expect(toolLabel('propose', true)).toBe('Filed the request with the rules')
    expect(toolLabel('something_new', true)).toBe('something new')
    expect(inputFacts('propose', { kind: 'payment', payee: 'Priya', amountCents: 9000, category: 'design' })).toEqual([{ k: 'pay', v: 'Priya' }, { k: 'amount', v: '$90.00' }, { k: 'work', v: 'design' }])
    expect(outputLine('propose', { decision: 'DENY', ruleCode: 'funding.missing' }, true)).toEqual({ tone: 'deny', text: 'Refused · funding.missing' })
    expect(outputLine('propose', { decision: 'AUTO', ruleCode: 'standing.matched' }, true).tone).toBe('good')
    expect(outputLine('propose', { decision: 'NEEDS_APPROVAL', ruleCode: 'amount.needs_approval' }, true).tone).toBe('need')
    expect(outputLine('get_jobs', { jobs: [{}, {}], payoutsPossibleFrom: [] }, true).text).toBe('2 jobs · 0 payments can still fund a payout')
  })
})
