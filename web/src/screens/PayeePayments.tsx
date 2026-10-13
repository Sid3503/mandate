import { Link } from 'react-router-dom'
import { Chip, Empty, Loading, Money, PageHead, ProblemCard } from '../components/ui'
import { relative } from '../lib/format'
import { useProposals } from '../lib/hooks'

export function PayeePayments() {
  const proposals = useProposals()
  const rows = proposals.data?.data ?? []
  const payouts = rows.filter((item) => item.kind === 'payment')

  return (
    <div className="page payments" data-testid="payee-payments-page">
      <PageHead eyebrow="Payee · read payments and settled shares" title="Your payments" />

      <section className="panel" aria-label="Payee notice">
        <p className="fine">
          Payments are made only from money that has already settled from clients, and only for approved milestone shares.
        </p>
      </section>

      {proposals.isLoading ? <Loading label="Loading your payments" /> : null}
      <ProblemCard error={proposals.error} />

      {payouts.length === 0 && !proposals.isLoading ? (
        <Empty title="No payments yet">Approved payouts will appear here once settled.</Empty>
      ) : (
        <section className="section" aria-label="Payments list">
          <ul className="payments-list" data-testid="payments-list" style={{ listStyle: 'none', padding: 0 }}>
            {payouts.map((row) => (
              <li key={row.id} className="panel row between align-center" style={{ marginBottom: 12 }} data-testid={`payment-item-${row.id}`}>
                <div>
                  <div className="row gap-s align-center">
                    <span className="mono strong">{row.payeeId ?? 'Contractor'}</span>
                    <Chip tone={row.phase === 'settled' || row.phase === 'executed' ? 'auto' : row.phase === 'pending_approval' ? 'need' : 'muted'}>
                      {row.phase}
                    </Chip>
                  </div>
                  <p className="small muted" style={{ marginTop: 4 }}>
                    {row.description || row.clause} · {relative(row.createdAt)}
                  </p>
                </div>
                <div className="right">
                  <div className="money-col"><Money cents={row.amountCents} /></div>
                  <Link to={`/p/${row.id}`} className="link small">Receipt ↗</Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
