/**
 * How a receipt says the money was allowed. A passkey row with no assertion is red.
 * An owner key or a demo tap is amber. A row that never named a method is grey and marked legacy.
 * This does not call a signature valid. The verify page does that.
 */

export type ApprovalProof = {
  method: 'passkey' | 'owner-key' | 'demo' | 'legacy' | 'rule'
  tone: 'red' | 'amber' | 'grey' | 'ink'
  who: string
  how: string
  at: string | null
  fingerprint: string | null
}

function assertionPresent(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const assertion = value as { id?: unknown; response?: { signature?: unknown } }
  return typeof assertion.id === 'string' && assertion.id.length > 0
    && typeof assertion.response?.signature === 'string' && assertion.response.signature.length > 0
}

function shortPrint(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 8) return null
  return value.slice(0, 8)
}

export function approvalProof(input: {
  payload: Record<string, unknown> | null
  at: string | null
  warrantVersion: number | null
  warrantSigned: boolean
}): ApprovalProof {
  const payload = input.payload
  if (!payload) {
    const how = input.warrantVersion == null
      ? 'No rules version is stored.'
      : `Rules v${input.warrantVersion}. That version ${input.warrantSigned ? 'has a signature.' : 'has no signature.'}`
    return { method: 'rule', tone: 'grey', who: 'Standing rule', how, at: input.at, fingerprint: null }
  }
  const who = typeof payload.actor === 'string' ? payload.actor : 'owner'
  const fingerprint = shortPrint(payload.fingerprint)
  if (payload.method === 'passkey') {
    if (!assertionPresent(payload.assertion)) {
      return { method: 'passkey', tone: 'red', who, how: 'passkey, signature missing', at: input.at, fingerprint }
    }
    return { method: 'passkey', tone: 'ink', who, how: 'passkey', at: input.at, fingerprint }
  }
  if (payload.method === 'owner-key') return { method: 'owner-key', tone: 'amber', who, how: 'owner key', at: input.at, fingerprint: null }
  if (payload.method === 'demo') return { method: 'demo', tone: 'amber', who, how: 'demo', at: input.at, fingerprint: null }
  if (assertionPresent(payload.assertion)) {
    return { method: 'passkey', tone: 'ink', who, how: 'passkey', at: input.at, fingerprint }
  }
  return { method: 'legacy', tone: 'grey', who, how: 'legacy', at: input.at, fingerprint: null }
}
