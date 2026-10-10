import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { ProblemCard } from './ui'

const PHRASE = 'reset the demo'

/**
 * Only on a server that was started as a hosted sandbox demo. It puts the ledger back to a fresh Line Studio so the next
 * person starts clean. It keeps every key, and it is a typed phrase away from being pressed, never one tap.
 */
export function DemoReset() {
  const client = useQueryClient()
  const navigate = useNavigate()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const ready = typed.trim().toLowerCase() === PHRASE
  const reset = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.resetDemo()
      await client.invalidateQueries()
      setTyped('')
      navigate('/')
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : null)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="panel" aria-labelledby="h-demo-reset" data-testid="demo-reset">
      <h2 className="panel-title" id="h-demo-reset">Start the demo over</h2>
      <p className="fine">This server is a hosted sandbox demo. Resetting puts the ledger, deals, deliveries and rules back to a fresh Line Studio, so the next person starts clean. Keys stay valid. Money already moved in the PayPal sandbox stays where it is. This cannot be undone.</p>
      <div className="row gap-s wrap share-form">
        <label className="field"><span>Type “{PHRASE}” to enable the button</span><input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} /></label>
        <button type="button" className="btn btn-ink" disabled={!ready || busy} onClick={() => void reset()}>{busy ? 'Resetting…' : 'Reset the demo'}</button>
      </div>
      <ProblemCard error={error} />
    </section>
  )
}
