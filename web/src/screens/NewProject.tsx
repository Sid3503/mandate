import { useMutation } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PlanEditor, newKey, totalOf, type EditableStage } from '../components/PlanEditor'
import { Chip, PageHead, ProblemCard, Spinner } from '../components/ui'
import { useWarrant } from '../lib/hooks'
import { dollars } from '../lib/money'
import { projectsApi, type DraftedPlan } from '../lib/projects'

/**
 * Brief in, paid stages out. The freelancer pastes what the client sent (or attaches it); a model drafts a plan and
 * code reads the plan back against the brief: over budget, past the deadline, a count the client never asked for.
 * Every field stays editable. Nothing is sent until they press Send.
 */

const EXAMPLE = `Kola Press
Design brief · Cold-pressed juice, Lekki

About us
We are Kola Press, a cold-pressed juice brand launching in Lekki next month.
Four flavours to start: Green, Sunny, Zobo+ and Pine.

What we need
• A logo
• A small brand kit: colours, fonts and label style for our bottles
• Six Instagram launch posts

Budget and timing
Budget is about $1,400 and we want everything in 3 weeks.

Contact
hello@kolapress.example`

export function NewProject() {
  const navigate = useNavigate()
  const warrant = useWarrant()
  const [brief, setBrief] = useState('')
  const [source, setSource] = useState<string | null>(null)
  const [imported, setImported] = useState<string | null>(null)
  const [rate, setRate] = useState('')
  const [plan, setPlan] = useState<DraftedPlan | null>(null)
  const [stages, setStages] = useState<EditableStage[]>([])
  const [meta, setMeta] = useState({ title: '', summary: '', clientName: '', clientEmail: '', category: '', reviewDays: 3, reviseDays: 3 })
  const [showQuestions, setShowQuestions] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const w = warrant.data as unknown as { currency?: string; categories?: string[]; perPaymentCeilingCents?: number } | undefined
  const currency = plan?.currency ?? w?.currency ?? 'USD'

  const importFile = useMutation({
    mutationFn: (file: File) => projectsApi.importBrief(file),
    onSuccess: (read) => {
      setBrief(read.text)
      setSource(read.source)
      setImported(`Imported from ${read.source}${read.pages ? `, ${read.pages} page${read.pages === 1 ? '' : 's'}` : ''}${read.readBy === 'model' ? `, read by ${read.model}` : ''}. Check it reads right before planning.`)
    },
  })
  const draft = useMutation({
    mutationFn: () => projectsApi.draft(brief, rate.trim() || null),
    onSuccess: (made) => {
      setPlan(made)
      setStages(made.stages.map((stage) => ({ ...stage, key: newKey() })))
      setMeta({ title: made.title, summary: made.summary, clientName: made.clientName ?? '', clientEmail: made.clientEmail ?? '', category: made.categories[0] ?? '', reviewDays: 3, reviseDays: 3 })
    },
  })
  const create = useMutation({
    mutationFn: async () => {
      const made = await projectsApi.create({
        title: meta.title.trim(), summary: meta.summary.trim(), clientName: meta.clientName.trim(), clientEmail: meta.clientEmail.trim(), currency, category: meta.category, reviewDays: meta.reviewDays, reviseDays: meta.reviseDays,
        stages: stages.map(({ title, description, deliverables, amountCents, dueDate }) => ({ title: title.trim(), description: description.trim(), deliverables, amountCents, dueDate })),
        brief, briefSource: source, questions: plan?.questions ?? [],
      })
      return projectsApi.send(made.id)
    },
    onSuccess: (sent) => navigate(`/projects/${sent.id}`, { state: { justSent: true } }),
  })

  const total = totalOf(stages)
  const ready = meta.title.trim() && meta.clientName.trim() && /@/.test(meta.clientEmail) && meta.category && stages.length > 0 && stages.every((stage) => stage.title.trim() && stage.deliverables.length > 0 && stage.amountCents > 0)

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Brief in. Paid stages out." title="New project" />
      <div className={`brief-layout${plan ? ' has-plan' : ''}`}>
        <section className="brief-col">
          {!plan ? <h2 className="brief-ask">What did the client send you?</h2> : null}
          {!plan ? <p className="lede">Paste it, upload it, or link to it, as it is. Mandate turns it into paid stages.</p> : null}
          <label className="field">
            <span>Client brief</span>
            <textarea className="brief-box" rows={plan ? 18 : 9} value={brief} data-testid="brief" placeholder="Paste the DM, email or call notes here, or drop a PDF, Word file or screenshot"
              onChange={(event) => setBrief(event.target.value)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) importFile.mutate(file) }} />
          </label>
          <div className="row gap-s wrap brief-tools">
            <button type="button" className="btn btn-ghost btn-small" onClick={() => fileInput.current?.click()} disabled={importFile.isPending}>{importFile.isPending ? <><Spinner /> Reading…</> : 'Attach file'}</button>
            <input ref={fileInput} type="file" hidden accept=".pdf,.docx,.txt,.md,image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) importFile.mutate(file); event.target.value = '' }} />
            {!brief ? <button type="button" className="btn btn-ghost btn-small" onClick={() => { setBrief(EXAMPLE); setSource('example') }}>Use an example</button> : null}
            <span className="fine">PDF, Word, text or screenshot</span>
          </div>
          {imported ? <p className="notice-line" role="status">{imported} <button type="button" className="link-button" onClick={() => setImported(null)}>Got it</button></p> : null}
          <ProblemCard error={importFile.error} />
          <label className="field">
            <span>Your usual rate <small>(optional)</small></span>
            <input value={rate} onChange={(event) => setRate(event.target.value)} placeholder="e.g. $45/hour or $1,500 per brand kit" />
          </label>
          <button type="button" className="btn btn-ink btn-big" disabled={brief.trim().length < 20 || draft.isPending} onClick={() => draft.mutate()} data-testid="plan-payments">
            {draft.isPending ? <><Spinner /> Planning the payments…</> : plan ? 'Plan again from the brief' : 'Plan the payments'}
          </button>
          <ProblemCard error={draft.error} />
          {!plan ? (
            <ol className="how-steps">
              <li><b>1</b> Mandate splits the brief into priced, dated stages</li>
              <li><b>2</b> You check them and send the client a link</li>
              <li><b>3</b> They pay each stage into a PayPal hold, and release it when they approve the work</li>
            </ol>
          ) : null}
        </section>

        {plan ? (
          <section className="plan-col panel" data-testid="drafted-plan">
            <div className="row between wrap gap-s">
              <span className="eyebrow">Payment plan</span>
              <span className="fine">{plan.source === 'model' ? `Drafted by ${plan.model}, read back by code` : 'Split with plain rules'}</span>
            </div>
            <input className="plan-title-input" value={meta.title} onChange={(event) => setMeta({ ...meta, title: event.target.value })} aria-label="Project title" />
            <textarea className="plan-summary-input" rows={2} value={meta.summary} onChange={(event) => setMeta({ ...meta, summary: event.target.value })} aria-label="Summary" placeholder="One or two lines the client reads first" />
            {plan.note ? <p className="fine">{plan.note}</p> : null}
            {plan.flags.length > 0 ? (
              <ul className="plan-flags" aria-label="What code found">
                {plan.flags.map((flag) => <li key={flag.text} className={`flag-${flag.level}`}><Chip tone={flag.level === 'red' ? 'deny' : 'need'}>{flag.level === 'red' ? 'Check' : 'Note'}</Chip>{flag.text}</li>)}
              </ul>
            ) : <p className="fine flag-clear">✓ Code read the plan back against the brief: within the stated budget and deadline.</p>}
            <div className="client-box">
              <label className="field"><span>Client</span><input value={meta.clientName} onChange={(event) => setMeta({ ...meta, clientName: event.target.value })} /></label>
              <label className="field"><span>Client email</span><input type="email" value={meta.clientEmail} onChange={(event) => setMeta({ ...meta, clientEmail: event.target.value })} /></label>
              <label className="field"><span>Kind of work</span>
                <select value={meta.category} onChange={(event) => setMeta({ ...meta, category: event.target.value })}>
                  {plan.categories.map((category) => <option key={category} value={category}>{category}</option>)}
                </select>
              </label>
            </div>
            <div className="row between"><h3 className="panel-title">Stages</h3><span className="fine">{stages.length} payment{stages.length === 1 ? '' : 's'}</span></div>
            <PlanEditor stages={stages} currency={currency} onChange={setStages} ceilingCents={w?.perPaymentCeilingCents ?? null} />
            <div className="windows">
              <label className="field field-inline"><span>Client reviews each stage for</span><select value={meta.reviewDays} onChange={(event) => setMeta({ ...meta, reviewDays: Number(event.target.value) })}>{[1, 2, 3, 5, 7, 10, 14].map((n) => <option key={n} value={n}>{n} day{n === 1 ? '' : 's'}</option>)}</select></label>
              <label className="field field-inline"><span>You send a revision within</span><select value={meta.reviseDays} onChange={(event) => setMeta({ ...meta, reviseDays: Number(event.target.value) })}>{[1, 2, 3, 5, 7, 10, 14].map((n) => <option key={n} value={n}>{n} day{n === 1 ? '' : 's'}</option>)}</select></label>
              <p className="fine">Both are part of the plan the client signs. Silence past the review window releases the money to you; a missed revision deadline lets the client cancel and be released from the hold.{meta.reviewDays > 3 ? ' Past three days PayPal renews the hold once before capturing it.' : ''}</p>
            </div>
            {plan.questions.length > 0 ? (
              <div className="questions">
                <button type="button" className="link-button" onClick={() => setShowQuestions((open) => !open)}>ⓘ {plan.questions.length} question{plan.questions.length === 1 ? '' : 's'} worth asking the client {showQuestions ? '▴' : '▾'}</button>
                {showQuestions ? <ul>{plan.questions.map((question) => <li key={question}>{question}</li>)}</ul> : null}
              </div>
            ) : null}
            <ProblemCard error={create.error} />
            <div className="plan-foot">
              <div><span className="money money-lg">{dollars(total, currency)}</span> <span className="muted">in {stages.length} payment{stages.length === 1 ? '' : 's'}</span><p className="fine">{meta.clientName || 'The client'} approves this plan before paying anything.</p></div>
              <button type="button" className="btn btn-lime btn-big" disabled={!ready || create.isPending} onClick={() => create.mutate()} data-testid="create-project">{create.isPending ? <><Spinner /> Creating…</> : 'Create project and send'}</button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}
