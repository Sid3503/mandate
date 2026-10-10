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

export function EmailNotice({ here = false }: { here?: boolean }) {
  const warrant = useWarrant()
  const today = useToday()
  const proposals = useProposals()
  const rules = warrant.data
  if (!rules || today.isPending || proposals.isPending) return null
  // A failed read is not evidence that nothing has been captured.
  if (today.isError || proposals.isError || !today.data || !proposals.data) return null
  const moved = today.data.setup.steps.some((step) => (step.id === 'first' || step.id === 'paid') && step.done)
    || today.data.inFlight.length > 0
    || proposals.data.data.some((row) => row.captureId || row.invoiceId || row.payoutBatchId)
  if (moved) return null
  const clients = rules.clients ?? []
  const example = [...clients, ...rules.payees].some((party) => exampleAddress(party.email))
  return (
    <div className={`panel wip-note${example ? ' panel-lime' : ''}`} role="status" data-testid="email-notice">
      <div>
        <strong>Before the first capture</strong>
        <p>{who('invoice recipient', clients)} {who('payout receiver', rules.payees)}</p>
        <p className="fine">A row already locked is invoiced and paid from the emails on its own warrant version, not from the live addresses above.</p>
        {example ? (
          <p className="fine">
            These are still the example addresses. {here ? 'Press Write version' : <>On the <Link to="/rules" className="link">Rules form</Link>, press Write version</>}, replace the example client and payee emails, and publish, before the first capture.
          </p>
        ) : null}
      </div>
    </div>
  )
}
