/**
 * Output guards. The model's prose is commentary; the tool results are the facts. These keep a confident but wrong
 * sentence from ever reaching a person as if it were the rules' answer.
 */

const CLAIMS_MONEY_MOVED = [
  /\b(i['’]?ve|i have|we['’]?ve|we have|has been|have been|was|were|is now|are now|successfully)\s+(paid|sent|transferred|released|processed|settled|approved|refunded|completed)\b/i,
  /\b(paid|sent|transferred|released)\s+(the\s+)?(payment|money|funds|payout|\$)/i,
  /\bpayment\s+(is\s+)?(complete|done|made)\b/i,
]

export type Outcome = {
  tool: string
  ok: boolean
  data: Record<string, unknown>
}

/** True when the sentence says money moved, which an agent that can only ask can never know. */
export function claimsMoneyMoved(text: string): boolean {
  return CLAIMS_MONEY_MOVED.some((pattern) => pattern.test(text))
}

/** The facts of one tool result, in the rules' own words. */
export function describe(outcome: Outcome): string | null {
  const d = outcome.data
  if (!outcome.ok) {
    const error = d.error as { code?: string; message?: string } | undefined
    return error ? `That did not go through (${error.code}): ${error.message}` : null
  }
  if (outcome.tool === 'propose') {
    const options = Array.isArray(d.whatWouldPass) && d.whatWouldPass.length > 0 ? ` What would pass: ${(d.whatWouldPass as string[]).join(' ')}` : ''
    return `${d.amount} request: ${String(d.decision).replace('_', ' ').toLowerCase()} (${d.ruleCode}). ${d.inPlainWords} ${d.nextStep}${options}`
  }
  if (outcome.tool === 'offer_deal') {
    const violations = (d.violations as Array<{ said: string }> | undefined) ?? []
    return d.result === 'AGREED'
      ? `Deal agreed. ${d.nextStep}`
      : `Deal refused. ${violations.map((item) => item.said).join(' ')} ${d.nextStep}`
  }
  return null
}

/**
 * The reply a person sees. Keep the model's words when they are safe and useful; otherwise state the facts.
 * `guarded` is true when the model's words were replaced, so the console can say so.
 */
/** Every dollar amount in a sentence, in cents. */
export function amountsIn(text: string): number[] {
  return [...text.matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)/g)].map((match) => Math.round(Number(match[1]!.replaceAll(',', '')) * 100)).filter(Number.isFinite)
}

/**
 * Amounts in a reply that neither a tool returned nor the person wrote. A model can state a confident figure that is
 * nowhere in what the rules said; that figure is removed by replacing the sentence with the facts.
 */
export function unsupportedAmounts(reply: string, evidence: string[]): number[] {
  const known = new Set<number>()
  for (const text of evidence) {
    for (const cents of amountsIn(text)) known.add(cents)
    // Tool results also carry bare numbers: cents as integers, and dollars as decimals.
    for (const match of text.matchAll(/\b\d+(?:\.\d+)?\b/g)) {
      const value = Number(match[0])
      known.add(Math.round(value))
      known.add(Math.round(value * 100))
    }
  }
  return amountsIn(reply).filter((cents) => !known.has(cents))
}

export function composeReply(modelText: string, outcomes: Outcome[], evidence: string[] = []): { reply: string; guarded: boolean } {
  const facts = outcomes.map(describe).filter((line): line is string => Boolean(line))
  const text = modelText.trim()
  const moved = outcomes.some((outcome) => outcome.ok && (outcome.data.phase === 'captured' || outcome.data.phase === 'refunded'))
  // Checked only when there is evidence to check against: a reply with no tool results has no figures to vouch for.
  const invented = evidence.length > 0 ? unsupportedAmounts(text, evidence) : []
  if (invented.length > 0) {
    const fallback = facts.length > 0 ? facts.join(' ') : 'I could not confirm the amounts in that answer from what the rules returned, so I am not going to state them. Ask again, or open the receipt.'
    return { reply: fallback, guarded: true }
  }
  if (text && !(claimsMoneyMoved(text) && !moved)) return { reply: text, guarded: false }
  if (facts.length > 0) return { reply: facts.join(' '), guarded: Boolean(text) }
  return { reply: text || 'I could not do anything with that. Try asking for a specific payment, for example “pay Priya her share for the Northwind logo”.', guarded: false }
}
