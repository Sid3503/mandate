import { Link } from 'react-router-dom'
import { useProposals, useToday, useWarrant } from '../lib/hooks'
import type { Party } from '../lib/types'

/** A seed address is not a PayPal account. Real ones are published on the rules, never committed here. */
function exampleAddress(email: string): boolean {
  const host = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
  return host === 'example.com' || host === 'example.net' || host === 'example.org' || host.endsWith('.example')
}

function who(label: 'invoice recipient' | 'payout receiver', parties: Party[]): string {
  if (parties.length === 0) return `The ${label} is nobody on the live rules.`
  const named = parties.map((party) => `${party.displayName} (${party.email})`).join(', ')
  return parties.length === 1 ? `The ${label} is ${named}.` : `The ${label}s are ${named}.`
}

/** Live warrant only. A locked row keeps its own version, so this is moot once money has been addressed. */
export function EmailNotice({ here = false }: { here?: boolean }) {
  const warrant = useWarrant()
  const today = useToday()
  const proposals = useProposals()
  const rules = warrant.data
  if (!rules || today.isPending || proposals.isPending) return null
  const captured = today.data?.setup.steps.some((step) => (step.id === 'first' || step.id === 'paid') && step.done) === true
    || (proposals.data?.data ?? []).some((row) => row.captureId || row.invoiceId || row.payoutBatchId)
  if (captured) return null
  const clients = rules.clients ?? []
  const example = [...clients, ...rules.payees].some((party) => exampleAddress(party.email))
  return (
    <div className={`panel wip-note${example ? ' panel-lime' : ''}`} role="status" data-testid="email-notice">
      <div>
        <strong>Before the first capture</strong>
        <p>{who('invoice recipient', clients)} {who('payout receiver', rules.payees)}</p>
        {example ? (
          <p className="fine">
            These are still the example addresses. The next action is to publish a new warrant version with PUT /v1/warrant
            {here ? ' on this form' : <> on the <Link to="/rules" className="link">Rules form</Link></>} before the first capture.
            A locked row keeps its version, so the invoice and the payout use that version’s addresses, not the latest email.
          </p>
        ) : null}
      </div>
    </div>
  )
}
