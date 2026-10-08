import { afterEach, describe, expect, it } from 'vitest'
import { explainRules, numbersIn } from '../src/agents/explainer'
import { LINE_STUDIO_WARRANT, WarrantBodySchema } from '../src/domain/schemas'
import { applyPatch } from '../src/agents/drafter'
import { scriptedModel, type ScriptedStep } from './mockModel'
import { call, closeAll, harness } from './support'

afterEach(closeAll)

const rules = WarrantBodySchema.parse(LINE_STUDIO_WARRANT)

describe('numbersIn', () => {
  it('reads amounts, percents, day counts and bare counts, without double counting', () => {
    expect(numbersIn('Requests under $20.00 go with no tap.')).toEqual([{ kind: 'money', value: 2000 }])
    expect(numbersIn('Priya gets $90.00 (60%) with no tap.')).toEqual([{ kind: 'money', value: 9000 }, { kind: 'percent', value: 60 }])
    expect(numbersIn('A reminder after 7 days, at most 2 reminders.')).toEqual([{ kind: 'days', value: 7 }, { kind: 'count', value: 2 }])
    expect(numbersIn('No tap from you.')).toEqual([])
  })
})

const draft = applyPatch(rules, {
  summary: 'x',
  standingRules: [{ payee: 'Priya', clients: ['Northwind'] }],
  autopilot: { payOnSettle: true },
})

const explainer = (lines: Array<{ text: string; facts: string[] }>, notes: Array<{ text: string; facts: string[] }> = []) =>
  scriptedModel((): ScriptedStep => ({ tool: 'read_back', input: { lines, notes } }))

describe('explainRules', () => {
  it('keeps sentences whose numbers come from the cited facts or the worked example', async () => {
    const model = explainer([
      { text: 'When Northwind pays $150.00 on a signed deal, Priya Shah gets $90.00 (60%) with no tap from you, the moment the payment settles.', facts: ['standing:priya_shah_from_northwind', 'automation.payOnSettle'] },
      { text: 'Requests under $20.00 that fit the rules go with no tap.', facts: ['autoSettleUnderCents'] },
      { text: 'At $20.00 and above, you tap.', facts: ['autoSettleUnderCents'] },
    ], [
      { text: 'That $90.00 payout would leave $90.00 of the $180.00 monthly cap.', facts: ['monthlyCapCents'] },
    ])
    const explained = await explainRules({ model, draft, exampleCents: 15_000 })
    expect(explained.lines).toHaveLength(3)
    expect(explained.notes).toEqual(['That $90.00 payout would leave $90.00 of the $180.00 monthly cap.'])
  })

  it('drops a sentence that writes a number from nowhere, and fails when nothing survives', async () => {
    const bad = explainer([{ text: 'Priya gets $9,999.00 with no tap.', facts: ['standing:priya_shah_from_northwind'] }])
    await expect(explainRules({ model: bad, draft, exampleCents: 15_000 })).rejects.toThrow()
  })

  it('drops a sentence that cites a fact that does not exist', async () => {
    const bad = explainer([{ text: 'Requests under $20.00 go with no tap.', facts: ['noSuchSetting'] }])
    await expect(explainRules({ model: bad, draft, exampleCents: 15_000 })).rejects.toThrow()
  })
})

describe('the draft route with a model-written read-back', () => {
  it('shows the model lines with verified numbers, marks who wrote them, and records the run', async () => {
    const model = scriptedModel(({ system }): ScriptedStep => {
      if (system.includes('You say a DRAFT')) {
        return { tool: 'read_back', input: { lines: [{ text: 'When Northwind pays $150.00 on a signed deal, Priya Shah gets $90.00 (60%) with no tap from you.', facts: ['standing:priya_shah_from_northwind'] }], notes: [] } }
      }
      return { tool: 'propose_rules', input: { summary: 'Priya is paid automatically.', standingRules: [{ payee: 'Priya', clients: ['Northwind'] }] } }
    })
    const { app } = harness({ model })
    const made = await call(app, 'POST', '/v1/rules/draft', { body: { instruction: 'pay Priya automatically' } })
    expect(made.status).toBe(200)
    expect(made.json.readBackBy).toBe('model')
    expect(made.json.readBack).toEqual(['When Northwind pays $150.00 on a signed deal, Priya Shah gets $90.00 (60%) with no tap from you.'])
    const runs = (await call(app, 'GET', '/v1/agent-runs')).json.data
    const run = runs.find((item: { agent: string }) => item.agent === 'rules_explainer')
    expect(run).toMatchObject({ status: 'ok' })
    expect((await call(app, 'GET', `/v1/agent-runs/${run.id}`)).json.promptVersion).toBe('rulesExplainer@v1')
  })
})
