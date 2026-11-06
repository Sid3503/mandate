import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { lazy, Suspense, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Chip, Empty, Loading, PageHead, ProblemCard } from '../components/ui'
import { useIsOwner } from '../lib/hooks'
import { wholeMoney } from '../lib/money'
import { projectsApi, STAGE_WORDS, when, type ProjectsSummary } from '../lib/projects'
import { relative } from '../lib/format'

const StageLedger = lazy(() => import('../components/StageLedger'))

/**
 * The freelancer's first screen for two-sided work: one sentence of money, then every project and its stages. Held
 * money is shown apart from banked money, because a hold is still the client's until they approve.
 */
export function Projects() {
  const summary = useQuery({ queryKey: ['projects'], queryFn: projectsApi.summary, refetchInterval: 15_000 })
  const owner = useIsOwner()
  return (
    <div className="page">
      <PageHead eyebrow="Nobody goes first" title="Projects">
        <Link className="btn btn-lime" to="/projects/new" data-testid="new-project">New project</Link>
      </PageHead>
      {summary.isLoading ? <Loading label="Opening projects" /> : null}
      <ProblemCard error={summary.error} onRetry={() => void summary.refetch()} />
      {summary.data ? <Headline data={summary.data} /> : null}
      {summary.data && summary.data.projects.length === 0 ? (
        <Empty title="No projects yet">Paste a client's brief. Mandate drafts paid stages, the client approves them on a private link, and each stage is paid into a PayPal hold that only they can release.</Empty>
      ) : null}
      {summary.data && summary.data.projects.length > 0 ? (
        <div className="projects-grid">
          <section className="panel projects-list" aria-label="Projects">
            <h2 className="section-title">Projects</h2>
            <ul className="list">
              {summary.data.projects.map((project) => (
                <li key={project.id}>
                  <Link to={`/projects/${project.id}`} className="project-row" data-testid="project-row">
                    <div className="project-row-main">
                      <strong>{project.client}</strong>
                      <span className="muted small">{project.title}</span>
                      {project.status === 'sent' || project.status === 'changes' ? <Chip tone="need">{project.status === 'sent' ? 'Plan not approved yet' : 'Client asked for changes'}</Chip> : null}
                    </div>
                    <div className="stage-dots" aria-label="Stages">
                      {project.stages.map((stage) => <span key={stage.id} className={`stage-dot is-${stage.status}${stage.overdue ? ' is-overdue' : ''}`} title={`${stage.title}: ${STAGE_WORDS[stage.status].label}${stage.overdue ? ' · overdue' : ''}`} />)}
                    </div>
                    <div className="project-row-money">
                      <b>{wholeMoney(project.owedCents > 0 ? project.owedCents : project.bankedCents, project.currency)}</b>
                      {project.overdueCents > 0 ? <Chip tone="deny">Overdue</Chip> : project.heldCents > 0 ? <Chip tone="ink">Held by PayPal</Chip> : project.owedCents === 0 && project.bankedCents > 0 ? <Chip tone="auto">Paid in full</Chip> : project.status === 'agreed' ? <Chip tone="need">Unpaid</Chip> : <Chip tone="muted">{project.status}</Chip>}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          <section className="panel" aria-label="Activity">
            <h2 className="section-title">Activity</h2>
            <ol className="activity-feed">
              {summary.data.activity.map((item, index) => (
                <li key={`${item.at}-${index}`} className={`kind-${item.kind.split('.')[0]}`}>
                  <Link to={`/projects/${item.projectId}`}>{item.text}</Link>
                  <span className="fine">{relative(item.at)}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      ) : null}
      {summary.data && summary.data.projects.length > 0 ? <Suspense fallback={<Loading label="Opening the ledger" />}><StageLedger /></Suspense> : null}
      {owner ? <ProfilePanel /> : null}
    </div>
  )
}

function Headline({ data }: { data: ProjectsSummary }) {
  const c = data.currency
  if (data.projects.length === 0) return null
  return (
    <section className="owed-head" data-testid="owed-headline">
      <h2>
        You’re owed {wholeMoney(data.owedCents, c)}.
        {data.mostOverdue ? <em> {wholeMoney(data.overdueCents, c)} of it is overdue{data.mostOverdue.cents === data.overdueCents ? `, from ${data.mostOverdue.client}` : ''}.</em> : null}
      </h2>
      <div className="owed-facts">
        <span className="owed-banked">✓ {wholeMoney(data.bankedCents, c)} banked so far{data.projectsWithMoney > 0 ? ` across ${data.projectsWithMoney} project${data.projectsWithMoney === 1 ? '' : 's'}` : ''}</span>
        {data.heldCents > 0 ? <span className="owed-held">{wholeMoney(data.heldCents, c)} held by PayPal while clients review</span> : null}
        <span className="muted small">{wholeMoney(data.monthCents, c)} collected this month</span>
      </div>
      {data.mostOverdue ? <Link className="btn btn-ghost btn-small" to={`/projects/${data.mostOverdue.projectId}`}>Chase overdue payments</Link> : null}
    </section>
  )
}

function ProfilePanel() {
  const client = useQueryClient()
  const current = useQuery({ queryKey: ['profile'], queryFn: projectsApi.profile })
  const [form, setForm] = useState({ handle: '', displayName: '', headline: '', bio: '', website: '', email: '' })
  useEffect(() => {
    const p = current.data?.profile
    if (p) setForm({ handle: p.handle, displayName: p.display_name, headline: p.headline, bio: p.bio, website: p.website ?? '', email: p.email ?? '' })
  }, [current.data])
  const save = useMutation({
    mutationFn: () => projectsApi.saveProfile({ ...form, website: form.website || null, email: form.email || null }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['profile'] }) },
  })
  const field = (key: keyof typeof form, label: string, hint?: string) => (
    <label className="field"><span>{label}</span><input value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />{hint ? <small>{hint}</small> : null}</label>
  )
  return (
    <details className="panel section profile-panel">
      <summary className="section-title">Your public profile {current.data?.profile ? <Link className="link small" to={`/u/${current.data.profile.handle}`} onClick={(event) => event.stopPropagation()}>View ↗</Link> : null}</summary>
      <p className="fine">Clients see your name and rating on their project page. The track record and the reviews come only from payments PayPal processed through Mandate, never from anything typed here.</p>
      <div className="field-row">{field('displayName', 'Name')}{field('handle', 'Handle', 'Your profile address: /u/handle')}</div>
      {field('headline', 'What you do')}
      <label className="field"><span>About</span><textarea rows={3} value={form.bio} onChange={(event) => setForm({ ...form, bio: event.target.value })} /></label>
      <div className="field-row">{field('website', 'Website')}{field('email', 'Email')}</div>
      <ProblemCard error={save.error} />
      <div className="row gap-s"><button type="button" className="btn btn-ink" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save profile'}</button>{save.isSuccess ? <span className="fine">Saved {when(new Date().toISOString(), true)}</span> : null}</div>
    </details>
  )
}
