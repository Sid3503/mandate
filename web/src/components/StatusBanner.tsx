import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'

/**
 * Says, at the top of every screen, when something Mandate depends on is not answering. It reads a cheap status route that
 * never calls PayPal itself, so it works exactly when PayPal does not. What it says is what is true: the rules still
 * decide, requests keep their place, and a sweep tries again by itself.
 */
export function StatusBanner() {
  const status = useQuery({ queryKey: ['status'], queryFn: api.status, refetchInterval: 15_000, retry: false })
  const down = status.data?.degraded ?? []
  if (status.isError && !status.data) {
    return <div className="degraded" role="status"><strong>Mandate could not be reached.</strong> What is on screen is the last thing it said. Nothing that moves money can be sent until it answers.</div>
  }
  if (down.length === 0) return null
  return (
    <div className="degraded" role="status" data-testid="degraded">
      {down.includes('paypal') ? <p><strong>PayPal is not answering.</strong> Requests are safe and keep their place. Mandate tries again by itself, and anything waiting on PayPal finishes when it is back.{status.data?.paypal?.lastError ? <span className="mono"> Last error: {status.data.paypal.lastError}.</span> : null}</p> : null}
      {down.includes('ai') ? <p><strong>The language model is cooling off.</strong> The rules, the ledger and every button still work. Ask and the drafter wait until it answers.</p> : null}
    </div>
  )
}
