import { useMutation } from '@tanstack/react-query'
import { BadgeCheck, ShieldAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import type { DealCheck, LockCheck } from '../lib/types'
import { Chip } from './ui'

/**
 * A signed lock or deal, with a button that asks the server to check it again from scratch.
 * "Signed" alone is a claim. The button turns it into evidence: the hash still recomputes from the stored fields,
 * and the signature verifies against the server's public key.
 */
export function Signature({ kind, id, signature, keyId, receipt }: { kind: 'lock' | 'deal'; id: string; signature: string | null; keyId: string | null; receipt?: unknown }) {
  const check = useMutation<LockCheck | DealCheck>({ mutationFn: () => (kind === 'lock' ? api.verifyLock(id) : api.verifyDeal(id)) })
  const result = check.data
  const good = result?.verdict === 'valid'
  return (
    <div className="sig">
      <div className="row between gap-s wrap">
        <span className="eyebrow">Server signature · Ed25519</span>
        <button type="button" className="btn btn-ghost btn-small" disabled={!signature || check.isPending} onClick={() => check.mutate()}>
          {check.isPending ? 'Checking…' : 'Verify'}
        </button>
      </div>
      {signature ? <code className="sig-text" title={signature}>{signature.slice(0, 44)}…</code> : <p className="fine">Not signed yet.</p>}
      {keyId ? <p className="fine">Key <span className="mono">{keyId}</span>. Public keys are at <a href="/.well-known/mandate-keys.json" target="_blank" rel="noreferrer">/.well-known/mandate-keys.json</a>.</p> : null}
      {receipt ? <p className="fine"><Link to="/verify" state={{ receipt }} className="link">Check it in your browser instead, without asking this server →</Link></p> : null}
      {result ? (
        <div className={`sig-result ${good ? 'ok' : 'bad'}`} role="status">
          {good ? <BadgeCheck size={18} aria-hidden="true" /> : <ShieldAlert size={18} aria-hidden="true" />}
          <span>
            {good
              ? `Valid. The ${kind === 'lock' ? 'amounts and payee' : 'terms'} still match what was signed, and only this server’s key could have signed them.`
              : 'Does not verify. The record was changed after it was signed, so it will not be sent to PayPal.'}
          </span>
        </div>
      ) : null}
      {check.error ? <Chip tone="deny">could not check</Chip> : null}
    </div>
  )
}
