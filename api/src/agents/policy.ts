import type { WarrantBody } from '../domain/schemas'
import { compareRules } from './drafter'
import type { IntentFlag } from './intent'

/**
 * Paste your written policy; see which sentences Mandate enforces.
 *
 * What the language model does: every judgment about meaning. It reads each sentence and says what kind it is (a rule,
 * a matter of judgment, someone else's words, something Mandate cannot express); a second model call reads the finished
 * draft and says, sentence by sentence, whether the rules carry it out and why, and whether each change in the draft
 * is something the policy asked for.
 *
 * What code does here, and only this: cut the text into numbered pieces (formatting, no meaning), write the rules out as
 * an exact list of facts, and CHECK the model's claims against that list. A claim that cites a rule that does not exist,
 * or quotes words that are not in the sentence, is thrown out. A sentence the model did not answer for is never assumed
 * to be fine. None of this decides what a sentence means, so none of it can be wrong in a clever way; it can only refuse
 * to believe something that points at nothing.
 */

export const POLICY_MAX_CHARS = 12_000
export const POLICY_MIN_CHARS = 20
export const POLICY_MAX_SENTENCES = 300
/** How many sentences go to the drafter at once. A longer policy is drafted in parts. */
export const POLICY_SEND_MAX = 40
/** How many sentences one reader call is given. Chunks are read in parallel. */
export const READ_CHUNK = 80
const SEND_CHARS = 5_000

export type SentenceKind = 'rule' | 'cannot_express' | 'judgment' | 'second_person' | 'background' | 'not_owners'

export type SentenceStatus =
  | 'covered' // the draft carries it out, and the claim was checked against the rules
  | 'partly' // some of it is carried out
  | 'not_covered' // it asks for something Mandate could not or did not carry out
  | 'unenforceable' // a person's judgment, or a second person
  | 'context' // background, a heading, a fact
  | 'untrusted' // not the owner's words, or aimed at the system
  | 'skipped' // left for later because the paste is long
  | 'unchecked' // nobody could say: the model did not answer for it

export type Segment = { id: number; text: string; start: number; end: number; line: number }

export type PolicySentence = {
  id: number
  text: string
  start: number
  end: number
  line: number
  status: SentenceStatus
  /** Plain reasons. Empty for a sentence carried out exactly; otherwise they say what is not carried out, or how the rules are narrower than the sentence. */
  reasons: string[]
  /** Pieces of the rules that carry it out, each tied to the words in the sentence it answers. Every one was checked. */
  carriedBy: string[]
  /** Everything it asks for is already true in the live rules, so signing the draft changes nothing for it. */
  already: boolean
}

const clean = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')

/**
 * Cuts the pasted text into numbered pieces: one per line, then one per sentence. This is formatting. It does not decide
 * what anything means; the model is shown the pieces with their neighbours and says what each one is.
 */
export function segmentPolicy(raw: string): Segment[] {
  const text = clean(raw)
  const out: Segment[] = []
  let offset = 0
  for (const [index, full] of text.split('\n').entries()) {
    const lineStart = offset
    offset += full.length + 1
    if (!full.trim()) continue
    const lead = /^(\s*(?:[-*•–]|\d{1,2}[.)]|[a-z][.)])\s+|\s*#{1,6}\s+|\s*>+\s*)?/.exec(full)![0]
    const body = full.slice(lead.length)
    const plain = body.trim()
    const bodyStart = lineStart + lead.length + (body.length - body.trimStart().length)
    let cursor = 0
    for (const part of plain.split(/(?<=[.!?;])\s+(?=[A-Z0-9"“(\[$])/)) {
      const at = plain.indexOf(part, cursor)
      cursor = at + part.length
      if (part.trim().length < 2) continue
      out.push({ id: out.length + 1, text: part.trim(), start: bodyStart + at, end: bodyStart + at + part.length, line: index + 1 })
    }
  }
  return out
}

// ---------- the rules, written out exactly ----------

export type Fact = { key: string; label: string; value: string }

const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const yes = (on: boolean) => (on ? 'yes' : 'no')

/**
 * Every setting in the rules as a labelled fact with a stable key. The model cites keys; code looks them up. The list is
 * exhaustive on purpose (a test checks it covers every field), so "the rules have no place for this" is a claim about
 * this list and can be checked against it.
 */
export function factsOf(body: WarrantBody): Fact[] {
  const name = (id: string) => [...body.payees, ...body.clients].find((party) => party.id === id)?.displayName ?? id
  const facts: Fact[] = [
    { key: 'autoSettleUnderCents', label: 'the automatic line (a request under this needs no tap)', value: money(body.autoSettleUnderCents) },
    { key: 'monthlyCapCents', label: 'the monthly contractor cap', value: money(body.monthlyCapCents) },
    { key: 'perPaymentCeilingCents', label: 'the per-payment ceiling (no single payment above it)', value: money(body.perPaymentCeilingCents) },
    { key: 'contractorShareBps', label: 'the most of a client payment contractors can receive', value: `${body.contractorShareBps / 100}%` },
    { key: 'evidenceRequired', label: 'every request needs an https link to the work', value: yes(body.evidenceRequired) },
    { key: 'fundingRequired', label: 'a contractor is paid only from a client payment that has settled', value: yes(body.fundingRequired) },
    { key: 'categories', label: 'the allowed kinds of work', value: body.categories.join(', ') || 'none' },
    { key: 'currency', label: 'the currency', value: body.currency },
    { key: 'timezone', label: 'the time zone the month is counted in', value: body.timezone },
    { key: 'automation.billSignedDeals', label: 'autopilot bills a signed-deal milestone with no tap once proof is attached', value: yes(body.automation.billSignedDeals) },
    { key: 'automation.requireAcceptance', label: 'billing waits for the client\'s agent to accept the delivery', value: yes(body.automation.requireAcceptance) },
    { key: 'automation.payOnSettle', label: 'autopilot pays contractors when a client payment settles', value: yes(body.automation.payOnSettle) },
    { key: 'automation.remindUnpaidAfterDays', label: 'an unpaid invoice gets PayPal\'s reminder after this many days', value: body.automation.remindUnpaidAfterDays === null ? 'off' : `${body.automation.remindUnpaidAfterDays} days` },
    { key: 'automation.maxReminders', label: 'the most reminders for one invoice', value: String(body.automation.maxReminders) },
  ]
  for (const person of body.payees) facts.push({ key: `payee:${person.id}`, label: `${person.displayName} can be paid`, value: person.email })
  for (const person of body.clients) facts.push({ key: `client:${person.id}`, label: `${person.displayName} can be billed`, value: person.email })
  for (const rule of body.standing) {
    const share = rule.shareBps !== undefined ? `, share ${rule.shareBps / 100}%` : ''
    facts.push({ key: `standing:${rule.id}`, label: `standing rule: ${name(rule.payeeId)} is paid with no tap from ${rule.clientIds.map(name).join(' or ')}`, value: `${rule.requireDeal ? 'signed deals only' : 'any payment'}${share}` })
  }
  return facts
}

/** The facts that are new or different in the draft. Exact comparison of the two lists. */
export function changedKeys(current: WarrantBody, draft: WarrantBody): Set<string> {
  const before = new Map(factsOf(current).map((fact) => [fact.key, fact.value]))
  return new Set(factsOf(draft).filter((fact) => before.get(fact.key) !== fact.value).map((fact) => fact.key))
}

export type Change = { n: number; kind: 'loosens' | 'tightens' | 'note'; text: string }

/** Every change the draft makes, as numbered sentences, from the exact comparison of the two sets of rules. */
export function listChanges(current: WarrantBody, draft: WarrantBody): Change[] {
  const { loosens, tightens, notes } = compareRules(current, draft)
  return [
    ...loosens.map((text) => ({ kind: 'loosens' as const, text })),
    ...tightens.map((text) => ({ kind: 'tightens' as const, text })),
    ...notes.map((text) => ({ kind: 'note' as const, text })),
  ].map((item, index) => ({ n: index + 1, ...item }))
}

// ---------- checking what the model claims ----------

/** Quotes are compared without case, extra spaces or curly quotes: the check is "are these the words?", not "are they typed the same?". */
const flat = (text: string) => text.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()
export const inSentence = (quote: string, sentence: string) => flat(quote).length > 0 && flat(sentence).includes(flat(quote))

/** The ids a reader must answer for are exactly the ids it was shown, each once. Returns a complaint, or null. */
export function checkReader(shown: number[], answered: number[]): string | null {
  const seen = new Set<number>()
  const dupes: number[] = []
  for (const id of answered) { if (seen.has(id)) dupes.push(id); seen.add(id) }
  const missing = shown.filter((id) => !seen.has(id))
  const unknown = [...seen].filter((id) => !shown.includes(id))
  const parts = [
    missing.length ? `you left out ids ${missing.slice(0, 20).join(', ')}` : '',
    unknown.length ? `ids ${unknown.slice(0, 20).join(', ')} were never shown to you` : '',
    dupes.length ? `ids ${[...new Set(dupes)].slice(0, 20).join(', ')} appear more than once` : '',
  ].filter(Boolean)
  return parts.length ? `${parts.join('; ')}. Answer for every id exactly once.` : null
}

export type AuditedSentence = {
  id: number
  verdict: 'enforced' | 'partly' | 'not_enforced'
  suspicious: boolean
  evidence: Array<{ fact: string; quote: string }>
  gap: string
}

export type Grounded = { id: number; status: 'covered' | 'partly' | 'not_covered' | 'untrusted'; reasons: string[]; carriedBy: string[]; already: boolean }

/**
 * Keeps a verdict only as far as it points at something real. "Enforced" or "partly" needs at least one piece of
 * evidence that names a fact that exists, quotes words that are in the sentence. With none, the claim is not believed.
 * Whether a cited fact really satisfies the sentence is the model's judgment, and is shown to the owner next to the words
 * it answers so they can see it.
 */
export function groundSentence(entry: AuditedSentence, text: string, facts: Fact[], changed: Set<string>): Grounded {
  const byKey = new Map(facts.map((fact) => [fact.key, fact]))
  if (entry.suspicious) return { id: entry.id, status: 'untrusted', reasons: [entry.gap || 'A second reading judged this to be an instruction to the system, not a rule about money. It has no effect.'], carriedBy: [], already: false }
  const real = entry.evidence.filter((item) => byKey.has(item.fact) && inSentence(item.quote, text))
  const carriedBy = [...new Set(real.map((item) => { const fact = byKey.get(item.fact)!; return `“${item.quote.trim()}” → ${fact.label} is ${fact.value}` }))]
  const already = real.length > 0 && real.every((item) => !changed.has(item.fact))
  const dropped = entry.evidence.length - real.length
  if (entry.verdict === 'not_enforced' || real.length === 0) {
    const reasons = entry.gap ? [entry.gap] : []
    if (entry.verdict !== 'not_enforced') reasons.push(dropped > 0 ? 'The reading said this was carried out but pointed at nothing in the rules that exists, so it was not believed.' : 'The reading said this was carried out but pointed at nothing in the rules, so it was not believed.')
    if (reasons.length === 0) reasons.push('Nothing in the draft carries this out.')
    return { id: entry.id, status: 'not_covered', reasons, carriedBy: [], already: false }
  }
  if (entry.verdict === 'partly') return { id: entry.id, status: 'partly', reasons: entry.gap ? [entry.gap] : ['Only part of this is carried out.'], carriedBy, already: false }
  return { id: entry.id, status: 'covered', reasons: entry.gap ? [entry.gap] : [], carriedBy, already }
}

export type ChangeSupport = { change: number; supportedBy: number[] }

/**
 * Changes in the draft that no sentence of the policy asked for. A change the audit did not mention counts as unsupported,
 * and so does one supported only by a sentence that was set aside. Fail closed: silence is not support.
 */
export function unsupportedChanges(changes: Change[], support: ChangeSupport[], usable: Set<number>): Change[] {
  const by = new Map(support.map((item) => [item.change, item.supportedBy.filter((id) => usable.has(id))]))
  return changes.filter((change) => (by.get(change.n) ?? []).length === 0)
}

// ---------- what is sent to the drafter ----------

export function sendable(segments: Segment[], kinds: Map<number, SentenceKind>): { sent: Segment[]; skipped: Segment[] } {
  const sent: Segment[] = []
  const skipped: Segment[] = []
  let size = 0
  for (const segment of segments) {
    if (kinds.get(segment.id) !== 'rule') continue
    if (sent.length >= POLICY_SEND_MAX || size + segment.text.length + 8 > SEND_CHARS) { skipped.push(segment); continue }
    sent.push(segment)
    size += segment.text.length + 8
  }
  return { sent, skipped }
}

export function instructionFor(sent: Segment[]): string | null {
  return sent.length === 0 ? null : `These sentences come from my company's written spending policy. Draft the rules that carry them out, and skip any that cannot be expressed.\n${sent.map((segment) => `(${segment.id}) ${segment.text}`).join('\n')}`
}

export function countStatuses(sentences: PolicySentence[]): Record<SentenceStatus, number> {
  const counts: Record<SentenceStatus, number> = { covered: 0, partly: 0, not_covered: 0, unenforceable: 0, context: 0, untrusted: 0, skipped: 0, unchecked: 0 }
  for (const item of sentences) counts[item.status] += 1
  return counts
}

// ---------- putting the answers together ----------

/** Every sentence with what the reader said about it. Sentences the reader never answered for are unchecked, not fine. */
export function firstPass(all: Segment[], read: Map<number, { kind: SentenceKind; reason: string }>, skipped: Set<number>): PolicySentence[] {
  return all.map((segment): PolicySentence => {
    const answer = read.get(segment.id)
    const base = { id: segment.id, text: segment.text, start: segment.start, end: segment.end, line: segment.line, carriedBy: [] as string[], already: false }
    if (skipped.has(segment.id)) return { ...base, status: 'skipped', reasons: ['Too many rules in one paste to draft together. Paste the rest again after you have dealt with this draft.'] }
    if (!answer) return { ...base, status: 'unchecked', reasons: ['The model did not answer for this sentence, so nothing is claimed about it.'] }
    switch (answer.kind) {
      case 'judgment': case 'second_person': return { ...base, status: 'unenforceable', reasons: [answer.reason] }
      case 'background': return { ...base, status: 'context', reasons: [answer.reason] }
      case 'not_owners': return { ...base, status: 'untrusted', reasons: [`${answer.reason} It was not sent to the drafter and changes nothing.`] }
      case 'cannot_express': return { ...base, status: 'not_covered', reasons: [answer.reason] }
      case 'rule': return { ...base, status: 'unchecked', reasons: [] }
    }
  })
}

export type AuditResult = { sentences: AuditedSentence[]; changes: ChangeSupport[]; facts: Fact[]; changed: Set<string>; changeList: Change[] }

/**
 * Settles the sentences that were sent to the drafter, using the audit, and returns the changes nobody asked for.
 * With no audit, every sent sentence is unchecked and the draft is flagged: silence is never taken for approval.
 */
export function applyAudit(sentences: PolicySentence[], sent: Segment[], audit: AuditResult | null): IntentFlag[] {
  const byId = new Map(sentences.map((item) => [item.id, item]))
  for (const segment of sent) {
    const row = byId.get(segment.id)!
    if (!audit) { row.status = 'unchecked'; row.reasons = ['The draft could not be checked against this sentence. Read the draft yourself before you sign it.']; continue }
    const entry = audit.sentences.find((item) => item.id === segment.id)
    if (!entry) { row.status = 'unchecked'; row.reasons = ['The audit did not answer for this sentence, so nothing is claimed about it.']; continue }
    const grounded = groundSentence(entry, segment.text, audit.facts, audit.changed)
    Object.assign(row, { status: grounded.status, reasons: grounded.reasons, carriedBy: grounded.carriedBy, already: grounded.already })
  }
  if (!audit) return [{ phrase: 'This draft could not be checked against your policy', why: 'The second reading failed, so nobody has confirmed that each change was asked for. Read every change below before you sign.' }]
  const usable = new Set(sent.map((item) => item.id).filter((id) => byId.get(id)!.status !== 'untrusted'))
  return unsupportedChanges(audit.changeList, audit.changes, usable).map((change) => ({ phrase: change.text, why: 'No sentence of your policy asks for this. The drafter added it.' }))
}
