import { z } from 'zod'
import type { WarrantBody } from '../domain/schemas'
import { quantitiesIn } from './intent'
import { factsOf } from './policy'
import { rulesExplainerSystem } from './prompts'
import { callTool } from './structured'
import type { AgentModel } from './model'

/**
 * Says a finished draft back in plain words: a worked example in the owner's own numbers, then one idea per sentence,
 * then things worth knowing. The model phrases; code grounds.
 *
 * The check is exact, not a judgment about meaning: every number the model writes (an amount, a percent, a day count,
 * a bare count) must be a number from the facts the sentence cites, or from the worked example. A sentence that fails
 * the check is dropped, never shown. If nothing survives, the caller falls back to the code-written read-back, so the
 * owner always gets true lines or code lines, never model lines nobody checked.
 */

export const ExplainerSchema = z.object({
  lines: z.array(z.object({
    text: z.string().min(1).max(280).describe('One idea, in plain words for a non-technical owner.'),
    facts: z.array(z.string().max(120)).max(6).describe('The keys of the facts this sentence rests on, exactly as listed.'),
  })).min(1).max(14).describe('The worked example first, then one sentence per idea.'),
  notes: z.array(z.object({
    text: z.string().min(1).max(280).describe('Something worth knowing that follows from the numbers, for example how much room a worked example leaves under a cap.'),
    facts: z.array(z.string().max(120)).min(1).max(6).describe('The keys of the facts it follows from.'),
  })).max(3).describe('At most three. Empty when there is nothing worth adding.'),
})

export type Explained = { lines: string[]; notes: string[] }

type Token = { kind: 'money' | 'percent' | 'days' | 'count'; value: number }
const tokenKey = (token: Token) => `${token.kind}:${token.value}`

/** Every number in a sentence: amounts, percents and day counts from the shared reader, plus any bare count left over. */
export function numbersIn(text: string): Token[] {
  const found = quantitiesIn(text).map((quantity) => ({ kind: quantity.kind, value: quantity.value }))
  let masked = text
  // quantitiesIn reports each distinct number once, but a number written twice must still be masked twice.
  for (const quantity of quantitiesIn(text)) masked = masked.split(quantity.phrase).join(' '.repeat(quantity.phrase.length))
  for (const match of masked.matchAll(/\b\d[\d,]*\b/g)) {
    const value = Number(match[0].replaceAll(',', ''))
    if (Number.isFinite(value)) found.push({ kind: 'count', value })
  }
  return found
}

const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The numbers the worked example is allowed to use: the example payment and what each standing rule would pay from it. */
function exampleTokens(draft: WarrantBody, exampleCents: number): Token[] {
  const tokens: Token[] = [{ kind: 'money', value: exampleCents }]
  for (const rule of draft.standing) {
    const share = rule.shareBps ?? draft.contractorShareBps
    tokens.push({ kind: 'money', value: Math.floor((exampleCents * share) / 10_000) })
    tokens.push({ kind: 'percent', value: share / 100 })
  }
  return tokens
}

export async function explainRules(input: { model: AgentModel; draft: WarrantBody; exampleCents: number; signal?: AbortSignal; onRetry?: (reason: string) => void }): Promise<Explained> {
  const facts = factsOf(input.draft)
  const keys = new Set(facts.map((fact) => fact.key))
  const byKey = new Map(facts.map((fact) => [fact.key, fact.value]))
  const examples = new Set(exampleTokens(input.draft, input.exampleCents).map(tokenKey))
  const allowed = (cited: string[]): Set<string> => {
    const set = new Set(examples)
    for (const key of cited) {
      const value = byKey.get(key)
      if (value !== undefined) for (const token of numbersIn(value)) set.add(tokenKey(token))
    }
    return set
  }
  const check = (text: string, cited: string[], where: string): string | null => {
    for (const key of cited) if (!keys.has(key)) return `${where} cites “${key}”, which is not in the facts list.`
    const ok = allowed(cited)
    for (const token of numbersIn(text)) {
      if (!ok.has(tokenKey(token))) {
        const shown = token.kind === 'money' ? dollars(token.value) : token.kind === 'percent' ? `${token.value}%` : token.kind === 'days' ? `${token.value} days` : `${token.value}`
        return `${where} writes ${shown}, which is in neither the cited facts nor the worked example.`
      }
    }
    return null
  }
  const called = await callTool({
    model: input.model,
    system: rulesExplainerSystem(),
    user: [
      'THE RULES AS DRAFTED (the facts you may cite):',
      facts.map((fact) => `- ${fact.key}: ${fact.label} = ${fact.value}`).join('\n'),
      '',
      `THE WORKED EXAMPLE: a client payment of ${dollars(input.exampleCents)}.`,
      '',
      `Call read_back with the worked example first, then one sentence per idea, then at most three notes. Money exactly as listed (${dollars(2000)} style, never $20).`,
    ].join('\n'),
    name: 'read_back',
    description: 'Say the drafted rules back in plain words, with each sentence tied to the facts it rests on. Call it once.',
    schema: ExplainerSchema,
    validate: (value, last) => {
      if (last) return null
      const complaints: string[] = []
      value.lines.forEach((line, index) => {
        const problem = check(line.text, line.facts, `line ${index + 1}`)
        if (problem) complaints.push(problem)
      })
      value.notes.forEach((note, index) => {
        const problem = check(note.text, note.facts, `note ${index + 1}`)
        if (problem) complaints.push(problem)
      })
      return complaints.length ? complaints.slice(0, 6).join(' ') : null
    },
    signal: input.signal,
    attempts: 2,
    timeoutMs: 45_000,
    onRetry: (_attempt, reason) => input.onRetry?.(reason),
  })
  // On the last try, keep what points at something real and drop the rest. Silence is never shown as a line.
  const lines = called.value.lines.filter((line) => !check(line.text, line.facts, '')).map((line) => line.text.trim())
  const notes = called.value.notes.filter((note) => !check(note.text, note.facts, '')).map((note) => note.text.trim())
  if (lines.length === 0) throw new Error(called.leftover ?? 'no usable lines')
  return { lines, notes }
}
