import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Mark } from '../components/Shell'
import { ProblemCard } from '../components/ui'
import { api } from '../lib/api'
import { session } from '../lib/session'

const ROLE: Record<string, string> = {
  owner: 'An owner can approve.',
  approver: 'An approver can approve up to a limit. An approver cannot publish rules.',
  proposer: 'Staff can ask. Staff cannot approve.',
  viewer: 'A viewer can read. A viewer cannot ask or approve.',
  payee: 'A payee can read their own payments. A payee cannot approve.',
}

export function Join() {
  const navigate = useNavigate()
  const token = typeof window === 'undefined' ? '' : (window.location.hash.match(/(?:^#|[?&])t=([^&]+)/)?.[1] ?? '')
  const [name, setName] = useState('')
  const [preview, setPreview] = useState<{ workspaceId: string; name: string; role: string; inviter: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const look = async () => {
    setBusy(true)
    setError(null)
    try {
      setPreview(await api.joinPreview(decodeURIComponent(token)))
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  const accept = async (event: FormEvent) => {
    event.preventDefault()
    if (!preview) return
    setBusy(true)
    setError(null)
    try {
      const joined = await api.join(preview.workspaceId, decodeURIComponent(token), name.trim())
      session.setWorkspace(joined.workspaceId)
      session.setMode('studio')
      navigate('/')
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="unlock">
      <section className="unlock-hero">
        <div className="brand brand-lg"><Mark size={40} /><span>Mandate</span></div>
        <h1>Join a studio</h1>
        <p className="lede">The invite stays in this page. It is not sent as a query string.</p>
      </section>
      <section className="unlock-card">
        {token ? null : <p>This page needs an invite link.</p>}
        {preview ? (
          <form onSubmit={accept} className="stack">
            <h2>You were invited to {preview.name}</h2>
            <p data-testid="invite-who">Invited by {preview.inviter ?? 'the studio'}.</p>
            <p data-testid="invite-role">{ROLE[preview.role] ?? 'This role can read.'}</p>
            <label className="field">
              <span>Your name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} required minLength={1} maxLength={80} />
            </label>
            <button className="btn btn-lime btn-block" type="submit" disabled={busy || name.trim().length < 1}>{busy ? 'Joining…' : 'Accept invite'}</button>
          </form>
        ) : (
          <button type="button" className="btn btn-lime btn-block" onClick={look} disabled={busy || !token}>{busy ? 'Checking the invite…' : 'Show this invite'}</button>
        )}
        <ProblemCard error={error} />
        <p className="fine"><Link to="/welcome" className="link">Back</Link></p>
      </section>
    </div>
  )
}
