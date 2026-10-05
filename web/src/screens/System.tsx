import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useGuide } from '../components/GuidedTour'
import { Chip, KV, Loading, PageHead } from '../components/ui'
import { api } from '../lib/api'
import { when } from '../lib/format'
import { useSession } from '../lib/hooks'
import { session } from '../lib/session'

export function System() {
  const health = useQuery({ queryKey: ['health'], queryFn: api.health })
  const ready = useQuery({ queryKey: ['ready'], queryFn: api.ready, refetchInterval: 20_000 })
  const me = useSession()
  const keys = useQuery({ queryKey: ['signing-keys'], queryFn: api.signingKeys })
  const guide = useGuide()
  const navigate = useNavigate()
  const client = useQueryClient()
  const lock = () => {
    session.clear()
    client.clear()
    navigate('/unlock', { replace: true })
  }
  return (
    <div className="page">
      <PageHead eyebrow="System" title="This server">
        <button type="button" className="btn btn-ghost" onClick={() => guide.start('welcome')}>Take the full tour</button>
        <button type="button" className="btn btn-ghost" onClick={lock}>Lock console</button>
      </PageHead>
      <div className="rules-grid">
        <section className="panel" data-tour="system-checks">
          <h2 className="panel-title">Checks</h2>
          {ready.isLoading ? <Loading /> : null}
          <ul className="checks">
            <li><span>Process</span><Chip tone={health.data?.status === 'pass' ? 'auto' : 'deny'}>{health.data?.status ?? '…'}</Chip></li>
            {Object.entries(ready.data?.checks ?? {}).map(([name, results]) => (
              <li key={name}>
                <span className="mono">{name}</span>
                <Chip tone={results[0]?.status === 'pass' ? 'auto' : results[0]?.status === 'warn' ? 'need' : 'deny'}>{results[0]?.observedValue ?? results[0]?.status}</Chip>
                <span className="muted small">{when(results[0]?.time)}</span>
              </li>
            ))}
          </ul>
          <p className="fine">Readiness only fails when the ledger cannot be read. Missing PayPal credentials are a warning: the rules still decide, nothing settles.</p>
        </section>
        <section className="panel" data-tour="system-console">
          <h2 className="panel-title">This console</h2>
          <div className="kvs">
            <KV label="Key">{me.data?.role === 'owner' ? 'Owner · can approve, settle, change rules' : 'Proposer · can ask and read'}</KV>
            <KV label="API version" mono>{me.data?.version ?? '—'}</KV>
            <KV label="PayPal">{me.data?.paypalConfigured ? 'Sandbox credentials set' : 'Not configured'}</KV>
            <KV label="Agents">{me.data?.agents.enabled ? `On · ${me.data.agents.model}` : 'Off · set OLLAMA_API_KEY'}</KV>
            <KV label="Origin" mono>{location.origin}</KV>
            <KV label="Offline">App shell only. Money calls are never cached or queued.</KV>
          </div>
          <div className="kvs" data-tour="system-keys">
            {(keys.data?.data ?? []).map((key) => (
              <KV key={key.keyId} label={key.current ? 'Signing key' : 'Retired key'} mono>{key.keyId} · {key.publicKeyBase64Url.slice(0, 16)}…</KV>
            ))}
          </div>
          <a className="btn btn-ghost" href="/openapi.json" target="_blank" rel="noreferrer">OpenAPI 3.1 contract ↗</a>
        </section>
      </div>
    </div>
  )
}
