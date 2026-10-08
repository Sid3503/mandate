import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useGuide } from '../components/GuidedTour'
import { FeaturePanel, ToolTiers } from '../components/PayPalFeatures'
import { Chip, KV, Loading, PageHead } from '../components/ui'
import { api, ApiError } from '../lib/api'
import type { AgentRow, AgentScope } from '../lib/types'
import { when } from '../lib/format'
import { useIsOwner, useSession } from '../lib/hooks'
import { session } from '../lib/session'

const SCOPE_WORDS: Record<AgentScope, string> = { read: 'read', propose: 'propose', stream: 'live stream', mcp: 'MCP door', deals: 'deals' }

function AgentKeys() {
  const client = useQueryClient()
  const rows = useQuery({ queryKey: ['agent-keys'], queryFn: api.agents, refetchInterval: 30_000 })
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<AgentScope[]>(['read', 'propose'])
  const [perHour, setPerHour] = useState('60')
  const [centsPerHour, setCentsPerHour] = useState('')
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    try {
      const limits: { proposalsPerHour?: number; centsPerHour?: number } = {}
      const n = Number(perHour); if (n > 0) limits.proposalsPerHour = n
      const c = Number(centsPerHour); if (centsPerHour !== '' && c >= 0) limits.centsPerHour = Math.round(c * 100)
      const created = await api.createAgent({ name, scopes, ...(Object.keys(limits).length ? { limits } : {}) })
      setNewKey({ name: created.agent.name, key: created.apiKey })
      setName('')
      await client.invalidateQueries({ queryKey: ['agent-keys'] })
    } catch (e) { setError(e as ApiError) }
  }
  const act = async (action: 'revoke' | 'resume', agent: AgentRow) => {
    setError(null)
    try {
      if (action === 'revoke') await api.revokeAgent(agent.id)
      else await api.resumeAgent(agent.id)
      await client.invalidateQueries({ queryKey: ['agent-keys'] })
    } catch (e) { setError(e as ApiError) }
  }
  return (
    <section className="panel" aria-labelledby="h-agents" data-testid="agent-keys-panel">
      <h2 className="panel-title" id="h-agents">Agent keys</h2>
      <p className="fine">Each agent gets its own key, its own scopes, and its own hourly limits. The owner key keeps full control; agent keys can never approve, publish rules, or pause.
        A key that trips the breaker is suspended until you resume it.</p>
      {newKey ? (
        <div className="draft-added" role="alert">
          <strong>Copy this key now. It is shown once and never again.</strong>
          <pre className="mono small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{newKey.key}</pre>
        </div>
      ) : null}
      {error ? <p className="draft-added" role="alert">{error.title}: {error.detail}</p> : null}
      <form className="draft-form" onSubmit={submit}>
        <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nightly invoice sweep" required /></label>
        <fieldset>
          <legend>Scopes</legend>
          {(['read', 'propose', 'stream', 'mcp', 'deals'] as AgentScope[]).map((s) => (
            <label key={s} className="check" style={{ marginRight: 12 }}>
              <input type="checkbox" checked={scopes.includes(s)} onChange={() => setScopes((cur) => cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s])} /> {SCOPE_WORDS[s]}
            </label>
          ))}
        </fieldset>
        <label className="field"><span>Proposals per hour</span><input inputMode="numeric" value={perHour} onChange={(e) => setPerHour(e.target.value)} /></label>
        <label className="field"><span>Max asked value per hour ($)</span><input inputMode="decimal" placeholder="2500" value={centsPerHour} onChange={(e) => setCentsPerHour(e.target.value)} /></label>
        <button type="submit" className="btn btn-ink" disabled={!name.trim() || scopes.length === 0}>Create agent key</button>
      </form>
      <div className="table-wrap" style={{ marginTop: 12 }}>
        {rows.data && rows.data.length > 0 ? (
          <table className="diff runs">
            <thead><tr><th scope="col">Name</th><th scope="col">Scopes</th><th scope="col">Status</th><th scope="col">Last seen</th><th scope="col">Hourly limit</th><th scope="col">Actions</th></tr></thead>
            <tbody>
              {rows.data.map((agent) => (
                <tr key={agent.id}>
                  <th scope="row">{agent.name}</th>
                  <td>{agent.scopes.map((s) => SCOPE_WORDS[s]).join(', ')}</td>
                  <td><Chip tone={agent.status === 'active' ? 'auto' : agent.status === 'suspended' ? 'need' : 'deny'}>{agent.status}</Chip></td>
                  <td className="fine">{agent.lastSeenAt ? when(agent.lastSeenAt) : 'never'}</td>
                  <td className="fine">{agent.limits.proposalsPerHour}/h · ${(agent.limits.centsPerHour / 100).toLocaleString()}</td>
                  <td className="row gap-s">
                    {agent.status === 'suspended' ? <button type="button" className="btn btn-ghost btn-small" onClick={() => act('resume', agent)}>Resume</button> : null}
                    {agent.status !== 'revoked' ? <button type="button" className="btn btn-ghost btn-small" onClick={() => act('revoke', agent)}>Revoke</button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="fine">{rows.isLoading ? 'Loading…' : rows.data ? 'No agent keys yet. Create one above.' : 'Could not load agents.'}</p>}
      </div>
    </section>
  )
}

export function System() {
  const health = useQuery({ queryKey: ['health'], queryFn: api.health })
  const ready = useQuery({ queryKey: ['ready'], queryFn: api.ready, refetchInterval: 20_000 })
  const me = useSession()
  const keys = useQuery({ queryKey: ['signing-keys'], queryFn: api.signingKeys })
  const owner = useIsOwner()
  const agents = useQuery({ queryKey: ['agent-health'], queryFn: api.agentHealth, enabled: owner, refetchInterval: 15_000 })
  const safety = useQuery({ queryKey: ['safety'], queryFn: api.safety, refetchInterval: 30_000 })
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
      {safety.data ? (
        <section className="panel" aria-labelledby="h-safety" data-testid="safety-panel">
          <h2 className="panel-title" id="h-safety">Emergency stop and breaker</h2>
          <div className="kvs">
            <KV label="State">{safety.data.paused ? `Paused · ${safety.data.reason ?? ''}` : 'Running'}</KV>
            <KV label="Breaker">{safety.data.breaker.tripAfter === 0 ? 'Off' : `Pauses itself after ${safety.data.breaker.tripAfter} refusals from one key in ${Math.round(safety.data.breaker.windowSeconds / 60)} minutes`}</KV>
            <KV label="What counts">Requests the rules never allow (an unknown payee, a changed cart, an unlisted kind of work). Asking early, or without a proof link, does not.</KV>
          </div>
          <p className="fine">The owner’s Pause button does the same by hand. While paused nothing automatic runs, every agent is refused, and the Proof page checks that nothing did. The owner’s own requests wait for a tap.</p>
          {safety.data.events.length === 0 ? <p className="fine">Mandate has never been paused.</p> : (
            <ul className="runs">
              {safety.data.events.slice(0, 8).map((event) => (
                <li key={event.id}><Chip tone={event.type === 'paused' ? 'deny' : 'auto'}>{event.type}</Chip> <span>{event.by === 'breaker' ? 'by the breaker' : 'by the owner'}{event.reason ? ` · ${event.reason}` : ''}</span> <span className="muted small">{when(event.at)} · {event.signed ? 'signed ✓' : 'NOT SIGNED'}</span></li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {owner ? <AgentKeys /> : null}
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
