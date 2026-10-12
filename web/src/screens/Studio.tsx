import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Mark } from '../components/Shell'
import { ProblemCard } from '../components/ui'
import { ApiError, api } from '../lib/api'
import { session } from '../lib/session'

export function Studio() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [step, setStep] = useState<'name' | 'done'>('name')
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const passkeys = typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined'

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const started = await api.createStudio(name.trim())
      const registered = await startRegistration({ optionsJSON: started.options as never })
      const saved = await api.passkeyRegisterVerify({ challengeId: started.challengeId, response: registered })
      setFingerprint(saved.fingerprint)
      const login = await api.passkeyLoginOptions()
      const signed = await startAuthentication({ optionsJSON: login.options as never })
      const me = await api.passkeyLoginVerify({ challengeId: login.challengeId, response: signed })
      session.setWorkspace(me.workspaceId)
      session.setMode('studio')
      setStep('done')
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 404) {
        setError(new ApiError(404, caught.code, 'This door is off', 'Creating a studio is off on this server. Try the demo, or use a key.', caught.body))
      } else {
        setError(caught)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="unlock">
      <section className="unlock-hero">
        <div className="brand brand-lg"><Mark size={40} /><span>Mandate</span></div>
        <h1>Create your studio</h1>
        <p className="lede">Use Face ID or your device lock. No password. A new studio uses simulated PayPal. It does not charge the live sandbox.</p>
      </section>
      <section className="unlock-card">
        {passkeys ? null : <p>This browser cannot use passkeys. Try the demo, or use a key.</p>}
        {step === 'done' ? (
          <div className="stack">
            <h2>Studio ready</h2>
            <p>Save this</p>
            {fingerprint ? <p className="mono" data-testid="passkey-fingerprint">{fingerprint}</p> : null}
            <p>This is the fingerprint of the key that can sign. A receipt shows the first 8 characters. PayPal here is simulated. No real money. You can add a second passkey later from this browser. Recovery codes are not issued yet.</p>
            <button type="button" className="btn btn-lime btn-block" onClick={() => navigate('/')}>Open Today</button>
          </div>
        ) : (
          <form onSubmit={submit} className="stack">
            <label className="field">
              <span>Studio name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} required placeholder="Line Studio" />
            </label>
            <button className="btn btn-lime btn-block" type="submit" disabled={busy || !passkeys || name.trim().length < 2}>{busy ? 'Waiting for the passkey…' : 'Create and save a passkey'}</button>
            <ProblemCard error={error} />
          </form>
        )}
        <p className="fine"><Link to="/welcome" className="link">Back</Link></p>
      </section>
    </div>
  )
}
