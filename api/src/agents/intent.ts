import type { WarrantBody } from '../domain/schemas'

/**
 * Did the draft say what the owner said? Decided by code, never by the model.
 *
 * A model that turns words into rules can fail in two quiet ways. It can DROP something the owner asked for, and the
 * rule still looks fine. Or it can ADD something the owner never asked for, and the rule looks fine. This file reads
 * the owner's sentence and the finished rules and reports both:
 *
 *   ignored (amber)  something in the words that no part of the rules carries out
 *   added   (red)    something in the rules that nothing in the words asked for
 *
 * It is deliberately plain: numbers, percentages, days, counts, emails, and a short list of phrases that mean a
 * particular switch. It will miss a cleverly worded request, and it says so when it cannot tell; what it must never do
 * is call a draft faithful when a number or a switch in it came from nowhere.
 */

export type IntentFlag = { phrase: string; why: string }
export type IntentReport = {
  ignored: IntentFlag[]
  added: IntentFlag[]
  /** Parts of the message that look like someone else's instructions (a forwarded note, a quote, "ignore the rules"). They were not treated as the owner's. */
  untrusted: string[]
  checked: number
}

type Quantity = { kind: 'money' | 'percent' | 'days' | 'count'; value: number; phrase: string }

const WORD_NUMBERS: Record<string, number> = { one: 1, once: 1, two: 2, twice: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14, thirty: 30 }

/** The numbers the owner wrote, with what kind of thing each one is. */
export function quantitiesIn(words: string): Quantity[] {
  const out: Quantity[] = []
  const seen = new Set<string>()
  const add = (quantity: Quantity) => {
    const key = `${quantity.kind}:${quantity.value}:${quantity.phrase}`
    if (!seen.has(key)) { seen.add(key); out.push(quantity) }
  }
  for (const match of words.matchAll(/\$\s?([\d,]+(?:\.\d+)?)\s?(k\b)?/gi)) {
    const value = Number(match[1]!.replaceAll(',', '')) * (match[2] ? 1000 : 1)
    if (Number.isFinite(value)) add({ kind: 'money', value: Math.round(value * 100), phrase: match[0].trim() })
  }
  for (const match of words.matchAll(/(\d+(?:\.\d+)?)\s?(?:%|percent\b)/gi)) add({ kind: 'percent', value: Number(match[1]), phrase: match[0].trim() })
  for (const match of words.matchAll(/(\d+|one|two|three|four|five|six|seven|ten|fourteen|thirty)\s*(?:-\s*)?(days?|weeks?)\b/gi)) {
    const n = /\d/.test(match[1]!) ? Number(match[1]) : WORD_NUMBERS[match[1]!.toLowerCase()]!
    add({ kind: 'days', value: /week/i.test(match[2]!) ? n * 7 : n, phrase: match[0].trim() })
  }
  // "once" is left out on purpose: in "once Northwind pays" and "at once" it is not a count.
  for (const match of words.matchAll(/(\d+|one|two|three|four|five)\s*(?:times|x)\b|\b(twice)\b/gi)) {
    const token = (match[1] ?? match[2])!.toLowerCase()
    const n = /\d/.test(token) ? Number(token) : WORD_NUMBERS[token]!
    add({ kind: 'count', value: n, phrase: match[0].trim() })
  }
  return out
}

/** Every number the finished rules hold, by kind. */
function valuesIn(rules: WarrantBody) {
  return {
    money: new Set([rules.autoSettleUnderCents, rules.monthlyCapCents, rules.perPaymentCeilingCents]),
    percent: new Set([rules.contractorShareBps / 100, ...rules.standing.map((rule) => (rule.shareBps ?? rules.contractorShareBps) / 100)]),
    days: new Set(rules.automation.remindUnpaidAfterDays ? [rules.automation.remindUnpaidAfterDays] : []),
    count: new Set(rules.automation.remindUnpaidAfterDays ? [rules.automation.maxReminders] : []),
  }
}

const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`

/** Phrases that mean a switch, so a switch turned on without any of them is the model's own idea. */
const MEANS = {
  autopay: /automatic|no tap|without (a |any )?(tap|approval)|no approval|don'?t (need|have) to (tap|approve)|straight away|right away|as soon as|(when|once|after|whenever) .{0,40}(pays|paid|payment|settles)|pay(s|ing)? .{0,40}(share|%|percent)|from now on|always pay/i,
  payOnSettle: /(as soon as|when|once|after|whenever) .{0,40}(pays|paid|payment|settles|settled)|automatic|no tap|without (a |any )?(tap|approval)|straight away|right away/i,
  billing: /\bbill|invoice|deliver|milestone|send .{0,20}(client|them) .{0,20}(invoice|bill)/i,
  acceptance: /accept|sign(s|ed)? off|approve[sd]? (it|the (work|delivery))|confirm|review|happy with|satisf|seen the work|look(s|ed)? (at|over) (it|the work)/i,
  reminders: /remind|nudge|chase|follow.?up|unpaid|overdue|late/i,
  noProof: /no proof|without proof|(don'?t|do not|no longer|doesn'?t|does not) (need|require|want|ask for)[^.;]{0,24}(proof|link)|drop[^.;]{0,24}(proof|link)|skip (the )?(proof|link)|proof (is )?optional|no link/i,
  noFunding: /before (the )?client (has )?(paid|pays)|without (the )?client (money|paying|payment)|don'?t wait for (the )?client|pay (them )?first/i,
}

/** Wishes that mean "I want to look first". A standing rule pays without asking, so these cannot be kept alongside one. */
const WANTS_A_LOOK = /\b(only after|not until|until|unless|before)\b[^.;,]{0,40}\b(I|me|my)\b[^.;,]{0,40}\b(see|seen|look|review|check|approve|ok|okay|sign off|confirm|happy)\b|\bafter (I|i) (have |'ve )?(seen|checked|reviewed|approved|looked)|\b(I|i) (want|need|'d like) to (see|check|review|approve|look)|\bask me (first|before)|\bneeds? my (ok|okay|approval|tap|sign.?off)\b/i

/**
 * The parts of a message that are not the owner speaking: a forwarded note, a quoted line, text that tells the rules
 * to be ignored. Whatever these say, they cannot be what the owner asked for, so a change that only they support is
 * reported as added by the model.
 */
export function splitUntrusted(message: string): { trusted: string; untrusted: string[] } {
  const untrusted: string[] = []
  const kept: string[] = []
  let quoting = false
  for (const line of message.split('\n')) {
    if (/^\s*(fwd?:|forwarded message|begin forwarded|-{3,}|_{3,}|on .{5,60} wrote:)/i.test(line)) quoting = true
    if (quoting || /^\s*>/.test(line) || /^\s*(system|assistant|developer)\s*:/i.test(line)) {
      if (line.trim()) untrusted.push(line.trim())
      continue
    }
    const sentences = line.split(/(?<=[.!?])\s+/)
    const good: string[] = []
    for (const sentence of sentences) {
      if (/\b(ignore|disregard|forget|override|bypass)\b[^.!?]{0,40}\b(previous|prior|above|earlier|all|your|the|these|owner'?s?)\b[^.!?]{0,30}\b(instructions?|rules?|limits?|checks?|caps?)\b|\bsystem (override|prompt|message)\b|\bnew instructions?\b/i.test(sentence)) untrusted.push(sentence.trim())
      else good.push(sentence)
    }
    if (good.length) kept.push(good.join(' '))
  }
  return { trusted: kept.join('\n'), untrusted }
}

/** Compares what the owner wrote with the rules the draft produced. */
export function checkIntent(message: string, before: WarrantBody, after: WarrantBody): IntentReport {
  const { trusted: words, untrusted } = splitUntrusted(message)
  const ignored: IntentFlag[] = []
  const added: IntentFlag[] = []
  const wanted = quantitiesIn(words)
  const has = valuesIn(after)
  const hadBefore = valuesIn(before)
  let checked = 0

  // 1. A number the owner wrote that no part of the rules holds.
  for (const quantity of wanted) {
    checked += 1
    const pool = has[quantity.kind] as Set<number>
    if (pool.has(quantity.value)) continue
    const shown = quantity.kind === 'money' ? dollars(quantity.value) : quantity.kind === 'percent' ? `${quantity.value}%` : quantity.kind === 'days' ? `${quantity.value} days` : `${quantity.value} times`
    const what = quantity.kind === 'money' ? 'The rules have no place for a fixed amount like this, only limits (the automatic line, the monthly cap, the per-payment ceiling).' : quantity.kind === 'percent' ? 'No share in the rules is this.' : quantity.kind === 'days' ? 'No reminder schedule in the rules uses this.' : 'No reminder limit in the rules is this.'
    ignored.push({ phrase: quantity.phrase, why: `${shown} is in your words but in none of the rules. ${what}` })
  }

  // 2. A number in the rules that changed, and that the owner never wrote.
  const wrote = (kind: Quantity['kind'], value: number) => wanted.some((quantity) => quantity.kind === kind && quantity.value === value)
  const numbers: Array<[string, 'money' | 'percent' | 'days' | 'count', number, number]> = [
    ['The automatic line', 'money', before.autoSettleUnderCents, after.autoSettleUnderCents],
    ['The monthly contractor cap', 'money', before.monthlyCapCents, after.monthlyCapCents],
    ['The per-payment ceiling', 'money', before.perPaymentCeilingCents, after.perPaymentCeilingCents],
    ['The contractor share', 'percent', before.contractorShareBps / 100, after.contractorShareBps / 100],
    ['The reminder delay', 'days', before.automation.remindUnpaidAfterDays ?? 0, after.automation.remindUnpaidAfterDays ?? 0],
    ['The reminder limit', 'count', before.automation.maxReminders, after.automation.maxReminders],
  ]
  for (const [label, kind, was, now] of numbers) {
    if (was === now || (kind === 'days' && now === 0) || (kind === 'count' && after.automation.remindUnpaidAfterDays === null)) continue
    checked += 1
    if (!wrote(kind, now)) {
      const shown = kind === 'money' ? dollars(now) : kind === 'percent' ? `${now}%` : kind === 'days' ? `${now} days` : `${now}`
      const wasShown = kind === 'money' ? dollars(was) : kind === 'percent' ? `${was}%` : kind === 'days' ? (was ? `${was} days` : 'off') : `${was}`
      added.push({ phrase: `${label}: ${wasShown} → ${shown}`, why: `You did not write ${shown}. The model chose it.` })
    }
  }
  for (const rule of after.standing) {
    const previous = before.standing.find((item) => item.id === rule.id || (item.payeeId === rule.payeeId && item.clientIds.join() === rule.clientIds.join()))
    if (rule.shareBps !== undefined && rule.shareBps !== previous?.shareBps) {
      checked += 1
      if (!wrote('percent', rule.shareBps / 100)) added.push({ phrase: `A ${rule.shareBps / 100}% share for ${[...after.payees].find((p) => p.id === rule.payeeId)?.displayName ?? rule.payeeId}`, why: `You did not write ${rule.shareBps / 100}%. The model chose it.` })
    }
  }
  void hadBefore

  // 3. A switch turned on, and nothing in the words that means it.
  const turnedOn = (now: boolean, was: boolean) => now && !was
  const wantedNothing = (label: string, pattern: RegExp, why: string) => {
    checked += 1
    if (!pattern.test(words)) added.push({ phrase: label, why })
  }
  const newStanding = after.standing.filter((rule) => !before.standing.some((item) => item.id === rule.id || (item.payeeId === rule.payeeId && item.clientIds.join() === rule.clientIds.join())))
  for (const rule of newStanding) {
    const person = after.payees.find((p) => p.id === rule.payeeId)
    wantedNothing(`A standing rule: ${person?.displayName ?? rule.payeeId} is paid with no tap`, MEANS.autopay, 'Nothing in your words asks for payouts to go without a tap.')
    if (!rule.requireDeal) wantedNothing('The standing rule works on any payment, not only signed deals', /any payment|not (only )?(just )?(signed )?deals?|without a deal|no deal/i, 'You did not say it should work without a signed deal.')
  }
  if (turnedOn(after.automation.billSignedDeals, before.automation.billSignedDeals)) wantedNothing('Autopilot bills signed-deal milestones when work is delivered', MEANS.billing, 'Nothing in your words asks for billing to be automatic.')
  if (turnedOn(after.automation.requireAcceptance, before.automation.requireAcceptance)) wantedNothing('Billing waits for the client’s agent to accept', MEANS.acceptance, 'Nothing in your words asks to wait for the client.')
  if (turnedOn(after.automation.payOnSettle, before.automation.payOnSettle)) wantedNothing('Contractors are paid as soon as a client payment settles', MEANS.payOnSettle, 'Nothing in your words asks for contractors to be paid automatically.')
  if (after.automation.remindUnpaidAfterDays !== null && before.automation.remindUnpaidAfterDays === null) wantedNothing('Unpaid invoices get reminders', MEANS.reminders, 'Nothing in your words asks for reminders.')
  if (before.evidenceRequired && !after.evidenceRequired) wantedNothing('Requests would no longer need a link to the work', MEANS.noProof, 'You did not ask to drop the proof requirement.')
  if (before.fundingRequired && !after.fundingRequired) wantedNothing('Contractors could be paid before the client has paid', MEANS.noFunding, 'You did not ask to drop the rule that the client pays first.')
  for (const category of after.categories.filter((item) => !before.categories.includes(item))) wantedNothing(`“${category}” becomes an allowed kind of work`, new RegExp(`\\b${category.replace(/[^a-z0-9]/g, '.')}\\b`, 'i'), `You did not mention ${category}.`)
  for (const person of [...after.payees.filter((p) => !before.payees.some((q) => q.id === p.id)), ...after.clients.filter((p) => !before.clients.some((q) => q.id === p.id))]) {
    wantedNothing(`${person.displayName} (${person.email}) is added`, new RegExp(`${person.email.replace(/[.+*?^${}()|[\]\\]/g, '\\$&')}|\\b${person.displayName.split(/\s+/)[0]!.toLowerCase()}\\b`, 'i'), 'Nothing in your words names this person.')
  }

  // 4. A wish the words made, in a form the rules cannot keep.
  const look = WANTS_A_LOOK.exec(words)
  if (look && after.standing.length > 0) {
    checked += 1
    const clause = words.split(/(?<=[.;])\s+|,\s*(?=and |but |then )/).find((part) => WANTS_A_LOOK.test(part))?.trim() ?? look[0]
    ignored.push({ phrase: clause, why: 'A payout covered by a standing rule is sent without asking you, so a wish to look first cannot be kept beside one. To keep your tap, do not sign a standing rule for it, or make the client’s agent accept the delivery first.' })
  }

  // 5. A switch the words clearly asked for and the draft left off.
  const asked = (pattern: RegExp) => pattern.test(words)
  if (asked(/\bremind|nudge|chase|follow.?up\b/i) && after.automation.remindUnpaidAfterDays === null) { checked += 1; ignored.push({ phrase: 'reminders', why: 'You asked for reminders, but no reminder schedule is in the rules.' }) }
  if (asked(/\b(accept|sign(s|ed)? off)\b/i) && /client|northwind|customer/i.test(words) && !after.automation.requireAcceptance) { checked += 1; ignored.push({ phrase: 'the client accepting', why: 'You asked for the client to accept first, but billing does not wait for the client’s agent in these rules.' }) }
  if (asked(/\b(automatic(ally)?|no tap|without (a |any )?(tap|approval))\b/i) && after.standing.length === 0 && !after.automation.billSignedDeals && after.autoSettleUnderCents === before.autoSettleUnderCents) { checked += 1; ignored.push({ phrase: 'automatic payment', why: 'You asked for something to happen without a tap, but no standing rule or switch in the rules does that.' }) }

  // 6. Wishes the rules have no way to carry out at all.
  const notify = /\b(email|e-mail|text|sms|notify|alert|message|ping|slack)\b[^.;]{0,20}\b(me|us)\b|\bnotify\b|\bkeep me (posted|informed|updated)\b/i.exec(words)
  if (notify) { checked += 1; ignored.push({ phrase: notify[0], why: 'Mandate has no notification setting. It shows what needs you on the Today page, and nothing is sent to your inbox.' }) }
  const schedule = /\b(on|every|each)\s+(mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|weekdays?|weekends?|mornings?|evenings?)\b|\bat \d{1,2}\s?(am|pm)\b/i.exec(words)
  if (schedule) { checked += 1; ignored.push({ phrase: schedule[0], why: 'The rules have no day-of-week or time-of-day setting. Reminders go out after a number of days, not on a chosen day.' }) }
  const expiry = /\b(until (the )?(end|\d|january|february|march|april|may|june|july|august|september|october|november|december)|for the next \d+|for \d+\s*(weeks?|months?)|stop (this|it|them)?\s*(at|on|after)|end of the (month|week|year|job|project)|expires?)\b/i.exec(words)
  if (expiry) { checked += 1; ignored.push({ phrase: expiry[0], why: 'A rule has no end date. It stays until a newer version replaces it, so it will not switch off by itself.' }) }

  return { ignored: dedupe(ignored), added: dedupe(added), untrusted, checked }
}

const dedupe = (flags: IntentFlag[]) => flags.filter((flag, index) => flags.findIndex((other) => other.phrase === flag.phrase) === index)

/**
 * The rules, said back as sentences with a worked example, so the owner can check them against what they meant
 * without reading a diff. Pure arithmetic on the finished rules.
 */
export function readBack(rules: WarrantBody, exampleCents: number): string[] {
  const name = (id: string) => [...rules.payees, ...rules.clients].find((party) => party.id === id)?.displayName ?? id
  const lines: string[] = []
  const example = dollars(exampleCents)
  for (const rule of rules.standing) {
    const share = (rule.shareBps ?? rules.contractorShareBps) / 100
    const cents = Math.floor((exampleCents * (rule.shareBps ?? rules.contractorShareBps)) / 10_000)
    const client = rule.clientIds.map(name).join(' or ')
    const gate = rules.automation.requireAcceptance && rules.automation.billSignedDeals ? ' The client’s agent must accept the delivery before the invoice goes out.' : ''
    lines.push(`When ${client} pays ${example}${rule.requireDeal ? ' on a signed deal' : ''}, ${name(rule.payeeId)} gets ${dollars(cents)} (${share}%) with no tap from you${rules.automation.payOnSettle ? ', the moment the payment settles' : ', when someone asks for it'}.${gate}`)
  }
  if (rules.standing.length === 0) lines.push(`Every payout to a contractor needs your tap, unless it is under ${dollars(rules.autoSettleUnderCents)}.`)
  lines.push(`Anything under ${dollars(rules.autoSettleUnderCents)} that fits the rules goes with no tap; ${dollars(rules.autoSettleUnderCents)} and above waits for you unless a standing rule covers it.`)
  lines.push(`Contractors can be paid at most ${dollars(rules.monthlyCapCents)} a month, and no single payment can be above ${dollars(rules.perPaymentCeilingCents)}. After that, requests are refused until the month rolls over.`)
  if (rules.automation.billSignedDeals) lines.push(rules.automation.requireAcceptance ? 'A milestone is invoiced only after the client’s own agent has accepted the delivery.' : 'A milestone is invoiced as soon as proof of the work is attached.')
  if (rules.automation.remindUnpaidAfterDays) lines.push(`An invoice still unpaid after ${rules.automation.remindUnpaidAfterDays} days gets PayPal’s reminder, at most ${rules.automation.maxReminders} times.`)
  if (!rules.evidenceRequired) lines.push('A request does not need a link to the work.')
  if (!rules.fundingRequired) lines.push('A contractor can be paid without a client payment behind it.')
  return lines
}
