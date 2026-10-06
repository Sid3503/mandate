import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Chip, KV, Loading, ProblemCard } from './ui'
import { api } from '../lib/api'
import { useIsOwner } from '../lib/hooks'
import { dollars } from '../lib/money'
import type { Feature } from '../lib/types'

export function useFeatures() {
  return useQuery({ queryKey: ['paypal-features'], queryFn: api.features, staleTime: 60_000, enabled: true })
}

/** The dashboard steps that turn one PayPal feature on. Shown wherever a feature is missing, so the owner is never left guessing. */
export function EnableSteps({ feature }: { feature: Feature }) {
  const client = useQueryClient()
  const check = useMutation({ mutationFn: api.checkFeatures, onSuccess: (data) => client.setQueryData(['paypal-features'], data) })
  const now = check.data?.features.find((item) => item.id === feature.id)
  return (
    <div className="enable">
      {now?.enabled ? (
        <p className="fine"><Chip tone="auto">On now</Chip> PayPal reports {feature.label} is enabled. It works from the next request.</p>
      ) : (
        <>
          <p><strong>To turn on {feature.label}</strong>, in PayPal’s developer dashboard:</p>
          <ol className="how">{feature.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          <div className="row gap-s wrap">
            <a className="btn btn-ghost" href="https://developer.paypal.com/dashboard/applications/sandbox" target="_blank" rel="noreferrer noopener">Open PayPal dashboard ↗</a>
            <button type="button" className="btn btn-ink" disabled={check.isPending} onClick={() => check.mutate()}>{check.isPending ? 'Asking PayPal…' : 'Check again'}</button>
          </div>
          {check.isSuccess ? <p className="fine" role="status">Checked just now. {feature.label} is still off.</p> : null}
          <ProblemCard error={check.error} />
        </>
      )}
    </div>
  )
}

/** Every PayPal feature Mandate uses, and whether this app may use it yet. */
export function FeaturePanel() {
  const owner = useIsOwner()
  const features = useFeatures()
  const client = useQueryClient()
  const check = useMutation({ mutationFn: api.checkFeatures, onSuccess: (data) => client.setQueryData(['paypal-features'], data) })
  if (!owner) return null
  const data = check.data ?? features.data
  return (
    <section className="panel" data-tour="system-features">
      <div className="row between wrap gap-s">
        <h2 className="panel-title">PayPal features</h2>
        <button type="button" className="btn btn-ghost" disabled={check.isPending} onClick={() => check.mutate()}>{check.isPending ? 'Asking PayPal…' : 'Check again'}</button>
      </div>
      {features.isLoading ? <Loading /> : null}
      {data && !data.configured ? <p className="fine">PayPal credentials are not set, so nothing can be read.</p> : null}
      <ul className="features">
        {(data?.configured ? data.features : []).map((feature) => (
          <li key={feature.id}>
            <div className="row between wrap gap-s">
              <strong>{feature.label}</strong>
              <Chip tone={feature.enabled ? 'auto' : feature.core ? 'deny' : 'need'}>{feature.enabled ? 'On' : 'Off'}</Chip>
            </div>
            <p className="fine">{feature.enabled ? feature.usedFor : feature.without}</p>
            {!feature.enabled && feature.steps.length > 0 ? (
              <details>
                <summary>How to turn it on</summary>
                <EnableSteps feature={feature} />
              </details>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="fine">Read from the permissions PayPal put on this app’s access token, so it is what PayPal will actually allow{data?.checkedAt ? `, checked ${new Date(data.checkedAt).toLocaleTimeString('en-US')}` : ''}.</p>
      <BalanceNote />
      <ProblemCard error={features.error ?? check.error} />
    </section>
  )
}

const TIER_LABEL = { read: 'Read', propose: 'Propose only', out_of_scope: 'Not used' } as const

/** PayPal's Agent Toolkit has dozens of tools built for a model to call. This says what Mandate lets an agent reach: none. */
export function ToolTiers() {
  const owner = useIsOwner()
  const tools = useQuery({ queryKey: ['paypal-tools'], queryFn: api.tools, staleTime: 300_000, enabled: owner })
  if (!owner) return null
  const data = tools.data
  return (
    <section className="panel" data-tour="system-tools">
      <h2 className="panel-title">What an agent can reach in PayPal</h2>
      {tools.isLoading ? <Loading /> : null}
      {data ? (
        <>
          <p className="payout-lead"><strong>{data.agentCanCallDirectly} of PayPal’s {data.total} agent tools.</strong> An agent can only ask Mandate, and the rules answer.</p>
          <div className="kvs">
            <KV label="Read only">{data.read} tools: cannot change anything at PayPal</KV>
            <KV label="Propose only">{data.propose} tools: change state or move money, so only the rules and the owner can cause them</KV>
            <KV label="Not used">{data.outOfScope} tools: unrelated to billing a job</KV>
            <KV label="Called by the server">{data.usedByMandate} tools, from a locked cart or from PayPal itself. The server refuses any other.</KV>
          </div>
          <details>
            <summary>Every tool and why</summary>
            <ul className="features">
              {data.tools.map((tool) => (
                <li key={tool.name}>
                  <div className="row between wrap gap-s"><code>{tool.name}</code><span className="row gap-s"><Chip tone={tool.tier === 'read' ? 'auto' : tool.tier === 'propose' ? 'need' : 'muted'}>{TIER_LABEL[tool.tier]}</Chip>{tool.usedByMandate ? <Chip tone="ink">server uses it</Chip> : null}</span></div>
                  <p className="fine">{tool.area}. {tool.note}</p>
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : null}
      <ProblemCard error={tools.error} />
    </section>
  )
}

/** The account balance PayPal reports, as advice. It is a few hours old at best, so it warns but never decides. */
export function BalanceNote({ needCents }: { needCents?: number }) {
  const owner = useIsOwner()
  const balance = useQuery({ queryKey: ['paypal-balance'], queryFn: api.balance, staleTime: 120_000, enabled: owner })
  const data = balance.data
  if (!owner || !data || !data.available) return null
  const low = needCents !== undefined && data.availableCents < needCents
  return (
    <p className="fine" role="status">
      PayPal reports {dollars(data.availableCents, data.currency)} available{data.asOf ? `, as of ${new Date(data.asOf).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}. That report lags by hours, so treat it as a guide.
      {low ? <> <Chip tone="need">May be short</Chip> This payout is more than that balance. PayPal fails a payout it cannot fund, and Mandate will not count it as paid.</> : null}
    </p>
  )
}
