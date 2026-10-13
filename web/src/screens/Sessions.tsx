import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loading, PageHead, ProblemCard } from '../components/ui'
import { api } from '../lib/api'
import { when } from '../lib/format'

export function Sessions() {
  const client = useQueryClient()
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
