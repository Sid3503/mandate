import type { Decision } from './gate'

export type PayeeView = {
  status: 'active' | 'pending' | 'missing' | 'disabled'
  changePending: boolean
  waitUntil: string | null
}

/**
 * A new payee cannot ride a standing rule. The first payment waits for a person.
 * A payout account that is mid-change is refused until the owner signs the change.
 * Absent means the payee book is off and the decision is unchanged.
 */
export function applyPayeeBook(decision: Decision, payee: PayeeView | null): Decision {
  if (!payee || decision.gate === 'DENY') return decision
  if (payee.changePending) {
    return { gate: 'DENY', clause: 'payee.change_pending', detail: 'This payee has a payout account change waiting. Payments wait until the owner signs it.' }
  }
  if (payee.status === 'disabled') {
    return { gate: 'DENY', clause: 'payee.not_active', detail: 'This payee is not active.' }
  }
  if (payee.status === 'missing' || payee.status === 'pending' || payee.waitUntil) {
    return { gate: 'NEEDS_APPROVAL', clause: 'payee.not_active', detail: 'The first payment to a payee waits for the owner, even when a standing rule matches.' }
  }
  return decision
}
