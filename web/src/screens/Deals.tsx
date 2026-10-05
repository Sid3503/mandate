import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useToast } from '../components/Toast'
import { NegotiationStage } from '../components/NegotiationStage'
import { Signature } from '../components/Signature'
import { Chip, Empty, Loading, Money, PageHead, PhaseChip, ProblemCard } from '../components/ui'
import { api } from '../lib/api'
import { when } from '../lib/format'
import { useAgentsOn, useDeals, useIsOwner, useOnline, useRefreshDeals } from '../lib/hooks'
import { dollars, parseCents } from '../lib/money'
import type { Deal, PartyRulesView } from '../lib/types'
import { useNegotiation } from '../lib/useNegotiation'
import { DEAL_RULE } from '../lib/words'

const newKey = () => `web-deal-${crypto.randomUUID()}`

export function Deals() {
  const deals = useDeals()
  const owner = useIsOwner()
  const agents = useAgentsOn()
  const online = useOnline()
  const refresh = useRefreshDeals()
  const live = useNegotiation(() => void refresh())
  const [highlight, setHighlight] = useState<string | null>(null)
  const rules = useQuery({ queryKey: ['party-rules'], queryFn: api.partyRules, enabled: owner })
  const running = live.state.phase === 'running'
  const buyerMax = rules.data?.data.find((item) => item.role === 'buyer')?.maxTotalCents
  const sellerMin = rules.data?.data.find((item) => item.role === 'seller')?.minTotalCents
  const jump = () => {
    setHighlight(live.state.agreedDealId)
    document.getElementById(`deal-${live.state.agreedDealId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  // When the agreed deal appears in the list, bring it into view once.
  useEffect(() => {
    if (live.state.phase === 'done' && live.state.agreedDealId) {
      const timer = window.setTimeout(jump, 600)
      return () => window.clearTimeout(timer)
    }
  }, [live.state.phase, live.state.agreedDealId])
  const rows = deals.data?.data ?? []
  const threads = groupThreads(rows)

  return (
    <div className="page">
      <PageHead eyebrow="Two companies agree before any money exists" title="Deals">
        {owner ? (
          <button type="button" className="btn btn-lime" data-tour="deal-negotiate" disabled={!agents || !online || running} onClick={() => void live.start()} title={agents ? 'Two AI agents negotiate inside both companies’ rules' : 'Set OLLAMA_API_KEY to turn the agents on'}>
            {running ? 'Agents are negotiating…' : 'Let the agents negotiate'}
          </button>
        ) : null}
      </PageHead>

      <p className="lede deals-lede">A deal only exists where the studio’s rules and the client’s rules overlap. Agents can say anything to each other. The rules decide what stands.</p>
      <ProblemCard error={live.state.phase === 'failed' ? live.state.error : null} />
      {live.state.phase !== 'idle' ? <NegotiationStage state={live.state} buyerMax={buyerMax} sellerMin={sellerMin} onStop={live.stop} onReset={live.reset} onJump={jump} /> : null}

      {owner && rules.data && live.state.phase === 'idle' ? <RuleBand rules={rules.data.data} /> : null}

      {deals.isLoading ? <Loading /> : null}
      <ProblemCard error={deals.error} />
      {deals.data && rows.length === 0 && live.state.phase === 'idle' ? (
        <div data-tour="empty"><Empty title="No deals yet">{agents ? 'Press “Let the agents negotiate” to watch two agents reach a price, or make an offer yourself below.' : 'Make an offer below. The agents can negotiate for you once a language model is configured.'}</Empty></div>
      ) : null}

      <div className="stack-l deal-list">
        {threads.map((thread) => <Thread key={thread.id} deals={thread.deals} owner={owner} highlight={highlight} />)}
      </div>

      {owner ? <OfferForm /> : null}
    </div>
  )
}

function groupThreads(rows: Deal[]): Array<{ id: string; deals: Deal[] }> {
  const map = new Map<string, Deal[]>()
  for (const deal of [...rows].reverse()) map.set(deal.threadId, [...(map.get(deal.threadId) ?? []), deal])
  return [...map.entries()].map(([id, deals]) => ({ id, deals })).reverse()
}

/** Each company's limits as a band on a line, so "why was $450 refused?" is a picture, not a paragraph. */
function RuleBand({ rules }: { rules: PartyRulesView[] }) {
  const buyer = rules.find((item) => item.role === 'buyer')
  const seller = rules.find((item) => item.role === 'seller')
  if (!buyer?.maxTotalCents || !seller?.minTotalCents) return null
  const top = Math.max(buyer.maxTotalCents, seller.minTotalCents) * 1.25
  const at = (cents: number) => `${Math.min(100, (cents / top) * 100)}%`
  const fits = seller.minTotalCents <= buyer.maxTotalCents
  return (
    <section className="rule-band panel" aria-label="Where the two companies' rules overlap" data-tour="deal-band">
      <div className="row between wrap gap-s">
        <h2 className="panel-title">Where a deal can exist</h2>
        <Chip tone={fits ? 'auto' : 'deny'}>{fits ? `${dollars(seller.minTotalCents)} to ${dollars(buyer.maxTotalCents)}` : 'no overlap'}</Chip>
      </div>
      <div className="band-track" role="img" aria-label={`${buyer.displayName} pays at most ${dollars(buyer.maxTotalCents)}. ${seller.displayName} needs at least ${dollars(seller.minTotalCents)}.`}>
        <i className="band-buyer" style={{ left: 0, width: at(buyer.maxTotalCents) }} />
        <i className="band-seller" style={{ left: at(seller.minTotalCents), right: 0 }} />
        {fits ? <i className="band-zone" style={{ left: at(seller.minTotalCents), width: `calc(${at(buyer.maxTotalCents)} - ${at(seller.minTotalCents)})` }} /> : null}
      </div>
      <div className="band-legend">
        <span><b>{buyer.displayName}</b> pays at most {dollars(buyer.maxTotalCents)}</span>
        <span><b>{seller.displayName}</b> needs at least {dollars(seller.minTotalCents)}</span>
      </div>
      <p className="fine">Only you see this. Each company’s agent is told its own limit and never the other’s.</p>
    </section>
  )
}

function Thread({ deals, owner, highlight }: { deals: Deal[]; owner: boolean; highlight: string | null }) {
  const final = deals[deals.length - 1]!
  const agreed = deals.find((deal) => deal.status === 'agreed')
  return (
    <article id={agreed ? `deal-${agreed.id}` : undefined} className={`deal-card${agreed ? ' is-agreed' : ''}${agreed && agreed.id === highlight ? ' flash' : ''}`} data-tour={agreed ? 'deal-agreed' : undefined}>
      <header className="deal-head">
        <div>
          <span className="eyebrow">{final.buyerName} · {when(final.createdAt)}</span>
          <h2>{(agreed ?? final).terms.scope}</h2>
        </div>
        <div className="row gap-s wrap">
          <Money cents={(agreed ?? final).terms.totalCents} size="lg" />
          <Chip tone={agreed ? 'auto' : 'deny'}>{agreed ? 'Agreed' : deals.length > 1 ? `${deals.length} offers, no deal` : 'Refused'}</Chip>
        </div>
      </header>

      {deals.length > 1 || !agreed ? (
        <ol className="offers">
          {deals.map((deal) => (
            <li key={deal.id} className={deal.status === 'agreed' ? 'yes' : 'no'}>
              <span className="mono small">{deal.offeredBy === 'seller' ? 'studio' : deal.offeredBy === 'buyer' ? 'client' : 'owner'}</span>
              <Money cents={deal.terms.totalCents} />
              <span>{deal.status === 'agreed' ? 'Agreed' : deal.verdict.violations.map((v) => DEAL_RULE[v.code] ?? v.code).join(' · ')}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {agreed ? <Agreed deal={agreed} owner={owner} /> : null}
    </article>
  )
}

function Agreed({ deal, owner }: { deal: Deal; owner: boolean }) {
  const refresh = useRefreshDeals()
  const online = useOnline()
  const navigate = useNavigate()
  const [proof, setProof] = useState('')
  const toast = useToast()
  const bill = useMutation({
    mutationFn: (milestone: number) => api.billMilestone(deal.id, milestone, proof.trim()),
    onSuccess: (proposal) => { toast({ title: `Milestone billed · ${dollars(proposal.amountCents)}`, body: proposal.gate === 'DENY' ? 'The rules refused it.' : 'Approve it on the Waiting page.', tone: proposal.gate === 'DENY' ? 'bad' : 'good' }); void refresh(); navigate(`/p/${proposal.id}`) },
  })
  const milestones = deal.billing?.milestones ?? []
  return (
    <div className="deal-body">
      <div className="deal-cols">
        <div>
          <h3 className="panel-title">Milestones</h3>
          <ol className="milestones" data-tour="deal-milestones">
            {milestones.map((item) => (
              <li key={item.index}>
                <span className="mono small">M{item.index + 1}</span>
                <span className="grow">{item.title}</span>
                <Money cents={item.amountCents} />
                {item.chargeId ? <Link to={`/p/${item.chargeId}`} className="link"><PhaseChip phase={item.phase ?? 'pending_approval'} /></Link> : <Chip tone="muted">not billed</Chip>}
              </li>
            ))}
          </ol>
          <p className="fine">Job <Link to={`/jobs/${deal.jobId}`} className="mono">{deal.jobId}</Link>. A client charge on this job can bill a milestone, and only for exactly its agreed amount.</p>
          {owner ? (
            <div className="bill">
              <label className="field">
                <span>Link to the work for the next milestone</span>
                <input type="url" value={proof} onChange={(event) => setProof(event.target.value)} placeholder="https://www.figma.com/file/northwind-logo" />
              </label>
              <div className="row gap-s wrap">
                {milestones.filter((item) => !item.chargeId).slice(0, 1).map((item) => (
                  <button key={item.index} type="button" className="btn btn-ink" disabled={!online || !proof.trim() || bill.isPending} onClick={() => bill.mutate(item.index)}>
                    {bill.isPending ? 'Billing…' : `Bill milestone ${item.index + 1} · ${dollars(item.amountCents)}`}
                  </button>
                ))}
              </div>
              <ProblemCard error={bill.error} />
            </div>
          ) : null}
        </div>
        <div className="stack">
          <Signature kind="deal" id={deal.id} signature={deal.signature} keyId={deal.keyId} />
          <p className="fine">Agreed under the studio’s rules v{deal.rulesVersions.seller} and {deal.buyerName}’s rules v{deal.rulesVersions.buyer}.{deal.runId ? ' Negotiated by agents.' : ''}</p>
        </div>
      </div>
    </div>
  )
}

function OfferForm() {
  const refresh = useRefreshDeals()
  const online = useOnline()
  const [total, setTotal] = useState('')
  const [scope, setScope] = useState('Spring launch logo')
  const [count, setCount] = useState(2)
  const [as, setAs] = useState<'seller' | 'buyer'>('seller')
  const [idem, setIdem] = useState(newKey)
  const cents = parseCents(total)
  const send = useMutation({ mutationFn: () => {
    const each = Math.floor((cents ?? 0) / count)
    const milestones = Array.from({ length: count }, (_, index) => ({ title: `Milestone ${index + 1}`, amountCents: index === count - 1 ? (cents ?? 0) - each * (count - 1) : each }))
    return api.offerDeal({ buyer: 'Northwind', as, terms: { scope: scope.trim(), category: 'design', currency: 'USD', totalCents: cents, milestones, proofRequired: true } }, idem)
  }, onSuccess: () => { setIdem(newKey()); void refresh() } })
  const result = send.data
  const submit = (event: FormEvent) => { event.preventDefault(); if (cents) send.mutate() }
  return (
    <section className="panel offer-form" data-tour="deal-offer">
      <h2 className="panel-title">Make an offer yourself</h2>
      <p className="fine">Try $450 (over the client’s limit), $200 (under the studio’s minimum) and $300 (inside both).</p>
      <form className="stack" onSubmit={submit}>
        <div className="field-row">
          <label className="field"><span>Total</span><span className="dollar-input"><span>$</span><input inputMode="decimal" value={total} onChange={(event) => { setTotal(event.target.value); setIdem(newKey()) }} placeholder="300.00" required /></span>
            <small className="mono">{cents === null ? 'Dollars and cents' : `= ${cents} cents, split into ${count} equal milestones`}</small></label>
          <label className="field"><span>Offered by</span><select value={as} onChange={(event) => setAs(event.target.value as 'seller' | 'buyer')}><option value="seller">the studio</option><option value="buyer">the client</option></select></label>
        </div>
        <div className="field-row">
          <label className="field"><span>Scope</span><input value={scope} onChange={(event) => setScope(event.target.value)} maxLength={300} required /></label>
          <label className="field"><span>Milestones</span><select value={count} onChange={(event) => setCount(Number(event.target.value))}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        </div>
        <div className="row between wrap gap-s"><span className="fine">Each offer is a fresh thread.</span><button type="submit" className="btn btn-lime" disabled={!cents || !online || send.isPending}>{send.isPending ? 'Checking both rule sets…' : 'Offer these terms'}</button></div>
      </form>
      <ProblemCard error={send.error} />
      {result ? (
        <div className={`answer answer-${result.status === 'agreed' ? 'auto' : 'deny'}`} role="status">
          <Chip tone={result.status === 'agreed' ? 'auto' : 'deny'}>{result.status === 'agreed' ? 'Agreed' : 'Refused'}</Chip>
          {result.verdict.violations.map((v) => <p key={v.code} className="turn-why"><code>{v.code}</code> {DEAL_RULE[v.code] ?? v.code}. <span className="muted">{v.detail}</span> <em>{v.hint}</em></p>)}
          {result.status === 'agreed' ? <p>Signed. The job is <span className="mono">{result.jobId}</span>; bill its first milestone above.</p> : null}
        </div>
      ) : null}
    </section>
  )
}
