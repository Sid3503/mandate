import { MockLanguageModelV4 } from 'ai/test'
import type { AgentModel } from '../agents/model'

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

  const model = new MockLanguageModelV4({
    doGenerate: (async (call_: { prompt: Message[] }) => {
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
        const proof = /The proof it gave: (\S+)/.exec(system)?.[1] ?? ''
        const dealId = /The deal is ([0-9a-f-]{36})/.exec(system)?.[1]
        const milestone = Number(/milestone number (\d+)/.exec(system)?.[1] ?? 0)
        const bad = /example\.com|localhost|bit\.ly|placeholder/i.test(proof)
        return call('decide_delivery', { dealId, milestone, decision: bad ? 'rejected' : 'accepted', note: bad ? 'That link does not look like the delivered work.' : 'The link points at the design file for this milestone.' })
      }

      // The rules drafter: a few phrases, turned into the same patch a real model would write.
      if (system.includes('rules drafter for Mandate')) {
        if (seen > 0) return say('Drafted.')
        const lower = message.toLowerCase()
        if (/automatic|no tap|without a tap|paid when/.test(lower) && /priya/.test(lower)) {
          return call('propose_rules', { summary: 'Priya will be paid from Northwind\'s signed-deal payments with no tap, as soon as the client pays.', standingRules: [{ payee: 'Priya Shah', clients: ['Northwind'] }], autopilot: { payOnSettle: true, billSignedDeals: true, remindUnpaidAfterDays: 3, maxReminders: 2 } })
        }
        const cap = /cap[^$]*\$\s?([\d,]+)/.exec(message)
        if (cap) return call('propose_rules', { summary: `The monthly cap becomes $${cap[1]}.`, monthlyCapDollars: Number(cap[1]!.replaceAll(',', '')) })
        return call('propose_rules', { summary: 'That request is not about the rules, so nothing changes.' })
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
    }) as never,
  })
  return { model: model as never, name: 'demo-script' }
}
