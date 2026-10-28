import type { WarrantBody } from './schemas'

/**
 * The risk engine: the one place AI-adjacent judgment may add friction, and nowhere else.
 *
 * The invariant it must never break: a risk signal can only *raise* the friction of a decision the rules were about
 * to make on their own (AUTO -> NEEDS_APPROVAL). It can never turn a refusal into an approval, never lower a tap to
 * an automatic payment, and never soften a refusal. The gate applies the signals after every other check has passed,
 * so a signal is a second look at something that was about to go by itself - exactly the moment a fooled agent is
 * dangerous.
 *
 * Impersonation is the one signal that lives elsewhere: a lookalike payee ("P. Shah" for Priya Shah) does not resolve
 * to any party, so the gate refuses it as unknown anyway. What the risk engine adds there is not friction but
 * *honesty* - with the feature on, the refusal names the lookalike instead of shrugging "unknown". The refusal class
 * never changes: refused is refused, and PayPal is never called either way.
 *
 * The evaluator is pure: it takes the warrant's risk config, a small slice of the ledger, and the raw request, and
 * answers with at most one signal. No clock, no database, no PayPal. The service layer gathers the slice.
 */

export type RiskConfig = NonNullable<WarrantBody['risk']>

export const RiskClause = {
  velocity: 'risk.velocity',
  newEvidenceHost: 'risk.new_evidence_host',
  payeeImpersonation: 'risk.payee_impersonation',
} as const

/** The slice of the ledger the signal is judged against, gathered by the service from the database. */
export type RiskLedger = {
  /** Proposals of any kind filed inside the velocity window, across every payee and actor. */
  recentProposalCount: number
  /** Evidence hosts seen on any earlier proposal. Empty when the studio has no history yet, so a first request is never punished for arriving first. */
  knownEvidenceHosts: string[]
}

export type RiskInput = {
  evidenceUrl: string | null
}

export type RiskSignal = {
  escalate: true
  code: string
  detail: string
}

export function riskEnabled(warrant: Pick<WarrantBody, 'risk'> | undefined | null): boolean {
  return Boolean(warrant?.risk?.enabled)
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return null
  }
}

const words = (value: string): string[] =>
  value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9@\s]/g, ' ').split(/\s+/).filter((word) => word.length >= 3)

/**
 * Does this raw payee look like an impersonation of a party already on the rules? A lookalike shares a significant
 * word with a known name, alias or email ("P. Shah" for Priya Shah, "priya.shah@examp1e.com" for the real address)
 * without being an exact match for any of them. An exact match is the party themselves; no overlap at all is an
 * unknown stranger, which `payee.unknown` already refuses. Only the space between the two - close enough to fool a
 * person, wrong enough to steal from them - is a risk signal.
 */
export function impersonatesKnownParty(rawPayee: string, parties: WarrantBody['payees']): boolean {
  const query = rawPayee.trim().toLowerCase()
  if (!query) return false
  const queryTokens = new Set(words(query))
  if (queryTokens.size === 0) return false
  for (const party of parties) {
    const known = [party.id, party.displayName, party.email, ...party.aliases].map((value) => value.trim().toLowerCase())
    if (known.some((value) => value === query)) return false
    const knownTokens = new Set(known.flatMap((value) => value.split(/[^a-z0-9]+/)).filter((token) => token.length >= 3))
    for (const token of queryTokens) {
      if (knownTokens.has(token)) return true
    }
  }
  return false
}

/**
 * At most one signal, in the order a person would rank the danger: a burst of asks first, then work hosted somewhere
 * this studio has never paid against before. (The lookalike check is not here: it refuses, it does not escalate -
 * see the gate's identity check.)
 */
export function assessRisk(warrant: WarrantBody, ledger: RiskLedger, input: RiskInput): RiskSignal | null {
  const config = warrant.risk
  if (!config?.enabled) return null
  if (config.velocityMaxPerHour > 0 && ledger.recentProposalCount > config.velocityMaxPerHour) {
    return {
      escalate: true,
      code: RiskClause.velocity,
      detail: `${ledger.recentProposalCount} requests were filed in the last ${config.velocityWindowMinutes} minutes, over the ${config.velocityMaxPerHour} a burst of asks looks like`,
    }
  }
  if (config.escalateNewEvidenceHost && input.evidenceUrl) {
    const host = hostOf(input.evidenceUrl)
    if (host && ledger.knownEvidenceHosts.length > 0 && !ledger.knownEvidenceHosts.includes(host)) {
      return {
        escalate: true,
        code: RiskClause.newEvidenceHost,
        detail: `the proof is hosted on ${host}, where no earlier request in this ledger pointed, so a person should look at the work before money moves`,
      }
    }
  }
  return null
}

/**
 * Is this raw payee a lookalike of a party already on the rules? Shared by the gate's identity check, which turns it
 * into a refusal that names the attempt instead of a generic "unknown".
 */
export function isLookalike(rawPayee: string, warrant: Pick<WarrantBody, 'payees' | 'clients' | 'risk'>): boolean {
  return Boolean(
    warrant.risk?.enabled
    && warrant.risk.patternMatchPayees
    && (impersonatesKnownParty(rawPayee, warrant.payees) || impersonatesKnownParty(rawPayee, warrant.clients)),
  )
}
