import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { newKey } from '../lib/format'
import { useIsOwner, useNames, useOnline, useRefreshMoney, useWarrant } from '../lib/hooks'
import type { DraftField, InvoiceDraft } from '../lib/invoices'
import { centsInput, dollars } from '../lib/money'
import type { Proposal, ProposalInput } from '../lib/types'
import { explain } from '../lib/words'
import { LineItemsEditor, rowsToItems, type ItemRow } from './LineItemsEditor'
import { useToast } from './Toast'
import { Chip, ProblemCard } from './ui'

const EXAMPLES = [
  'Bill Northwind $120 for logo tweaks, net 14, send to accounts@northwind.example',
  'Invoice Northwind: logo design $200, banner x2 $40 each, due in 2 weeks',
  'Hey PayPilot, bill PayPal Hackathon Sponsor $120 for PayPilot AI Copilot MVP development and PayPal sandbox integration. Send it to buyer@personal.example.com in USD.',
]

/** One line each, shown under a field the notes did not fill. Nothing is guessed to fill the gap. */
const PROMPTS: Record<DraftField, string> = {
  client: 'The notes do not name a client on your rules. Choose who to bill.',
  price: 'The notes give no price for this. Type one, or leave the bill unasked.',
  description: 'The notes do not say what each line is for. Say it.',
  dueDate: 'No due date in the notes. Optional: without one, the bill counts as due 14 days after it goes out.',
  jobId: 'Every bill names the job it pays for. The notes did not. Name one.',
  category: 'The rules need a kind of work. The notes did not say, so choose one.',
  evidenceUrl: 'The rules need an https link to the work. The notes had none.',
}

const rowsOf = (draft: InvoiceDraft): ItemRow[] => draft.lineItems.map((item, index) => ({ key: index + 1, description: item.description, quantity: String(item.quantity), price: item.unitCents === null ? '' : centsInput(item.unitCents) }))

/**
 * Notes to invoice. Messy words go to the server, which reads them against your rules and answers with a LOCAL DRAFT: it
 * is not filed, not signed and not sent. Every field is editable. A field the notes did not give is highlighted, never
 * filled in for you. "Ask for this bill" is the same request the New request form sends: the rules decide, and you approve
 * it on the receipt.
 */
export function NotesToInvoice({ jobIds }: { jobIds: string[] }) {
  const [notes, setNotes] = useState('')
  const draft = useMutation({ mutationFn: (text: string) => api.draftInvoice(text) })
  return (
    <section className="panel notes-invoice" aria-labelledby="notes-title" data-testid="notes-to-invoice">
      <div className="row between wrap gap-s"><h2 className="panel-title" id="notes-title">Notes to invoice</h2><Chip tone="muted">draft only</Chip></div>
      <p className="fine">Paste what the client or you wrote. Mandate reads it against your rules and drafts a bill. Nothing is sent, and nothing is asked of PayPal.</p>
      <label className="field"><span>Your notes</span>
        <textarea rows={5} maxLength={4000} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Bill Northwind $120 for logo tweaks, net 14, send to accounts@northwind.example" data-testid="notes-input" />
      </label>
      <div className="chat-examples" role="group" aria-label="Example notes">
        {EXAMPLES.map((text) => <button key={text} type="button" className="example" onClick={() => setNotes(text)}>{text.length > 64 ? `${text.slice(0, 62)}…` : text}</button>)}
      </div>
      <div className="row gap-s wrap">
        <button type="button" className="btn btn-lime" disabled={!notes.trim() || draft.isPending} onClick={() => draft.mutate(notes)} data-testid="draft-it">{draft.isPending ? 'Reading your notes…' : 'Draft it'}</button>
        {draft.data ? <button type="button" className="btn btn-ghost" onClick={() => { draft.reset(); setNotes('') }}>Start over</button> : null}
      </div>
      <ProblemCard error={draft.error} />
      {draft.data ? <DraftCard key={draft.submittedAt} draft={draft.data} notes={notes} jobIds={jobIds} /> : null}
    </section>
  )
}

function DraftCard({ draft, notes, jobIds }: { draft: InvoiceDraft; notes: string; jobIds: string[] }) {
  const warrant = useWarrant()
  const names = useNames()
  const online = useOnline()
  const owner = useIsOwner()
  const refresh = useRefreshMoney()
  const toast = useToast()
  const [clientId, setClientId] = useState(draft.client?.id ?? '')
  const [rows, setRows] = useState<ItemRow[]>(() => rowsOf(draft))
  const [dueDate, setDueDate] = useState(draft.dueDate ?? '')
  const [note, setNote] = useState(draft.customerNote ?? '')
  const [jobId, setJobId] = useState(draft.jobId ?? '')
  const [category, setCategory] = useState(draft.category ?? '')
  const [evidenceUrl, setEvidenceUrl] = useState(draft.evidenceUrl ?? '')
  const missing = new Set<DraftField>(draft.missing)
  // A field stays highlighted until the person has given it a value.
  const lacks = (field: DraftField, value: string) => missing.has(field) && !value.trim()
  const items = rowsToItems(rows)
  const total = items ? items.reduce((sum, item) => sum + item.quantity * item.unitCents, 0) : null
  const currency = draft.currency
  const foreign = currency !== (warrant.data?.currency ?? 'USD')
  const jobOk = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(jobId.trim())

  const input: ProposalInput | null = clientId && items && total !== null && jobOk && category && /^https:\/\//i.test(evidenceUrl.trim())
    ? {
        kind: 'charge', payee: clientId, amountCents: total, currency, category, description: items.map((item) => item.description).join(', ').slice(0, 500),
        evidenceUrl: evidenceUrl.trim(), jobId: jobId.trim(), lineItems: items, prompt: notes.slice(0, 4000),
        dueDate: dueDate || undefined, customerNote: note.trim() || undefined,
      }
    : null

  // What the rules would say about this draft as it is edited: the existing pure preview, which files nothing.
  const signature = JSON.stringify(input)
  const verdict = useQuery({ queryKey: ['invoice-verdict', signature], queryFn: () => api.tryRequest(input as unknown as Record<string, unknown>), enabled: input !== null, staleTime: 15_000, retry: false })
  const live = input ? verdict.data?.live ?? null : null
  const shownVerdict = live ?? (input ? null : draft.verdict)
  const [idem, setIdem] = useState(() => newKey('web'))
  useEffect(() => setIdem(newKey('web')), [signature])
  const ask = useMutation({
    mutationFn: (body: ProposalInput) => api.propose(body, idem),
    onSuccess: (made: Proposal) => {
      toast(made.gate === 'DENY' ? { title: 'Refused by the rules', body: `${made.clause}. Nothing moved.`, tone: 'info' } : made.gate === 'AUTO' ? { title: 'Filed. No tap needed', body: 'It is inside your rules.' } : { title: 'Filed. Waiting for your tap', body: 'Approve it on its receipt.', tone: 'warn' })
      void refresh()
    },
  })
  const made = ask.data
  const clients = warrant.data?.clients ?? []
  const verdictWords = useMemo(() => {
    if (!shownVerdict) return null
    const why = explain(shownVerdict.clause, { kind: 'charge', payeeId: clientId || null, amountCents: total ?? draft.totalCents ?? undefined, category }, warrant.data, names)
    const lead = shownVerdict.gate === 'DENY' ? 'Refused' : shownVerdict.gate === 'AUTO' ? 'No tap needed' : 'Needs your tap'
    return { tone: shownVerdict.gate === 'DENY' ? ('deny' as const) : shownVerdict.gate === 'AUTO' ? ('auto' as const) : ('need' as const), text: `${lead}: ${why}` }
  }, [shownVerdict, clientId, total, category, warrant.data, names, draft.totalCents])
  const incomplete = !input

  return (
    <div className="draft-card" data-testid="draft-card" aria-label="Local draft">
      <div className="row between wrap gap-s">
        <h3 className="panel-title">Your draft</h3>
        <div className="row gap-s wrap"><Chip tone="muted">local draft</Chip><Chip tone="muted" title={draft.source === 'model' ? 'The AI helper phrased the lines and every number was checked against your notes.' : 'Read with plain rules.'}>{draft.source === 'model' ? 'AI-assisted, numbers checked' : 'read by rules'}</Chip></div>
      </div>
      <p className="banner-line" data-testid="nothing-asked">Nothing is asked of PayPal until you approve it.</p>
      {draft.warnings.length > 0 ? <ul className="draft-warnings" aria-label="Things to check">{draft.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}

      <label className={`field${lacks('client', clientId) ? ' field-missing' : ''}`}>
        <span>Client</span>
        <select value={clientId} onChange={(event) => setClientId(event.target.value)} data-testid="draft-client">
          <option value="">Choose a client on your rules</option>
          {clients.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
        </select>
        {draft.client && clientId === draft.client.id ? <small>Matched by {draft.client.matchedBy} from your notes.</small> : null}
        {lacks('client', clientId) ? <small className="missing-prompt" role="note">{PROMPTS.client}</small> : null}
      </label>

      <LineItemsEditor rows={rows} onChange={setRows} currency={currency} legend="Line items" flagged={(missing.has('price') || missing.has('description')) && !items} flagText={missing.has('price') ? PROMPTS.price : PROMPTS.description} />
      {foreign ? <p className="missing-prompt" role="note">These are {currency} amounts. Mandate bills in {warrant.data?.currency ?? 'USD'} only, so change them to {warrant.data?.currency ?? 'USD'} yourself. Nothing was converted.</p> : null}
      <p className="fine mono" data-testid="draft-total">Total {total === null ? 'cannot be worked out until every line has a price' : dollars(total, currency)}</p>

      <div className="field-row">
        <label className={`field${lacks('dueDate', dueDate) ? ' field-soft' : ''}`}><span>Due date</span>
          <input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} aria-label="Due date" />
          {lacks('dueDate', dueDate) ? <small className="missing-prompt" role="note">{PROMPTS.dueDate}</small> : null}
        </label>
        <label className={`field${lacks('jobId', jobId) || (jobId && !jobOk) ? ' field-missing' : ''}`}><span>Job</span>
          <input list="draft-jobs" value={jobId} onChange={(event) => setJobId(event.target.value)} placeholder="e.g. job_spring-launch" aria-label="Job" />
          <datalist id="draft-jobs">{jobIds.map((id) => <option key={id} value={id} />)}</datalist>
          {lacks('jobId', jobId) ? <small className="missing-prompt" role="note">{PROMPTS.jobId}</small> : jobId && !jobOk ? <small className="missing-prompt" role="note">Lowercase letters, numbers, - and _ only.</small> : null}
        </label>
      </div>
      <div className="field-row">
        <label className={`field${lacks('category', category) ? ' field-missing' : ''}`}><span>Kind of work</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Kind of work">
            <option value="">Choose one</option>
            {(warrant.data?.categories ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          {lacks('category', category) ? <small className="missing-prompt" role="note">{PROMPTS.category}</small> : null}
        </label>
        <label className={`field${lacks('evidenceUrl', evidenceUrl) ? ' field-missing' : ''}`}><span>Link to the work</span>
          <input type="url" value={evidenceUrl} onChange={(event) => setEvidenceUrl(event.target.value)} placeholder="https://example.com/the-work" aria-label="Link to the work" />
          {lacks('evidenceUrl', evidenceUrl) ? <small className="missing-prompt" role="note">{PROMPTS.evidenceUrl}</small> : null}
        </label>
      </div>
      <label className="field"><span>Note for the client <span className="fine">(optional)</span></span><textarea rows={2} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} aria-label="Note for the client" /></label>

      <div className="verdict-row" aria-live="polite" data-testid="draft-verdict">
        {verdictWords ? <><Chip tone={verdictWords.tone}>{verdictWords.tone === 'deny' ? 'Refused' : verdictWords.tone === 'auto' ? 'No tap needed' : 'Needs your tap'}</Chip><span>{verdictWords.text}{input ? '' : ' (so far, with what is filled in)'}</span></> : <span className="fine">The rules’ answer appears once there is a client and a total.</span>}
      </div>

      <div className="row between wrap gap-s">
        <span className="fine">{incomplete ? 'To ask for this bill, fill in the highlighted fields.' : 'This sends the same request the New request form sends. The rules decide, and you approve it on the receipt.'}</span>
        <button type="button" className="btn btn-lime btn-big" disabled={!input || !online || ask.isPending || Boolean(made) || foreign} onClick={() => input && ask.mutate(input)} data-testid="ask-bill">{ask.isPending ? 'Asking the rules…' : 'Ask for this bill'}</button>
      </div>
      <ProblemCard error={ask.error} />
      {made ? (
        <p className="draft-done" role="status" data-testid="draft-done">
          {made.gate === 'DENY' ? 'The rules refused it. Nothing moved. ' : made.gate === 'AUTO' ? 'Filed. It is inside your rules and needs no tap. ' : owner ? 'Filed. Open the receipt to approve it. ' : 'Filed. The owner approves it. '}
          <Link className="btn btn-ink btn-small" to={`/p/${made.id}`} data-testid="draft-receipt-link">Open the receipt →</Link>
        </p>
      ) : null}
    </div>
  )
}
