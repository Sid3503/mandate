import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useWarrant } from '../lib/hooks'
import type { Job } from '../lib/types'
import { Chip, ProblemCard } from './ui'

/**
 * Give one person a read-only page about this job, so they stop asking "has the client paid?". The link is shown once.
 * It shows only that person's part of the job, expires, and can be withdrawn here.
 */
export function JobShares({ job }: { job: Job }) {
  const client = useQueryClient()
  const warrant = useWarrant()
  const shares = useQuery({ queryKey: ['shares', job.jobId], queryFn: () => api.shares(job.jobId) })
  const people = [
    ...(job.client ? [{ id: job.client.id, name: `${job.client.displayName} (client)` }] : []),
    ...(warrant.data?.payees ?? []).map((payee) => ({ id: payee.id, name: `${payee.displayName} (contractor)` })),
  ]
  const [partyId, setPartyId] = useState('')
  const [days, setDays] = useState('30')
  const [made, setMade] = useState<{ url: string; name: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const chosen = partyId || people[0]?.id || ''
  const create = useMutation({
    mutationFn: () => api.createShare(job.jobId, { partyId: chosen, ttlDays: Number(days) }),
    onSuccess: (result) => {
      setMade({ url: result.url, name: result.share.partyName })
      setCopied(false)
      void client.invalidateQueries({ queryKey: ['shares', job.jobId] })
    },
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeShare(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['shares', job.jobId] }),
  })
  const copy = async () => {
    if (!made) return
    try {
      await navigator.clipboard.writeText(made.url)
      setCopied(true)
    } catch {
      /* clipboard blocked: the link is selectable on screen */
    }
  }
  const error = create.error ?? revoke.error ?? shares.error
  return (
    <section className="section" data-testid="job-shares" aria-labelledby="h-shares">
      <h2 className="section-title" id="h-shares">Share this job</h2>
      <p className="fine">Send a contractor or the client a read-only page. They see only their own part of the job: no totals, no rules, nobody else. They can look; they cannot ask, approve or pay.</p>
      <div className="row gap-s wrap share-form">
        <label className="field"><span>Who</span>
          <select value={chosen} onChange={(event) => setPartyId(event.target.value)} disabled={people.length === 0}>
            {people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Expires after</span>
          <select value={days} onChange={(event) => setDays(event.target.value)}>
            <option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option>
          </select>
        </label>
        <button type="button" className="btn btn-ink" disabled={!chosen || create.isPending} onClick={() => create.mutate()}>Create link</button>
      </div>
      {made ? (
        <div className="draft-added" role="status" data-testid="share-made">
          <strong>Copy this link for {made.name}. It is shown once.</strong>
          <pre className="mono small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{made.url}</pre>
          <button type="button" className="btn btn-ghost btn-small" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</button>
        </div>
      ) : null}
      <ProblemCard error={error instanceof ApiError ? error : null} />
      {shares.data && shares.data.data.length > 0 ? (
        <ul className="share-owner-list">
          {shares.data.data.map((share) => (
            <li key={share.id} className="row between wrap gap-s">
              <span><strong>{share.partyName}</strong> <span className="muted small">· {share.role} · {share.views} view{share.views === 1 ? '' : 's'} · expires {new Date(share.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span></span>
              <span className="row gap-s">
                <Chip tone={share.active ? 'auto' : 'muted'}>{share.revokedAt ? 'withdrawn' : share.active ? 'active' : 'expired'}</Chip>
                {share.active ? <button type="button" className="btn btn-ghost btn-small" onClick={() => revoke.mutate(share.id)} disabled={revoke.isPending}>Withdraw</button> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
