import { Link } from 'react-router-dom'
import { useProposals, useToday, useVersions, useWarrant } from '../lib/hooks'
import type { Party, Proposal, Warrant } from '../lib/types'

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

/** Open on Today. The proposals page is only the newest hundred, so an older invoice would otherwise look unsent. */
const ADDRESSED = new Set(['invoice_draft', 'invoice_sent', 'payout_sent', 'payout_unclaimed'])

function partyOn(version: Warrant | undefined, id: string | null, kind: 'clients' | 'payees'): Party | null {
  return version?.[kind]?.find((party) => party.id === id) ?? null
}

/** The locked cart is addressed from its own warrant version, which publish does not rewrite. */
function heldLine(row: Proposal, version: Warrant | undefined): string {
  if (row.kind === 'charge') {
    const party = partyOn(version, row.payeeId, 'clients')
    const named = party ? `${party.displayName} (${party.email})` : `the address on warrant version ${row.warrantVersion}`
    return `The locked charge keeps its invoice recipient, ${named}, on warrant version ${row.warrantVersion}.`
  }
  if (row.kind === 'payment') {
    const party = partyOn(version, row.payeeId, 'payees')
    const named = party ? `${party.displayName} (${party.email})` : `the address on warrant version ${row.warrantVersion}`
    return `The locked payout keeps its payout receiver, ${named}, on warrant version ${row.warrantVersion}.`
  }
  return `A locked refund keeps the addresses on warrant version ${row.warrantVersion}, not the live rules.`
}

export function EmailNotice({ here = false }: { here?: boolean }) {
  const warrant = useWarrant()
  const versions = useVersions()
  const today = useToday()
  const proposals = useProposals()
  const rules = warrant.data
  if (!rules || today.isPending || proposals.isPending) return null
  // An error is not evidence that nothing has been captured.
  if (today.isError || proposals.isError || !today.data || !proposals.data) return null
  const open = [...today.data.waiting, ...today.data.inFlight]
  const addressed = today.data.setup.steps.some((step) => (step.id === 'first' || step.id === 'paid') && step.done)
    || open.some((item) => ADDRESSED.has(item.phase))
    || proposals.data.data.some((row) => row.captureId || row.invoiceId || row.payoutBatchId)
  if (addressed) return null

  const held = proposals.data.data.filter((row) => (row.phase === 'locked' || row.phase === 'order_created') && !row.invoiceId && !row.payoutBatchId)
  if (held.length > 0 && versions.isPending) return null
  const byVersion = new Map((versions.data?.data ?? []).map((item) => [item.version, item]))
  const charges = held.filter((row) => row.kind === 'charge')
  const payouts = held.filter((row) => row.kind === 'payment')
  const refunds = held.filter((row) => row.kind === 'refund')
  const clients = rules.clients ?? []
  const example = [...clients, ...rules.payees].some((party) => exampleAddress(party.email))

  return (
    <div className={`panel wip-note${example ? ' panel-lime' : ''}`} role="status" data-testid="email-notice">
      <div>
        <strong>Before the first capture</strong>
        <p>
          {charges.length > 0 ? charges.map((row) => heldLine(row, byVersion.get(row.warrantVersion))).join(' ') : who('invoice recipient', clients)}
          {' '}
          {payouts.length > 0 ? payouts.map((row) => heldLine(row, byVersion.get(row.warrantVersion))).join(' ') : who('payout receiver', rules.payees)}
          {refunds.length > 0 ? ` ${refunds.map((row) => heldLine(row, byVersion.get(row.warrantVersion))).join(' ')}` : ''}
        </p>
        <p className="fine">A locked row keeps its version, so the invoice and the payout use that version’s addresses, not the latest email.</p>
        {example ? (
          <p className="fine">
            These are still the example addresses. {here ? 'Press Write version' : <>On the <Link to="/rules" className="link">Rules form</Link>, press Write version</>}, replace the example client and payee emails, and publish, before the first capture.
            {held.length > 0 ? ' That does not change a row already locked.' : ''}
          </p>
        ) : null}
      </div>
    </div>
  )
}
