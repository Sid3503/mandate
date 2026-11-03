import { z } from 'zod'
import { MAX_DUE_DAYS, MAX_LINE_ITEMS, ProposalCreateSchema, stripMarkup, type ProposalCreate, type WarrantBody } from '../domain/schemas'
import type { AgentModel } from './model'
import { callTool } from './structured'

/**
 * Notes to invoice: messy client notes in, a LOCAL DRAFT of a bill out. Nothing here files anything or touches PayPal.
 *
 * The honesty rules, all tested:
 *   - A price, quantity, client, date or link that is not in the notes is never made up. It goes into `missing`.
 *   - A bare number with no currency mark is not a price. The draft says it saw one and left it alone.
 *   - A currency other than the rules' is kept as written and warned about. It is never converted.
 *   - Markup is stripped from every word that came from the notes.
 *   - The total is computed from the items, or the draft says it cannot be.
 *   - An amount over the owner's limits is NOT blocked here. It is previewed, and the verdict says what the gate would do.
 *
 * The deterministic reader below always runs. A language model, when there is one, may re-read the notes for better
 * wording of the lines, but every number and word it returns is checked against the notes and thrown away if the notes
 * do not contain it. Dates, links, clients, categories and jobs are never taken from a model.
 */

export type DraftItem = { description: string; quantity: number; unitCents: number | null }
export type DraftVerdict = { gate: string; clause: string; detail: string; /** False while required fields are still missing: the verdict is for what is filled in so far. */ complete: boolean }
export type InvoiceDraft = {
  client: { id: string; name: string; matchedBy: 'email' | 'name' } | null
  lineItems: DraftItem[]
  /** Cents, or null when any line has no price in the notes. */
  totalCents: number | null
  dueDate: string | null
  currency: string
  customerNote: string | null
  jobId: string | null
  category: string | null
  evidenceUrl: string | null
  /** Fields the notes did not give: client, price, description, dueDate, jobId, category, evidenceUrl. */
  missing: string[]
  warnings: string[]
  verdict: DraftVerdict | null
  /** `model`: the lines were re-read by the model and every number checked. `rules`: read by the deterministic rules alone. */
  source: 'model' | 'rules'
}

export type DraftInput = {
  notes: string
  warrant: WarrantBody
  now: Date
  model?: AgentModel | null
  /** The gate's pure preview (tryRequest). Absent: no verdict. */
  preview?: (request: ProposalCreate) => { gate: string; clause: string; detail: string }
  /** Called with the model's real token use, so the daily budget stays true. */
  onUsage?: (usage: { inputTokens: number | undefined; outputTokens: number | undefined }) => void
}

const CODES = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'MXN', 'BRL', 'SGD', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'ZAR', 'AED', 'HKD']
const CODE_ALT = CODES.join('|')
const SYMBOLS: Record<string, string> = { '$': 'USD', 'US$': 'USD', 'A$': 'AUD', 'C$': 'CAD', '€': 'EUR', '£': 'GBP', '₹': 'INR', '¥': 'JPY', 'RS': 'INR', 'RS.': 'INR' }
const WORDS: Record<string, string> = { dollar: 'USD', dollars: 'USD', bucks: 'USD', euro: 'EUR', euros: 'EUR', pound: 'GBP', pounds: 'GBP', rupee: 'INR', rupees: 'INR', rs: 'INR' }

// One amount: an optional code or symbol in front, digits (with thousands commas and up to two decimals), an optional k, an optional code or word after.
const PRICE = new RegExp(`(?:\\b(${CODE_ALT})\\s*)?(US\\$|A\\$|C\\$|Rs\\.?|[$€£₹¥])?\\s*(\\d{1,3}(?:,\\d{3})+|\\d+)(\\.\\d{1,2})?(k\\b)?(?:\\s*(?:\\/\\s*\\w+)?\\s*(${CODE_ALT}|dollars?|bucks|euros?|pounds?|rupees?)\\b)?(\\s*(?:\\/\\s*(?:ea|each|unit|hr|hour|item|piece|day|page)\\b))?`, 'gi')

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const DAY = 86_400_000

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const startOfDay = (now: Date) => Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)
const realDate = (year: number, month: number, day: number): number | null => {
  const ms = Date.UTC(year, month - 1, day)
  const d = new Date(ms)
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? ms : null
}
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whole cents from the digits as written, without floating point. */
function toCents(whole: string, fraction: string | undefined, thousands: boolean): number {
  const dollars = Number(whole.replace(/,/g, '')) * (thousands ? 1000 : 1)
  const cents = fraction ? Number((fraction.slice(1) + '0').slice(0, 2)) * (thousands ? 1000 : 1) : 0
  return dollars * 100 + cents
}

type Found = { start: number; end: number; cents: number; currency: string | null; each: boolean }

/** Every amount that carries a currency mark. Bare numbers are returned separately and are never treated as prices. */
function findAmounts(text: string): { priced: Found[]; bare: string[] } {
  const priced: Found[] = []
  const bare: string[] = []
  for (const match of text.matchAll(PRICE)) {
    const [whole, codeBefore, symbol, digits, fraction, k, suffix, per] = [match[0], match[1], match[2], match[3]!, match[4], match[5], match[6], match[7]]
    const currency = codeBefore ? codeBefore.toUpperCase() : symbol ? SYMBOLS[symbol.toUpperCase()] ?? null : suffix ? (CODES.includes(suffix.toUpperCase()) ? suffix.toUpperCase() : WORDS[suffix.toLowerCase()] ?? null) : null
    if (!currency) { bare.push(digits.replace(/,/g, '') + (fraction ?? '')); continue }
    const index = match.index ?? 0
    const cents = toCents(digits, fraction, false) * (k ? 1000 : 1)
    priced.push({ start: index, end: index + whole.length, cents, currency, each: Boolean(per) })
  }
  return { priced, bare }
}

/** A due date from the notes, or null. `phrase` is the text that was read, so it can be taken out of the notes afterwards. */
function findDue(text: string, now: Date): { date: string | null; phrase: string | null; warning: string | null } {
  const today = startOfDay(now)
  const none = { date: null, phrase: null, warning: null }
  const pick = (ms: number | null, phrase: string) => {
    if (ms === null) return { date: null, phrase, warning: `“${phrase.trim()}” is not a real calendar date, so no due date was set.` }
    if (ms < today) return { date: null, phrase, warning: `The due date “${phrase.trim()}” is in the past, so no due date was set.` }
    if (ms > today + MAX_DUE_DAYS * DAY) return { date: null, phrase, warning: `The due date “${phrase.trim()}” is more than a year away, so no due date was set.` }
    return { date: iso(ms), phrase, warning: null }
  }
  let m = /\bnet[\s-]*(\d{1,3})\b(?:\s*days?)?/i.exec(text)
  if (m) return pick(today + Number(m[1]) * DAY, m[0])
  m = /\b(?:due|payable|pay(?:ment)?(?:\s+is)?\s+due)\s+(?:in|within)\s+(\d{1,3})\s*(day|week|month)s?\b/i.exec(text) ?? /\b(?:payable|pay)\s+(?:in|within)\s+(\d{1,3})\s*(day|week|month)s?\b/i.exec(text) ?? /\bwithin\s+(\d{1,3})\s*(day|week|month)s?\b/i.exec(text)
  if (m) {
    const n = Number(m[1])
    const unit = m[2]!.toLowerCase()
    return pick(today + n * (unit === 'week' ? 7 : unit === 'month' ? 30 : 1) * DAY, m[0])
  }
  m = /\bdue\s+(?:on\s+)?(\d{4})-(\d{2})-(\d{2})\b/i.exec(text)
  if (m) return pick(realDate(Number(m[1]), Number(m[2]), Number(m[3])), m[0])
  m = /\bdue\s+(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/i.exec(text)
  if (m) {
    // Month first, the way the rules' currency writes dates. A date that already passed this year means next year.
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : now.getUTCFullYear()
    let ms = realDate(year, Number(m[1]), Number(m[2]))
    if (ms !== null && ms < today && !m[3]) ms = realDate(year + 1, Number(m[1]), Number(m[2]))
    return pick(ms, m[0])
  }
  const monthName = `(${MONTHS.join('|')})[a-z]*\\.?`
  m = new RegExp(`\\bdue\\s+(?:on\\s+)?${monthName}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`, 'i').exec(text)
  if (m) {
    const month = MONTHS.indexOf(m[1]!.toLowerCase()) + 1
    const year = m[3] ? Number(m[3]) : now.getUTCFullYear()
    let ms = realDate(year, month, Number(m[2]))
    if (ms !== null && ms < today && !m[3]) ms = realDate(year + 1, month, Number(m[2]))
    return pick(ms, m[0])
  }
  m = new RegExp(`\\bdue\\s+(?:on\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+${monthName}(?:,?\\s*(\\d{4}))?\\b`, 'i').exec(text)
  if (m) {
    const month = MONTHS.indexOf(m[2]!.toLowerCase()) + 1
    const year = m[3] ? Number(m[3]) : now.getUTCFullYear()
    let ms = realDate(year, month, Number(m[1]))
    if (ms !== null && ms < today && !m[3]) ms = realDate(year + 1, month, Number(m[1]))
    return pick(ms, m[0])
  }
  m = /\bdue\s+(tomorrow|today|next week|end of (?:the )?month|(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b/i.exec(text)
  if (m) {
    const word = m[1]!.toLowerCase()
    if (word === 'tomorrow') return pick(today + DAY, m[0])
    if (word === 'today') return pick(today, m[0])
    if (word === 'next week') return pick(today + 7 * DAY, m[0])
    if (word.startsWith('end of')) return pick(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0), m[0])
    const target = WEEKDAYS.indexOf(m[2]!.toLowerCase())
    const ahead = ((target - new Date(today).getUTCDay() + 7) % 7) || 7
    return pick(today + ahead * DAY, m[0])
  }
  return none
}

const VERB = /^\s*(?:(?:please|kindly)\s+)?(?:(?:can|could|would)\s+you\s+)?(?:(?:create|make|draft|raise|write|prepare|send|issue)\s+(?:an?\s+|the\s+)?(?:invoice|bill)\s+(?:to|for)\s+|(?:bill|invoice|charge)\s+)/i
const GREETING = /^\s*(?:hey|hi|hello|yo)\b[^,.:\n]{0,40}[,:]\s*/i
const TRAILING_DIRECTIVE = /\s*(?:\band\s+)?(?:(?:send|email|mail|forward)(?:\s+(?:it|this|the\s+invoice|invoice))?(?:\s+(?:to|at))?|in|proof|evidence|see|link|here(?:'s| is)|screenshot|category|job|due|net)\s*[:,-]?\s*$/i

const clean = (value: string) => value.replace(/\s+/g, ' ').replace(/^[\s:;,.\-–—@]+|[\s:;,.\-–—@]+$/g, '').trim()

type Parsed = Omit<InvoiceDraft, 'verdict' | 'source'> & { amountsInNotes: number[]; numbersInNotes: number[] }

/** The deterministic reader. It is the whole of Notes-to-invoice when there is no model, and the check on it when there is. */
export function parseNotes(rawNotes: string, warrant: WarrantBody, now: Date): Parsed {
  const warnings: string[] = []
  const missing: string[] = []
  // `<name@host>` is how mail clients write an address. Keep it before whole tags are dropped.
  let text = rawNotes.replace(/<([^\s<>@]+@[^\s<>]+)>/g, ' $1 ')
  const stripped = stripMarkup(text)
  if (stripped !== text.trim()) warnings.push('Markup was removed from the notes.')
  text = stripped.replace(GREETING, '')

  // Links and addresses first, so their digits are never read as money.
  const urls = [...text.matchAll(/https?:\/\/[^\s<>)"']+/gi)].map((m) => m[0].replace(/[.,;:!?]+$/, ''))
  text = text.replace(/https?:\/\/[^\s<>)"']+/gi, ' ')
  const emails = [...text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((m) => m[0])
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ')
  const https = urls.filter((url) => /^https:\/\//i.test(url))
  const evidenceUrl = https[0] ?? null
  if (!evidenceUrl && urls.length > 0) warnings.push('The link in the notes is not https, and a bill needs an https link to the work.')
  if (https.length > 1) warnings.push(`The notes have ${https.length} links. The first one is used as the proof of work.`)

  // Explicit fields.
  let customerNote: string | null = null
  const note = /(?:^|[\s.;,])(?:customer\s+)?(?:note|message)\s*[:=]\s*([^\n]+)/i.exec(text)
  if (note) {
    customerNote = clean(note[1]!) || null
    text = text.replace(note[0], ' ')
  }
  let jobId: string | null = null
  const job = /\bjob(?:\s*id)?\s*[:#=]?\s*([a-z0-9][a-z0-9_-]{0,63})\b/i.exec(text) ?? /\b(job_[a-z0-9_-]{1,59})\b/i.exec(text)
  if (job && /\d|_|-/.test(job[1]!)) {
    jobId = job[1]!.toLowerCase()
    text = text.replace(job[0], ' ')
  }
  let category: string | null = null
  const cat = /(?:\bcategory|\bcat)\s*[:=]?\s*([a-z][a-z0-9_-]{0,31})\b/i.exec(text) ?? /(?:^|\s)#([a-z][a-z0-9_-]{0,31})\b/i.exec(text)
  if (cat) {
    const wanted = cat[1]!.toLowerCase()
    if (warrant.categories.includes(wanted)) category = wanted
    else warnings.push(`“${wanted}” is not one of the allowed kinds of work (${warrant.categories.join(', ')}).`)
    text = text.replace(cat[0], ' ')
  }

  // Due date.
  const due = findDue(text, now)
  if (due.phrase) text = text.replace(due.phrase, ' ')
  if (due.warning) warnings.push(due.warning)

  // Client: an address on the rules wins over a name.
  const clients = warrant.clients
  let client: InvoiceDraft['client'] = null
  const byEmail = clients.filter((c) => emails.some((e) => e.toLowerCase() === c.email.toLowerCase()))
  if (byEmail.length === 1) client = { id: byEmail[0]!.id, name: byEmail[0]!.displayName, matchedBy: 'email' }
  let clientHint: string | null = null
  let clientNameFound: string | null = null
  if (!client) {
    const hits = clients.filter((c) => [c.displayName, ...c.aliases].some((name) => new RegExp(`(?<![\\w])${escape(name)}(?![\\w])`, 'i').test(text)))
    if (hits.length === 1) {
      client = { id: hits[0]!.id, name: hits[0]!.displayName, matchedBy: 'name' }
    } else if (hits.length > 1) {
      warnings.push(`The notes name more than one client (${hits.map((c) => c.displayName).join(', ')}), so none was picked.`)
    }
  }
  if (client) {
    const c = clients.find((item) => item.id === client!.id)!
    clientNameFound = [c.displayName, ...c.aliases].sort((a, b) => b.length - a.length).find((name) => new RegExp(`(?<![\\w])${escape(name)}(?![\\w])`, 'i').test(text)) ?? null
  }
  if (!client) {
    for (const email of emails) if (!clients.some((c) => c.email.toLowerCase() === email.toLowerCase())) warnings.push(`${email} is not a client address on your rules, so it did not pick a client.`)
  }

  // Currency, over the whole text.
  const all = findAmounts(text)
  const seen = [...new Set(all.priced.map((p) => p.currency!))]
  const named = [...text.matchAll(new RegExp(`\\bin\\s+(${CODE_ALT})\\b`, 'gi'))].map((m) => m[1]!.toUpperCase())
  const currencies = [...new Set([...seen, ...named])]
  const foreign = currencies.filter((code) => code !== warrant.currency)
  let currency = warrant.currency
  if (foreign.length > 0) {
    currency = foreign[0]!
    warnings.push(`Mandate bills in ${warrant.currency} only. The notes say ${foreign.join(', ')}${foreign.length > 1 || currencies.length > foreign.length ? ' (more than one currency)' : ''}. Nothing was converted, so the gate will refuse this unless you change the amounts to ${warrant.currency}.`)
  }
  text = text.replace(new RegExp(`\\bin\\s+(?:${CODE_ALT})\\b`, 'gi'), ' ')

  // Pieces: a sentence, a line, a semicolon or a comma followed by a space.
  const pieces = text.split(/[;\n]+|\.(?=\s|$)|,(?=\s)/).map((piece) => piece.trim()).filter(Boolean)
  const items: DraftItem[] = []
  const quantitiesRead: string[] = []
  let leftoverBare: string[] = []
  let firstPiece = true
  for (const piece of pieces) {
    const verb = VERB.exec(piece)
    const withVerb = Boolean(verb)
    let body = verb ? piece.slice(verb[0].length) : piece
    if (clientNameFound) body = body.replace(new RegExp(`(?<![\\w])${escape(clientNameFound)}(?![\\w])`, 'i'), ' ')
    body = body.replace(/\b(?:to|for)\s+client\b|\bclient\s*:/gi, ' ')
    const amounts = findAmounts(body)
    firstPiece = false
    if (amounts.priced.length === 0) {
      // A piece with no price. It may still say what the bill is for ("bill Northwind for the logo tweaks").
      const forWhat = /^(?:\s*(?:for|of)\s+)(.+)$/i.exec(body)
      if (withVerb && forWhat && items.length === 0) {
        const description = clean(stripMarkup(forWhat[1]!).replace(TRAILING_DIRECTIVE, ''))
        if (description) items.push({ description, quantity: 1, unitCents: null })
      }
      leftoverBare.push(...amounts.bare)
      continue
    }
    // Several amounts in one piece: split at "and", "plus", "+", "&" between them.
    const parts = amounts.priced.length > 1 ? splitAmounts(body, amounts.priced) : [body]
    if (parts === null) {
      warnings.push(`“${clean(body).slice(0, 80)}” has several amounts and I could not tell which line each belongs to. Add them by hand.`)
      continue
    }
    for (const part of parts) {
      const found = findAmounts(part)
      if (found.priced.length !== 1) { warnings.push(`“${clean(part).slice(0, 80)}” has more than one amount, so no line was made from it.`); continue }
      const price = found.priced[0]!
      const before = part.slice(0, price.start)
      let rest = (before + ' ' + part.slice(price.end)).replace(/\s+/g, ' ')
      let quantity = 1
      let quantityKind: 'none' | 'times' | 'word' = 'none'
      const timesBefore = /(\d{1,3})\s*[x×]\s*$/i.exec(before)
      let qm: RegExpExecArray | null = null
      if (timesBefore) {
        quantity = Number(timesBefore[1])
        quantityKind = 'times'
        rest = (before.slice(0, timesBefore.index) + ' ' + part.slice(price.end)).replace(/\s+/g, ' ')
      } else if ((qm = /(?:^|\s)(\d{1,3})\s*[x×]\s+(?=\S)/i.exec(rest))) {
        quantity = Number(qm[1]); quantityKind = 'times'; rest = rest.replace(qm[0], ' ')
      } else if ((qm = /(?:^|[\s(])[x×]\s*(\d{1,3})\b/i.exec(rest))) {
        quantity = Number(qm[1]); quantityKind = 'word'; rest = rest.replace(qm[0], ' ')
      } else if ((qm = /(?:^|\s)(\d{1,3})\s*(?:units?|pcs|pieces|hours?|hrs?|items?|days?|pages?|revisions?|licen[sc]es?)\b/i.exec(rest))) {
        quantity = Number(qm[1]); quantityKind = 'word'; rest = rest.replace(qm[0], ' ')
      }
      if (qm) quantitiesRead.push(String(quantity))
      if (timesBefore) quantitiesRead.push(String(quantity))
      // Leftover bare digits are only reported when no price was found anywhere.
      leftoverBare.push(...findAmounts(rest).bare)
      const eachWord = /\b(?:each|per|ea)\b|@/i.test(rest) || price.each
      let unitCents: number | null = price.cents
      if (quantity > 1 && quantityKind !== 'times' && !eachWord) {
        // "logo x3 $120": is $120 each or the total? Reading it as the total never bills more than the notes say.
        if (price.cents % quantity === 0) {
          unitCents = price.cents / quantity
          warnings.push(`I read ${fmt(price.cents)} as the total for ${quantity}, so ${fmt(unitCents)} each. If it is the price of each, change the unit price.`)
        } else {
          warnings.push(`I could not split ${fmt(price.cents)} evenly over ${quantity}, so it is one line of 1. Change the quantity and unit price if you meant ${quantity}.`)
          quantity = 1
        }
      }
      rest = rest.replace(/\b(?:each|per|ea)\b|@/gi, ' ')
      // The words before a price, when the sentence began "bill X <price> for Y": X is the client's name as written.
      let description = ''
      const forAfter = /(?:^|\s)(?:for|of)\s+(.+)$/i.exec(part.slice(price.end))
      if (withVerb && forAfter && !client && clean(before).length > 0 && items.length === 0 && !clientHint) {
        clientHint = clean(before.replace(/\b(?:to|for)\b\s*$/i, ''))
        description = clean(forAfter[1]!)
      } else {
        description = clean(rest.replace(/^\s*(?:for|of|on|at|plus|and|also|&|\+)\s+/i, '').replace(/\s+(?:for|of|at|plus|and|also|&|\+)\s*$/i, ''))
      }
      description = clean(stripMarkup(description).replace(/^(?:for|of|on|and|plus|total)\b\s*:?\s*/i, '').replace(TRAILING_DIRECTIVE, ''))
      if (price.cents <= 0 || price.cents > 100_000_000) { warnings.push(`${fmt(price.cents)} is outside what a bill can hold, so no line was made from it.`); continue }
      if (quantity > 999) { warnings.push('A quantity over 999 is not allowed, so no line was made from it.'); continue }
      items.push({ description: description.slice(0, 200), quantity, unitCents })
    }
  }
  void firstPiece

  // A client hint is only reported when nothing on the rules matched it.
  if (!client && clientHint) warnings.push(`“${clientHint}” is not a client on your rules. Mandate can only bill a client you have added.`)

  const items20 = items.slice(0, MAX_LINE_ITEMS)
  if (items.length > MAX_LINE_ITEMS) warnings.push(`A bill holds at most ${MAX_LINE_ITEMS} lines, so only the first ${MAX_LINE_ITEMS} were kept.`)
  if (!client) missing.push('client')
  if (items20.length === 0 || items20.some((item) => item.unitCents === null)) {
    missing.push('price')
    const bareSeen = [...new Set(leftoverBare.filter((n) => !quantitiesRead.includes(n)))]
    if (bareSeen.length > 0 && all.priced.length === 0) warnings.push(`I saw ${bareSeen.slice(0, 3).join(', ')} but no currency mark (like $), so I did not treat it as a price.`)
  }
  if (items20.length === 0 || items20.some((item) => !item.description)) missing.push('description')
  if (!due.date) missing.push('dueDate')
  if (!jobId) missing.push('jobId')
  if (!category) missing.push('category')
  if (!evidenceUrl) missing.push('evidenceUrl')

  const priced = items20.every((item) => item.unitCents !== null) && items20.length > 0
  const totalCents = priced ? items20.reduce((sum, item) => sum + item.quantity * item.unitCents!, 0) : null
  if (!priced) warnings.push('The total cannot be worked out until every line has a price.')
  else if (totalCents! > 100_000_000) warnings.push('The total is more than a bill can hold.')

  return {
    client,
    lineItems: items20,
    totalCents,
    dueDate: due.date,
    currency,
    customerNote,
    jobId,
    category,
    evidenceUrl,
    missing,
    warnings,
    amountsInNotes: all.priced.map((p) => p.cents),
    numbersInNotes: [...text.matchAll(/\d+/g)].map((m) => Number(m[0])),
  }
}

const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`

/** Splits a piece with several amounts into one part per amount at "and", "plus", "+", "&". Null when it cannot be done cleanly. */
function splitAmounts(body: string, priced: Found[]): string[] | null {
  const parts: string[] = []
  let from = 0
  for (let i = 0; i < priced.length - 1; i += 1) {
    const gap = body.slice(priced[i]!.end, priced[i + 1]!.start)
    const cut = /\s+(?:and|plus|also)\s+|\s*[+&]\s*/i.exec(gap)
    if (!cut) return null
    const at = priced[i]!.end + (cut.index ?? 0)
    parts.push(body.slice(from, at))
    from = at + cut[0].length
  }
  parts.push(body.slice(from))
  return parts
}

const ModelSchema = z.object({
  items: z.array(z.object({
    description: z.string().min(1).max(200),
    quantity: z.number().int().min(1).max(999),
    unitPrice: z.number().positive().max(1_000_000),
  })).min(1).max(MAX_LINE_ITEMS),
})

/** Why the model's lines cannot be trusted, or null when every number and word is in the notes. */
function unsupported(value: z.infer<typeof ModelSchema>, notes: string, parsed: Parsed): string | null {
  const lower = notes.toLowerCase()
  for (const item of value.items) {
    const unit = Math.round(item.unitPrice * 100)
    if (!parsed.amountsInNotes.includes(unit) && !parsed.amountsInNotes.includes(unit * item.quantity)) return `the price ${item.unitPrice} for “${item.description}” is not an amount in the notes.`
    if (item.quantity > 1 && !parsed.numbersInNotes.includes(item.quantity)) return `the quantity ${item.quantity} is not in the notes.`
    const words = stripMarkup(item.description).toLowerCase().match(/[a-z0-9]{4,}/g) ?? []
    const absent = words.filter((word) => !lower.includes(word))
    if (words.length > 0 && absent.length / words.length > 0.2) return `“${item.description}” uses words that are not in the notes (${absent.slice(0, 3).join(', ')}).`
  }
  return null
}

/**
 * Notes to a draft invoice. The rules read the notes first; the model, if there is one, may phrase the lines, and its
 * answer is used only when every price, quantity and word in it can be found in the notes.
 */
export async function draftInvoice(input: DraftInput): Promise<InvoiceDraft> {
  const { warrant, now } = input
  const notes = input.notes
  const parsed = parseNotes(notes, warrant, now)
  const { amountsInNotes: _a, numbersInNotes: _n, ...base } = parsed
  let draft: Omit<InvoiceDraft, 'verdict' | 'source'> = base
  let source: 'model' | 'rules' = 'rules'
  if (input.model && base.currency === warrant.currency) {
    try {
      const result = await callTool({
        model: input.model,
        system: 'You read a freelancer\'s messy notes about one piece of billable work and list its invoice lines. Use ONLY facts in the notes. Never invent or guess a price, a quantity or a description. A price must be an amount written in the notes. If the notes give a total for several units, give the unit price as total divided by units only when that divides evenly. Never add tax, fees or discounts. Describe each line in the notes\' own words.',
        user: `Notes (the only facts you may use):\n"""\n${stripMarkup(notes).slice(0, 4000)}\n"""\n\nThe rules read these as: ${JSON.stringify({ lines: base.lineItems, total: base.totalCents })}.`,
        name: 'list_lines',
        description: 'List the invoice lines found in the notes. unitPrice is in major units, for example 40 or 12.5.',
        schema: ModelSchema,
        attempts: 2,
        timeoutMs: 40_000,
        validate: (value) => unsupported(value, notes, parsed),
      })
      input.onUsage?.(result.usage)
      if (!result.leftover) {
        draft = {
          ...base,
          lineItems: result.value.items.map((item) => ({ description: stripMarkup(item.description).slice(0, 200), quantity: item.quantity, unitCents: Math.round(item.unitPrice * 100) })),
        }
        source = 'model'
      } else {
        draft.warnings = [...draft.warnings, 'The AI helper’s answer used something that is not in the notes, so the notes were read with plain rules instead.']
      }
    } catch {
      draft.warnings = [...draft.warnings, 'The AI helper was not available, so the notes were read with plain rules.']
    }
  }
  if (source === 'model') {
    const items = draft.lineItems
    const total = items.reduce((sum, item) => sum + item.quantity * item.unitCents!, 0)
    draft = {
      ...draft,
      totalCents: total,
      missing: draft.missing.filter((key) => key !== 'price' && key !== 'description'),
      warnings: draft.warnings.filter((warning) => !warning.startsWith('The total cannot be worked out')),
    }
  }
  return { ...draft, verdict: verdictFor(draft, input), source }
}

/** What the gate WOULD decide for this draft: the existing pure preview, so no row is written and PayPal is never called. */
function verdictFor(draft: Omit<InvoiceDraft, 'verdict' | 'source'>, input: DraftInput): DraftVerdict | null {
  if (!input.preview || draft.totalCents === null || draft.totalCents <= 0 || draft.totalCents > 100_000_000) return null
  const request: Record<string, unknown> = {
    kind: 'charge',
    payee: draft.client?.id ?? 'unknown client',
    amountCents: draft.totalCents,
    currency: draft.currency,
    description: draft.lineItems.map((item) => item.description).filter(Boolean).join(', ').slice(0, 480) || 'Invoice',
    ...(draft.category ? { category: draft.category } : {}),
    ...(draft.evidenceUrl ? { evidenceUrl: draft.evidenceUrl } : {}),
    ...(draft.jobId ? { jobId: draft.jobId } : {}),
  }
  const parsed = ProposalCreateSchema.safeParse(request)
  if (!parsed.success) return null
  try {
    const decided = input.preview(parsed.data)
    return { ...decided, complete: draft.missing.every((key) => key === 'dueDate') }
  } catch {
    return null
  }
}
