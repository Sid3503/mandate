import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { relative } from '../lib/format'
import { useIsOwner, useOnline } from '../lib/hooks'
import { useToast } from './Toast'
import { ProblemCard } from './ui'

/**
 * Says, at the top of every screen, when something Mandate depends on is not answering. It reads a cheap status route that
 * never calls PayPal itself, so it works exactly when PayPal does not. What it says is what is true: the rules still
 * decide, requests keep their place, and a sweep tries again by itself.
 */
export function StatusBanner() {
  const status = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: 15_000, retry: false })
  const owner = useIsOwner()
  const online = useOnline()
  const client = useQueryClient()
  const toast = useToast()
  const resume = useMutation({
    mutationFn: () => api.resume(),
    onSuccess: () => {
      toast({ title: 'Mandate is running again', body: 'The autopilot caught up on what it was told to wait for.', key: 'safety' })
      void Promise.all(['status', 'safety', 'today', 'proposals', 'audit'].map((key) => client.invalidateQueries({ queryKey: [key] })))
    },
  })
  const down = status.data?.degraded ?? []
  if (status.isError && !status.data) {
    return <div className="degraded" role="status"><strong>Mandate could not be reached.</strong> What is on screen is the last thing it said. Nothing that moves money can be sent until it answers.</div>
  }
  const paused = status.data?.paused ?? null
  if (down.length === 0 && !paused) return null
  return (
    <>
    {paused ? (
      <div className="paused" role="alert" data-testid="paused-banner">
        <div>
          <strong>Mandate is paused.</strong> {paused.by === 'breaker' ? 'It paused itself: ' : ''}{paused.reason ?? 'The owner paused it.'}{paused.since ? <span className="muted"> · {relative(paused.since)}</span> : null}
          <p className="fine">Nothing automatic runs and every agent is refused, with the refusal written down. Payouts already sent to PayPal cannot be called back. The rules and the ledger still work.</p>
        </div>
        {owner ? <button type="button" className="btn btn-ink btn-small" disabled={!online || resume.isPending} onClick={() => resume.mutate()}>{resume.isPending ? 'Resuming…' : 'Resume'}</button> : null}
        <ProblemCard error={resume.error} />
      </div>
    ) : null}
    {down.length === 0 ? null : (
    <div className="degraded" role="status" data-testid="degraded">
      {down.includes('paypal') ? <p><strong>PayPal is not answering.</strong> Requests are safe and keep their place. Mandate tries again by itself, and anything waiting on PayPal finishes when it is back.{status.data?.paypal?.lastError ? <span className="mono"> Last error: {status.data.paypal.lastError}.</span> : null}</p> : null}
      {down.includes('ai') ? <p><strong>The language model is cooling off.</strong> The rules, the ledger and every button still work. Ask and the drafter wait until it answers.</p> : null}
    </div>
    )}
    </>
  )
}
