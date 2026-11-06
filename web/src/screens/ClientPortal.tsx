import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Mark } from '../components/Shell'
import { PaySheet, type PayVia } from '../components/PaySheet'
import { Chip, Loading, ProblemCard, Spinner } from '../components/ui'
import { ApiError } from '../lib/api'
import { dollars } from '../lib/money'
import { bytes, portalApi, when, type DeliveryCheck, type PortalStage, type PortalView } from '../lib/projects'

/**
 * The client's project page. No account and no app: the link the studio sent is the key, and it can only act on this
 * one project. The client approves the plan before any money moves, sees each stage's work sealed with a check against
 * what was agreed, pays into a PayPal hold, reviews watermarked copies (the originals never reach this page before
 * the money is captured), and approves, asks for changes, or cancels if the studio misses its revision deadline.
 */
export function ClientPortal() {
  const { token = '' } = useParams()
  const view = useQuery({ queryKey: ['portal', token], queryFn: () => portalApi.view(token), refetchInterval: 10_000, retry: false })
  useEffect(() => {
    const meta = document.createElement('meta')
    meta.name = 'robots'
    meta.content = 'noindex, nofollow'
    document.head.appendChild(meta)
    return () => { meta.remove() }
  }, [])
  const gone = view.error instanceof ApiError && view.error.status === 404
  return (
    <div className="share-page portal-page">
      <header className="share-head"><div className="brand"><Mark size={28} /><span>Mandate</span></div><span className="eyebrow">Your project · nobody goes first</span></header>
      <main className="portal-main" id="main">
        {view.isLoading ? <Loading label="Opening your project" /> : null}
        {gone ? <section className="panel" role="alert" data-testid="portal-gone"><h1>This link is not available</h1><p>It may have been replaced. Ask the person who sent it for the current link.</p></section> : null}
        {view.error && !gone ? <ProblemCard error={view.error} onRetry={() => void view.refetch()} /> : null}
        {view.data ? <Portal token={token} data={view.data} /> : null}
      </main>
    </div>
  )
}

function usePortalAction(token: string) {
  const client = useQueryClient()
  return (next: PortalView) => {
    client.setQueryData(['portal', token], next)
    void client.invalidateQueries({ queryKey: ['portal', token] })
  }
}

function Portal({ token, data }: { token: string; data: PortalView }) {
  const p = data.project
  const studio = data.studio
  const agreed = p.status === 'agreed' || p.status === 'done'
  const pct = data.money.totalCents > 0 ? Math.round((data.money.releasedCents / data.money.totalCents) * 100) : 0
  return (
    <>
      <section className="portal-hero">
        <div className="studio-pill">
          <span className="studio-avatar" aria-hidden="true">{studio.name.slice(0, 1)}</span>
          <div><strong>{studio.name}</strong><span className="fine">{studio.headline}{studio.rating !== null ? <> · <b className="stars-inline">★ {studio.rating}</b> ({studio.reviewCount})</> : null}</span></div>
          {studio.handle ? <Link className="link small" to={`/u/${studio.handle}`}>View profile</Link> : null}
        </div>
        <div className="portal-title">
          <div>
            <h1>{p.title}</h1>
            <p className="lede">Hi {p.client}. When a stage is ready, you pay into a PayPal hold and review the full work. {studio.name} only receives the money when you approve it.</p>
          </div>
          <div className="portal-dial">
            <div className="ring" style={{ ['--ring-paid' as string]: `${pct}%`, ['--ring-held' as string]: `${data.money.totalCents > 0 ? Math.round(((data.money.releasedCents + data.money.heldCents) / data.money.totalCents) * 100) : 0}%` }}><b>{pct}%</b><span>paid out</span></div>
            <dl>
              <div><dt><i className="sw-paid" />Released</dt><dd>{dollars(data.money.releasedCents, p.currency)}</dd></div>
              <div><dt><i className="sw-held" />Held for review</dt><dd>{dollars(data.money.heldCents, p.currency)}</dd></div>
              <div><dt><i className="sw-still" />Still to pay</dt><dd>{dollars(data.money.stillCents, p.currency)}</dd></div>
            </dl>
            <p className="fine">{data.money.approved} of {data.money.stages} stages approved · {dollars(data.money.totalCents, p.currency)} total</p>
          </div>
        </div>
      </section>

      {!agreed && data.plan ? <PlanStep token={token} data={data} /> : null}
      {agreed ? <p className="fine windows-note">You have {p.reviewDays} day{p.reviewDays === 1 ? '' : 's'} to review each stage once it is in the hold. If you ask for changes, {studio.name} has {p.reviseDays} day{p.reviseDays === 1 ? '' : 's'} to send the revision; if they miss it, you can cancel and the hold is released back to you.</p> : null}

      {agreed ? (
        <div className="portal-stages">
          {data.stages.map((stage, index) => <PortalStageCard key={stage.id} token={token} data={data} stage={stage} index={index} />)}
        </div>
      ) : null}

      {data.canReview || data.review ? <ReviewBox token={token} data={data} /> : null}
      <p className="fine portal-foot">Payments are handled by PayPal ({data.paypal.environment === 'sandbox' ? 'sandbox: test money only' : 'live'}). Mandate never sees your card. Every file shows its SHA-256 fingerprint, so you can check that what you download is exactly what was delivered.</p>
    </>
  )
}

function PlanStep({ token, data }: { token: string; data: PortalView }) {
  const plan = data.plan!
  const apply = usePortalAction(token)
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState('')
  const agree = useMutation({ mutationFn: () => portalApi.agree(token, plan.version), onSuccess: apply })
  const ask = useMutation({ mutationFn: () => portalApi.askPlanChanges(token, note), onSuccess: (next) => { apply(next); setAsking(false) } })
  const diff = new Map((plan.diff?.stages ?? []).map((item) => [item.id, item]))
  const currency = data.project.currency
  if (plan.status === 'changes') return (
    <section className="portal-step" data-testid="plan-changes-sent">
      <span className="eyebrow">Step 1</span>
      <h2>You asked for changes</h2>
      <p className="quote">“{plan.note}”</p>
      <p className="fine">{data.studio.name} is updating the plan. You will see exactly what changed here, and approve it before paying anything.</p>
    </section>
  )
  return (
    <section className="portal-step" data-testid="plan-review">
      <span className="eyebrow">Step 1{plan.version > 1 ? ` · version ${plan.version}` : ''}</span>
      <h2>{plan.diff ? 'Review the changes to the plan' : 'Review and approve the plan'}</h2>
      <p className="fine">These are the stages {data.studio.name} proposes. You only pay for each one when its work is delivered, into a PayPal hold.</p>
      <ol className="plan-list">
        {plan.stages.map((stage, index) => {
          const change = diff.get(stage.id)
          return (
            <li key={stage.id} className={change?.isNew ? 'is-new' : change?.was ? 'is-changed' : ''}>
              <span className="stage-num">{index + 1}</span>
              <div className="grow"><strong>{stage.title}</strong>{change?.isNew ? <Chip tone="need">New</Chip> : null}<p className="fine">{stage.deliverables.join(' · ')}</p>
                {change?.was ? <p className="fine was">Was: {change.was.title !== stage.title ? `“${change.was.title}”, ` : ''}{dollars(change.was.amountCents, currency)}, due {when(change.was.dueDate)}</p> : null}</div>
              <div className="plan-price"><b>{dollars(stage.amountCents, currency)}</b><span className="fine">Due {when(stage.dueDate)}</span></div>
            </li>
          )
        })}
        {plan.diff?.removed.map((item) => <li key={item.title} className="is-removed"><span className="stage-num">–</span><div className="grow"><s>{item.title}</s> <Chip tone="muted">Removed</Chip></div><div className="plan-price"><s>{dollars(item.amountCents, currency)}</s></div></li>)}
      </ol>
      <div className="plan-foot">
        <div>Total <span className="money money-lg">{dollars(plan.totalCents, currency)}</span> <span className="muted">in {plan.stages.length} payment{plan.stages.length === 1 ? '' : 's'}</span></div>
        <div className="row gap-s">
          <button type="button" className="btn btn-ghost" onClick={() => setAsking((open) => !open)}>Ask for changes</button>
          <button type="button" className="btn btn-ink" disabled={agree.isPending} onClick={() => agree.mutate()} data-testid="approve-plan">{agree.isPending ? 'Approving…' : 'Approve the plan'}</button>
        </div>
      </div>
      {asking ? (
        <div className="ask-box">
          <label className="field"><span>What would you like changed?</span><textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} /></label>
          <button type="button" className="btn btn-ink btn-small" disabled={note.trim().length < 5 || ask.isPending} onClick={() => ask.mutate()}>Send to {data.studio.name}</button>
        </div>
      ) : null}
      <ProblemCard error={agree.error ?? ask.error} />
      <p className="fine">Approving records your answer, signed, against this exact version of the plan (<code title={plan.termsHash}>{plan.termsHash.slice(0, 12)}</code>). No money moves when you approve.</p>
    </section>
  )
}

function SealedTile({ token, file, onReview, unlocked }: { token: string; file: PortalStage['files'][number]; onReview?: () => void; unlocked?: boolean }) {
  return (
    <figure className={`file-tile sealed-tile${unlocked ? ' is-unlocked' : ''}`} title={`${file.name} · ${bytes(file.size)} · sha256 ${file.sha256}`}>
      <span className="file-type">{file.name.split('.').pop()?.toUpperCase().slice(0, 4)}</span>
      {file.kind === 'image' ? <img src={unlocked ? `${portalApi.downloadUrl(token, file.id)}?inline=1` : portalApi.thumbUrl(token, file.id)} alt={unlocked ? file.name : `${file.name}, sealed`} draggable={false} onContextMenu={(event) => event.preventDefault()} /> : <span className="file-generic">{file.name}</span>}
      {!unlocked ? <span className="seal-mark" aria-hidden="true"><Mark size={30} /></span> : null}
      {onReview && file.kind === 'image' ? <button type="button" className="review-btn" onClick={onReview} data-testid="review-file">👁 Review</button> : null}
      {unlocked ? <a className="download-btn" href={portalApi.downloadUrl(token, file.id)} aria-label={`Download ${file.name}`} download>↓</a> : null}
      <figcaption>{file.name}<small>{bytes(file.size)}</small></figcaption>
    </figure>
  )
}

function ClientCheck({ check }: { check: DeliveryCheck }) {
  const [open, setOpen] = useState(false)
  const flagged = check.items.filter((item) => item.status === 'missing' || item.status === 'partial')
  return (
    <div className={`check-card ${flagged.length > 0 ? 'is-flagged' : 'is-clear'}`} data-testid="client-check">
      <button type="button" className="check-card-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="check-icon">{flagged.length > 0 ? 'ⓘ' : '✓'}</span>
        <strong>{flagged.length > 0 ? 'A few things to look at' : 'Delivered as agreed'}</strong>
        <span className="fine">{check.items.filter((item) => item.status === 'missing').length} not delivered · {check.items.filter((item) => item.status === 'met').length} delivered</span>
        <span className="link small">{open ? 'Hide' : 'See details'}</span>
      </button>
      {open ? (
        <div className="check-body">
          <ul>{check.items.map((item, index) => <li key={`${item.label}-${index}`} className={`ck-${item.status}`}><span className="ck-mark">{item.status === 'met' ? '✓' : item.status === 'missing' ? '✕' : item.status === 'partial' ? '!' : 'ⓘ'}</span><div><strong>{item.label}</strong><p className="fine">{item.note}</p></div></li>)}</ul>
          <p className="fine">Checked against the agreed deliverables using file facts{check.ai === 'used' ? ' and an AI look at the images' : ''}. The studio sees the same check.</p>
        </div>
      ) : null}
    </div>
  )
}

function PortalStageCard({ token, data, stage, index }: { token: string; data: PortalView; stage: PortalStage; index: number }) {
  const apply = usePortalAction(token)
  const client = useQueryClient()
  const c = data.project.currency
  const [paying, setPaying] = useState(false)
  const [viewing, setViewing] = useState<PortalStage['files'][number] | null>(null)
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState('')
  const [receipt, setReceipt] = useState(false)
  const [cracked, setCracked] = useState(false)
  const approve = useMutation({ mutationFn: () => portalApi.approve(token, stage.id), onSuccess: (next) => { setCracked(true); apply(next) } })
  const changes = useMutation({ mutationFn: () => portalApi.changes(token, stage.id, note), onSuccess: (next) => { setAsking(false); apply(next) } })
  const cancel = useMutation({ mutationFn: () => portalApi.cancel(token, stage.id), onSuccess: apply })
  const via: PayVia = useMemo(() => ({ session: (method) => portalApi.paySession(token, stage.id, method), confirm: () => portalApi.payConfirm(token, stage.id), hold: true }), [token, stage.id])
  const status = stage.status
  const downloadAll = () => {
    stage.files.forEach((file, at) => window.setTimeout(() => {
      const link = document.createElement('a')
      link.href = portalApi.downloadUrl(token, file.id)
      link.download = file.name
      document.body.appendChild(link)
      link.click()
      link.remove()
    }, at * 400))
  }
  return (
    <section className={`portal-stage is-${status}${cracked ? ' seal-cracked' : ''}`} data-testid="portal-stage" data-status={status}>
      <header className="stage-card-head">
        <div><span className="eyebrow">Stage {index + 1} of {data.stages.length}</span><h3>{stage.title}</h3><p className="fine">{stage.description || stage.deliverables.join(', ')}</p></div>
      </header>

      {status === 'open' ? <p className="fine">In progress. Expected by {when(stage.dueDate)}. You’ll pay once there’s work to review.</p> : null}

      {(status === 'held' || status === 'changes') && stage.reviewEndsAt ? (
        <div className="hold-banner" data-testid="hold-banner"><strong>{dollars(stage.amountCents, c)} is held by PayPal while you review.</strong><span>It releases to {data.studio.name} automatically on {new Date(stage.reviewEndsAt).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} unless you approve sooner or ask for changes.</span></div>
      ) : null}
      {status === 'changes' ? (
        <div className="hold-banner"><strong>You asked for changes. {dollars(stage.amountCents, c)} stays held.</strong><span>“{stage.request?.note}” — the revision is due by {when(stage.reviseBy, true)}.{stage.canCancel ? ' It is late: you can cancel this stage, and the hold is released back to you.' : ''}</span></div>
      ) : null}

      {stage.files.length > 0 ? (
        <div className="file-grid">
          {stage.files.map((file) => <SealedTile key={file.id} token={token} file={file} unlocked={status === 'released'} onReview={status === 'held' || status === 'changes' ? () => setViewing(file) : undefined} />)}
        </div>
      ) : null}
      {stage.check && status !== 'released' ? <ClientCheck check={stage.check} /> : null}

      {status === 'delivered' && stage.awaitingStudio ? <p className="fine">The studio is confirming this bill. You can pay in a moment.</p> : null}
      {stage.canPay && !paying ? (
        <div className="pay-cta">
          <button type="button" className="btn btn-ink btn-big" onClick={() => setPaying(true)} data-testid="pay-into-hold">Pay {dollars(stage.amountCents, c)} into hold</button>
          <p className="fine">Held by PayPal until you approve. You review the full work first.</p>
        </div>
      ) : null}
      {stage.canPay && paying ? (
        <PaySheet proposalId={stage.id} amountCents={stage.amountCents} currency={c} description={`${data.project.title}: ${stage.title}`} via={via} onPaid={() => { void client.invalidateQueries({ queryKey: ['portal', token] }) }} />
      ) : null}

      {stage.canApprove || stage.canRequestChanges ? (
        <div className="decide-row">
          <div><span className="money money-lg">{dollars(stage.amountCents, c)}</span><span className="fine">Held by PayPal</span></div>
          <div className="row gap-s wrap">
            <button type="button" className="btn btn-ghost" onClick={() => setAsking((open) => !open)} data-testid="request-changes">Request changes</button>
            <button type="button" className="btn btn-ink" disabled={approve.isPending} onClick={() => approve.mutate()} data-testid="approve-release">{approve.isPending ? <><Spinner /> Releasing…</> : `Approve and release ${dollars(stage.amountCents, c)}`}</button>
          </div>
        </div>
      ) : null}
      {asking ? (
        <div className="ask-box">
          <label className="field"><span>What needs to change?</span><textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Be specific, so the studio can fix exactly that." /></label>
          <p className="fine">Your money stays held. {data.studio.name} has {data.project.reviseDays} day{data.project.reviseDays === 1 ? '' : 's'} to send a revision.</p>
          <button type="button" className="btn btn-ink btn-small" disabled={note.trim().length < 10 || changes.isPending} onClick={() => changes.mutate()}>Send the change request</button>
        </div>
      ) : null}
      {stage.canCancel ? <button type="button" className="btn btn-ghost btn-small" disabled={cancel.isPending} onClick={() => { if (window.confirm('Cancel this stage? The PayPal hold is released back to you and you are not charged.')) cancel.mutate() }} data-testid="cancel-stage">Cancel and release my hold</button> : null}
      <ProblemCard error={approve.error ?? changes.error ?? cancel.error} />

      {status === 'released' ? (
        <div className="released-row">
          <div><span className="money money-lg">{dollars(stage.receipt?.paidCents ?? stage.amountCents, c)}</span><span className="fine">Released, thank you</span></div>
          <div className="row gap-s wrap">
            <Chip tone="auto">Unlocked</Chip>
            <button type="button" className="btn btn-ghost btn-small" onClick={() => setReceipt(true)} data-testid="receipt">Receipt</button>
            <button type="button" className="btn btn-ink btn-small" onClick={downloadAll} data-testid="download-all">↓ Download all {stage.files.length} file{stage.files.length === 1 ? '' : 's'}</button>
          </div>
        </div>
      ) : null}
      {status === 'cancelled' ? <p className="fine">Cancelled. The hold was released back to you; you were not charged.</p> : null}
      {status !== 'released' && status !== 'cancelled' ? <div className="stage-price-line"><span className="money money-md">{dollars(stage.amountCents, c)}</span><span className="fine">{status === 'open' || status === 'delivered' ? `Due ${when(stage.dueDate)}` : ''}</span></div> : null}

      {viewing ? <Viewer token={token} file={viewing} onClose={() => setViewing(null)} /> : null}
      {receipt && stage.receipt ? <ReceiptModal data={data} stage={stage} onClose={() => setReceipt(false)} /> : null}
    </section>
  )
}

/**
 * The review copy. The server made it for this session, at most 1200 px, with the client's own name, email, the time
 * and a session code written across it. A close-up is a 300 px square of the original resolution, marked the same way.
 * The original file never comes to this page before the money is captured.
 */
function Viewer({ token, file, onClose }: { token: string; file: PortalStage['files'][number]; onClose: () => void }) {
  const open = useQuery({ queryKey: ['review-session', token, file.id], queryFn: () => portalApi.openFile(token, file.id), staleTime: 9 * 60_000, gcTime: 0, retry: false })
  const [loupe, setLoupe] = useState<{ x: number; y: number; px: number; py: number; src: string } | null>(null)
  const [left, setLeft] = useState<number | null>(null)
  const [hidden, setHidden] = useState(false)
  const img = useRef<HTMLImageElement>(null)
  useEffect(() => {
    const blur = () => setHidden(true)
    const focus = () => setHidden(false)
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('blur', blur)
    window.addEventListener('focus', focus)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('blur', blur); window.removeEventListener('focus', focus); window.removeEventListener('keydown', key) }
  }, [onClose])
  const zoom = useCallback(async (event: React.MouseEvent<HTMLImageElement>) => {
    if (!open.data || !img.current) return
    const box = img.current.getBoundingClientRect()
    const x = (event.clientX - box.left) / box.width
    const y = (event.clientY - box.top) / box.height
    const response = await fetch(portalApi.closeupUrl(token, open.data.session, x, y), { cache: 'no-store' })
    if (!response.ok) { setLeft(0); return }
    setLeft(Number(response.headers.get('x-closeups-left') ?? 0))
    const blob = await response.blob()
    setLoupe((before) => { if (before) URL.revokeObjectURL(before.src); return { x, y, px: event.clientX - box.left, py: event.clientY - box.top, src: URL.createObjectURL(blob) } })
  }, [open.data, token])
  return (
    <div className="viewer-backdrop" role="dialog" aria-modal="true" aria-label={`Review copy of ${file.name}`} onClick={onClose}>
      <div className="viewer" onClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>
        <div className="row between gap-s"><strong>{file.name}</strong><span className="fine">{open.data ? `Session ${open.data.session} · click anywhere for a full-resolution close-up${left !== null ? ` (${left} left)` : ''}` : 'Opening…'}</span><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></div>
        {open.error ? <ProblemCard error={open.error} /> : null}
        {open.data ? (
          <div className={`viewer-stage${hidden ? ' is-hidden' : ''}`}>
            <img ref={img} src={portalApi.reviewUrl(token, open.data.session)} alt={`Review copy of ${file.name}`} draggable={false} onClick={(event) => void zoom(event)} />
            {loupe ? <img className="loupe" src={loupe.src} alt="Close-up" style={{ left: loupe.px, top: loupe.py }} onClick={() => setLoupe(null)} /> : null}
          </div>
        ) : <Loading label="Making your review copy" />}
        <p className="fine">A review copy made for you, with your name and this session’s code written across it. The original is sent only after you approve and the payment is captured. Fingerprint <code>{file.sha256.slice(0, 16)}…</code></p>
      </div>
    </div>
  )
}

function ReceiptModal({ data, stage, onClose }: { data: PortalView; stage: PortalStage; onClose: () => void }) {
  const r = stage.receipt!
  return (
    <div className="viewer-backdrop" role="dialog" aria-modal="true" aria-label="Your receipt" onClick={onClose}>
      <div className="receipt-modal" onClick={(event) => event.stopPropagation()} data-testid="receipt-modal">
        <div className="row between"><div><h2>Your receipt</h2><p className="fine">{stage.title}, by {data.studio.name}</p></div><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></div>
        <dl className="receipt-dl">
          <div><dt>You paid</dt><dd className="ok">{dollars(r.paidCents, data.project.currency)}</dd></div>
          <div><dt>Held by PayPal</dt><dd>{when(r.heldAt, true)}</dd></div>
          <div><dt>{r.approvedBy === 'review_window' ? 'Released when the review window ended' : 'You approved it'}</dt><dd>{when(r.approvedAt, true)}</dd></div>
          {r.paidWith ? <div><dt>Paid with</dt><dd>{r.paidWith}</dd></div> : null}
          <div><dt>Paid to</dt><dd>{data.studio.name}, through Mandate</dd></div>
        </dl>
        <div className="receipt-refs">
          <p className="fine">Your PayPal reference, if you ever contact PayPal about this payment</p>
          <div className="row between"><span>PayPal transaction</span><code>{r.paypalCaptureId}</code><button type="button" className="link-button small" onClick={() => void navigator.clipboard.writeText(r.paypalCaptureId ?? '')}>Copy</button></div>
          {r.paypalAuthorizationId ? <div className="row between"><span>PayPal hold</span><code>{r.paypalAuthorizationId}</code></div> : null}
          {r.manifestHash ? <div className="row between"><span>Files released</span><code title={r.manifestHash}>{r.manifestHash.slice(0, 16)}…</code></div> : null}
        </div>
        <p className="fine">PayPal also emailed you its own receipt for this payment.</p>
      </div>
    </div>
  )
}

function ReviewBox({ token, data }: { token: string; data: PortalView }) {
  const apply = usePortalAction(token)
  const [stars, setStars] = useState(5)
  const [text, setText] = useState('')
  const leave = useMutation({ mutationFn: () => portalApi.review(token, stars, text), onSuccess: apply })
  if (data.review) return <section className="portal-step"><span className="eyebrow">Your review</span><p><span className="stars">{'★'.repeat(data.review.stars)}{'☆'.repeat(5 - data.review.stars)}</span> “{data.review.text}”</p><p className="fine">Shown on {data.studio.name}’s profile as verified: it is signed together with the PayPal payment that proves you paid.</p></section>
  return (
    <section className="portal-step" data-testid="review-box">
      <span className="eyebrow">Only clients who paid can review</span>
      <h2>How was working with {data.studio.name}?</h2>
      <div className="star-pick" role="radiogroup" aria-label="Stars">{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={stars === n} className={n <= stars ? 'on' : ''} onClick={() => setStars(n)}>★</button>)}</div>
      <label className="field"><span>A sentence or two</span><textarea rows={3} value={text} onChange={(event) => setText(event.target.value)} /></label>
      <ProblemCard error={leave.error} />
      <button type="button" className="btn btn-ink btn-small" disabled={text.trim().length < 10 || leave.isPending} onClick={() => leave.mutate()}>Post the review</button>
    </section>
  )
}
