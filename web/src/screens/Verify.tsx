import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { BadgeCheck, ShieldAlert } from 'lucide-react'
import { Mark } from '../components/Shell'
import { Chip } from '../components/ui'
import { parseKeys, verifyMandateToken, verifyReceipt, type MandateVerdict, type PublicKey, type Receipt, type Verdict } from '../lib/verify'

/**
 * Check a receipt or a mandate without asking Mandate. No key is needed and nothing is sent anywhere: the receipt
 * is read in the browser, the lock is recomputed, and the signatures are checked against the public keys. This page
 * is public on purpose: an accountant or a client should be able to check a receipt or a mandate they were sent.
 */
export function Verify() {
  const location = useLocation()
  const given = (location.state as { receipt?: unknown } | null)?.receipt
  const [text, setText] = useState(given ? JSON.stringify(given, null, 2) : '')
  const [keysText, setKeysText] = useState('')
  const [keys, setKeys] = useState<PublicKey[] | null>(null)
  const [keysNote, setKeysNote] = useState('Fetching this server’s public keys…')
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [mandateText, setMandateText] = useState('')
  const [mandateVerdict, setMandateVerdict] = useState<MandateVerdict | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [fingerprint, setFingerprint] = useState('')
  const ran = useRef(false)

  useEffect(() => {
    let live = true
    fetch('/.well-known/mandate-keys.json', { cache: 'no-store' })
      .then((response) => response.json())
      .then((json) => {
        if (!live) return
        const found = parseKeys(json)
        setKeys(found)
        setKeysNote(found.length > 0 ? `${found.length} public key${found.length === 1 ? '' : 's'} loaded from this server.` : 'This server returned no keys. Paste them below.')
      })
      .catch(() => live && setKeysNote('Could not fetch keys from this server. Paste them below.'))
    return () => { live = false }
  }, [])

  const run = async (source = text) => {
    setError(null)
    setVerdict(null)
    let receipt: Receipt
    try {
      receipt = JSON.parse(source) as Receipt
    } catch {
      setError('That is not valid JSON. Paste the whole file from a receipt’s Download button.')
      return
    }
    let use = keys ?? []
    if (keysText.trim()) {
      try {
        use = parseKeys(JSON.parse(keysText))
      } catch {
        setError('The public keys are not valid JSON. Paste the body of /.well-known/mandate-keys.json.')
        return
      }
    }
    setBusy(true)
    try {
      setVerdict(await verifyReceipt(receipt, use, { fingerprint }))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (given && keys && !ran.current) { ran.current = true; void run(JSON.stringify(given)) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys])

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const content = await file.text()
    setText(content)
    void run(content)
  }

  const runMandate = async (source = mandateText) => {
    setError(null)
    setMandateVerdict(null)
    let use = keys ?? []
    if (keysText.trim()) {
      try {
        use = parseKeys(JSON.parse(keysText))
      } catch {
        setError('The public keys are not valid JSON. Paste the body of /.well-known/mandate-keys.json.')
        return
      }
    }
    setBusy(true)
    try {
      setMandateVerdict(await verifyMandateToken(source, use))
    } finally {
      setBusy(false)
    }
  }

  const mandateClaims = (verdict: MandateVerdict): Array<[string, string]> => {
    const payload = verdict.payload
    if (!payload) return []
    const closed = payload.vct === 'mandate.payment.closed.1'
    const payee = payload.payee as { displayName?: string; id?: string } | undefined
    const lines: Array<[string, string]> = [
      [closed ? 'It authorizes' : 'It is the standing rule for', `${payee?.displayName ?? payee?.id ?? 'unknown'}${closed ? ` · ${payload.amountCents as number} ${String(payload.currency ?? '')}` : ''}`],
      ['Signed', `key ${String((verdict.check.detail.match(/key (\S+)\./) ?? [])[1] ?? 'on the mandate')}`],
    ]
    if (closed) lines.push(['The payment it came from', `cart hash ${String(payload.sub ?? 'none').slice(0, 16)}…`])
    else lines.push(['Its limits', `share ${((payload.limits as { shareBps?: number } | undefined)?.shareBps ?? 0) / 100}% · monthly cap ${(payload.limits as { monthlyCapCents?: number } | undefined)?.monthlyCapCents ?? 0} cents`])
    return lines
  }

  return (
    <div className="verify-page">
      <header className="verify-top">
        <Link to="/welcome" className="brand"><Mark size={26} /><span>Mandate</span></Link>
        <Link to="/" className="link">Open the console</Link>
      </header>
      <main className="verify-main" id="main">
        <p className="eyebrow">Check a receipt without trusting the server</p>
        <h1>Verify a receipt</h1>
        <p className="lead">Paste the file from a receipt’s <strong>Download</strong> button. Your browser recomputes the lock from the fields and checks the signatures against the server’s public keys. Nothing is uploaded, and no key is needed.</p>

        <section className="panel" aria-labelledby="h-receipt">
          <h2 className="panel-title" id="h-receipt">The receipt</h2>
          <label className="sr-only" htmlFor="receipt-json">Receipt JSON</label>
          <textarea id="receipt-json" rows={10} value={text} spellCheck={false} placeholder='{ "proposal": { … }, "lock": { "hash": "…", "signature": "…", "keyId": "…" } }' onChange={(event) => setText(event.target.value)} />
          <label className="field">
            <span>Fingerprint you saved</span>
            <input data-testid="typed-fingerprint" value={fingerprint} spellCheck={false} onChange={(event) => setFingerprint(event.target.value)} placeholder="Optional. Leave blank to check the key on the receipt." />
          </label>
          <div className="row gap-s wrap">
            <button type="button" className="btn btn-ink btn-big" disabled={!text.trim() || busy} onClick={() => void run()}>{busy ? 'Checking…' : 'Verify this receipt'}</button>
            <label className="btn btn-ghost">Choose a file<input type="file" accept="application/json,.json" className="sr-only" onChange={(event) => void onFile(event)} /></label>
          </div>
          {error ? <p role="alert" className="verify-error">{error}</p> : null}
        </section>

        {verdict ? (
          <section className={`verdict ${verdict.ok ? 'ok' : 'bad'}`} role="status" data-testid="verdict">
            <div>
              <div className="row gap-s" style={{ alignItems: 'center', marginBottom: '0.25rem' }}>
                <span className="eyebrow">{verdict.ok ? 'Cryptographic Proof Valid' : 'Verification Failed'}</span>
                <span style={{ fontWeight: 800, letterSpacing: '0.05em', color: verdict.ok ? '#22c55e' : '#ef4444' }}>
                  {verdict.ok ? '✓ GENUINE' : '✗ TAMPERED'}
                </span>
              </div>
              <h2>{verdict.ok ? 'This receipt is authentic and unmodified.' : 'Do not rely on this receipt.'}</h2>
              <ul className="verify-checks">
                {verdict.checks.map((check) => (
                  <li key={check.id} className={check.ok ? 'ok' : 'bad'}>
                    {check.ok ? <BadgeCheck size={18} aria-hidden="true" /> : <ShieldAlert size={18} aria-hidden="true" />}
                    <div><strong>{check.label}</strong><span>{check.detail}</span></div>
                  </li>
                ))}
              </ul>
            </div>
            <Chip tone={verdict.ok ? 'auto' : 'deny'}>{verdict.ok ? 'GENUINE' : 'TAMPERED'}</Chip>
          </section>
        ) : null}

        <section className="panel" aria-labelledby="h-mandate">
          <h2 className="panel-title" id="h-mandate">Or verify a mandate</h2>
          <p className="fine">A mandate is the signed statement of what was authorized: a <strong>closed mandate</strong> is one exact locked payment, an <strong>open mandate</strong> is a standing rule with its limits. An agent that hands you a token can be checked the same way as a receipt: your browser checks the EdDSA signature against the public keys and shows the claims. Nothing is uploaded.</p>
          <label className="sr-only" htmlFor="mandate-token">Mandate token</label>
          <textarea id="mandate-token" rows={4} value={mandateText} spellCheck={false} placeholder="eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6IuKApn0.eyJ2Y3QiOiLigKZ9.…" onChange={(event) => setMandateText(event.target.value)} />
          <div className="row gap-s wrap">
            <button type="button" className="btn btn-ink btn-big" disabled={!mandateText.trim() || busy} onClick={() => void runMandate()}>{busy ? 'Checking…' : 'Verify this mandate'}</button>
          </div>
          {mandateVerdict ? (
            <section className={`verdict ${mandateVerdict.ok ? 'ok' : 'bad'}`} role="status" data-testid="mandate-verdict">
              <div>
                <span className="eyebrow">{mandateVerdict.ok ? 'Verified' : 'Does not verify'}</span>
                <h2>{mandateVerdict.ok ? 'This mandate is genuine.' : 'Do not rely on this mandate.'}</h2>
                <ul className="verify-checks">
                  <li className={mandateVerdict.check.ok ? 'ok' : 'bad'}>
                    {mandateVerdict.check.ok ? <BadgeCheck size={18} aria-hidden="true" /> : <ShieldAlert size={18} aria-hidden="true" />}
                    <div><strong>{mandateVerdict.check.label}</strong><span>{mandateVerdict.check.detail}</span></div>
                  </li>
                </ul>
                {mandateVerdict.ok && mandateClaims(mandateVerdict).length > 0 ? (
                  <dl className="mandate-claims">
                    {mandateClaims(mandateVerdict).map(([term, detail]) => <div key={term}><dt>{term}</dt><dd>{detail}</dd></div>)}
                  </dl>
                ) : null}
              </div>
              <Chip tone={mandateVerdict.ok ? 'auto' : 'deny'}>{mandateVerdict.ok ? 'verified' : 'failed'}</Chip>
            </section>
          ) : null}
        </section>

        <section className="panel">
          <h2 className="panel-title">The public keys</h2>
          <p className="fine">{keysNote} To be sure a server is not lying to you about its own keys, paste the keys you were given separately, or published somewhere else (for example in the repository or the Devpost page). If you paste any, they are used instead.</p>
          <label className="sr-only" htmlFor="keys-json">Public keys JSON</label>
          <textarea id="keys-json" rows={4} value={keysText} spellCheck={false} placeholder='{ "data": [ { "keyId": "…", "publicKeyBase64Url": "…" } ] }' onChange={(event) => setKeysText(event.target.value)} />
        </section>

        <section className="panel">
          <h2 className="panel-title">What this proves, and what it does not</h2>
          <p className="fine"><strong>It proves</strong> that the payee, amount, currency, category, proof link, job and funding on the receipt are exactly what was locked, that the Mandate server’s key signed that, and (when present) that the client’s own agent signed its acceptance of exactly the proof that was billed. A passkey line, when the receipt has one, is checked as a signature by the key on the receipt. A mandate token is checked the same way: the EdDSA signature against the public keys, with the claims it carries shown above. An algorithm this page does not know says "cannot verify here".</p>
          <p className="fine"><strong>It does not prove</strong> that PayPal moved the money. Check the PayPal ids on the receipt in PayPal. The checker is one short file, <code>web/src/lib/verify.ts</code>, and it runs in your browser.</p>
        </section>
      </main>
    </div>
  )
}
