import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { BadgeCheck, ShieldAlert } from 'lucide-react'
import { Mark } from '../components/Shell'
import { Chip } from '../components/ui'
import { parseKeys, verifyReceipt, type PublicKey, type Receipt, type Verdict } from '../lib/verify'

/**
 * Check a receipt without asking Mandate. No key is needed and nothing is sent anywhere: the receipt is read in the
 * browser, the lock is recomputed, and the signatures are checked against the public keys. This page is public on
 * purpose: an accountant or a client should be able to check a receipt they were sent.
 */
export function Verify() {
  const location = useLocation()
  const given = (location.state as { receipt?: unknown } | null)?.receipt
  const [text, setText] = useState(given ? JSON.stringify(given, null, 2) : '')
  const [keysText, setKeysText] = useState('')
  const [keys, setKeys] = useState<PublicKey[] | null>(null)
  const [keysNote, setKeysNote] = useState('Fetching this server’s public keys…')
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
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
      setVerdict(await verifyReceipt(receipt, use))
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
          <div className="row gap-s wrap">
            <button type="button" className="btn btn-ink btn-big" disabled={!text.trim() || busy} onClick={() => void run()}>{busy ? 'Checking…' : 'Verify this receipt'}</button>
            <label className="btn btn-ghost">Choose a file<input type="file" accept="application/json,.json" className="sr-only" onChange={(event) => void onFile(event)} /></label>
          </div>
          {error ? <p role="alert" className="verify-error">{error}</p> : null}
        </section>

        {verdict ? (
          <section className={`verdict ${verdict.ok ? 'ok' : 'bad'}`} role="status" data-testid="verdict">
            <div>
              <span className="eyebrow">{verdict.ok ? 'Verified' : 'Does not verify'}</span>
              <h2>{verdict.ok ? 'This receipt is genuine.' : 'Do not rely on this receipt.'}</h2>
              <ul className="verify-checks">
                {verdict.checks.map((check) => (
                  <li key={check.id} className={check.ok ? 'ok' : 'bad'}>
                    {check.ok ? <BadgeCheck size={18} aria-hidden="true" /> : <ShieldAlert size={18} aria-hidden="true" />}
                    <div><strong>{check.label}</strong><span>{check.detail}</span></div>
                  </li>
                ))}
              </ul>
            </div>
            <Chip tone={verdict.ok ? 'auto' : 'deny'}>{verdict.ok ? 'verified' : 'failed'}</Chip>
          </section>
        ) : null}

        <section className="panel">
          <h2 className="panel-title">The public keys</h2>
          <p className="fine">{keysNote} To be sure a server is not lying to you about its own keys, paste the keys you were given separately, or published somewhere else (for example in the repository or the Devpost page). If you paste any, they are used instead.</p>
          <label className="sr-only" htmlFor="keys-json">Public keys JSON</label>
          <textarea id="keys-json" rows={4} value={keysText} spellCheck={false} placeholder='{ "data": [ { "keyId": "…", "publicKeyBase64Url": "…" } ] }' onChange={(event) => setKeysText(event.target.value)} />
        </section>

        <section className="panel">
          <h2 className="panel-title">What this proves, and what it does not</h2>
          <p className="fine"><strong>It proves</strong> that the payee, amount, currency, category, proof link, job and funding on the receipt are exactly what the owner approved, that the Mandate server’s key signed that, and (when present) that the client’s own agent signed its acceptance of exactly the proof that was billed.</p>
          <p className="fine"><strong>It does not prove</strong> that PayPal moved the money. Check the PayPal ids on the receipt in PayPal. The checker is one short file, <code>web/src/lib/verify.ts</code>, and it runs in your browser.</p>
        </section>
      </main>
    </div>
  )
}
