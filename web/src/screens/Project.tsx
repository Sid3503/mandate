import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { PlanEditor, newKey, type EditableStage } from '../components/PlanEditor'
import { Chip, Hash, Loading, Money, PageHead, PhaseChip, ProblemCard, Spinner } from '../components/ui'
import { useToast } from '../components/Toast'
import { ApiError } from '../lib/api'
import { useIsOwner, useWarrant } from '../lib/hooks'
import { dollars } from '../lib/money'
import { bytes, checkTally, projectsApi, STAGE_WORDS, when, type DeliveryCheck, type StudioProject, type StudioStage } from '../lib/projects'
import { relative } from '../lib/format'
import { session } from '../lib/session'

/** One project, from the studio's side: the plan and its signatures, each stage's files, its bill, its hold, its release. */
export function ProjectScreen() {
  const { id = '' } = useParams()
  const project = useQuery({ queryKey: ['project', id], queryFn: () => projectsApi.get(id), refetchInterval: 8_000 })
  const location = useLocation()
  const toast = useToast()
  const shown = useRef(false)
  useEffect(() => {
    if ((location.state as { justSent?: boolean } | null)?.justSent && project.data && !shown.current) {
      shown.current = true
      toast({ title: 'Plan sent', body: `Copy the client link and send it to ${project.data.client.name}. They approve the plan before paying anything.` })
    }
  }, [location.state, project.data, toast])
  if (project.isLoading) return <div className="page"><Loading label="Opening the project" /></div>
  if (project.error || !project.data) return <div className="page"><ProblemCard error={project.error} /></div>
  return <ProjectBody p={project.data} />
}

function useRefresh(id: string) {
  const client = useQueryClient()
  return (next?: StudioProject) => {
    if (next) client.setQueryData(['project', id], next)
    void client.invalidateQueries({ queryKey: ['project', id] })
    void client.invalidateQueries({ queryKey: ['projects'] })
  }
}

function ProjectBody({ p }: { p: StudioProject }) {
  const owner = useIsOwner()
  const toast = useToast()
  const refresh = useRefresh(p.id)
  const [editing, setEditing] = useState(false)
  const send = useMutation({ mutationFn: () => projectsApi.send(p.id), onSuccess: (next) => { refresh(next); toast({ title: next.resent ? 'Plan sent' : 'Nothing changed', body: next.resent ? 'The client sees exactly what changed and approves again.' : 'The client already has this version.' }) } })
  const rotate = useMutation({ mutationFn: () => projectsApi.rotateLink(p.id), onSuccess: (next) => { refresh(next); toast({ title: 'New client link', body: 'The old link no longer works. Send this one.' }) } })
  const copy = async () => {
    if (!p.link?.url) return
    await navigator.clipboard.writeText(p.link.url).catch(() => undefined)
    toast({ title: 'Client link copied', body: 'No account or app needed on their side.', key: 'copy-link' })
  }
  const count = p.stages.filter((stage) => stage.status !== 'cancelled').length
  return (
    <div className="page page-wide">
      <div className="project-top">
        <div>
          <Link to="/projects" className="fine">← All projects</Link>
          <PageHead eyebrow={`For ${p.client.name}${p.client.email ? ` (${p.client.email})` : ''}`} title={p.title} />
          <div className="row gap-s wrap">
            {p.link?.url ? <button type="button" className="btn btn-ghost btn-small" onClick={() => void copy()} data-testid="copy-client-link">Copy client link</button> : null}
            {p.link?.url ? <a className="btn btn-ghost btn-small" href={p.link.url} target="_blank" rel="noreferrer" data-testid="open-client-view">Open the client’s view ↗</a> : null}
            {owner && p.link ? <button type="button" className="link-button small" onClick={() => rotate.mutate()}>New link</button> : null}
            {p.link ? <span className="fine">{p.link.views > 0 ? `Opened ${p.link.views} time${p.link.views === 1 ? '' : 's'}, last ${relative(p.link.lastSeenAt!)}` : 'Not opened yet'}</span> : null}
          </div>
        </div>
        <Dial money={p.money} currency={p.currency} count={count} />
      </div>

      <PlanBanner p={p} onEdit={() => setEditing(true)} onSend={() => send.mutate()} sending={send.isPending} />
      <ProblemCard error={send.error ?? rotate.error} />
      {editing ? <EditPlan p={p} onDone={(next) => { setEditing(false); if (next) { refresh(next); toast({ title: next.plan && next.plan.version > 1 ? `Plan version ${next.plan.version} sent` : 'Plan saved', body: next.plan?.status === 'sent' ? 'It goes back to the client: they approve the change before paying for an open stage.' : 'Saved.' }) } }} /> : null}

      <div className="stage-list">
        {p.stages.map((stage, index) => <StageCard key={stage.id} p={p} stage={stage} index={index} count={p.stages.length} owner={owner} />)}
      </div>

      <div className="grid-two section">
        <section className="panel">
          <h2 className="section-title">Activity</h2>
          <ol className="activity-feed">{p.activity.map((item, index) => <li key={`${item.at}-${index}`} className={`kind-${item.kind.split('.')[0]}`}><span>{item.text}</span><span className="fine">{relative(item.at)}</span></li>)}</ol>
        </section>
        <section className="panel">
          <h2 className="section-title">The brief{p.briefSource ? ` · ${p.briefSource}` : ''}</h2>
          {p.questions.length > 0 ? <><h3 className="panel-title">Worth asking</h3><ul className="fine">{p.questions.map((question) => <li key={question}>{question}</li>)}</ul></> : null}
          <pre className="brief-pre">{p.brief || 'No brief was kept.'}</pre>
          {p.review ? <div className="review-quote"><span className="stars">{'★'.repeat(p.review.stars)}{'☆'.repeat(5 - p.review.stars)}</span> “{p.review.text}”</div> : null}
          <p className="fine">Job <code>{p.jobId}</code>{p.dealId ? <> · signed deal <Link to="/deals">{p.dealId.slice(0, 8)}</Link></> : null}</p>
        </section>
      </div>
    </div>
  )
}

function Dial({ money, currency, count }: { money: StudioProject['money']; currency: string; count: number }) {
  const r = 46
  const c = 2 * Math.PI * r
  const paid = money.totalCents > 0 ? money.releasedCents / money.totalCents : 0
  const held = money.totalCents > 0 ? money.heldCents / money.totalCents : 0
  return (
    <div className="dial" data-testid="project-dial">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle cx="60" cy="60" r={r} className="dial-track" />
        <circle cx="60" cy="60" r={r} className="dial-held" strokeDasharray={`${(paid + held) * c} ${c}`} />
        <circle cx="60" cy="60" r={r} className="dial-paid" strokeDasharray={`${paid * c} ${c}`} />
      </svg>
      <div className="dial-center"><b>{money.percent}%</b><span>collected</span></div>
      <dl className="dial-legend">
        <div><dt><i className="sw-paid" />Paid to you</dt><dd>{dollars(money.releasedCents, currency)}</dd></div>
        {money.heldCents > 0 ? <div><dt><i className="sw-held" />Held by PayPal</dt><dd>{dollars(money.heldCents, currency)}</dd></div> : null}
        <div><dt><i className="sw-still" />Still to collect</dt><dd>{dollars(money.stillCents, currency)}</dd></div>
      </dl>
      <p className="fine">{count} stage{count === 1 ? '' : 's'} · {dollars(money.totalCents, currency)} total</p>
    </div>
  )
}

function PlanBanner({ p, onEdit, onSend, sending }: { p: StudioProject; onEdit: () => void; onSend: () => void; sending: boolean }) {
  const plan = p.plan
  const signatures = plan ? (
    <span className="row gap-s wrap">
      <Chip tone={plan.studioSignatureValid ? 'auto' : 'deny'} title="The studio's signature over this plan's hash">{plan.studioSignatureValid ? 'Studio signature ✓' : 'Studio signature ✗'}</Chip>
      {plan.clientSignatureValid !== null ? <Chip tone={plan.clientSignatureValid ? 'auto' : 'deny'} title="The client's answer, recorded and signed">{plan.clientSignatureValid ? 'Client’s answer signed ✓' : 'Client signature ✗'}</Chip> : null}
      <Hash value={plan.termsHash} />
    </span>
  ) : null
  if (!plan) return (
    <section className="plan-banner is-draft"><div><strong>Not sent yet</strong><p className="fine">The client sees nothing until you send the plan.</p></div><div className="row gap-s"><button type="button" className="btn btn-ghost" onClick={onEdit}>Edit plan</button><button type="button" className="btn btn-lime" onClick={onSend} disabled={sending}>{sending ? 'Sending…' : 'Send plan'}</button></div></section>
  )
  if (plan.status === 'agreed') return (
    <section className="plan-banner is-agreed" data-testid="plan-agreed">
      <span className="banner-mark">✓</span>
      <div><strong>Plan approved {when(plan.decidedAt)}</strong><p className="fine">{p.client.name} agreed the stages and prices (version {plan.version}). It is a signed deal: the rules refuse any bill on this job that is not one of its stages, for its exact price. Changing it sends the plan back for approval.</p>{signatures}</div>
      <div className="row gap-s">{plan.unsentChanges ? <button type="button" className="btn btn-lime" onClick={onSend} disabled={sending}>Send changes</button> : null}<button type="button" className="btn btn-ghost" onClick={onEdit}>Edit plan</button></div>
    </section>
  )
  if (plan.status === 'changes') return (
    <section className="plan-banner is-changes" data-testid="plan-changes">
      <span className="banner-mark">!</span>
      <div><strong>{p.client.name} asked for changes to the plan</strong><p className="quote">“{plan.clientNote}”</p>{signatures}</div>
      <div className="row gap-s"><button type="button" className="btn btn-ink" onClick={onEdit}>Edit plan</button>{plan.unsentChanges ? <button type="button" className="btn btn-lime" onClick={onSend} disabled={sending}>Send version {plan.version + 1}</button> : null}</div>
    </section>
  )
  return (
    <section className="plan-banner is-waiting" data-testid="plan-waiting">
      <span className="banner-mark">◷</span>
      <div><strong>Waiting for {p.client.name} to approve the plan</strong><p className="fine">They can’t pay for any stage until they do. Share the client link if you haven’t. Version {plan.version}, sent {relative(plan.sentAt)}.</p>{signatures}</div>
      <div className="row gap-s">{plan.unsentChanges ? <button type="button" className="btn btn-lime" onClick={onSend} disabled={sending}>Send changes</button> : null}<button type="button" className="btn btn-ghost" onClick={onEdit}>Edit plan</button></div>
    </section>
  )
}

function EditPlan({ p, onDone }: { p: StudioProject; onDone: (next: StudioProject | null) => void }) {
  const warrant = useWarrant()
  const [stages, setStages] = useState<EditableStage[]>(() => p.stages.filter((stage) => stage.status !== 'cancelled').map((stage) => ({ key: newKey(), id: stage.id, title: stage.title, description: stage.description, deliverables: stage.deliverables, amountCents: stage.amountCents, dueDate: stage.dueDate, locked: stage.status !== 'open', lockedWhy: stage.status !== 'open' ? `${STAGE_WORDS[stage.status].label}: its terms are what the client agreed to.` : undefined })))
  const [reviewDays, setReviewDays] = useState(p.reviewDays)
  const [reviseDays, setReviseDays] = useState(p.reviseDays)
  const save = useMutation({ mutationFn: () => projectsApi.editPlan(p.id, { stages: stages.map(({ id, title, description, deliverables, amountCents, dueDate }) => ({ id, title, description, deliverables, amountCents, dueDate })), reviewDays, reviseDays }), onSuccess: (next) => onDone(next) })
  const ceiling = (warrant.data as unknown as { perPaymentCeilingCents?: number } | undefined)?.perPaymentCeilingCents ?? null
  return (
    <section className="panel edit-plan" data-testid="edit-plan">
      <h2 className="section-title">Edit the plan</h2>
      <PlanEditor stages={stages} currency={p.currency} onChange={setStages} ceilingCents={ceiling} />
      <div className="windows row gap-s wrap">
        <label className="field field-inline"><span>Review window</span><select value={reviewDays} onChange={(event) => setReviewDays(Number(event.target.value))}>{[1, 2, 3, 5, 7, 10, 14].map((n) => <option key={n} value={n}>{n} day{n === 1 ? '' : 's'}</option>)}</select></label>
        <label className="field field-inline"><span>Revision window</span><select value={reviseDays} onChange={(event) => setReviseDays(Number(event.target.value))}>{[1, 2, 3, 5, 7, 10, 14].map((n) => <option key={n} value={n}>{n} day{n === 1 ? '' : 's'}</option>)}</select></label>
      </div>
      <ProblemCard error={save.error} />
      <div className="row gap-s"><button type="button" className="btn btn-ink" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : p.plan ? 'Save and send to the client' : 'Save'}</button><button type="button" className="btn btn-ghost" onClick={() => onDone(null)}>Cancel</button></div>
    </section>
  )
}

/** The studio's own file, fetched with its key, shown from memory. An <img> cannot carry the key itself. */
function useOwnImage(url: string | null) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!url) return
    let live = true
    let made: string | null = null
    const key = session.get()
    void fetch(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, credentials: 'include' }).then((response) => (response.ok ? response.blob() : null)).then((blob) => {
      if (!live || !blob) return
      made = URL.createObjectURL(blob)
      setSrc(made)
    }).catch(() => undefined)
    return () => { live = false; if (made) URL.revokeObjectURL(made) }
  }, [url])
  return src
}

function Thumb({ projectId, file, onRemove }: { projectId: string; file: StudioStage['files'][number]; onRemove?: () => void }) {
  const src = useOwnImage(file.kind === 'image' ? projectsApi.fileUrl(projectId, file.id) : null)
  return (
    <figure className="file-tile" title={`${file.name} · ${bytes(file.size)} · sha256 ${file.sha256}`}>
      <span className="file-type">{file.name.split('.').pop()?.toUpperCase().slice(0, 4)}</span>
      {file.kind === 'image' ? (src ? <img src={src} alt={file.name} /> : <span className="file-skel" />) : <span className="file-generic">{file.name}</span>}
      <figcaption>{file.name}<small>{bytes(file.size)}</small></figcaption>
      {onRemove ? <button type="button" className="file-remove" aria-label={`Remove ${file.name}`} onClick={onRemove}>✕</button> : null}
    </figure>
  )
}

export function CheckCard({ check, compact = false }: { check: DeliveryCheck; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const flagged = check.items.filter((item) => item.status === 'missing' || item.status === 'partial')
  return (
    <div className={`check-card ${flagged.length > 0 ? 'is-flagged' : 'is-clear'}`} data-testid="check-card">
      <button type="button" className="check-card-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="check-icon">{flagged.length > 0 ? 'ⓘ' : '✓'}</span>
        <strong>{flagged.length > 0 ? 'A few things to look at' : 'Delivered as agreed'}</strong>
        <span className="fine">{checkTally(check)}</span>
        <span className="link small">{open ? 'Hide' : 'See details'}</span>
      </button>
      {open || (!compact && flagged.length > 0 && open) ? (
        <div className="check-body">
          <ul>
            {check.items.map((item, index) => (
              <li key={`${item.label}-${index}`} className={`ck-${item.status}`}>
                <span className="ck-mark">{item.status === 'met' ? '✓' : item.status === 'missing' ? '✕' : item.status === 'partial' ? '!' : 'ⓘ'}</span>
                <div><strong>{item.label}</strong><p className="fine">{item.note}{item.source === 'ai' ? ' (AI look)' : ''}</p></div>
              </li>
            ))}
          </ul>
          <p className="fine">Checked against the agreed deliverables using file facts{check.ai === 'used' ? ' and an AI look at the images' : ''}. {check.aiNote ?? ''} The client sees this check before they pay.</p>
        </div>
      ) : null}
    </div>
  )
}

function StageCard({ p, stage, index, count, owner }: { p: StudioProject; stage: StudioStage; index: number; count: number; owner: boolean }) {
  const refresh = useRefresh(p.id)
  const toast = useToast()
  const fileInput = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<unknown>(null)
  const [preview, setPreview] = useState<DeliveryCheck | null>(null)
  const [reminder, setReminder] = useState<{ text: string; tone: string; mailto: string | null; source: string } | null>(null)
  const words = STAGE_WORDS[stage.status]
  const canUpload = p.status === 'agreed' && (stage.status === 'open' || stage.status === 'changes')
  const send = useMutation({ mutationFn: () => projectsApi.sendStage(p.id, stage.id), onSuccess: (next) => { refresh(next); setPreview(null); toast({ title: stage.status === 'changes' ? 'Revision sent' : `${stage.title} sent sealed`, body: stage.status === 'changes' ? 'The money stays held; the client has a fresh review window.' : 'The client sees sealed previews and the check, and pays into a PayPal hold.' }) } })
  const check = useMutation({ mutationFn: () => projectsApi.check(p.id, stage.id), onSuccess: setPreview })
  const remove = useMutation({ mutationFn: (fileId: string) => projectsApi.removeFile(p.id, fileId), onSuccess: (next) => refresh(next) })
  const remind = useMutation({ mutationFn: () => projectsApi.remind(p.id, stage.id), onSuccess: (made) => { setReminder(made); refresh() } })
  const release = useMutation({ mutationFn: () => projectsApi.releaseHold(p.id, stage.id), onSuccess: (next) => { refresh(next); toast({ title: 'Hold released back to the client', body: 'They were not charged.' }) } })
  const onFiles = async (files: FileList | File[]) => {
    setUploadError(null)
    for (const file of Array.from(files)) {
      setUploading(file.name)
      try { refresh(await projectsApi.uploadFile(p.id, stage.id, file)) } catch (error) { setUploadError(error); break }
    }
    setUploading(null)
    setPreview(null)
  }
  const reviewLeft = stage.reviewEndsAt ? Math.max(0, Date.parse(stage.reviewEndsAt) - Date.now()) : null
  return (
    <section className={`stage-card is-${stage.status}`} data-testid="stage-card" data-status={stage.status}>
      <header className="stage-card-head">
        <div>
          <span className="eyebrow">Stage {index + 1} of {count}{stage.rounds > 1 ? ` · round ${stage.round}` : ''}</span>
          <h3>{stage.title}</h3>
          <p className="fine">{stage.deliverables.join(', ')}</p>
        </div>
        <div className="stage-card-money">
          <Money cents={stage.amountCents} currency={p.currency} size="lg" />
          <Chip tone={words.tone}>{words.label}</Chip>
          <span className="fine">Due {when(stage.dueDate)}</span>
        </div>
      </header>

      {stage.request ? <div className="client-note"><strong>{p.client.name} asked for changes</strong><p className="quote">“{stage.request.note}”</p><p className="fine">The money stays held. Your revision is due by {when(stage.reviseBy, true)}. Upload the revised files and send the revision.</p></div> : null}

      {canUpload || stage.files.length > 0 ? (
        <div className="file-grid">
          {stage.files.map((file) => <Thumb key={file.id} projectId={p.id} file={file} onRemove={canUpload ? () => remove.mutate(file.id) : undefined} />)}
          {canUpload ? (
            <button type="button" className="file-drop" onClick={() => fileInput.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void onFiles(event.dataTransfer.files) }} data-testid="add-files">
              {uploading ? <><Spinner /> {uploading}</> : <>＋ Add deliverables<small>Images show sealed; anything else stays a sealed file</small></>}
            </button>
          ) : null}
          <input ref={fileInput} type="file" multiple hidden onChange={(event) => { if (event.target.files) void onFiles(event.target.files); event.target.value = '' }} />
        </div>
      ) : null}
      {stage.status === 'open' && stage.files.length === 0 && p.status === 'agreed' ? <p className="fine">No files yet. Add the deliverables: your client sees them sealed, with a check against what you agreed, before they pay.</p> : null}
      {stage.status === 'open' && p.status !== 'agreed' ? <p className="fine">Deliver once {p.client.name} approves the plan, so the work is checked against terms they agreed to.</p> : null}
      <ProblemCard error={uploadError ?? remove.error} />

      {preview ? <CheckCard check={preview} /> : stage.delivery?.check && stage.status !== 'open' ? <CheckCard check={stage.delivery.check} compact /> : null}

      {stage.charge ? <BillLine p={p} stage={stage} /> : null}

      {stage.status === 'held' || stage.status === 'changes' ? (
        <div className="hold-line" data-testid="hold-line">
          <strong>{dollars(stage.amountCents, p.currency)} is held by PayPal{stage.status === 'held' ? ` while ${p.client.name} reviews` : ''}.</strong>
          <p className="fine">
            {stage.status === 'held' && stage.reviewEndsAt ? <>It releases to you automatically {when(stage.reviewEndsAt, true)}{reviewLeft !== null && reviewLeft < 86_400_000 ? ` (in ${Math.ceil(reviewLeft / 3_600_000)} h)` : ''} unless they approve sooner or ask for changes. </> : null}
            Authorization <code>{stage.hold?.authorizationId}</code>{stage.hold?.payerEmail ? ` from ${stage.hold.payerEmail}` : ''}. PayPal honours it until {when(stage.hold?.honorUntil, true)}{stage.hold?.reauthorizedAt ? ' (renewed)' : ''}.
          </p>
          <p className="fine">{stage.views.opens > 0 ? `${p.client.name} opened review copies ${stage.views.opens} time${stage.views.opens === 1 ? '' : 's'} and inspected ${stage.views.closeups} close-up${stage.views.closeups === 1 ? '' : 's'}.${stage.views.last ? ` Last: ${stage.views.last.file}, ${when(stage.views.last.at, true)}.` : ''}` : 'Not opened yet.'}</p>
          {owner ? <button type="button" className="link-button small" disabled={release.isPending} onClick={() => { if (window.confirm('Release the hold back to the client? They will not be charged, and this stage is cancelled.')) release.mutate() }}>Release the hold back to the client</button> : null}
          <ProblemCard error={release.error} />
        </div>
      ) : null}

      {stage.status === 'released' ? <PaidLine p={p} stage={stage} /> : null}
      {stage.status === 'cancelled' ? <p className="fine">Cancelled. {stage.hold?.voidReason ? `The hold was released: ${stage.hold.voidReason}.` : 'Nothing was charged.'}</p> : null}

      <div className="stage-actions row gap-s wrap">
        {canUpload && stage.files.length > 0 ? <button type="button" className="btn btn-ghost btn-small" disabled={check.isPending} onClick={() => check.mutate()}>{check.isPending ? <><Spinner /> Checking…</> : 'Check against the plan'}</button> : null}
        {canUpload && stage.files.length > 0 ? <button type="button" className="btn btn-ink btn-small" disabled={send.isPending} onClick={() => send.mutate()} data-testid="send-stage">{send.isPending ? <><Spinner /> Sealing…</> : stage.status === 'changes' ? 'Send the revision' : 'Send for review, sealed'}</button> : null}
        {(stage.status === 'delivered' || (stage.status === 'open' && p.status === 'agreed' && stage.dueDate < new Date().toISOString().slice(0, 10))) ? <button type="button" className="btn btn-ghost btn-small" disabled={remind.isPending} onClick={() => remind.mutate()}>{remind.isPending ? 'Writing…' : stage.reminders.count > 0 ? 'Remind again' : 'Write a reminder'}</button> : null}
        {stage.reminders.count > 0 ? <span className="fine">{stage.reminders.count} reminder{stage.reminders.count === 1 ? '' : 's'} written, last {relative(stage.reminders.lastAt!)}</span> : null}
      </div>
      <ProblemCard error={send.error ?? check.error ?? remind.error} />
      {reminder ? (
        <div className="reminder-box" data-testid="reminder">
          <div className="row between"><strong>A {reminder.tone} reminder{reminder.source === 'model' ? ', written by the AI' : ''}</strong><button type="button" className="icon-btn" aria-label="Close" onClick={() => setReminder(null)}>✕</button></div>
          <pre>{reminder.text}</pre>
          <div className="row gap-s">
            <button type="button" className="btn btn-ghost btn-small" onClick={() => { void navigator.clipboard.writeText(reminder.text); toast({ title: 'Copied', body: 'Paste it wherever you talk to the client.', key: 'copy-reminder' }) }}>Copy</button>
            {reminder.mailto ? <a className="btn btn-ink btn-small" href={reminder.mailto}>Open in email</a> : null}
          </div>
          <p className="fine">Nothing was sent. You read it first, and send it yourself. Each reminder is a little firmer than the last.</p>
        </div>
      ) : null}
    </section>
  )
}

function BillLine({ p, stage }: { p: StudioProject; stage: StudioStage }) {
  const charge = stage.charge!
  return (
    <div className="bill-line">
      <span className="fine">Bill</span>
      <Link to={`/p/${charge.id}`} className="link mono small">{charge.id.slice(0, 8)}</Link>
      <PhaseChip phase={charge.phase} kind="charge" />
      {charge.lockValid ? <Chip tone="auto" title="The lock covers the manifest of the delivered files' SHA-256 fingerprints">Lock signed · covers the files</Chip> : null}
      {charge.phase === 'pending_approval' ? <Link className="btn btn-lime btn-small" to={`/p/${charge.id}`}>Approve the bill</Link> : null}
      {charge.phase === 'locked' || charge.phase === 'order_created' ? <span className="fine">Waiting for {p.client.name} to pay into the hold.</span> : null}
      {stage.delivery ? <span className="fine">Manifest <code title={stage.delivery.manifestHash}>{stage.delivery.manifestHash.slice(0, 12)}</code> · round {stage.delivery.round} · {stage.delivery.files.length} file{stage.delivery.files.length === 1 ? '' : 's'}</span> : null}
    </div>
  )
}

function PaidLine({ p, stage }: { p: StudioProject; stage: StudioStage }) {
  const c = stage.charge
  return (
    <div className="paid-line" data-testid="paid-line">
      <span className="banner-mark">✓</span>
      <div>
        <strong>{dollars(c?.capturedCents ?? stage.amountCents, p.currency)} paid</strong> <span className="fine">{stage.release?.decidedBy === 'review_window' ? 'Released when the review window ended' : `Approved by ${p.client.name}`} · {when(stage.release?.at ?? stage.hold?.releasedAt, true)}</span>
        <p className="fine">PayPal capture <code>{c?.captureId}</code>{c?.feeCents !== null && c?.feeCents !== undefined ? ` · PayPal fee ${dollars(c.feeCents, p.currency)} · net ${dollars(c.netCents, p.currency)}` : ''}{stage.release ? <> · release {stage.release.signatureValid ? 'signed ✓' : 'signature ✗'} over manifest <code>{stage.release.manifestHash.slice(0, 12)}</code></> : null}</p>
        {stage.payouts.length > 0 ? <p className="fine">From this money: {stage.payouts.map((payout) => `${dollars(payout.amountCents, p.currency)} to ${payout.payeeId} (${payout.phase === 'captured' ? 'paid' : payout.phase.replace('_', ' ')}${payout.clause === 'standing.matched' ? ', by your standing rule' : ''})`).join(', ')}.</p> : null}
        <p className="fine">{stage.views.downloads > 0 ? `${p.client.name} downloaded the files.` : 'The files are unlocked for the client.'}</p>
      </div>
    </div>
  )
}

export { ApiError }
