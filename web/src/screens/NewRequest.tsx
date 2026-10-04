import { useMutation, useQueries } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Chip, GateChip, Loading, NoMoneyMoved, PageHead, PhaseChip, ProblemCard } from '../components/ui'
import { api } from '../lib/api'
import { newKey } from '../lib/format'
import { useIsOwner, useNames, useOnline, useProposals, useRefreshMoney, useWarrant } from '../lib/hooks'
import { centsInput, dollars, parseCents } from '../lib/money'
import type { Kind, Proposal, ProposalInput } from '../lib/types'
import { explain, KIND } from '../lib/words'

const OTHER = '__other__'
const UNFUNDED = '__none__'

export function NewRequest() {
  const [params] = useSearchParams()
  const warrant = useWarrant()
  const proposals = useProposals()
  const names = useNames()
  const owner = useIsOwner()
  const online = useOnline()
  const refresh = useRefreshMoney()

  const [kind, setKind] = useState<Kind>((params.get('kind') as Kind | null) ?? 'payment')
  const [party, setParty] = useState('')
  const [stranger, setStranger] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState('')
  const [otherCategory, setOtherCategory] = useState('')
  const [description, setDescription] = useState('')
  const [evidenceUrl, setEvidenceUrl] = useState('')
  const [prompt, setPrompt] = useState('')
  const [jobId, setJobId] = useState(params.get('job') ?? '')
  const [funding, setFunding] = useState(params.get('funding') ?? '')
  const [parent, setParent] = useState(params.get('parent') ?? '')

  const rows = proposals.data?.data ?? []
  // Only PayPal captures can be refunded or fund a payout. A paid payout has a Payouts id, not a capture id.
  const captured = rows.filter((row) => row.phase === 'captured' && Boolean(row.captureId) && (row.kind === 'charge' || row.kind === 'payment'))
  const charges = captured.filter((row) => row.kind === 'charge')
  const jobIds = [...new Set(rows.map((row) => row.jobId).filter((id): id is string => Boolean(id)))]
  const fundingJobs = [...new Set(charges.map((row) => row.jobId).filter((id): id is string => Boolean(id)))]
  const jobQueries = useQueries({ queries: fundingJobs.map((id) => ({ queryKey: ['job', id], queryFn: () => api.job(id) })) })
  const fundable = useMemo(() => {
    const map = new Map<string, number>()
    for (const query of jobQueries) for (const charge of query.data?.charges ?? []) if (charge.captureId) map.set(charge.captureId, charge.fundableCents)
    return map
  }, [jobQueries])

  const parentRow = captured.find((row) => row.captureId === parent) ?? null
  const fundingRow = charges.find((row) => row.captureId === funding) ?? null
  const people = kind === 'charge' ? warrant.data?.clients ?? [] : warrant.data?.payees ?? []

  // Sensible defaults that follow the kind and the chosen source of money.
  useEffect(() => {
    if (kind === 'refund' && parentRow) {
      setParty(parentRow.payeeId ?? '')
      setCategory(parentRow.category ?? '')
      setAmount((current) => current || centsInput(parentRow.amountCents))
      setJobId(parentRow.jobId ?? '')
    }
  }, [kind, parentRow])
  useEffect(() => {
    if (kind === 'payment' && fundingRow) setJobId(fundingRow.jobId ?? '')
  }, [kind, fundingRow])
  useEffect(() => {
    if (kind !== 'refund' && people.length > 0 && !people.some((item) => item.id === party)) setParty(people[0]!.id)
  }, [kind, people, party])
  useEffect(() => {
    if (!category && warrant.data?.categories[0]) setCategory(warrant.data.categories[0])
  }, [warrant.data, category])

  const cents = parseCents(amount)
  const finalCategory = category === OTHER ? otherCategory.trim().toLowerCase() : category
  const payee = stranger !== null && kind !== 'refund' ? stranger.trim() : party
  const input: ProposalInput | null = cents === null || !payee || !description.trim() ? null : {
    kind,
    payee,
    amountCents: cents,
    currency: warrant.data?.currency ?? 'USD',
    category: finalCategory || undefined,
    description: description.trim(),
    evidenceUrl: evidenceUrl.trim() || undefined,
    prompt: prompt.trim() || undefined,
    jobId: jobId.trim() || undefined,
    fundingCaptureId: kind === 'payment' && funding && funding !== UNFUNDED ? funding : undefined,
    parentCaptureId: kind === 'refund' ? parent || undefined : undefined,
  }

  // One idempotency key per distinct request body. A retry of the same body reuses it, so a double tap cannot ask twice.
  const signature = JSON.stringify(input)
  const [idem, setIdem] = useState(() => newKey('web'))
  useEffect(() => setIdem(newKey('web')), [signature])

  const send = useMutation({ mutationFn: (body: ProposalInput) => api.propose(body, idem), onSuccess: () => void refresh() })
  const result: Proposal | undefined = send.data
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (input) send.mutate(input)
  }
  const reset = () => {
    send.reset()
    setAmount('')
    setDescription('')
    setPrompt('')
    setIdem(newKey('web'))
  }

  if (warrant.isLoading) return <div className="page"><Loading /></div>

  return (
    <div className="page">
      <PageHead eyebrow="New request · the rules decide, not this screen" title="Ask to move money" />
      <div className="new-grid">
        <form className="panel stack" onSubmit={submit} aria-describedby="new-help">
          <fieldset className="segmented" aria-label="Kind">
            {(['charge', 'payment', 'refund'] as Kind[]).map((value) => (
              <label key={value} className={kind === value ? 'on' : ''}>
                <input type="radio" name="kind" value={value} checked={kind === value} onChange={() => { setKind(value); send.reset() }} />
                <span>{KIND[value].arrow} {KIND[value].label}</span>
              </label>
            ))}
          </fieldset>

          {kind === 'refund' ? (
            <label className="field">
              <span>Refund which settled payment</span>
              <select value={parent} onChange={(event) => setParent(event.target.value)} required>
                <option value="">Choose a settled payment</option>
                {captured.map((row) => <option key={row.id} value={row.captureId ?? ''}>{KIND[row.kind].short} · {names(row.payeeId)} · {dollars(row.amountCents)} · {row.captureId}</option>)}
              </select>
            </label>
          ) : (
            <label className="field">
              <span>{kind === 'charge' ? 'Bill which client' : 'Pay whom'}</span>
              <select value={stranger !== null ? '__stranger__' : party} onChange={(event) => {
                if (event.target.value === '__stranger__') setStranger('')
                else { setStranger(null); setParty(event.target.value) }
              }}>
                {people.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
                <option value="__stranger__">Someone not on the rules…</option>
              </select>
            </label>
          )}
          {stranger !== null && kind !== 'refund' ? (
            <label className="field"><span>Their name or account</span><input value={stranger} onChange={(event) => setStranger(event.target.value)} placeholder="P. Shah (new account)" required /><small>The rules refuse anyone not listed. Try it.</small></label>
          ) : null}

          {kind === 'payment' ? (
            <label className="field">
              <span>Funded by which client payment</span>
              <select value={funding} onChange={(event) => setFunding(event.target.value)}>
                <option value="">Choose a settled client payment</option>
                {charges.map((row) => (
                  <option key={row.id} value={row.captureId ?? ''}>
                    {names(row.payeeId)} · {dollars(row.capturedAmountCents)} · {row.jobId} · can fund {fundable.has(row.captureId ?? '') ? dollars(fundable.get(row.captureId ?? '')) : '…'}
                  </option>
                ))}
                <option value={UNFUNDED}>Nothing yet · the client has not paid</option>
              </select>
              <small>Contractors are paid only from client money already settled on the same job.</small>
            </label>
          ) : null}

          <div className="field-row">
            <label className="field">
              <span>Amount</span>
              <span className="dollar-input big"><span>$</span><input inputMode="decimal" autoComplete="off" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="90.00" required /></span>
              <small className="mono">{cents === null ? 'Dollars and cents' : `= ${cents} cents`}</small>
            </label>
            <label className="field">
              <span>Kind of work</span>
              <select value={category} onChange={(event) => setCategory(event.target.value)} disabled={kind === 'refund' && Boolean(parentRow)}>
                {(warrant.data?.categories ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
                <option value={OTHER}>Something else…</option>
              </select>
              {category === OTHER ? <input value={otherCategory} onChange={(event) => setOtherCategory(event.target.value)} placeholder="lunch" aria-label="Other kind of work" /> : null}
            </label>
          </div>

          <label className="field"><span>What it is for</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder={kind === 'charge' ? 'Northwind logo milestone 1 invoice' : 'Northwind logo milestone 1'} required maxLength={500} /></label>
          <label className="field"><span>Link to the work</span><input type="url" value={evidenceUrl} onChange={(event) => setEvidenceUrl(event.target.value)} placeholder="https://www.figma.com/file/northwind-logo" /><small>The rules need an https link.</small></label>
          {kind !== 'payment' ? (
            <label className="field">
              <span>Job</span>
              <input list="jobs" value={jobId} onChange={(event) => setJobId(event.target.value)} placeholder="job_northwind_logo" pattern="[a-z0-9][a-z0-9_-]{0,63}" readOnly={kind === 'refund' && Boolean(parentRow)} />
              <datalist id="jobs">{jobIds.map((id) => <option key={id} value={id} />)}</datalist>
            </label>
          ) : jobId ? <p className="fine">Job <span className="mono">{jobId}</span>, taken from the client payment.</p> : null}
          <label className="field"><span>How it was asked, in words</span><textarea rows={2} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Pay Priya her $90 share for Northwind milestone 1" maxLength={4000} /></label>

          <div className="row between wrap gap-s">
            <span className="mono small muted" title="Sent as the Idempotency-Key header">Idempotency-Key {idem.slice(0, 18)}…</span>
            <button type="submit" className="btn btn-lime btn-big" disabled={!input || !online || send.isPending}>{send.isPending ? 'Asking the rules…' : 'Ask the rules'}</button>
          </div>
          <ProblemCard error={send.error} />
        </form>

        <aside className="stack-l" id="new-help" aria-live="polite">
          {result ? (
            <section className={`panel answer answer-${result.gate.toLowerCase()}`}>
              <div className="row between"><span className="eyebrow">The rules answered</span><GateChip gate={result.gate} /></div>
              <h2 className="answer-amount">{dollars(result.amountCents)} <span>{KIND[result.kind].label.toLowerCase()} · {names(result.payeeId)}</span></h2>
              <p className="decision-words">{explain(result.clause, result, warrant.data, names)}</p>
              <p className="server-words"><span>Server · {result.clause}</span>{result.detail}</p>
              {result.gate === 'DENY' ? <NoMoneyMoved /> : null}
              <div className="row gap-s wrap">
                {result.phase !== 'denied' ? <PhaseChip phase={result.phase} /> : null}
                <Link className="btn btn-ink" to={`/p/${result.id}`}>Open receipt →</Link>
                {result.gate === 'NEEDS_APPROVAL' && owner ? <Link className="btn btn-lime" to="/">Review and approve</Link> : null}
                <button type="button" className="btn btn-ghost" onClick={reset}>New request</button>
              </div>
            </section>
          ) : (
            <section className="panel">
              <span className="eyebrow">Rules v{warrant.data?.version}</span>
              <ul className="rules-short">
                <li><Chip tone="auto">Automatic</Chip> under {dollars(warrant.data?.autoSettleUnderCents)}</li>
                <li><Chip tone="need">Needs you</Chip> {dollars(warrant.data?.autoSettleUnderCents)} and above</li>
                <li><Chip tone="deny">Refused</Chip> anyone or anything not on the rules</li>
              </ul>
              <p className="fine">This screen never predicts the answer. It sends the request, and the server’s decision comes back word for word. A refusal is stored too, and PayPal is not called.</p>
              <Link to="/rules" className="link">Read the rules →</Link>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}
