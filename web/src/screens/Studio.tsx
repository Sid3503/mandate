import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Mark } from '../components/Shell'
import { ProblemCard } from '../components/ui'
import { ApiError, api } from '../lib/api'
import { session } from '../lib/session'

const PROGRESS = 'mandate.studio.progress'

type WizardStep = 'name' | 'backup' | 'people' | 'rules' | 'done'
type Backup = 'none' | 'passkey' | 'codes'

type WizardProgress = {
  step: WizardStep
  name: string
  fingerprint: string | null
  backup: Backup
  /** The client this studio will bill, and the contractor it will pay. Empty until the owner types them. */
  clientName: string
  clientEmail: string
  payeeName: string
  payeeEmail: string
  /** What this studio does, in the owner's words. Empty until they type it. */
  work: string
  rules: string
  /** Which PayPal the studio moves money on. The server is asked anyway; this only keeps the screen honest between loads. */
  paypal: 'none' | 'fake' | 'sandbox' | 'live' | null
  /**
   * The studio this wizard opened. sessionStorage is per tab, so a tab opened later would not know which studio it is
   * in; the studio's own id is kept here, where every tab of this browser can find it.
   */
  workspace: string | null
}

const emptyProgress = (): WizardProgress => ({ step: 'name', name: '', fingerprint: null, backup: 'none', clientName: '', clientEmail: '', payeeName: '', payeeEmail: '', work: '', rules: '', paypal: null, workspace: null })

function named(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function pair(person: string, email: string): boolean {
  const address = email.trim()
  return person.trim().length >= 2 && address.includes('@') && address.includes('.')
}

/**
 * The cast, in the same sentences Rules gives the drafter. An address only ever comes from words the owner typed.
 * The server keeps these, so another browser can open Rules and still find this client and this contractor.
 */
function castText(input: { clientName: string; clientEmail: string; payeeName: string; payeeEmail: string; work: string }): string {
  const lines: string[] = []
  if (pair(input.clientName, input.clientEmail)) lines.push(`The client on this studio is ${input.clientName.trim()} (${input.clientEmail.trim()}).`)
  if (pair(input.payeeName, input.payeeEmail)) lines.push(`The contractor on this studio is ${input.payeeName.trim()} (${input.payeeEmail.trim()}).`)
  const work = input.work.trim()
  if (work.length >= 2) lines.push(`This studio does ${work}.`)
  return lines.join('\n')
}

function loadProgress(): WizardProgress {
  try {
    const raw = localStorage.getItem(PROGRESS)
    if (!raw) return emptyProgress()
    const parsed = JSON.parse(raw) as Partial<WizardProgress>
    const step = parsed.step
    if (step !== 'name' && step !== 'backup' && step !== 'people' && step !== 'rules' && step !== 'done') return emptyProgress()
    return {
      step,
      name: typeof parsed.name === 'string' ? parsed.name : '',
      fingerprint: typeof parsed.fingerprint === 'string' ? parsed.fingerprint : null,
      backup: parsed.backup === 'passkey' || parsed.backup === 'codes' ? parsed.backup : 'none',
      clientName: named(parsed.clientName),
      clientEmail: named(parsed.clientEmail),
      payeeName: named(parsed.payeeName),
      payeeEmail: named(parsed.payeeEmail),
      work: named(parsed.work),
      rules: typeof parsed.rules === 'string' ? parsed.rules : '',
      paypal: parsed.paypal === 'fake' || parsed.paypal === 'sandbox' || parsed.paypal === 'live' || parsed.paypal === 'none' ? parsed.paypal : null,
      workspace: typeof parsed.workspace === 'string' ? parsed.workspace : null,
    }
  } catch {
    return emptyProgress()
  }
}

/**
 * What the browser says, in the owner's words. A passkey fails for ordinary reasons: the person said no, the browser
 * would not make one on this address, or the device has none. None of that is the server's fault, and none of it is
 * worth showing as an exception.
 */
function passkeyProblem(error: unknown): string {
  const name = (error as { name?: string })?.name ?? ''
  const message = (error as { message?: string })?.message ?? ''
  if (name === 'SecurityError' || /invalid domain|not a registrable domain/i.test(message)) {
    return 'This browser would not make a passkey on this address. Open the console on localhost, not on an IP address, and try again.'
  }
  if (name === 'NotAllowedError') return 'The passkey was not made. It may have been cancelled, or this device has no passkey set up.'
  if (name === 'InvalidStateError') return 'This device already has a passkey for this account. Sign in with it instead.'
  if (name === 'NotSupportedError') return 'This browser cannot make a passkey. Try another browser, or use a key.'
  return 'The passkey could not be made in this browser. Nothing was sent.'
}

/** The truth about the PayPal this studio moves money on, taken from the server that owns the studio. */
function paypalWords(mode: 'none' | 'fake' | 'sandbox' | 'live' | null): string {
  if (mode === 'sandbox') {
    return 'PayPal here is this server’s PayPal sandbox account. It is real PayPal, running on test money: it never reaches live PayPal, and no card is charged.'
  }
  if (mode === 'live') {
    return 'PayPal here is a live PayPal account. Real money can move.'
  }
  if (mode === 'fake') {
    return 'PayPal here is simulated. No charge reaches PayPal. No real money moves.'
  }
  return 'PayPal here is not connected yet, so nothing can be charged.'
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
  const [clientName, setClientName] = useState(saved.clientName)
  const [clientEmail, setClientEmail] = useState(saved.clientEmail)
  const [payeeName, setPayeeName] = useState(saved.payeeName)
  const [payeeEmail, setPayeeEmail] = useState(saved.payeeEmail)
  const [work, setWork] = useState(saved.work)
  const [rules, setRules] = useState(saved.rules)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [paypal, setPaypal] = useState<'none' | 'fake' | 'sandbox' | 'live' | null>(saved.paypal)
  const [kept, setKept] = useState(false)
  const [workspace, setWorkspace] = useState<string | null>(saved.workspace)
  const passkeys = typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined'

  useEffect(() => {
    const body: WizardProgress = { step, name, fingerprint, backup, clientName, clientEmail, payeeName, payeeEmail, work, rules, paypal, workspace }
    localStorage.setItem(PROGRESS, JSON.stringify(body))
  }, [step, name, fingerprint, backup, clientName, clientEmail, payeeName, payeeEmail, work, rules, paypal, workspace])

  /**
   * The studio's PayPal, from the server that owns it. The screen never guesses: a reload, an old tab or a cleared
   * cache cannot make it claim a payment is simulated when it is not.
   *
   * Only this wizard's studio is asked. A tab that is signed into the demo must not have that demo written over the
   * studio this browser already opened.
   */
  const askServer = useCallback(async () => {
    const target = workspace
    if (!target) return
    session.setWorkspace(target)
    session.setMode('studio')
    const me = await api.authMe().catch(() => null)
    // A cookie for another studio must not drop this id. The next save signs into this studio first.
    if (!me || me.workspaceId !== target) return
    session.setMode('studio')
    const answer = await api.session().catch(() => null)
    if (!answer) return
    const mode = answer.paypalMode
    if (mode === 'sandbox' || mode === 'live' || mode === 'fake' || mode === 'none') setPaypal(mode)
    if (answer.studioName && !name) setName(answer.studioName)
  }, [workspace, name])

  useEffect(() => { void askServer() }, [askServer, step])

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
      setWorkspace(me.workspaceId)
      setStep('backup')
      // The server says which PayPal this studio moves money on; the screen takes its word for it.
      await askServer()
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 404) {
        setError(new ApiError(404, caught.code, 'This door is off', 'Creating a studio is off on this server. Try the demo, or use a key.', caught.body))
      } else if (caught instanceof ApiError) {
        setError(caught)
      } else {
        setError(new Error(passkeyProblem(caught)))
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
      setStep('people')
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new Error(passkeyProblem(caught)))
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
      setStep('people')
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Open the studio this wizard made. The button used to go to Today in whatever workspace the tab already held,
   * so a tab that had started the demo opened the demo. If that other session is the one in the cookie, sign this
   * studio back in first.
   */
  const enterStudio = async (to: string) => {
    if (!workspace) {
      setError(new Error('This browser has no studio to open. Create one, then open it from that step.'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      session.setWorkspace(workspace)
      session.setMode('studio')
      const me = await api.authMe().catch(() => null)
      if (me?.workspaceId !== workspace) {
        const login = await api.passkeyLoginOptions()
        const signed = await startAuthentication({ optionsJSON: login.options as never })
        const who = await api.passkeyLoginVerify({ challengeId: login.challengeId, response: signed })
        session.setWorkspace(who.workspaceId)
        session.setMode('studio')
        setWorkspace(who.workspaceId)
      }
      navigate(to)
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new Error(passkeyProblem(caught)))
    } finally {
      setBusy(false)
    }
  }

  const another = () => {
    setStep('name')
    setName('')
    setFingerprint(null)
    setBackup('none')
    setClientName('')
    setClientEmail('')
    setPayeeName('')
    setPayeeEmail('')
    setWork('')
    setRules('')
    setCodes(null)
    setPaypal(null)
    setKept(false)
    setWorkspace(null)
    setError(null)
  }

  /**
   * The cookie and this wizard can disagree: a reload, another studio, or a cleared tab. The names are saved only
   * after the passkey's studio is the one the request is sent to.
   */
  const signIntoStudio = async (): Promise<void> => {
    const target = workspace
    if (target) {
      session.setWorkspace(target)
      session.setMode('studio')
      const me = await api.authMe().catch(() => null)
      if (me?.workspaceId === target) return
    }
    // Ask on the outer server. A studio id that no longer exists must not hide the passkey.
    const held = session.workspace()
    session.clearWorkspace()
    try {
      const login = await api.passkeyLoginOptions()
      const signed = await startAuthentication({ optionsJSON: login.options as never })
      const who = await api.passkeyLoginVerify({ challengeId: login.challengeId, response: signed })
      session.setWorkspace(who.workspaceId)
      session.setMode('studio')
      setWorkspace(who.workspaceId)
    } catch (caught) {
      if (held) session.setWorkspace(held)
      throw caught instanceof ApiError ? caught : new Error(passkeyProblem(caught))
    }
  }

  /** The client and the contractor, kept on this studio before any rule is published. */
  const keepPeople = async () => {
    const text = castText({ clientName, clientEmail, payeeName, payeeEmail, work })
    if (!text) {
      setStep('rules')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await signIntoStudio()
      await api.saveRuleWords(text)
      setStep('rules')
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  /** The sentence, with the people already named, so the Rules screen starts from both. */
  const saveWords = async () => {
    const sentence = rules.trim()
    const cast = castText({ clientName, clientEmail, payeeName, payeeEmail, work })
    const text = cast && !sentence.includes('The client on this studio is') ? `${sentence}\n\n${cast}` : sentence
    if (text.length > 1000) {
      setError(new Error('Keep the rule under 1000 characters, including the people you named.'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await signIntoStudio()
      await api.saveRuleWords(text)
      setKept(true)
      setStep('done')
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
        <p className="lede">Use Face ID or your device lock. No password. The studio starts empty: your name, your passkey, the client you bill, the contractor you pay, what you do, then the rule you write. Invoices and autopay come after that rule is published. PayPal is the account this server uses.</p>
      </section>
      <section className="unlock-card">
        {passkeys ? null : <p>This browser cannot use passkeys. Try the demo, or use a key.</p>}
        {step === 'name' ? (
          <form onSubmit={submit} className="stack">
            <label className="field">
              <span>Studio name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} required placeholder="Harbor Studio" />
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
              <p>{paypalWords(paypal)}</p>
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
        {step === 'people' ? (
          <form className="stack" data-testid="studio-people" onSubmit={(event) => { event.preventDefault(); void keepPeople() }}>
            <h2>Who you bill, and who you pay</h2>
            <p>Name the one client who pays this studio, and the one contractor you assign the work to and pay from that money. The next step is the rule that says when. Invoices, shares, and who can be paid without a tap come after you publish that rule.</p>
            <label className="field">
              <span>Client you bill</span>
              <input value={clientName} onChange={(event) => setClientName(event.target.value)} placeholder="Harbor Foods" autoComplete="organization" />
            </label>
            <label className="field">
              <span>Client email</span>
              <input type="email" value={clientEmail} onChange={(event) => setClientEmail(event.target.value)} placeholder="accounts@client.com" autoComplete="email" />
            </label>
            <label className="field">
              <span>Contractor you pay</span>
              <input value={payeeName} onChange={(event) => setPayeeName(event.target.value)} placeholder="Ava Chen" autoComplete="name" />
            </label>
            <label className="field">
              <span>Contractor email</span>
              <input type="email" value={payeeEmail} onChange={(event) => setPayeeEmail(event.target.value)} placeholder="ava@studio.com" autoComplete="email" />
            </label>
            <label className="field">
              <span>What you do</span>
              <input value={work} onChange={(event) => setWork(event.target.value)} placeholder="Logo and brand design" maxLength={120} />
            </label>
            <button className="btn btn-lime btn-block" type="submit" disabled={busy || !pair(clientName, clientEmail) || !pair(payeeName, payeeEmail)}>{busy ? 'Saving…' : 'Continue'}</button>
            <button type="button" className="btn btn-ghost btn-block" onClick={() => setStep('rules')} disabled={busy}>Skip for now</button>
            <ProblemCard error={error} />
          </form>
        ) : null}
        {step === 'rules' ? (
          <form className="stack" data-testid="studio-rules" onSubmit={(event) => { event.preventDefault(); void saveWords() }}>
            <h2>The rule, in your words</h2>
            <p>{pair(clientName, clientEmail) && pair(payeeName, payeeEmail)
              ? `${clientName.trim()} pays ${name || 'you'}. You pay ${payeeName.trim()} from that money. Say when that may happen. Nothing is published yet.`
              : 'Say the rule you want, in your own words. They are kept on the server, and nothing is published yet.'}</p>
            <label className="field">
              <span>Rules in words</span>
              <textarea value={rules} onChange={(event) => setRules(event.target.value)} maxLength={1000} rows={4} />
            </label>
            <button className="btn btn-lime btn-block" type="submit" disabled={busy || rules.trim().length < 3}>{busy ? 'Keeping them…' : 'Save these words'}</button>
            <button type="button" className="btn btn-ghost btn-block" onClick={() => setStep('done')} disabled={busy}>Skip rules</button>
            <ProblemCard error={error} />
          </form>
        ) : null}
        {step === 'done' ? (
          <div className="stack" data-testid="studio-done">
            <h2>{name.trim() ? `${name.trim()} is ready` : 'You can open Today'}</h2>
            <p data-testid="paypal-sim">{paypalWords(paypal)}</p>
            {pair(clientName, clientEmail) && pair(payeeName, payeeEmail) ? (
              <>
                <p data-testid="studio-cast">You bill {clientName.trim()}. You pay {payeeName.trim()}{work.trim().length >= 2 ? ` for ${work.trim()}` : ''}. Nothing moves until you publish the rule.</p>
                <ol className="rule-list" data-testid="studio-phases">
                  <li>Publish the rule. It names who you bill, who you pay, and when money may move.</li>
                  <li>Set the least {name.trim() || 'this studio'} will take, on Deals. {clientName.trim()} sets the most they will pay with their own key.</li>
                  <li>Bill {clientName.trim()}. Pay {payeeName.trim()} from that money. A deal is optional.</li>
                  <li>After the first payment, say who is paid with no tap. That is autopilot.</li>
                </ol>
              </>
            ) : (
              <p>Name the client and the contractor on Rules. Nothing can be invoiced or paid until both are there.</p>
            )}
            {backup === 'passkey' ? <p>A second passkey is on this account.</p> : <p>Recovery codes are saved.</p>}
            {kept ? (
              <div className="panel wip-note" role="status" data-testid="studio-words-kept">
                <p><strong>Your words are kept.</strong> They are on the server, and the Rules screen starts from them.</p>
                <button type="button" className="btn btn-ink btn-block" onClick={() => void enterStudio('/rules')} disabled={busy}>Write your rules →</button>
              </div>
            ) : (
              <p>You have no rules yet, so nothing can be asked for, approved or paid until you write them.</p>
            )}
            <button type="button" className="btn btn-lime btn-block" onClick={() => void enterStudio(kept ? '/' : '/rules')} disabled={busy}>{busy ? 'Opening your studio…' : kept ? 'Open Today' : 'Write the rules'}</button>
            {kept ? null : <button type="button" className="btn btn-ink btn-block" onClick={() => void enterStudio('/')} disabled={busy}>Open Today</button>}
            <button type="button" className="btn btn-ghost btn-block" onClick={another} disabled={busy}>Create another studio</button>
          </div>
        ) : null}
        <p className="fine"><Link to="/welcome" className="link">Back</Link></p>
      </section>
    </div>
  )
}
