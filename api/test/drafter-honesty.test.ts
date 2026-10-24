import { describe, expect, it } from 'vitest'
import { codeSummary, summaryContradiction } from '../src/agents/drafter'
import { wrongSwitchClaim } from '../src/agents/intent'
import { LINE_STUDIO_WARRANT, WarrantBodySchema } from '../src/domain/schemas'

const rules = WarrantBodySchema.parse(LINE_STUDIO_WARRANT)

describe('the model’s own summary', () => {
  it('is caught when it gets the direction of a change backwards', () => {
    // What the model wrote: "the monthly contractor cap is reduced to $500".
    const changes = ['The monthly contractor cap goes up from $180 to $500.']
    expect(summaryContradiction('Priya Shah will now be paid automatically from Northwind payments up to 60%, and the monthly contractor cap is reduced to $500.', changes)).toBe('The monthly contractor cap goes up from $180 to $500.')
  })

  it('is left alone when it agrees with the code', () => {
    const changes = ['The monthly contractor cap goes up from $180 to $500.']
    expect(summaryContradiction('The monthly contractor cap is raised to $500, and Priya is paid automatically from Northwind.', changes)).toBeNull()
  })

  it('is left alone when it talks about something else', () => {
    const changes = ['The monthly contractor cap goes up from $180 to $500.']
    expect(summaryContradiction('The per-payment ceiling is reduced to $50, and a standing rule is added.', changes)).toBeNull()
  })

  it('is caught the other way round, when a cap goes down', () => {
    const changes = ['The monthly contractor cap goes down from $180 to $100.']
    expect(summaryContradiction('The monthly contractor cap is raised to $100.', changes)).toBe('The monthly contractor cap goes down from $180 to $100.')
  })

  it('has a code-written version to fall back on', () => {
    expect(codeSummary(['A standing rule would let Priya Shah be paid with no tap.'], [], [])).toBe('A standing rule would let Priya Shah be paid with no tap.')
    expect(codeSummary([], [], [])).toBe('The draft changes nothing that the code can see.')
  })
})

describe('what a sentence claims about the switches', () => {
  it('catches a claim that autopilot pays on settle when it does not', () => {
    expect(wrongSwitchClaim('Priya Shah gets $135.00 with no tap from you, the moment the payment settles.', rules)).toBe('autopilot pays contractors when a client payment settles')
  })

  it('catches a claim that a switch is off when it is on', () => {
    const on = { ...rules, automation: { ...rules.automation, payOnSettle: true } }
    expect(wrongSwitchClaim('Autopilot does not pay contractors automatically when a client payment settles.', on)).toBe('autopilot pays contractors when a client payment settles')
  })

  it('accepts a claim that matches the rules', () => {
    expect(wrongSwitchClaim('Autopilot does not pay contractors automatically when a client payment settles.', rules)).toBeNull()
    const on = { ...rules, automation: { ...rules.automation, payOnSettle: true } }
    expect(wrongSwitchClaim('Priya Shah gets $135.00 the moment the payment settles.', on)).toBeNull()
  })

  it('catches a claim about the proof link that is the wrong way round', () => {
    expect(wrongSwitchClaim('A request does not need a link to the work.', rules)).toBe('every request needs an https link to the work')
  })

  it('says nothing about a sentence that makes no claim', () => {
    expect(wrongSwitchClaim('Contractors can receive at most 60% of a client payment.', rules)).toBeNull()
  })
})
