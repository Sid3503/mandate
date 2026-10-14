import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Mark } from '../components/Shell'
import { Chip, ProblemCard } from '../components/ui'
import { api } from '../lib/api'
import { session } from '../lib/session'

export function Unlock() {
  const navigate = useNavigate()
  const where = useLocation()
  const client = useQueryClient()
  const ready = useQuery({ queryKey: ['ready'], queryFn: api.ready, retry: false })
  const [key, setKey] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const from = (where.state as { from?: string } | null)?.from ?? '/'
  const flags = useQuery({ queryKey: ['flags'], queryFn: api.flags, staleTime: 60_000 })

  const roleLanding = (role?: string, side?: string | null) => {
    if (role === 'proposer') return '/clerk'
    if (role === 'viewer') return '/proof'
    if (role === 'payee') return '/payments'
    if (side === 'buyer') return '/deals'
    return '/'
  }

  const handlePayPalLogin = async () => {
    setBusy(true)
    setError(null)
    try {
      const start = await api.paypalLoginStart()
      const result = await api.paypalLoginCallback('mock_auth_code', start.state)
      session.setWorkspace(result.workspaceId)
      session.setMode('studio')
      client.clear()
      const target = from !== '/' && from !== '/app' && from !== '/app/' ? from : roleLanding(result.role)
      navigate(target, { replace: true })
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  const signIn = async () => {
    setBusy(true)
    setError(null)
    try {
      const me = await api.signInWithPasskey()
      session.setWorkspace(me.workspaceId)
      session.setMode('studio')
      try { localStorage.removeItem('mandate.session.expired') } catch {}
      client.clear()
      const target = from !== '/' && from !== '/app' && from !== '/app/' ? from : roleLanding(me.role)
      navigate(target, { replace: true })
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const me = await api.session(key.trim())
      session.set(key.trim())
      try { localStorage.removeItem('mandate.session.expired') } catch {}
      client.clear()
      client.setQueryData(['session'], me)
      const target = from !== '/' && from !== '/app' && from !== '/app/' ? from : (session.mode() === 'demo' ? roleLanding(me.role, me.side) : '/')
      navigate(target, { replace: true })
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  const db = ready.data?.checks['sqlite:read']?.[0]?.status
  const paypal = ready.data?.checks['paypal:credentials']?.[0]?.status

  const isExpired = Boolean(
    (where.state as { reason?: string } | null)?.reason === 'expired' ||
    where.search.includes('expired') ||
    (typeof localStorage !== 'undefined' && localStorage.getItem('mandate.session.expired') === '1')
  )
  const passkeys = typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined'

  return (
    <div className="unlock">
      <section className="unlock-hero">
        <div className="brand brand-lg"><Mark size={40} /><span>Mandate</span></div>
        <h1>Agents can ask.<br /><span className="hl">Only you can pay.</span></h1>
        <p className="lede">The owner console for the rules server. Approve with one tap, settle through PayPal, and keep a receipt for every dollar.</p>
        <ul className="unlock-facts">
          <li><span className="mono">01</span>Every request is judged by the rules in plain code. Not by a model.</li>
          <li><span className="mono">02</span>Your tap locks payee, cents, category and proof into one hash.</li>
          <li><span className="mono">03</span>A contractor is paid only from client money already settled.</li>
        </ul>
      </section>
      <section className="unlock-card" aria-labelledby="unlock-title">
        <div className="unlock-status">
          <span className="eyebrow">This server</span>
          <div className="row gap-s wrap">
            <Chip tone={ready.isError ? 'deny' : db === 'pass' ? 'auto' : 'muted'}>{ready.isLoading ? 'Checking…' : db === 'pass' ? 'Ledger ready' : 'Ledger not ready'}</Chip>
            <Chip tone={paypal === 'pass' ? 'auto' : 'muted'}>{paypal === 'pass' ? 'PayPal sandbox' : 'PayPal not set'}</Chip>
            {ready.data ? <Chip tone="muted">v{ready.data.version}</Chip> : null}
          </div>
        </div>
        {!passkeys ? (
          <div className="panel" data-testid="unsupported-webauthn" style={{ marginBottom: 16 }}>
            <p className="fine">This browser does not support WebAuthn passkeys. Unlock using an API key below, or try in a modern browser.</p>
          </div>
        ) : null}
        {isExpired && passkeys ? (
          <div className="stack gap-s" style={{ marginBottom: 20 }} data-testid="expired-session-box">
            <div className="row between align-center">
              <span className="eyebrow" style={{ margin: 0 }}>Session expired</span>
              <Chip tone="need">Biometric unlock</Chip>
            </div>
            <p className="fine" style={{ margin: 0 }}>Your session ended. Unlock with Face ID or your device passkey to continue.</p>
            <button
              type="button"
              className="btn btn-lime btn-block"
              data-testid="unlock-faceid-btn"
              onClick={() => void signIn()}
              disabled={busy}
            >
              {busy ? 'Scanning biometric…' : 'Unlock with Face ID'}
            </button>
          </div>
        ) : null}
        <form onSubmit={submit} className="stack">
          <h2 id="unlock-title">Unlock</h2>
          <label className="field">
            <span>API key</span>
            <input
              type="password"
              autoComplete="current-password"
              spellCheck={false}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="Owner or proposer key"
              required
              minLength={8}
            />
            <small>Kept only in this tab. Closing the tab locks the console.</small>
          </label>
          <button className="btn btn-lime btn-block" type="submit" disabled={busy || key.trim().length < 8}>
            {busy ? 'Checking key…' : 'Unlock console'}
          </button>
          <ProblemCard error={error} />
        </form>
        <button type="button" className="btn btn-ghost btn-block" onClick={() => void signIn()} disabled={busy}>
          {busy ? 'Waiting for the passkey…' : 'Sign in with a passkey'}
        </button>
        {flags.data?.paypalLogin ? (
          <button type="button" className="btn btn-outline btn-block" data-testid="paypal-login-btn" onClick={() => void handlePayPalLogin()} disabled={busy}>
            Log in with PayPal
          </button>
        ) : null}
        <p className="fine"><Link to="/welcome" className="link">← What is Mandate?</Link></p>
        <p className="fine">A key is authority. Owner, staff, client, and agent keys each see only their side.</p>
        <p className="fine">The owner key can approve, settle and change the rules. A proposer key, the kind an agent gets, can only ask and read.</p>
      </section>
    </div>
  )
}
