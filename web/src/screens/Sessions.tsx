import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Loading, PageHead, ProblemCard } from '../components/ui'
import { api } from '../lib/api'
import { when } from '../lib/format'

export function Sessions() {
  const client = useQueryClient()
  const [codes, setCodes] = useState<string[] | null>(null)
  const [savedCodes, setSavedCodes] = useState(false)
  const me = useQuery({ queryKey: ['auth-me'], queryFn: api.authMe, retry: false })
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions })
  const events = useQuery({ queryKey: ['auth-events'], queryFn: api.authEvents, enabled: me.data?.role === 'owner', retry: false })
  const revoke = useMutation({
    mutationFn: (publicId: string) => api.revokeSession(publicId),
    onSuccess: () => client.invalidateQueries({ queryKey: ['sessions'] }),
  })
  const others = useMutation({
    mutationFn: () => api.revokeOtherSessions(),
    onSuccess: () => client.invalidateQueries({ queryKey: ['sessions'] }),
  })
  const issue = useMutation({ mutationFn: () => api.issueRecovery(), onSuccess: (body) => { setCodes(body.codes); setSavedCodes(false) } })
  const ack = useMutation({ mutationFn: () => api.ackRecovery(), onSuccess: () => { setCodes(null); setSavedCodes(true) } })
  const replace = useMutation({ mutationFn: () => api.regenerateRecovery(), onSuccess: (body) => { setCodes(body.codes); setSavedCodes(false) } })
  const keys = useQuery({ queryKey: ['credentials'], queryFn: api.credentials, retry: false })
  const addKey = useMutation({
    mutationFn: () => api.addCredential(),
    onSuccess: () => client.invalidateQueries({ queryKey: ['credentials'] }),
  })
  const dropKey = useMutation({
    mutationFn: (id: string) => api.revokeCredential(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['credentials'] }),
  })
  if (sessions.isLoading) return <div className="page"><Loading label="Loading sessions" /></div>
  if (sessions.isError) return <div className="page"><PageHead eyebrow="Account" title="Sessions" /><ProblemCard error={sessions.error} onRetry={() => void sessions.refetch()} /></div>
  const rows = sessions.data?.sessions ?? []
  return (
    <div className="page">
      <PageHead eyebrow="Account" title="Sessions">
        <button type="button" className="btn btn-ink" onClick={() => others.mutate()} disabled={others.isPending}>End other sessions</button>
      </PageHead>
      {rows.length === 0 ? <p className="panel">No sessions on this account.</p> : (
        <ul className="stack-l">
          {rows.map((row) => (
            <li key={row.publicId} className="panel" data-testid="session-row">
              <p><strong>{row.current ? 'This session' : 'Other session'}</strong> · {row.method} · {row.revoked ? 'ended' : 'active'}</p>
              <p className="fine">Started {when(row.at)}. Last seen {when(row.lastSeen)}.</p>
              {row.current || row.revoked ? null : (
                <button type="button" className="btn btn-ghost btn-small" onClick={() => revoke.mutate(row.publicId)}>End this session</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {revoke.isError ? <ProblemCard error={revoke.error} /> : null}
      <section className="panel" data-testid="passkeys">
        <h2 className="panel-title">Passkeys</h2>
        <p className="fine">The last passkey stays. Add another before you remove one.</p>
        {keys.isLoading ? <Loading label="Loading passkeys" /> : null}
        {keys.isError ? <ProblemCard error={keys.error} /> : null}
        <ul className="stack-l">
          {(keys.data?.credentials ?? []).filter((row) => !row.revoked).map((row) => (
            <li key={row.id} data-testid="passkey-row">
              <p className="mono">{row.fingerprint}</p>
              <button type="button" className="btn btn-ghost btn-small" onClick={() => dropKey.mutate(row.id)} disabled={dropKey.isPending}>Remove</button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn btn-ink btn-small" onClick={() => addKey.mutate()} disabled={addKey.isPending}>Add a passkey</button>
        {addKey.isError ? <ProblemCard error={addKey.error} /> : null}
        {dropKey.isError ? <ProblemCard error={dropKey.error} /> : null}
      </section>
      <section className="panel" data-testid="recovery-codes">
        <h2 className="panel-title">Recovery codes</h2>
        <p className="fine">Each code works once. A recovery session can add a passkey. It cannot approve or replace these codes.</p>
        {codes ? (
          <ol>{codes.map((code) => <li key={code} className="mono">{code}</li>)}</ol>
        ) : <p>{savedCodes ? 'Saved.' : 'No codes are showing.'}</p>}
        <div className="row gap-s wrap">
          <button type="button" className="btn btn-ghost btn-small" onClick={() => issue.mutate()} disabled={issue.isPending}>Create recovery codes</button>
          <button type="button" className="btn btn-ink btn-small" onClick={() => ack.mutate()} disabled={!codes || ack.isPending}>I saved these</button>
          <button type="button" className="btn btn-ghost btn-small" onClick={() => replace.mutate()} disabled={replace.isPending}>Replace recovery codes</button>
        </div>
        {issue.isError ? <ProblemCard error={issue.error} /> : null}
        {ack.isError ? <ProblemCard error={ack.error} /> : null}
        {replace.isError ? <ProblemCard error={replace.error} /> : null}
      </section>
      {me.data?.role === 'owner' ? (
        <section className="panel" data-testid="login-history">
          <h2 className="panel-title">Sign-in history</h2>
          {events.isLoading ? <Loading label="Loading history" /> : null}
          {events.isError ? <ProblemCard error={events.error} /> : null}
          {(events.data?.events ?? []).length === 0 && !events.isLoading ? <p>No sign-ins recorded yet.</p> : (
            <ul>
              {(events.data?.events ?? []).map((row) => (
                <li key={`${row.at}-${row.event}-${row.result}`}>{when(row.at)} · {row.event} · {row.result}</li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  )
}
