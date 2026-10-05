import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Chip, Loading, ProblemCard } from './ui'
import { api } from '../lib/api'
import { useIsOwner } from '../lib/hooks'
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
      <ProblemCard error={features.error ?? check.error} />
    </section>
  )
}
