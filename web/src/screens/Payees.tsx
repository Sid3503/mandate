import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Chip, Empty, Loading, Money, PageHead, ProblemCard } from '../components/ui'
import { api, ApiError } from '../lib/api'
import { relative } from '../lib/format'
import type { PayeeBookEntry } from '../lib/types'

export function Payees() {
  const client = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isChanging, setIsChanging] = useState(false)
  const [newEmail, setNewEmail] = useState('')

  const payeesQuery = useQuery({
    queryKey: ['payees'],
    queryFn: api.payees,
    retry: false,
  })

  const rows = payeesQuery.data?.payees ?? []
  const activeId = selectedId ?? rows[0]?.id ?? null

  const detailQuery = useQuery({
    queryKey: ['payee', activeId],
    queryFn: () => (activeId ? api.payee(activeId) : null),
    enabled: Boolean(activeId),
  })

  const selectedPayee: PayeeBookEntry | null =
    detailQuery.data?.payee ?? rows.find((p) => p.id === activeId) ?? null

  const changeMutation = useMutation({
    mutationFn: ({ id, email }: { id: string; email: string }) => api.changePayee(id, email),
    onSuccess: () => {
      setIsChanging(false)
      setNewEmail('')
      void client.invalidateQueries({ queryKey: ['payees'] })
      void client.invalidateQueries({ queryKey: ['payee', activeId] })
    },
  })

  const confirmMutation = useMutation({
    mutationFn: (id: string) => api.confirmPayeeChange(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['payees'] })
      void client.invalidateQueries({ queryKey: ['payee', activeId] })
    },
  })

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.cancelPayeeChange(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['payees'] })
      void client.invalidateQueries({ queryKey: ['payee', activeId] })
    },
  })

  const attestMutation = useMutation({
    mutationFn: (id: string) => api.attestPayee(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['payees'] })
      void client.invalidateQueries({ queryKey: ['payee', activeId] })
    },
  })

  if (payeesQuery.isLoading) {
    return (
      <div className="page" data-testid="payees-page">
        <PageHead eyebrow="Contractors · Payee Book" title="Payees" />
        <Loading label="Loading payee book" />
      </div>
    )
  }

  if (payeesQuery.isError) {
    const error = payeesQuery.error
    const isOff = error instanceof ApiError && (error.status === 404 || error.code === 'flag/disabled')
    return (
      <div className="page" data-testid="payees-page">
        <PageHead eyebrow="Contractors · Payee Book" title="Payees" />
        {isOff ? (
          <section className="panel" data-testid="payees-disabled-notice" aria-label="Payee book disabled">
            <h2 className="panel-title">Payee Book is inactive</h2>
            <p className="muted">
              The Payee Book is currently switched off on this workspace. When <code>FLAG_PAYEE_BOOK</code> is enabled,
              new contractor cooling periods, owner attestations, and payout account locks are actively enforced.
            </p>
          </section>
        ) : (
          <ProblemCard error={error} onRetry={() => void payeesQuery.refetch()} />
        )}
      </div>
    )
  }

  return (
    <div className="page payees-screen" data-testid="payees-page">
      <PageHead eyebrow="Contractors · Payee Book" title="Payees" />

      <section className="panel" aria-label="Overview notice">
        <p className="fine">
          The Payee Book enforces cooling periods on new accounts and locks payouts when payout accounts change.
          First payments to unverified payees always require owner approval.
        </p>
      </section>

      {rows.length === 0 ? (
        <Empty title="No payees found">
          No contractors have been added to the spending warrant yet.
        </Empty>
      ) : (
        <div className="row gap-l wrap align-start" style={{ marginTop: 16 }}>
          {/* Left Column: Payees List */}
          <section
            className="panel"
            style={{ flex: '1 1 320px', minWidth: 280 }}
            aria-label="Contractor payees list"
          >
            <h2 className="panel-title" style={{ marginBottom: 12 }}>Contractor Accounts</h2>
            <ul
              className="payees-list"
              data-testid="payees-list"
              style={{ listStyle: 'none', padding: 0, margin: 0 }}
            >
              {rows.map((row) => {
                const isSelected = row.id === activeId
                return (
                  <li
                    key={row.id}
                    data-testid={`payee-row-${row.id}`}
                    style={{
                      padding: '12px 14px',
                      borderRadius: 8,
                      marginBottom: 8,
                      cursor: 'pointer',
                      border: isSelected ? '1px solid var(--lime, #b8e986)' : '1px solid var(--line, #333)',
                      background: isSelected ? 'rgba(184, 233, 134, 0.08)' : 'transparent',
                    }}
                    onClick={() => {
                      setSelectedId(row.id)
                      setIsChanging(false)
                    }}
                  >
                    <div className="row between align-center gap-xs">
                      <span className="strong">{row.name || row.id}</span>
                      {row.change_pending ? (
                        <Chip tone="need">Change pending</Chip>
                      ) : row.cooling ? (
                        <Chip tone="need">Cooling</Chip>
                      ) : row.status === 'active' ? (
                        <Chip tone="auto">Active</Chip>
                      ) : (
                        <Chip tone="muted">{row.status}</Chip>
                      )}
                    </div>
                    <div className="row between align-center gap-xs" style={{ marginTop: 4 }}>
                      <span className="small muted mono">{row.email}</span>
                      <span className="small">
                        <Money cents={row.total_paid_cents} />
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>

          {/* Right Column: Payee Diagnostics & History */}
          {selectedPayee ? (
            <div style={{ flex: '2 1 440px', minWidth: 320 }} className="stack-m">
              {/* Diagnostic Card: "Why can I not pay this account?" */}
              <section
                className="panel"
                data-testid="payee-diagnostic-card"
                aria-label="Payability diagnostics"
                style={{
                  borderLeft: selectedPayee.diagnostics.canPay
                    ? '4px solid var(--lime, #5cb85c)'
                    : '4px solid var(--warn, #f0ad4e)',
                }}
              >
                <div className="row between align-center">
                  <h2 className="panel-title" style={{ margin: 0 }}>
                    Why can I not pay this account?
                  </h2>
                  <Chip tone={selectedPayee.diagnostics.canPay ? 'auto' : 'need'}>
                    {selectedPayee.diagnostics.canPay ? 'Payable' : 'Blocked'}
                  </Chip>
                </div>

                <p
                  data-testid="payee-diagnostic-reason"
                  style={{ marginTop: 12, fontSize: '0.95rem', lineHeight: 1.5 }}
                >
                  {selectedPayee.diagnostics.reason}
                </p>

                {/* Quick actions depending on state */}
                <div className="row gap-s align-center wrap" style={{ marginTop: 14 }}>
                  {selectedPayee.cooling ? (
                    <button
                      type="button"
                      className="btn btn-ink btn-small"
                      data-testid="attest-payee-btn"
                      disabled={attestMutation.isPending}
                      onClick={() => attestMutation.mutate(selectedPayee.id)}
                    >
                      {attestMutation.isPending ? 'Attesting…' : 'Attest payee (skip cooling)'}
                    </button>
                  ) : null}

                  {selectedPayee.change_pending ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-ink btn-small"
                        data-testid="confirm-change-btn"
                        disabled={confirmMutation.isPending}
                        onClick={() => confirmMutation.mutate(selectedPayee.id)}
                      >
                        {confirmMutation.isPending ? 'Confirming…' : 'Confirm change (with passkey)'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-small"
                        data-testid="cancel-change-btn"
                        disabled={cancelMutation.isPending}
                        onClick={() => cancelMutation.mutate(selectedPayee.id)}
                      >
                        {cancelMutation.isPending ? 'Cancelling…' : 'Cancel change'}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      data-testid="change-account-btn"
                      onClick={() => setIsChanging(!isChanging)}
                    >
                      {isChanging ? 'Close' : 'Change payout account'}
                    </button>
                  )}
                </div>

                {/* Form to change payout account */}
                {isChanging && !selectedPayee.change_pending ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (newEmail.trim()) {
                        changeMutation.mutate({ id: selectedPayee.id, email: newEmail.trim() })
                      }
                    }}
                    style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--line, #333)' }}
                    data-testid="change-account-form"
                  >
                    <label className="field">
                      <span className="small strong">New PayPal payout email</span>
                      <input
                        type="email"
                        required
                        placeholder="new.email@example.com"
                        value={newEmail}
                        onChange={(e) => setNewEmail(e.target.value)}
                        className="input"
                        data-testid="new-email-input"
                        style={{ marginTop: 4, width: '100%', maxWidth: 360 }}
                      />
                    </label>
                    <div className="row gap-s" style={{ marginTop: 10 }}>
                      <button
                        type="submit"
                        className="btn btn-ink btn-small"
                        data-testid="submit-change-btn"
                        disabled={changeMutation.isPending}
                      >
                        {changeMutation.isPending ? 'Submitting…' : 'Submit change'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-small"
                        onClick={() => setIsChanging(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : null}

                {attestMutation.isError ? <ProblemCard error={attestMutation.error} /> : null}
                {confirmMutation.isError ? <ProblemCard error={confirmMutation.error} /> : null}
                {cancelMutation.isError ? <ProblemCard error={cancelMutation.error} /> : null}
                {changeMutation.isError ? <ProblemCard error={changeMutation.error} /> : null}
              </section>

              {/* History of payouts to this payee */}
              <section
                className="panel"
                data-testid="payee-history"
                aria-label="Payee payout history"
              >
                <div className="row between align-center">
                  <h2 className="panel-title" style={{ margin: 0 }}>Payout History</h2>
                  <span className="small muted">
                    Total paid: <Money cents={selectedPayee.total_paid_cents} />
                  </span>
                </div>

                {detailQuery.isLoading ? (
                  <Loading label="Loading payout history" />
                ) : !selectedPayee.history || selectedPayee.history.length === 0 ? (
                  <p className="muted small" style={{ marginTop: 12 }}>
                    No payouts have been executed for this contractor yet.
                  </p>
                ) : (
                  <ul
                    className="history-list"
                    data-testid="history-list"
                    style={{ listStyle: 'none', padding: 0, marginTop: 12 }}
                  >
                    {selectedPayee.history.map((item) => (
                      <li
                        key={item.id}
                        className="row between align-center"
                        style={{
                          padding: '10px 0',
                          borderBottom: '1px solid var(--line, #333)',
                        }}
                        data-testid={`history-item-${item.id}`}
                      >
                        <div>
                          <div className="row gap-s align-center">
                            <span className="mono small">{item.description || item.kind}</span>
                            <Chip tone={item.phase === 'settled' || item.phase === 'executed' ? 'auto' : 'muted'}>
                              {item.phase}
                            </Chip>
                          </div>
                          <span className="fine muted">{relative(item.createdAt)}</span>
                        </div>
                        <div className="right">
                          <div><Money cents={item.amountCents} /></div>
                          <Link to={`/p/${item.id}`} className="link fine">Receipt ↗</Link>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
