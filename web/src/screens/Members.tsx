import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Loading, PageHead, ProblemCard } from '../components/ui'
import { api } from '../lib/api'

const ROLES = ['owner', 'approver', 'proposer', 'viewer', 'payee'] as const

export function Members() {
  const client = useQueryClient()
  const [openRequests, setOpenRequests] = useState<string[]>([])
  const members = useQuery({ queryKey: ['members'], queryFn: api.members, retry: false })
  const role = useMutation({
    mutationFn: (input: { id: string; role: string }) => api.setMemberRole(input.id, input.role),
    onSuccess: () => client.invalidateQueries({ queryKey: ['members'] }),
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeMember(id),
    onSuccess: (body) => {
      setOpenRequests(body.openRequests)
      void client.invalidateQueries({ queryKey: ['members'] })
    },
  })
  if (members.isLoading) return <div className="page"><Loading label="Loading members" /></div>
  if (members.isError) return <div className="page"><PageHead eyebrow="Account" title="Members" /><ProblemCard error={members.error} onRetry={() => void members.refetch()} /></div>
  const rows = members.data?.members ?? []
  return (
    <div className="page">
      <PageHead eyebrow="Account" title="Members" />
      <section data-testid="members">
        {rows.length === 0 ? <p className="panel">No members in this studio.</p> : (
          <ul className="stack-l">
            {rows.map((row) => (
              <li key={row.id} className="panel" data-testid="member-row">
                <p><strong>{row.name}</strong> · {row.role} · {row.status}</p>
                {row.status === 'active' ? (
                  <p>
                    <label className="field">
                      <span>Role</span>
                      <select aria-label={`Role for ${row.name}`} value={row.role} disabled={role.isPending} onChange={(event) => role.mutate({ id: row.id, role: event.target.value })}>
                        {ROLES.map((item) => <option key={item} value={item}>{item}</option>)}
                      </select>
                    </label>
                    <button type="button" className="btn btn-ghost btn-small" onClick={() => revoke.mutate(row.id)} disabled={revoke.isPending}>Revoke</button>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {role.isError ? <ProblemCard error={role.error} /> : null}
        {revoke.isError ? <ProblemCard error={revoke.error} /> : null}
        {openRequests.length > 0 ? (
          <div className="panel" data-testid="open-requests">
            <h2 className="panel-title">Open requests</h2>
            <ul>{openRequests.map((id) => <li key={id} className="mono">{id}</li>)}</ul>
          </div>
        ) : null}
      </section>
    </div>
  )
}
