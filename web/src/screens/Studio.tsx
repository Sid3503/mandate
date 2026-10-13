import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Mark } from '../components/Shell'
import { ProblemCard } from '../components/ui'
import { ApiError, api } from '../lib/api'
import { session } from '../lib/session'

const PROGRESS = 'mandate.studio.progress'

type WizardStep = 'name' | 'backup' | 'rules' | 'done'
type Backup = 'none' | 'passkey' | 'codes'

type WizardProgress = {
  step: WizardStep
  name: string
  fingerprint: string | null
  backup: Backup
  rules: string
}

const emptyProgress = (): WizardProgress => ({ step: 'name', name: '', fingerprint: null, backup: 'none', rules: '' })

function loadProgress(): WizardProgress {
  try {
    const raw = localStorage.getItem(PROGRESS)
    if (!raw) return emptyProgress()
    const parsed = JSON.parse(raw) as Partial<WizardProgress>
    const step = parsed.step
    if (step !== 'name' && step !== 'backup' && step !== 'rules' && step !== 'done') return emptyProgress()
    return {
      step,
      name: typeof parsed.name === 'string' ? parsed.name : '',
      fingerprint: typeof parsed.fingerprint === 'string' ? parsed.fingerprint : null,
      backup: parsed.backup === 'passkey' || parsed.backup === 'codes' ? parsed.backup : 'none',
      rules: typeof parsed.rules === 'string' ? parsed.rules : '',
    }
  } catch {
    return emptyProgress()
  }
}

export function Studio() {
  const navigate = useNavigate()
  const saved = loadProgress()
  const [name, setName] = useState(saved.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [step, setStep] = useState<WizardStep>(saved.step)
  const [fingerprint, setFingerprint] = useState<string | null>(saved.fingerprint)
  const [backup, setBackup] = useState<Backup>(saved.backup)
  const [rules, setRules] = useState(saved.rules)
  const [codes, setCodes] = useState<string[] | null>(null)
  const passkeys = typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined'

  useEffect(() => {
    const body: WizardProgress = { step, name, fingerprint, backup, rules }
    localStorage.setItem(PROGRESS, JSON.stringify(body))
  }, [step, name, fingerprint, backup, rules])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const started = await api.createStudio(name.trim())
      const registered = await startRegistration({ optionsJSON: started.options as never })
      const verified = await api.passkeyRegisterVerify({ challengeId: started.challengeId, response: registered })
      setFingerprint(verified.fingerprint)
      const login = await api.passkeyLoginOptions()
      const signed = await startAuthentication({ optionsJSON: login.options as never })
      const me = await api.passkeyLoginVerify({ challengeId: login.challengeId, response: signed })
      session.setWorkspace(me.workspaceId)
      session.setMode('studio')
      setStep('backup')
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

  const addSecond = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.addCredential()
      setBackup('passkey')
      setStep('rules')
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  const issueCodes = async () => {
    setBusy(true)
    setError(null)
    try {
      const issued = await api.issueRecovery()
      setCodes(issued.codes)
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  const ackCodes = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.ackRecovery()
      setCodes(null)
      setBackup('codes')
      setStep('rules')
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
        <h1>Create your studio</h1>
        <p className="lede">Use Face ID or your device lock. No password. A new studio uses simulated PayPal. It does not charge the live sandbox.</p>
      </section>
      <section className="unlock-card">
        {passkeys ? null : <p>This browser cannot use passkeys. Try the demo, or use a key.</p>}
        {step === 'name' ? (
          <form onSubmit={submit} className="stack">
            <label className="field">
              <span>Studio name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} required placeholder="Line Studio" />
            </label>
            <button className="btn btn-lime btn-block" type="submit" disabled={busy || !passkeys || name.trim().length < 2}>{busy ? 'Waiting for the passkey…' : 'Create and save a passkey'}</button>
            <ProblemCard error={error} />
          </form>
        ) : null}
        {step === 'backup' ? (
          <div className="stack" data-testid="studio-backup">
            <h2>Studio ready</h2>
            <p>Save this</p>
            {fingerprint ? <p className="mono" data-testid="passkey-fingerprint">{fingerprint}</p> : null}
            <p>This is the fingerprint of the key that can sign. A receipt shows the first 8 characters.</p>
            <div className="panel" data-testid="paypal-sim">
              <h2 className="panel-title">PayPal</h2>
              <p>PayPal here is simulated. No charge reaches PayPal. No real money moves.</p>
            </div>
            <p>Add a second passkey, or save recovery codes, before you open Today. One key is not enough.</p>
            {codes ? (
              <div data-testid="wizard-codes">
                <ol>{codes.map((code) => <li key={code} className="mono">{code}</li>)}</ol>
                <button type="button" className="btn btn-lime btn-block" onClick={() => void ackCodes()} disabled={busy}>I saved these</button>
              </div>
            ) : (
              <>
                <button type="button" className="btn btn-ink btn-block" onClick={() => void addSecond()} disabled={busy}>Add a second passkey</button>
                <button type="button" className="btn btn-ghost btn-block" onClick={() => void issueCodes()} disabled={busy}>Create recovery codes</button>
              </>
            )}
            <ProblemCard error={error} />
          </div>
        ) : null}
        {step === 'rules' ? (
          <form className="stack" data-testid="studio-rules" onSubmit={(event) => { event.preventDefault(); setStep('done') }}>
            <h2>Rules in words</h2>
            <p>Write the rule you want, or skip it. Nothing is published yet.</p>
            <label className="field">
              <span>Rules in words</span>
              <textarea value={rules} onChange={(event) => setRules(event.target.value)} maxLength={1000} rows={4} />
            </label>
            <button className="btn btn-lime btn-block" type="submit">Save these words</button>
            <button type="button" className="btn btn-ghost btn-block" onClick={() => setStep('done')}>Skip rules</button>
          </form>
        ) : null}
        {step === 'done' ? (
          <div className="stack" data-testid="studio-done">
            <h2>You can open Today</h2>
            <p data-testid="paypal-sim">PayPal here is simulated. No charge reaches PayPal. No real money moves.</p>
            {backup === 'passkey' ? <p>A second passkey is on this account.</p> : <p>Recovery codes are saved.</p>}
            <button type="button" className="btn btn-lime btn-block" onClick={() => navigate('/')}>Open Today</button>
          </div>
        ) : null}
        <p className="fine"><Link to="/welcome" className="link">Back</Link></p>
      </section>
    </div>
  )
}
