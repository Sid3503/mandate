import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../lib/api'
import { useOnline, useWarrant } from '../lib/hooks'
import { dollars, parseCents } from '../lib/money'
import type { TryVerdict, Warrant } from '../lib/types'
import { explain, GATE } from '../lib/words'
import { Chip, GateChip, ProblemCard } from './ui'

type Rules = Omit<Warrant, 'id' | 'version' | 'createdAt'>

const same = (a: TryVerdict | null, b: TryVerdict | null) => a && b && a.gate === b.gate && a.clause === b.clause

/**
 * Check a rule against what its writer meant, before it matters. Type a request and see the verdict the gate would give,
 * or run the cases made from the rules' own numbers (just under the no-tap line, exactly on it, a stranger, work that is
 * not allowed). With a draft open, each row shows the live rules and the draft side by side. Nothing is filed and PayPal is
 * never called: the gate is a pure function, so asking it is free.
 */
export function TryRules({ rules }: { rules?: Rules }) {
  const online = useOnline()
  const warrant = useWarrant()
  const signature = rules ? JSON.stringify(rules) : 'live'
  const cases = useQuery({ queryKey: ['try-cases', signature], queryFn: () => api.tryCases(rules), staleTime: 15_000 })
  const [payee, setPayee] = useState('')
  const [amount, setAmount] = useState('50')
  const [work, setWork] = useState('')
  const [withProof, setWithProof] = useState(true)
  const [cite, setCite] = useState(true)
  const people = warrant.data?.payees ?? []
  const kinds = rules?.categories ?? warrant.data?.categories ?? []
  const funding = cases.data?.funding ?? null
  const cents = parseCents(amount)
  const run = useMutation({
    mutationFn: () => api.tryRequest({
      kind: 'payment', payee: payee || people[0]?.displayName || 'Priya', amountCents: cents ?? 0, currency: warrant.data?.currency ?? 'USD', category: work || kinds[0] || 'design',
      description: 'Try-it request', ...(withProof ? { evidenceUrl: 'https://www.figma.com/file/try-it' } : {}),
      ...(cite && funding ? { fundingCaptureId: funding.captureId, ...(funding.jobId ? { jobId: funding.jobId } : {}) } : {}),
    }, rules),
  })

  return (
    <section className="try" aria-labelledby="h-try" data-testid="try-rules">
      <h3 className="try-title" id="h-try">Try it before it matters</h3>
      <form className="try-form" onSubmit={(event) => { event.preventDefault(); if (cents) run.mutate() }}>
        <label className="field"><span>Pay</span>
          <select value={payee} onChange={(event) => setPayee(event.target.value)}>
            {people.map((person) => <option key={person.id} value={person.displayName}>{person.displayName}</option>)}
            <option value="A. Stranger">A stranger (not on the rules)</option>
          </select>
        </label>
        <label className="field"><span>Amount</span><span className="dollar-input"><span>$</span><input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></span></label>
        <label className="field"><span>Kind of work</span>
          <select value={work} onChange={(event) => setWork(event.target.value)}>
            {kinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
            <option value="lunch">lunch (not listed)</option>
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={withProof} onChange={(event) => setWithProof(event.target.checked)} /> With a link to the work</label>
        <label className="check"><input type="checkbox" checked={cite && funding !== null} disabled={funding === null} onChange={(event) => setCite(event.target.checked)} /> {funding ? `Cite a settled client payment (${dollars(funding.canStillFundCents)} left to pay out)` : 'No settled client payment yet to cite'}</label>
        <button type="submit" className="btn btn-ink btn-small" disabled={!online || !cents || run.isPending}>{run.isPending ? 'Asking the rules…' : 'Try it'}</button>
      </form>
      <ProblemCard error={run.error} />
      {run.data ? (
        <div className="try-result" role="status" data-testid="try-result">
          <div className="row gap-s wrap"><GateChip gate={run.data.live.gate} /><code>{run.data.live.clause}</code><span>under the live rules</span></div>
          <p className="fine">{explain(run.data.live.clause, { amountCents: cents ?? undefined, payeeId: people.find((person) => person.displayName === (payee || people[0]?.displayName))?.id }, warrant.data, (id) => people.find((person) => person.id === id)?.displayName ?? 'That party') || run.data.live.detail}</p>
          {run.data.draft ? <div className="row gap-s wrap"><GateChip gate={run.data.draft.gate} /><code>{run.data.draft.clause}</code><span>under this draft{same(run.data.live, run.data.draft) ? ' (the same)' : ' (different)'}</span></div> : null}
          <p className="fine">Nothing was filed and PayPal was not called.</p>
        </div>
      ) : null}

      <h3 className="try-title">Cases made from the rules</h3>
      <p className="fine">Each is a request on a boundary of your rules. Read down the column: is each answer what you meant?{rules ? ' The right-hand column is the draft.' : ''}</p>
      <ProblemCard error={cases.error} />
      {cases.data && cases.data.cases.length > 0 ? (
        <table className="diff try-cases">
          <thead><tr><th scope="col">Request</th><th scope="col">{rules ? 'Live rules' : 'Answer'}</th>{rules ? <th scope="col">This draft</th> : null}</tr></thead>
          <tbody>
            {cases.data.cases.map((item) => (
              <tr key={item.id} className={rules && !same(item.live, item.draft) ? 'try-changed' : ''}>
                <th scope="row">{item.label}</th>
                <td><Chip tone={GATE[item.live.gate].tone}>{GATE[item.live.gate].label}</Chip> <code>{item.live.clause}</code></td>
                {rules ? <td>{item.draft ? <><Chip tone={GATE[item.draft.gate].tone}>{GATE[item.draft.gate].label}</Chip> <code>{item.draft.clause}</code></> : '—'}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : cases.isLoading ? <p className="fine">Making the cases…</p> : <p className="fine">No cases yet.</p>}
      {cases.data && !cases.data.funding ? <p className="fine">No client has paid yet, so cases about small or unproven payouts are left out: the rules ask for client money first.</p> : null}
    </section>
  )
}

