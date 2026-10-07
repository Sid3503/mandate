import { MockLanguageModelV4 } from 'ai/test'
import type { AgentModel } from '../agents/model'
import { streamFromGenerate } from './mock-stream'

/**
 * A deterministic stand-in for the language model, used by `npm run demo` and the browser tests when no
 * OLLAMA_API_KEY is set. It is a tiny script, not an AI: it reads a message with a few patterns and makes the same
 * tool calls a real model would. Everything after the tool call is the real system (MCP, the gate, the guards).
 */

type Part = { type: string; text?: string; toolName?: string; output?: unknown; result?: unknown }
type Message = { role: string; content: unknown }

const text = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? (content as Part[]).map((part) => part.text ?? '').join('') : ''

function lastToolJson(prompt: Message[]): Record<string, any> | null {
  const tool = [...prompt].reverse().find((message) => message.role === 'tool')
  if (!tool || !Array.isArray(tool.content)) return null
  const part = (tool.content as Part[]).find((item) => item.type === 'tool-result')
  const output = (part?.output ?? part?.result) as { value?: unknown } | undefined
  const raw = (output && typeof output === 'object' && 'value' in output ? output.value : output) as unknown
  // The AI SDK hands MCP results back as a list of content parts; older shapes carry structuredContent directly.
  const parts = Array.isArray(raw) ? (raw as Array<{ text?: string }>) : ((raw as { content?: Array<{ text?: string }> } | undefined)?.content ?? [])
  const structured = (raw as { structuredContent?: unknown } | undefined)?.structuredContent
  if (structured) return structured as Record<string, any>
  const body = parts.find((item) => item.text)?.text
  try {
    return body ? (JSON.parse(body) as Record<string, any>) : null
  } catch {
    return null
  }
}

const dollarsIn = (message: string): number | null => {
  const found = /\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(message)
  return found ? Math.round(Number(found[1]!.replaceAll(',', '')) * 100) : null
}

const url = (message: string) => /https:\/\/\S+/.exec(message)?.[0]

export function demoModel(options: { delayMs?: number } = {}): AgentModel {
  let counter = 0
  const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } }
  const call = (name: string, input: Record<string, unknown>) => ({
    content: [{ type: 'tool-call', toolCallId: `demo-${(counter += 1)}`, toolName: name, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [],
  })
  const say = (words: string) => ({ content: [{ type: 'text', text: words }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] })

  const generate = (async (call_: { prompt: Message[] }) => {
      // A real model takes seconds. A little delay keeps the console's "thinking" states visible and testable.
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      const prompt = call_.prompt
      const system = prompt.filter((message) => message.role === 'system').map((message) => text(message.content)).join('\n')
      const user = [...prompt].reverse().find((message) => message.role === 'user')
      const message = text(user?.content)
      const seen = prompt.filter((item) => item.role === 'tool').length
      const result = lastToolJson(prompt)

      // The client's reviewer: accepts a delivery whose proof is a plausible https link, rejects a placeholder.
      if (system.includes('You review deliveries for')) {
        if (seen > 0) return say('Decided.')
        const proof = /<untrusted label="proof_url">\s*(\S+)/.exec(system)?.[1] ?? ''
        const dealId = /The deal is ([0-9a-f-]{36})/.exec(system)?.[1]
        const milestone = Number(/milestone number (\d+)/.exec(system)?.[1] ?? 0)
        const bad = /example\.com|localhost|bit\.ly|placeholder/i.test(proof)
        return call('decide_delivery', { dealId, milestone, decision: bad ? 'rejected' : 'accepted', note: bad ? 'That link does not look like the delivered work.' : 'The link points at the design file for this milestone.' })
      }

      // The policy reader and auditor. Stand-ins for the offline demo and the browser tests only: a real model does this
      // by reading, and the app does not use patterns like these anywhere. They answer in the shape the real ones do.
      if (system.includes('You read a company')) {
        if (seen > 0) return say('Classified.')
        const items = [...message.matchAll(/^\[(\d+)\] (.+)$/gm)].map((match) => {
          const line = match[2]!
          const kind = /ignore (all )?(the )?(previous|prior|above)|system administrator|^>/i.test(line) ? 'not_owners'
            : /manager|cfo|sign-?off/i.test(line) ? 'second_person'
            : /judg(e)?ment|reasonabl|fair/i.test(line) ? 'judgment'
            : /text message|within \d+ days|net \d+|notify/i.test(line) ? 'cannot_express'
            : line.split(/\s+/).length <= 3 && !/[$%\d]/.test(line) ? 'background' : 'rule'
          const reason = kind === 'rule' ? 'A rule the settings can carry out.' : kind === 'cannot_express' ? 'Mandate has no notification setting or payment-term clock.' : kind === 'judgment' ? 'This asks for judgment, which a gate cannot check.' : kind === 'second_person' ? 'This needs a second person to approve.' : kind === 'background' ? 'A heading.' : 'Not the owner speaking.'
          return { id: Number(match[1]), kind, reason }
        })
        return call('classify_policy', { items })
      }
      if (system.includes('You check a DRAFT')) {
        if (seen > 0) return say('Audited.')
        const sentences = [...message.matchAll(/^\[(\d+)\] (.+)$/gm)].map((match) => ({ id: Number(match[1]), text: match[2]! }))
        const factKeys = [...message.matchAll(/^- (\S+): /gm)].map((match) => match[1]!)
        const has = (key: string) => factKeys.find((candidate) => candidate === key || candidate.startsWith(key))
        const audited = sentences.map(({ id, text: line }) => {
          const money = /\$[\d,]+/.exec(line)?.[0]
          const cite = (fact: string | undefined, quote: string | undefined) => fact && quote ? { id, verdict: 'enforced', suspicious: false, evidence: [{ fact, quote }], gap: '' } : null
          return (money && /month/i.test(line) ? cite(has('monthlyCapCents'), money) : null)
            ?? (money && /single|per payment/i.test(line) ? cite(has('perPaymentCeilingCents'), money) : null)
            ?? (/priya|automatic/i.test(line) ? cite(has('standing:'), line.slice(0, Math.min(20, line.length))) : null)
            ?? (/link to the work|proof/i.test(line) ? cite(has('evidenceRequired'), /link to the work|proof/i.exec(line)?.[0]) : null)
            ?? { id, verdict: 'not_enforced', suspicious: /ignore/i.test(line), evidence: [], gap: 'Nothing in the rules carries this out.' }
        })
        const ids = sentences.map((item) => item.id)
        const changes = [...message.matchAll(/^(\d+)\. \((?:loosens|tightens|note)\)/gm)].map((match) => ({ change: Number(match[1]), supportedBy: ids }))
        return call('audit_policy', { sentences: audited, changes })
      }

      // The rules drafter: a few phrases, turned into the same kind of patch a real model would write. It only puts in
      // what the words ask for, which is what a faithful drafter does; the checker in the app is what catches an unfaithful one.
      if (system.includes('rules drafter for Mandate')) {
        if (seen > 0) return say('Drafted.')
        const lower = message.toLowerCase()
        const patch: Record<string, unknown> = { summary: 'That request is not about the rules, so nothing changes.' }
        const share = /(\d+(?:\.\d+)?)\s?%/.exec(message)
        const cap = /(?:never more than|at most|cap[^$]*|up to)\s*\$\s?([\d,]+)/i.exec(message)
        const days = /(\d+)\s*days?/i.exec(message)
        const autopay = /automatic|no tap|without a tap|pays? (?:priya|her|him)|paid when|60%|\d+%/.test(lower) && /priya/.test(lower)
        const notes: string[] = []
        if (autopay) {
          patch.standingRules = [{ payee: 'Priya Shah', clients: ['Northwind'], ...(share ? { sharePercent: Number(share[1]) } : {}) }]
          patch.autopilot = { payOnSettle: true, ...(/accept/.test(lower) ? { billSignedDeals: true, requireAcceptance: true } : {}), ...(days ? { remindUnpaidAfterDays: Number(days[1]), maxReminders: 2 } : {}) }
          notes.push('Priya will be paid from Northwind\'s signed-deal payments with no tap, as soon as the client pays.')
        }
        if (cap) {
          patch.monthlyCapDollars = Number(cap[1]!.replaceAll(',', ''))
          notes.push(`The monthly cap becomes $${cap[1]}.`)
        }
        if (notes.length > 0) patch.summary = notes.join(' ')
        return call('propose_rules', patch)
      }

      // Negotiators: the studio opens high, the client opens low, the studio settles at a fair price.
      if (system.includes('You negotiate for')) {
        const threadId = /threadId "([0-9a-f-]{36})"/.exec(system)?.[1]
        if (seen > 0) return say('Offer made.')
        const seller = system.includes('the seller')
        const earlier = (message.match(/^\d+\. /gm) ?? []).length
        const total = seller ? (earlier === 0 ? 45_000 : 30_000) : 20_000
        const half = total / 2
        return call('offer_deal', {
          buyer: 'Northwind',
          threadId,
          prompt: seller ? (earlier === 0 ? 'Our opening price for the spring-launch logo.' : 'Let us meet in the middle.') : 'This is what we can commit to.',
          terms: { scope: 'Spring launch logo', category: 'design', currency: 'USD', totalCents: total, proofRequired: true, milestones: [{ title: 'Concepts', amountCents: half }, { title: 'Final files', amountCents: half }] },
        })
      }

      // The clerk.
      if (seen === 0) {
        const lower = message.toLowerCase()
        if (/what|which|show|list|waiting|refused|why/.test(lower) && !/\bpay\b/.test(lower)) return call('list_ledger', { status: /refus/.test(lower) ? 'refused' : 'waiting' })
        if (/share/.test(lower) && /priya/.test(lower)) return call('get_jobs', {})
        const amount = dollarsIn(message)
        if (amount) {
          const payee = /p\.?\s?shah/i.test(message) ? 'P. Shah' : /priya/i.test(message) ? 'Priya' : /cafe|caf[eé]|lunch/i.test(message) ? 'Cafe Lila' : 'Unknown'
          return call('propose', {
            kind: 'payment', payee, amountCents: amount, currency: 'USD', category: /lunch/i.test(message) ? 'lunch' : 'design',
            description: message.split('\n')[0]!.slice(0, 120), evidenceUrl: url(message), prompt: message.slice(0, 500),
          })
        }
        return say('Tell me what to pay and to whom, for example: pay Priya her share for the Northwind logo milestone 1.')
      }
      if (seen === 1 && result && Array.isArray(result.jobs)) {
        const payment = result.payoutsPossibleFrom?.[0]
        return call('propose', {
          kind: 'payment', payee: 'Priya', amountCents: payment?.canStillFundCents ?? 9000, currency: 'USD', category: 'design',
          description: message.split('\n')[0]!.slice(0, 120), evidenceUrl: url(message), prompt: message.slice(0, 500),
          jobId: payment?.jobId, fundingCaptureId: payment?.captureId,
        })
      }
      // Say nothing, so the guard states the rules' answer in the rules' own words.
      return say('')
    }) as never
  const model = new MockLanguageModelV4({ doGenerate: generate as never, doStream: streamFromGenerate(generate as never, { chunkDelayMs: options.delayMs ? 25 : 0 }) as never })
  return { model: model as never, name: 'demo-script' }
}
