import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, ApiError } from '../lib/api'
import { when } from '../lib/format'
import { Chip, ProblemCard } from './ui'

/** Whether the owner is told, in their own Slack, Discord or Zapier, when something needs them. The address is never shown. */
export function NotifyPanel() {
  const client = useQueryClient()
  const status = useQuery({ queryKey: ['notify'], queryFn: api.notify, refetchInterval: 30_000 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const test = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.notifyTest()
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null)
    } finally {
      setBusy(false)
      await client.invalidateQueries({ queryKey: ['notify'] })
    }
  }
  const data = status.data
  return (
    <section className="panel" aria-labelledby="h-notify" data-testid="notify-panel">
      <h2 className="panel-title" id="h-notify">Tell me when something needs me</h2>
      <p className="fine">Mandate can message your own Slack, Discord or Zapier when a request needs your tap, a payout fails or is unclaimed, or Mandate pauses itself. The message only says what needs you and links here. It cannot approve or pay anything.</p>
      {data?.enabled ? (
        <>
          <div className="row gap-s wrap"><Chip tone="auto">Connected</Chip><span className="fine">{data.sent} sent{data.lastSentAt ? ` · last ${when(data.lastSentAt)}` : ''}</span>{data.lastError ? <Chip tone="deny">Last send failed: {data.lastError}</Chip> : null}</div>
          <button type="button" className="btn btn-ghost btn-small" onClick={() => void test()} disabled={busy}>{busy ? 'Sending…' : 'Send a test message'}</button>
        </>
      ) : (
        <p className="fine"><Chip tone="muted">Not set up</Chip> Start the server with <code className="mono">NOTIFY_WEBHOOK_URL</code> set to an https incoming-webhook address, then restart. The address is a secret, so it lives in the environment, never in the browser.</p>
      )}
      <ProblemCard error={error} />
    </section>
  )
}
