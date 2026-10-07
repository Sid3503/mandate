import type { WarrantBody } from '../domain/schemas'
import { checkIntent, INJECTION, MEANS, QUOTE_LINE, QUOTE_START, quantitiesIn, valuesIn } from './intent'

/**
 * Paste your written policy; see which sentences Mandate enforces.
 *
 * A company's spending policy is mostly prose. Some sentences are rules Mandate can carry out ("contractors may be paid
 * at most $2,000 a month"), some are things no gate can judge ("use good judgment"), some are background, and some may
 * not be the owner's at all (a forwarded email, text that tells the system to ignore its rules).
 *
 * Two passes, both plain code:
 *   plan    splits the text into sentences and sorts out what is NOT a rule: background, vague, someone else's. Only the
 *           sentences that could be rules go to the drafter, as numbered lines inside the owner's own request.
 *   assess  after the drafter has produced a draft, reads each sentence against the finished rules and says what holds,
 *           and what does not. A sentence is "covered" only when something concrete in it (a number, a person, a switch)
 *           is found in the draft. The model never decides what is covered.
 *
 * The model is not trusted with the verdict, for the same reason it is not trusted with `loosens`: the mistake that
 * matters is the reassuring one.
 */

export const POLICY_MAX_CHARS = 12_000
export const POLICY_MIN_CHARS = 20
export const POLICY_MAX_SENTENCES = 300
/** How many sentences go to the drafter at once. A longer policy is drafted in parts. */
export const POLICY_SEND_MAX = 40
const SEND_CHARS = 5_000

export type SentenceStatus =
  | 'covered' // something concrete in it is carried out by the draft
  | 'partly' // some of it is carried out and some is not
  | 'not_covered' // it reads like a rule, and nothing in the draft carries it out
  | 'unenforceable' // a person's judgment, not something a gate can check
  | 'context' // background, a heading, a statement of fact
  | 'untrusted' // not the owner's words, or an instruction aimed at the system
  | 'skipped' // left out because the policy is too long to draft at once

export type PolicySentence = {
  id: number
  text: string
  /** Where it sits in what was pasted, so the screen can point at it. */
  start: number
  end: number
  line: number
  status: SentenceStatus
  /** Plain reasons, in order. For a sentence that is covered these say what carries it out. */
  reasons: string[]
  /** Pieces of the rules that carry it out. */
  carriedBy: string[]
  /** Everything in it that is already true in the current rules, so signing the draft changes nothing for it. */
  already: boolean
}

export type PolicyPlan = {
  sentences: PolicySentence[]
  /** The numbered sentences the drafter is given. */
  instruction: string | null
  sent: number[]
}

const clean = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')

/** Judgment, taste and ethics: a person can follow these, a gate cannot check them. */
const VAGUE = /\b(good|sound|best|common|business|reasonable)\s+(judg(e)?ment|sense|faith|practices?|efforts?)\b|\buse (your |good )?(discretion|judg(e)?ment)\b|\bas (appropriate|needed|necessary|required|you see fit|deemed)\b|\breasonabl[ey]\b|\bappropriate(ly)?\b|\bwhere (possible|practical|feasible|appropriate)\b|\bbest efforts?\b|\btry to\b|\bwhen in doubt\b|\bif in doubt\b|\bsensible\b|\bunusual\b|\bsuspicious\b|\bintegrity\b|\bethic(s|al)\b|\bwe (value|believe|trust|expect)\b|\bin the spirit\b|\bculture\b|\bfair(ly)?\b|\bcareful(ly)?\b|\bresponsibl[ey]\b/i
/** A second person, a department, a record: things Mandate has no way to check. */
const HUMAN = /\b(manager|director|vp|cfo|ceo|controller|finance team|legal|counsel|compliance|hr|board|second (person|approver|reviewer)|two (people|approvers|signatures)|dual|countersign|co-?sign)\b[^.]{0,50}\b(approv|sign|review|authori[sz]|consent|sign-?off)|\b(approv|sign|review|authori[sz])\w*[^.]{0,30}\b(by|from) (a |the |your )?(manager|director|vp|cfo|controller|finance|legal|board)\b/i
const OUTSIDE = /\b(w-?9|w-?8|1099|tax(es)? form|vat|invoice number|purchase order|po number|background check|kyc|aml|sanctions|keep records?|retain|retention|audit(ed)? by|contract(s)? (is|are)? ?(signed|on file)|nda)\b/i
/** "Net 30", "within 30 days": Mandate has no payment-term clock. */
const TERMS = /\bnet[\s-]?\d+\b|\b(within|inside|no later than|by)\s+(\d+|one|two|three|four|five|seven|ten|fourteen|thirty)\s*(business |working |calendar )?(days?|weeks?)\b|\bon time\b|\bpromptly\b/i
/** A sentence that gives an instruction or a limit, as opposed to describing the company. */
const DIRECTIVE = /\b(must|may|can|cannot|can'?t|shall|should|will|won'?t|need(s)?|require[sd]?|allowed|permitted|not allowed|never|always|only|pay(s|ing|ment|ments|out|outs)?|paid|bill(s|ed|ing)?|invoice[sd]?|approv\w*|up to|at most|no more than|limit(ed)?|cap(ped)?|under|over|above|below|exceed\w*|proof|evidence|remind\w*|accept\w*)\b|[$%]/i

/** Wishes for a message to the owner: Mandate shows what needs you on Today and sends nothing. */
const NOTIFY = /\b(send|email|e-mail|text|sms|notify|alert|message|ping|tell|let|slack)\b[^.;]{0,25}\b(me|us|the owner|finance)\b|\bnotify\b|\bnotifications?\b|\bkeep me (posted|informed|updated)\b/i

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi

/** Splits what was pasted into sentences, keeping where each one sits. Headings and bullets are lines of their own. */
export function splitPolicy(raw: string): Array<{ text: string; start: number; end: number; line: number; heading: boolean; quoted: boolean }> {
  const text = clean(raw)
  const out: Array<{ text: string; start: number; end: number; line: number; heading: boolean; quoted: boolean }> = []
  let offset = 0
  let quoting = false
  const lines = text.split('\n')
  for (const [index, full] of lines.entries()) {
    const lineStart = offset
    offset += full.length + 1
    if (!full.trim()) continue
    if (QUOTE_START.test(full)) quoting = true
    const quoted = quoting || QUOTE_LINE.test(full)
    const lead = /^(\s*(?:[-*•–]|\d{1,2}[.)]|[a-z][.)])\s+|\s*#{1,6}\s+|\s*>+\s*)?/.exec(full)![0]
    const body = full.slice(lead.length)
    const plain = body.trim()
    const bodyStart = lineStart + lead.length + (body.length - body.trimStart().length)
    const heading = !quoted && (/:\s*$/.test(plain) || /^#{1,6}\s/.test(full.trim()) || (plain.split(/\s+/).length <= 6 && !/[.!?;$%\d]/.test(plain) && !/^\s*[-*•–]/.test(full)))
    let cursor = 0
    for (const part of plain.split(/(?<=[.!?;])\s+(?=[A-Z0-9"“(\[$])/)) {
      const at = plain.indexOf(part, cursor)
      cursor = at + part.length
      if (part.trim().length < 2) continue
      out.push({ text: part.trim(), start: bodyStart + at, end: bodyStart + at + part.length, line: index + 1, heading, quoted })
    }
  }
  return out
}

/** Names on the rules that a sentence mentions. */
function mentioned(sentence: string, rules: WarrantBody) {
  const says = (person: { displayName: string; email: string; aliases: string[] }) =>
    [person.displayName, person.email, ...person.aliases].some((name) => name && new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i').test(sentence))
  return { payees: rules.payees.filter(says), clients: rules.clients.filter(says) }
}

const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`

/** The first pass: what is a rule and what is not. Needs the current rules only to recognise names. */
export function planPolicy(raw: string, current: WarrantBody): PolicyPlan {
  const parts = splitPolicy(raw)
  const sentences: PolicySentence[] = parts.slice(0, POLICY_MAX_SENTENCES).map((part, index) => {
    const base = { id: index + 1, text: part.text, start: part.start, end: part.end, line: part.line, reasons: [] as string[], carriedBy: [] as string[], already: false }
    if (part.quoted || INJECTION.test(part.text)) return { ...base, status: 'untrusted' as const, reasons: [part.quoted ? 'This is quoted or forwarded text, not your own words. It was not sent to the model and changes nothing.' : 'This reads like an instruction to the system, not a rule about money. It was not sent to the model and changes nothing.'] }
    const who = mentioned(part.text, current)
    const concrete = quantitiesIn(part.text).length > 0 || (part.text.match(EMAIL)?.length ?? 0) > 0 || who.payees.length + who.clients.length > 0 || MEANS.reminders.test(part.text) || MEANS.billing.test(part.text) || MEANS.acceptance.test(part.text) || MEANS.noProof.test(part.text) || MEANS.noFunding.test(part.text) || /\b(proof|link to|evidence)\b/i.test(part.text)
    if (part.heading) return { ...base, status: 'context' as const, reasons: ['A heading. It says what comes next and asks for nothing.'] }
    if (HUMAN.test(part.text)) return { ...base, status: 'unenforceable' as const, reasons: ['This needs a second person to approve. Mandate has one owner, and does not model a manager or a second signature. It was not sent to the model, because turning a number from it into a limit could make the rules looser than the policy.'] }
    if (TERMS.test(part.text) && !quantitiesIn(part.text).some((quantity) => quantity.kind === 'money' || quantity.kind === 'percent') && who.payees.length === 0) return { ...base, status: 'unenforceable' as const, reasons: ['Mandate has no payment-term clock. It pays when the client pays or when you tap, not by a due date.'] }
    if (NOTIFY.test(part.text) && quantitiesIn(part.text).length === 0) return { ...base, status: 'unenforceable' as const, reasons: ['Mandate has no notification setting. It shows what needs you on the Today page, and nothing is sent to your inbox or phone.'] }
    if (!concrete && (VAGUE.test(part.text) || HUMAN.test(part.text) || OUTSIDE.test(part.text) || TERMS.test(part.text))) {
      const reason = HUMAN.test(part.text) ? 'This needs a second person to approve. Mandate has one owner, and does not model a manager or a second signature.' : OUTSIDE.test(part.text) ? 'This is about records, tax or checks outside the payment. Mandate does not verify it.' : TERMS.test(part.text) ? 'Mandate has no payment-term clock. It pays when the client pays or when you tap.' : 'This asks for judgment. A gate can check numbers, people and proof; it cannot check “reasonable” or “appropriate”. You still do that when you tap.'
      return { ...base, status: 'unenforceable' as const, reasons: [reason] }
    }
    if (!concrete && !DIRECTIVE.test(part.text)) return { ...base, status: 'context' as const, reasons: ['Background. It does not ask for anything a rule could check.'] }
    return { ...base, status: 'not_covered' as const }
  })
  // Candidates are provisional `not_covered` until the draft exists.
  const candidates = sentences.filter((item) => item.status === 'not_covered')
  const sent: number[] = []
  let size = 0
  for (const item of candidates) {
    if (sent.length >= POLICY_SEND_MAX || size + item.text.length + 8 > SEND_CHARS) {
      item.status = 'skipped'
      item.reasons = ['Too many rules in one paste to draft together. Paste the rest again after you have dealt with this draft.']
      continue
    }
    sent.push(item.id)
    size += item.text.length + 8
  }
  if (parts.length > POLICY_MAX_SENTENCES) {
    for (const [index, part] of parts.slice(POLICY_MAX_SENTENCES).entries()) sentences.push({ id: POLICY_MAX_SENTENCES + index + 1, text: part.text, start: part.start, end: part.end, line: part.line, status: 'skipped', reasons: ['Past the first 300 sentences. Paste the rest separately.'], carriedBy: [], already: false })
  }
  const instruction = sent.length === 0 ? null : `These sentences come from my company's written spending policy. Draft the rules that carry them out, and skip any that cannot be expressed.\n${sent.map((id) => `(${id}) ${sentences.find((item) => item.id === id)!.text}`).join('\n')}`
  return { sentences, instruction, sent }
}

type Item = { label: string; held: boolean; heldNow: boolean }

/** Which part of the rules a dollar amount in a sentence is about, from the words around it. */
function moneyField(clause: string): 'ceiling' | 'cap' | 'line' | null {
  if (/per (single )?(payment|invoice|transaction|request|expense|item)|single (payment|invoice|expense)|each (payment|invoice|expense)|every (payment|invoice)|ceiling|no (single )?(payment|invoice|expense)[^,.;]{0,20}(above|over|more)/i.test(clause)) return 'ceiling'
  if (/(per|a|each|every|in a|per calendar)\s+month|monthly|\bcap\b|budget|in total|altogether/i.test(clause)) return 'cap'
  if (/auto|without (a |any )?(tap|approval|sign)|no tap|no approval|(under|below|less than|up to)\b/i.test(clause)) return 'line'
  return null
}

const FIELD = {
  ceiling: { name: 'the per-payment ceiling', value: (r: WarrantBody) => r.perPaymentCeilingCents },
  cap: { name: 'the monthly cap', value: (r: WarrantBody) => r.monthlyCapCents },
  line: { name: 'the automatic line', value: (r: WarrantBody) => r.autoSettleUnderCents },
} as const

/** What in the rules carries out what a sentence says, and what it says that the rules do not hold. Pure. */
function read(sentence: string, rules: WarrantBody): { items: Array<{ label: string; held: boolean }>; missing: Array<{ phrase: string; why: string }> } {
  const items: Array<{ label: string; held: boolean }> = []
  const missing: Array<{ phrase: string; why: string }> = []
  const have = valuesIn(rules)
  const quantities = quantitiesIn(sentence)
  const who = mentioned(sentence, rules)
  const autopay = MEANS.autopay.test(sentence)

  for (const quantity of quantities) {
    if (quantity.kind === 'money') {
      const index = sentence.indexOf(quantity.phrase)
      const clause = (sentence.slice(0, index).split(/[,;]|\band\b|\bbut\b/).pop() ?? '') + sentence.slice(index).split(/[,;]|\band\b|\bbut\b/)[0]!
      const field = moneyField(clause)
      if (field) {
        const there = FIELD[field].value(rules)
        if (there === quantity.value) items.push({ label: `${FIELD[field].name} is ${money(there)}`, held: true })
        else if (have.money.has(quantity.value)) {
          const where = (Object.keys(FIELD) as Array<keyof typeof FIELD>).find((key) => FIELD[key].value(rules) === quantity.value)!
          missing.push({ phrase: quantity.phrase, why: `${money(quantity.value)} is in the rules, but as ${FIELD[where].name}. ${FIELD[field].name[0]!.toUpperCase()}${FIELD[field].name.slice(1)} is ${money(there)}.` })
        } else missing.push({ phrase: quantity.phrase, why: `Your policy says ${money(quantity.value)}, but ${FIELD[field].name} in the rules is ${money(there)}.` })
      } else if (have.money.has(quantity.value)) {
        const where = (Object.keys(FIELD) as Array<keyof typeof FIELD>).find((key) => FIELD[key].value(rules) === quantity.value)!
        items.push({ label: `${FIELD[where].name} is ${money(quantity.value)}`, held: true })
      }
    } else if (quantity.kind === 'percent') {
      if (have.percent.has(quantity.value)) {
        const rule = rules.standing.find((item) => (item.shareBps ?? rules.contractorShareBps) / 100 === quantity.value && (who.payees.length === 0 || who.payees.some((p) => p.id === item.payeeId)))
        const name = rule ? rules.payees.find((p) => p.id === rule.payeeId)?.displayName : null
        items.push({ label: name ? `${name}'s share is ${quantity.value}%` : `the contractor share is ${quantity.value}%`, held: true })
      }
    } else if (quantity.kind === 'days') {
      if (have.days.has(quantity.value) && !TERMS.test(sentence)) items.push({ label: `an unpaid invoice gets a reminder after ${quantity.value} days`, held: true })
    } else if (quantity.kind === 'count') {
      if (have.count.has(quantity.value)) items.push({ label: `at most ${quantity.value} reminders`, held: true })
    }
  }

  for (const email of sentence.match(EMAIL) ?? []) {
    const known = [...rules.payees, ...rules.clients].some((person) => person.email.toLowerCase() === email.toLowerCase())
    if (known) items.push({ label: `${email} is on the rules`, held: true })
    else missing.push({ phrase: email, why: `${email} is in your policy but not on the rules, so nobody can be paid or billed at that address.` })
  }

  if (/\b(proof|link to|evidence|receipt|screenshot)\b/i.test(sentence) && /\b(must|require[sd]?|need(s|ed)?|attach|include|provide|before)\b/i.test(sentence) && !MEANS.noProof.test(sentence)) {
    if (rules.evidenceRequired) items.push({ label: 'every request needs a link to the work', held: true })
    else missing.push({ phrase: 'proof of the work', why: 'Your policy asks for proof, but the rules do not require a link to the work.' })
  }
  if (MEANS.noProof.test(sentence)) {
    if (!rules.evidenceRequired) items.push({ label: 'a request does not need a link to the work', held: true })
    else missing.push({ phrase: 'no proof needed', why: 'Your policy drops the proof requirement, but the rules still ask for a link to the work.' })
  }
  if (/\bclient\b|\bcustomer\b/i.test(sentence) && /\b(has |have )?(paid|pays|payment|money|funds|settled)\b/i.test(sentence) && /\b(before|first|only after|until|unless|only when|only if)\b/i.test(sentence) && /\b(pay|payout|contractor|freelancer|designer)/i.test(sentence) && !MEANS.noFunding.test(sentence)) {
    if (rules.fundingRequired) items.push({ label: 'a contractor is paid only from a client payment that has settled', held: true })
    else missing.push({ phrase: 'client pays first', why: 'Your policy says the client pays first, but the rules let a contractor be paid without client money.' })
  }
  if (MEANS.noFunding.test(sentence)) {
    if (!rules.fundingRequired) items.push({ label: 'a contractor can be paid without a client payment behind it', held: true })
    else missing.push({ phrase: 'pay before the client', why: 'Your policy lets a contractor be paid before the client, but the rules still wait for client money.' })
  }
  if (/\b(accept|accepted|acceptance|sign(s|ed)? off)\b/i.test(sentence) && /\bclient|customer\b/i.test(sentence)) {
    if (rules.automation.billSignedDeals && rules.automation.requireAcceptance) items.push({ label: 'billing waits for the client’s agent to accept the delivery', held: true })
    else missing.push({ phrase: 'client accepts first', why: 'Your policy waits for the client to accept, but billing does not wait for the client’s agent in these rules.' })
  }
  if (/\b(invoice|bill)\w*\b/i.test(sentence) && /\b(automatic(ally)?|as soon as|once|when|after)\b/i.test(sentence) && /\b(deliver\w*|complet\w*|finish\w*|milestone|proof|work)\b/i.test(sentence) && !/\baccept/i.test(sentence)) {
    if (rules.automation.billSignedDeals) items.push({ label: 'a signed-deal milestone is invoiced when proof is attached', held: true })
    else missing.push({ phrase: 'bill when delivered', why: 'Your policy bills as soon as work is delivered, but autopilot billing is off in these rules.' })
  }
  if (MEANS.reminders.test(sentence) && /\bremind\w*|nudge|chase|follow.?up\b/i.test(sentence)) {
    if (rules.automation.remindUnpaidAfterDays !== null) items.push({ label: `unpaid invoices get PayPal’s reminder after ${rules.automation.remindUnpaidAfterDays} days`, held: true })
    else missing.push({ phrase: 'reminders', why: 'Your policy sends reminders, but no reminder schedule is in the rules.' })
  }
  if (who.payees.length > 0 && autopay && /\b(pay|paid|payout)/i.test(sentence)) {
    for (const person of who.payees) {
      const rule = rules.standing.find((item) => item.payeeId === person.id && (who.clients.length === 0 || who.clients.some((client) => item.clientIds.includes(client.id))))
      if (rule) items.push({ label: `${person.displayName} has a standing rule: paid with no tap${rule.requireDeal ? ', on signed deals' : ''}`, held: true })
      else missing.push({ phrase: `${person.displayName} paid automatically`, why: `Your policy pays ${person.displayName} without a tap, but no standing rule in the draft covers them${who.clients.length ? ` from ${who.clients.map((c) => c.displayName).join(' or ')}` : ''}.` })
    }
  }
  if (who.payees.length > 0 && !autopay && items.length === 0 && missing.length === 0) {
    for (const person of who.payees) items.push({ label: `${person.displayName} is a contractor on the rules`, held: true })
  }
  const known = rules.categories.filter((kind) => new RegExp(`\\b${kind.replace(/[^a-z0-9]/g, '.')}\\b`, 'i').test(sentence))
  for (const kind of known) if (/\b(allowed|permitted|only|covers?|eligible|may be paid for|work)\b/i.test(sentence)) items.push({ label: `“${kind}” is an allowed kind of work`, held: true })
  return { items, missing }
}

/**
 * The second pass: what the draft does with each sentence that was sent. Every claim here is found by code in the
 * finished rules; nothing is taken from the model's summary.
 */
export function assessPolicy(plan: PolicyPlan, current: WarrantBody, draft: WarrantBody): PolicySentence[] {
  return plan.sentences.map((item) => {
    if (!plan.sent.includes(item.id)) return item
    const now = read(item.text, draft)
    const before = read(item.text, current)
    const flags = new Map<string, string>()
    for (const miss of now.missing) flags.set(miss.phrase, miss.why)
    // Anything the intent check can name that the draft left out: a number held nowhere, a wish for notifications, a schedule, an expiry.
    for (const flag of checkIntent(item.text, current, draft).ignored) {
      if (flags.has(flag.phrase)) continue
      if (TERMS.test(item.text) && /\bdays?\b|\bweeks?\b/i.test(flag.phrase)) flags.set(flag.phrase, 'Mandate has no payment-term clock. It pays when the client pays or when you tap, not by a due date.')
      else flags.set(flag.phrase, flag.why)
    }
    const caveat = VAGUE.test(item.text) || HUMAN.test(item.text) ? ['Part of this asks for judgment or a second person. Mandate carries out only the concrete part.'] : []
    const carriedBy = [...new Set(now.items.map((entry) => entry.label))]
    const nowHeld = new Set(before.items.map((entry) => entry.label))
    const already = carriedBy.length > 0 && flags.size === 0 && carriedBy.every((label) => nowHeld.has(label))
    const missing = [...flags.values()]
    if (carriedBy.length > 0 && missing.length === 0) return { ...item, status: caveat.length ? ('partly' as const) : ('covered' as const), reasons: caveat, carriedBy, already }
    if (carriedBy.length > 0) return { ...item, status: 'partly' as const, reasons: [...missing, ...caveat], carriedBy, already: false }
    if (missing.length > 0) return { ...item, status: 'not_covered' as const, reasons: missing, carriedBy: [], already: false }
    return { ...item, status: 'not_covered' as const, reasons: ['It reads like a rule, but nothing in the draft carries it out. The model may have skipped it, or the rules have no place for it.'], carriedBy: [], already: false }
  })
}

export function countStatuses(sentences: PolicySentence[]): Record<SentenceStatus, number> {
  const counts: Record<SentenceStatus, number> = { covered: 0, partly: 0, not_covered: 0, unenforceable: 0, context: 0, untrusted: 0, skipped: 0 }
  for (const item of sentences) counts[item.status] += 1
  return counts
}
