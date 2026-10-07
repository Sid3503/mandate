import { dollars } from './money'

/**
 * How a tool call reads to a person. Every tool an AI layer can call is named in words, its arguments are shown as the
 * few facts that matter, and its answer is reduced to one line and a tone. Nothing here changes what the tool did: it
 * is only how the call is drawn.
 */
export type Tone = 'good' | 'need' | 'deny' | 'muted' | 'bad'
export type Chipish = { k: string; v: string }

export const TOOL_LABEL: Record<string, { past: string; present: string; glyph: string }> = {
  get_rules: { present: 'Reading the rules', past: 'Read the rules', glyph: '§' },
  get_jobs: { present: 'Finding the job and the client payment', past: 'Found the job and the client payment', glyph: '◧' },
  list_ledger: { present: 'Reading the ledger', past: 'Read the ledger', glyph: '≣' },
  explain: { present: 'Looking up what happened', past: 'Looked up what happened', glyph: '?' },
  propose: { present: 'Filing the request with the rules', past: 'Filed the request with the rules', glyph: '✦' },
  offer_deal: { present: 'Offering deal terms', past: 'Offered deal terms', glyph: '⇄' },
  get_deliveries: { present: 'Looking at what was delivered', past: 'Looked at what was delivered', glyph: '▤' },
  decide_delivery: { present: 'Deciding on the delivery', past: 'Decided on the delivery', glyph: '✔' },
  proof_check: { present: 'Checking the proof link', past: 'Checked the proof link', glyph: '⌕' },
  propose_rules: { present: 'Drafting the rules', past: 'Drafted the rules', glyph: '✎' },
}

export const toolLabel = (tool: string, finished: boolean) => {
  const known = TOOL_LABEL[tool]
  return known ? (finished ? known.past : known.present) : tool.replaceAll('_', ' ')
}
export const toolGlyph = (tool: string) => TOOL_LABEL[tool]?.glyph ?? '•'

const obj = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {})
const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const short = (value: string, max = 42) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)

/** The few arguments worth showing on the card. */
export function inputFacts(tool: string, input: unknown): Chipish[] {
  const i = obj(input)
  const out: Chipish[] = []
  const add = (k: string, v: string | null) => { if (v) out.push({ k, v }) }
  if (tool === 'propose') {
    add(i.kind === 'charge' ? 'bill' : i.kind === 'refund' ? 'refund' : 'pay', str(i.payee))
    add('amount', num(i.amountCents) !== null ? dollars(num(i.amountCents)!) : null)
    add('work', str(i.category))
    add('funded by', str(i.fundingCaptureId) ? short(String(i.fundingCaptureId), 14) : null)
    add('proof', str(i.evidenceUrl) ? short(String(i.evidenceUrl).replace(/^https:\/\/(www\.)?/, ''), 34) : null)
  } else if (tool === 'offer_deal') {
    const terms = obj(i.terms)
    add('price', num(terms.totalCents) !== null ? dollars(num(terms.totalCents)!) : null)
    add('milestones', Array.isArray(terms.milestones) ? String(terms.milestones.length) : null)
    add('says', str(i.prompt) ? short(String(i.prompt), 50) : null)
  } else if (tool === 'decide_delivery') {
    add('decision', str(i.decision))
    add('milestone', num(i.milestone) !== null ? String(num(i.milestone)! + 1) : null)
    add('note', str(i.note) ? short(String(i.note), 60) : null)
  } else if (tool === 'proof_check') {
    add('link', str(i.url) ? short(String(i.url).replace(/^https:\/\/(www\.)?/, ''), 44) : null)
  } else if (tool === 'list_ledger') {
    add('showing', str(i.status) ?? 'everything')
  } else if (tool === 'get_jobs') {
    add('job', str(i.jobId) ?? 'all jobs')
  } else if (tool === 'explain') {
    add('request', str(i.proposalId) ? short(String(i.proposalId), 10) : null)
  }
  return out
}

/** One line and a tone for what came back. */
export function outputLine(tool: string, output: unknown, ok: boolean): { tone: Tone; text: string } {
  const o = obj(output)
  if (!ok) {
    const error = obj(o.error)
    return { tone: 'bad', text: str(error.message) ?? str(error.code) ?? 'It did not go through' }
  }
  if (tool === 'propose') {
    const decision = String(o.decision ?? '')
    const code = str(o.ruleCode) ?? ''
    if (decision === 'DENY') return { tone: 'deny', text: `Refused · ${code}` }
    if (decision === 'AUTO') return { tone: 'good', text: `Goes with no tap · ${code}` }
    return { tone: 'need', text: `Waits for your tap · ${code}` }
  }
  if (tool === 'offer_deal') return o.result === 'AGREED' ? { tone: 'good', text: 'Agreed and signed' } : { tone: 'deny', text: 'Refused by a rule' }
  if (tool === 'decide_delivery') {
    const d = obj(o.delivery)
    const status = str(o.status) ?? str(d.status) ?? str(o.decision)
    return status === 'accepted' ? { tone: 'good', text: 'Accepted and signed' } : status === 'rejected' ? { tone: 'deny', text: 'Rejected' } : { tone: 'muted', text: 'Decided' }
  }
  if (tool === 'proof_check') return { tone: o.verdict === 'reject' ? 'deny' : o.verdict === 'plausible' ? 'good' : 'need', text: str(o.summary) ?? 'Checked' }
  if (tool === 'get_jobs') {
    const jobs = Array.isArray(o.jobs) ? o.jobs.length : null
    const fundable = Array.isArray(o.payoutsPossibleFrom) ? o.payoutsPossibleFrom.length : null
    return { tone: 'muted', text: `${jobs ?? '?'} job${jobs === 1 ? '' : 's'} · ${fundable ?? 0} payment${fundable === 1 ? '' : 's'} can still fund a payout` }
  }
  if (tool === 'list_ledger') {
    const list = Array.isArray(o.items) ? o.items : Array.isArray(o.data) ? o.data : null
    return { tone: 'muted', text: list ? `${list.length} request${list.length === 1 ? '' : 's'}` : 'Read' }
  }
  return { tone: 'muted', text: 'Done' }
}
