import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useToast } from '../components/Toast'
import { NegotiationStage } from '../components/NegotiationStage'
import { Signature } from '../components/Signature'
import { Chip, Empty, Loading, Money, PageHead, PhaseChip, ProblemCard } from '../components/ui'
import { api } from '../lib/api'
import { when } from '../lib/format'
import { useAgentsOn, useDeals, useIsOwner, useOnline, useRefreshDeals, useSession } from '../lib/hooks'
import { centsInput, dollars, parseCents } from '../lib/money'
import type { Deal, PartyRulesView } from '../lib/types'
import { useNegotiation } from '../lib/useNegotiation'
import { DEAL_RULE } from '../lib/words'

const newKey = () => `web-deal-${crypto.randomUUID()}`

export function Deals() {
  const deals = useDeals()
  const owner = useIsOwner()
  const session = useSession()
  const agents = useAgentsOn()
  const online = useOnline()
  const refresh = useRefreshDeals()
  const toast = useToast()
  const live = useNegotiation(() => void refresh())
  const [highlight, setHighlight] = useState<string | null>(null)
  const rules = useQuery({ queryKey: ['party-rules'], queryFn: api.partyRules, enabled: owner })
  // Not the owner: this key reads its own sheet only. A client key may read nothing else about the other company.
  const mine = useQuery({ queryKey: ['party-rules', 'mine'], queryFn: api.myPartyRules, enabled: session.data !== undefined && !owner, retry: false })
  const warrant = useQuery({ queryKey: ['warrant'], queryFn: api.warrant, enabled: owner, staleTime: 30_000 })
  const running = live.state.phase === 'running'
  const sheetRows = owner ? (rules.data?.data ?? []) : mine.data ? [mine.data] : []
  const buyerSheet = sheetRows.find((item) => item.role === 'buyer')
  const sellerSheet = sheetRows.find((item) => item.role === 'seller')
  const buyerMax = buyerSheet?.maxTotalCents
  const sellerMin = sellerSheet?.minTotalCents
  // A deal needs a number from both companies. Until both exist there is nothing for the rules to judge against.
  const bothSet = Boolean(buyerMax && sellerMin)
  // And examples do not count: the agents talk only inside numbers a person chose. The server refuses otherwise.
  const confirmed = bothSet && buyerSheet?.origin === 'written' && sellerSheet?.origin === 'written'
  const parties: SheetParty[] = owner
    ? [
        ...(warrant.data?.clients ?? []).map((client) => ({
          key: client.id,
          partyId: client.id,
          role: 'buyer' as const,
          displayName: client.displayName,
          sheet: sheetRows.find((row) => row.partyId === client.id),
        })),
        // The studio's own id never leaves the server; the owner writes it through `mine`.
        {
          key: 'studio',
          partyId: 'mine',
          role: 'seller' as const,
          displayName: sheetRows.find((row) => row.role === 'seller')?.displayName ?? '',
          sheet: sheetRows.find((row) => row.role === 'seller'),
        },
      ]
    : [{
        key: 'mine',
        partyId: 'mine',
        role: session.data?.side === 'buyer' ? ('buyer' as const) : ('seller' as const),
        displayName: mine.data?.displayName ?? '',
        sheet: mine.data,
      }]
  const sheetsReady = owner ? Boolean(rules.data && warrant.data) : Boolean(session.data) && !mine.isLoading
  const jump = () => {
    setHighlight(live.state.agreedDealId)
    document.getElementById(`deal-${live.state.agreedDealId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  // Say how a negotiation ended, once, however the person is looking at the screen.
  const phase = live.state.phase
  const told = useRef('')
  useEffect(() => {
    const id = `${phase}:${live.state.agreedDealId ?? ''}`
    if (told.current === id || (phase !== 'done' && phase !== 'stopped' && phase !== 'failed')) return
    told.current = id
    if (phase === 'done' && live.state.agreedDealId) toast({ title: 'Deal agreed', body: 'Both companies\' rules allow it. The server signed it.', action: { label: 'Go to the signed deal', onClick: jump } })
    else if (phase === 'done') toast({ title: 'No deal', body: 'The agents ran out of turns without terms that fit both rules. Nothing moved.', tone: 'warn' })
    else if (phase === 'stopped') toast({ title: 'Negotiation stopped', body: 'Offers so far are kept. Nothing was agreed unless it says Agreed.', tone: 'info' })
    else toast({ title: 'The negotiation hit an error', body: 'Nothing was agreed and nothing moved.', tone: 'bad' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, live.state.agreedDealId])
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
          <button
            type="button"
            className="btn btn-lime"
            data-tour="deal-negotiate"
            disabled={!agents || !online || running || !bothSet || !confirmed}
            onClick={() => void live.start()}
            title={!bothSet ? 'Both companies need a price limit first: a deal needs a number each company will accept' : !confirmed ? 'Keep the starting numbers first: the agents talk only inside numbers a person chose' : agents ? 'Two AI agents negotiate inside both companies’ rules' : 'Set OLLAMA_API_KEY to turn the agents on'}
          >
            {running ? 'Agents are negotiating…' : 'Let the agents negotiate'}
          </button>
        ) : null}
      </PageHead>

      <p className="lede deals-lede">A deal only exists where the studio’s rules and the client’s rules overlap. Agents can say anything to each other. The rules decide what stands.</p>
      <ProblemCard error={live.state.phase === 'failed' ? live.state.error : null} />
      {live.state.phase !== 'idle' ? <NegotiationStage state={live.state} buyerMax={buyerMax} sellerMin={sellerMin} onStop={live.stop} onReset={live.reset} onJump={jump} /> : null}

      {/* The bar that makes first boot honest: these numbers came with the box. Nothing counts until a person keeps them. */}
      {sheetsReady && live.state.phase === 'idle' ? <KeepBar sheets={sheetRows} owner={owner} /> : null}

      {owner && rules.data && live.state.phase === 'idle' ? <RuleBand rules={sheetRows} examples={!confirmed} /> : null}

      {/* The writer for the numbers above: each company writes its own limit, and nobody else can reach it. */}
      {sheetsReady && live.state.phase === 'idle' ? <PriceSheets parties={parties} owner={owner} /> : null}

      {deals.isLoading ? <Loading /> : null}
      <ProblemCard error={deals.error} />
      {deals.data && rows.length === 0 && live.state.phase === 'idle' ? (
        <div data-tour="empty"><Empty title="No deals yet">{agents ? 'Press “Let the agents negotiate” to watch two agents reach a price, or make an offer yourself below.' : 'Make an offer below. The agents can negotiate for you once a language model is configured.'}</Empty></div>
      ) : null}

      <div className="stack-l deal-list">
        {threads.map((thread) => <Thread key={thread.id} deals={thread.deals} owner={owner} highlight={highlight} />)}
      </div>

      {owner ? <OfferForm blocked={!bothSet || !confirmed} blockedHint={!bothSet ? 'Both companies need a price limit before an offer can be judged.' : 'Keep the starting numbers first: offers wait until a person chose them.'} /> : null}
    </div>
  )
}

function groupThreads(rows: Deal[]): Array<{ id: string; deals: Deal[] }> {
  const map = new Map<string, Deal[]>()
  for (const deal of [...rows].reverse()) map.set(deal.threadId, [...(map.get(deal.threadId) ?? []), deal])
  return [...map.entries()].map(([id, deals]) => ({ id, deals })).reverse()
}

/**
 * The bar that makes first boot honest. The sample numbers that came with the studio are shown, not hidden — but
 * they count for nothing until a person looks at them and keeps them. One click writes the same numbers as the next
 * version of each sheet, which is exactly what "a person chose them" means in this product. A company that already
 * wrote its sheet never sees this bar.
 */
function KeepBar({ sheets, owner }: { sheets: PartyRulesView[]; owner: boolean }) {
  const queryClient = useQueryClient()
  const online = useOnline()
  const toast = useToast()
  const examples = sheets.filter((sheet) => sheet.origin === 'seed' && (sheet.role === 'buyer' ? sheet.maxTotalCents !== undefined : sheet.minTotalCents !== undefined))
  const keep = useMutation({
    // A client key writes through `mine`: the route resolves it to its own party and refuses any other.
    mutationFn: () => Promise.all(examples.map((sheet) => api.putPartyRules(owner ? sheet.partyId : 'mine', sheet.role === 'buyer' ? { maxTotalCents: sheet.maxTotalCents } : { minTotalCents: sheet.minTotalCents }))),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['party-rules'] })
      void queryClient.invalidateQueries({ queryKey: ['party-rules', 'mine'] })
      toast({ title: 'Starting numbers kept', body: 'Recorded as your choice, as the next version of each sheet. A real client would set its own with its own key.', tone: 'good' })
    },
  })
  if (examples.length === 0) return null
  return (
    <section className="panel panel-lime keep-bar" data-tour="keep-bar">
      <div className="row between wrap gap-s">
        <h2 className="panel-title">Starting examples, not {examples.length === 1 && !owner ? 'your number' : 'your numbers'} yet</h2>
        <Chip tone="need">{examples.length} to keep</Chip>
      </div>
      <p className="fine">
        These numbers came with the sample studio so you can try the product: {examples.map((sheet) => sheet.role === 'buyer' ? `${sheet.displayName} pays at most ${dollars(sheet.maxTotalCents)}` : `${sheet.displayName} takes a job for at least ${dollars(sheet.minTotalCents)}`).join(' · ')}.{' '}
        Nothing is judged, and the agents do not talk, until a person chooses them. Keeping records your choice; changing them in the forms below records a better one.
      </p>
      <div className="row gap-s wrap">
        <button type="button" className="btn btn-ink" disabled={!online || keep.isPending} onClick={() => keep.mutate()}>{keep.isPending ? 'Keeping…' : examples.length === 1 && !owner ? 'Keep this number' : 'Keep these numbers'}</button>
      </div>
      <ProblemCard error={keep.error} />
    </section>
  )
}

/** Each company's limits as a band on a line, so "why was $450 refused?" is a picture, not a paragraph. */
function RuleBand({ rules, examples }: { rules: PartyRulesView[]; examples: boolean }) {
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
        <Chip tone={examples ? 'need' : fits ? 'auto' : 'deny'}>{examples ? 'starting examples' : fits ? `${dollars(seller.minTotalCents)} to ${dollars(buyer.maxTotalCents)}` : 'no overlap'}</Chip>
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

/** One company's price limit, and where the form writes it. `partyId` is `mine` whenever the caller writes its own. */
type SheetParty = {
  key: string
  partyId: string
  role: 'buyer' | 'seller'
  displayName: string
  sheet: PartyRulesView | undefined
}

/**
 * The writer for the numbers the band above draws. Each company writes its own limit: the form sends only the price,
 * the server keeps everything else about the company, and the other side's sheet is not reachable from here at all.
 */
function PriceSheets({ parties, owner }: { parties: SheetParty[]; owner: boolean }) {
  const unset = parties.filter((party) => {
    const number = party.role === 'buyer' ? party.sheet?.maxTotalCents : party.sheet?.minTotalCents
    return number === undefined
  })
  const examples = parties.filter((party) => {
    const number = party.role === 'buyer' ? party.sheet?.maxTotalCents : party.sheet?.minTotalCents
    return number !== undefined && party.sheet?.origin === 'seed'
  })
  const state = unset.length > 0 ? 'missing' : examples.length > 0 ? 'examples' : 'set'
  return (
    <section className="panel price-sheets" data-tour="price-sheets">
      <div className="row between wrap gap-s">
        <h2 className="panel-title">{owner ? 'What each company will accept' : 'What your company will accept'}</h2>
        <Chip tone={state === 'set' ? 'auto' : 'need'}>{state === 'set' ? (owner ? 'both numbers are set' : 'your number is set') : state === 'examples' ? (owner || examples.length > 1 ? 'starting examples' : 'starting example') : `${unset.length} still to set`}</Chip>
      </div>
      <p className="fine">
        {state === 'set'
          ? 'A deal has to fit between these two numbers. Only this console sees both: each company’s agent is told its own and never the other’s.'
          : state === 'examples'
            ? 'These are still the sample numbers that came with the studio. Keep them in the bar above, or change them here — until then nothing is judged.'
            : 'A deal can only exist where the two numbers overlap. Until both are set there is nothing for the rules to judge against, so offers and negotiation are held.'}
      </p>
      <div className="stack">
        {parties.map((party) => <PriceSheetForm key={party.key} party={party} />)}
      </div>
    </section>
  )
}

function PriceSheetForm({ party }: { party: SheetParty }) {
  const queryClient = useQueryClient()
  const online = useOnline()
  const toast = useToast()
  const field = party.role === 'buyer' ? 'maxTotalCents' : 'minTotalCents'
  const current = field === 'maxTotalCents' ? party.sheet?.maxTotalCents : party.sheet?.minTotalCents
  const [value, setValue] = useState(() => (current === undefined ? '' : centsInput(current)))
  const [name, setName] = useState(party.displayName)
  const cents = parseCents(value)
  const label = party.role === 'buyer' ? 'pays at most' : 'takes a job for at least'
  const noun = party.role === 'buyer' ? 'ceiling' : 'floor'
  const save = useMutation({
    mutationFn: () => api.putPartyRules(party.partyId, {
      ...(name.trim() ? { displayName: name.trim() } : {}),
      [field]: cents,
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['party-rules'] })
      toast({
        title: `${name.trim() || party.displayName || 'The company'}’s ${noun} is now ${dollars(cents)}`,
        body: 'Saved as the next version of its sheet. Nothing has moved: this is only a limit.',
        tone: 'good',
      })
    },
  })
  return (
    <form className="sheet-form" data-tour={`price-${party.role}`} onSubmit={(event) => { event.preventDefault(); if (cents) save.mutate() }}>
      <div className="row between wrap gap-s">
        <span className="eyebrow">{party.sheet ? party.displayName : party.role === 'buyer' ? 'A client on the warrant' : 'Your studio'}</span>
        {party.sheet ? <span className="mono small">sheet v{party.sheet.version}</span> : <Chip tone="need">not set</Chip>}
      </div>
      <div className="field-row">
        {party.sheet ? null : (
          <label className="field"><span>Company name</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required placeholder="Harbor Foods" /></label>
        )}
        <label className="field">
          <span>{name || 'This company'} {label} for a whole job</span>
          <span className="dollar-input"><span>$</span><input inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} placeholder="400.00" required /></span>
          <small className="mono">{cents === null ? 'Dollars and cents' : `= ${cents} cents`}</small>
        </label>
      </div>
      <div className="row between wrap gap-s">
        <span className="fine">{party.role === 'buyer' ? 'The studio is never told this number.' : 'The client is never told this number.'}</span>
        <button type="submit" className="btn btn-ink" disabled={!cents || !online || save.isPending}>
          {save.isPending ? 'Saving…' : party.sheet ? 'Save this limit' : 'Set this limit'}
        </button>
      </div>
      <ProblemCard error={save.error} />
    </form>
  )
}

function Thread({ deals, owner, highlight }: { deals: Deal[]; owner: boolean; highlight: string | null }) {
  const final = deals[deals.length - 1]!
  const agreed = deals.find((deal) => deal.status === 'agreed')
  // Hints already end with a period; the sentence adds its own, so one of them has to give.
  const firstHint = final.verdict.violations[0]?.hint.replace(/[.。\s]*$/, '')
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

      {agreed ? <Agreed deal={agreed} owner={owner} /> : (
        <p className="fine" data-tour="deal-next">
          No deal yet{firstHint ? ` — ${firstHint}` : ''}.{' '}
          {owner ? 'Adjust a price limit above, or offer again below.' : 'Adjust your ceiling above. The studio is never told your number.'}
        </p>
      )}
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
    // Delivering goes through the owner's rules: it bills at once, or waits for the client's agent, or waits for the owner's tap.
    mutationFn: (milestone: number) => api.deliverMilestone(deal.id, milestone, proof.trim()),
    onSuccess: (made) => {
      void refresh()
      if (made.mode === 'awaiting') {
        toast({ title: 'Sent to the client to accept', body: 'Nothing is billed until the client’s agent accepts. You can follow it on Today.', tone: 'info' })
        navigate('/')
        return
      }
      const proposal = made.charge
      toast({ title: `Milestone billed · ${dollars(proposal.amountCents)}`, body: proposal.gate === 'DENY' ? 'The rules refused it.' : proposal.gate === 'AUTO' ? 'Your rule covers it: the invoice is on its way, no tap.' : 'Approve it on Today.', tone: proposal.gate === 'DENY' ? 'bad' : 'good' })
      navigate(`/p/${proposal.id}`)
    },
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
                <span>Link to the delivered work for the next milestone</span>
                <input type="url" value={proof} onChange={(event) => setProof(event.target.value)} placeholder="https://www.figma.com/file/northwind-logo" />
              </label>
              <div className="row gap-s wrap">
                {milestones.filter((item) => !item.chargeId).slice(0, 1).map((item) => (
                  <button key={item.index} type="button" className="btn btn-ink" disabled={!online || !proof.trim() || bill.isPending} onClick={() => bill.mutate(item.index)}>
                    {bill.isPending ? 'Sending…' : `Deliver milestone ${item.index + 1} · ${dollars(item.amountCents)}`}
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

function OfferForm({ blocked = false, blockedHint = '' }: { blocked?: boolean; blockedHint?: string }) {
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
          <label className="field"><span>Offered by</span><select value={as} onChange={(event) => setAs(event.target.value as 'seller' | 'buyer')}><option value="seller">the studio</option><option value="buyer">the client</option></select>
            <small>The rules judge the terms, never the speaker: the verdict is the same either way. This only labels who offered.</small></label>
        </div>
        <div className="field-row">
          <label className="field"><span>Scope</span><input value={scope} onChange={(event) => setScope(event.target.value)} maxLength={300} required /></label>
          <label className="field"><span>Milestones</span><select value={count} onChange={(event) => setCount(Number(event.target.value))}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        </div>
        <div className="row between wrap gap-s">
          <span className="fine">{blocked ? blockedHint : 'Each offer starts its own thread. A thread ends when a deal is agreed.'}</span>
          <button type="submit" className="btn btn-lime" disabled={!cents || !online || send.isPending || blocked}>{send.isPending ? 'Checking both rule sets…' : 'Offer these terms'}</button>
        </div>
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
