import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PageHead } from '../components/ui'
import { api, ApiError } from '../lib/api'
import { useIsOwner } from '../lib/hooks'

/**
 * Where an app that signs in with a browser (Claude.ai, ChatGPT, Cursor) lands after /oauth/authorize. The owner is
 * already signed in to the console, so this is the one place a connection is approved. The server checks the request
 * again before it acts: nothing on this page is trusted by the server, it only reads what the owner chose.
 */
export function OAuthConsent() {
  const isOwner = useIsOwner()
  const [params] = useSearchParams()
  const query = params.toString()
  const info = useQuery({ queryKey: ['oauth-request', query], queryFn: () => api.oauthRequest(query), retry: false })
  const [grant, setGrant] = useState<'look' | 'ask'>('look')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isOwner) return <div className="page"><p className="panel">Only the owner can approve a connection.</p></div>

  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(true)
    setError(null)
    try {
      const sent = await api.oauthDecision({
        client_id: params.get('client_id') ?? '',
        redirect_uri: params.get('redirect_uri') ?? '',
        code_challenge: params.get('code_challenge') ?? '',
        ...(params.get('state') ? { state: params.get('state')! } : {}),
        ...(params.get('resource') ? { resource: params.get('resource')! } : {}),
        ...(params.get('scope') ? { scope: params.get('scope')! } : {}),
        decision,
        ...(decision === 'approve' ? { grant } : {}),
      })
      window.location.assign(sent.redirectTo)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.detail || caught.title : 'That did not go through. Nothing was approved.')
      setBusy(false)
    }
  }

  const readOnlyDoor = info.data?.resource.endsWith('/mcp/readonly') ?? false
  return (
    <div className="page" data-testid="oauth-consent">
      <PageHead eyebrow="Agents" title="Approve a connection" />
      {info.isLoading ? <p className="panel">Checking the request…</p> : null}
      {info.error ? (
        <section className="panel" data-testid="oauth-consent-invalid">
          <p><strong>This sign-in request cannot be approved.</strong></p>
          <p className="fine">{info.error instanceof ApiError ? info.error.detail || info.error.title : 'The request could not be read.'} Go back to the app and start the connection again.</p>
        </section>
      ) : null}
      {info.data ? (
        <section className="panel" aria-labelledby="h-oauth">
          <h2 className="panel-title" id="h-oauth"><span data-testid="oauth-client-name">{info.data.clientName}</span> wants to connect</h2>
          <p className="fine">If you approve, it is sent back to <code className="mono small" data-testid="oauth-redirect-host">{info.data.redirectHost}</code>. Approve only if you started this from that app just now.</p>
          <fieldset className="field" disabled={busy || readOnlyDoor}>
            <legend>What it may do</legend>
            <label className="row gap-s"><input type="radio" name="grant" checked={grant === 'look'} onChange={() => setGrant('look')} data-testid="oauth-grant-look" /> <span><strong>Look only.</strong> Read the rules, jobs and ledger, and ask for an explanation.</span></label>
            <label className="row gap-s"><input type="radio" name="grant" checked={grant === 'ask' && !readOnlyDoor} onChange={() => setGrant('ask')} data-testid="oauth-grant-ask" /> <span><strong>Look and ask.</strong> It can also file a request to pay or bill. Every request still goes through your rules, and one that needs you waits for your tap.</span></label>
          </fieldset>
          {readOnlyDoor ? <p className="fine">This connection is for the read-only door, so it can only look.</p> : null}
          <p className="fine">Whichever you pick, it cannot approve, send money or change the rules. You can end the connection any time from Connect an agent.</p>
          {error ? <p className="fine" role="alert" data-testid="oauth-consent-error">{error}</p> : null}
          <div className="row gap-s">
            <button type="button" className="btn btn-ink" data-testid="oauth-approve" disabled={busy} onClick={() => void decide('approve')}>{busy ? 'Working…' : 'Approve'}</button>
            <button type="button" className="btn" data-testid="oauth-deny" disabled={busy} onClick={() => void decide('deny')}>Not now</button>
          </div>
        </section>
      ) : null}
    </div>
  )
}
