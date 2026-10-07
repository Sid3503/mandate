import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useGuide } from '../components/GuidedTour'
import { FeaturePanel, ToolTiers } from '../components/PayPalFeatures'
import { Chip, KV, Loading, PageHead } from '../components/ui'
import { api } from '../lib/api'
import { when } from '../lib/format'
import { useIsOwner, useSession } from '../lib/hooks'
import { session } from '../lib/session'

export function System() {
  const health = useQuery({ queryKey: ['health'], queryFn: api.health })
  const ready = useQuery({ queryKey: ['ready'], queryFn: api.ready, refetchInterval: 20_000 })
  const me = useSession()
  const keys = useQuery({ queryKey: ['signing-keys'], queryFn: api.signingKeys })
  const owner = useIsOwner()
  const agents = useQuery({ queryKey: ['agent-health'], queryFn: api.agentHealth, enabled: owner, refetchInterval: 15_000 })
  const errors = useQuery({ queryKey: ['client-errors'], queryFn: api.clientErrors, enabled: owner, refetchInterval: 60_000 })
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
      <FeaturePanel />
      {owner && (errors.data?.data.length ?? 0) > 0 ? (
        <section className="panel" aria-labelledby="h-screen-errors">
          <h2 className="panel-title" id="h-screen-errors">Recent screen errors</h2>
          <p className="fine">Things that broke on a screen, as the console reported them. Each one was shown to the person as a card, not a blank page, and none of them sent anything to PayPal.</p>
          <ul className="runs">
            {errors.data!.data.slice(0, 8).map((row) => (
              <li key={row.id}><Chip tone="muted">{row.scope}</Chip> <span>{row.message.slice(0, 110)}</span> <span className="muted small">{when(row.at)} · {row.release ?? 'dev'}</span></li>
            ))}
          </ul>
        </section>
      ) : null}
      {owner && agents.data?.enabled ? (
        <section className="panel" aria-labelledby="h-ai-health">
          <h2 className="panel-title" id="h-ai-health">The AI layer</h2>
          <div className="kvs">
            <KV label="Clerk, negotiators, client's reviewer" mono>{agents.data.primary}</KV>
            <KV label="Rules drafter" mono>{agents.data.drafter}</KV>
            <KV label="Fallback" mono>{agents.data.fallback ?? 'none'}</KV>
            <KV label="Prompt versions" mono>{Object.entries(agents.data.prompts).map(([name, version]) => `${name} v${version}`).join(' · ')}</KV>
          </div>
          {agents.data.models.length === 0 ? <p className="fine">No model has been called since the server started.</p> : (
            <table className="diff ai-health">
              <thead><tr><th scope="col">Model</th><th scope="col">Circuit</th><th scope="col">Calls</th><th scope="col">Failed</th><th scope="col">Median</th><th scope="col">Slowest 5%</th><th scope="col">Tokens in / out</th></tr></thead>
              <tbody>
                {agents.data.models.map((model) => (
                  <tr key={model.name}>
                    <th scope="row" className="mono">{model.name}</th>
                    <td><Chip tone={model.circuit === 'closed' ? 'auto' : model.circuit === 'half_open' ? 'need' : 'deny'}>{model.circuit === 'closed' ? 'healthy' : model.circuit === 'half_open' ? 'testing' : 'cooling off'}</Chip></td>
                    <td>{model.calls}</td>
                    <td>{model.failures}{model.lastError ? <span className="muted small"> · {model.lastError}</span> : null}</td>
                    <td>{model.p50Ms === null ? '—' : `${(model.p50Ms / 1000).toFixed(1)} s`}</td>
                    <td>{model.p95Ms === null ? '—' : `${(model.p95Ms / 1000).toFixed(1)} s`}</td>
                    <td className="mono">{model.inputTokens.toLocaleString('en-US')} / {model.outputTokens.toLocaleString('en-US')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="fine">A model that fails three times in a row is paused for 30 seconds and the fallback answers instead, so nobody waits through a failure that is coming. The rules are the same whichever model asks.</p>
        </section>
      ) : null}
      <ToolTiers />
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
            <KV label="Agents">{me.data?.agents.enabled ? `On · ${me.data.agents.model}` : 'Off · set BEDROCK_API_KEY'}</KV>
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
