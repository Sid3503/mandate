import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useToast } from '../components/Toast'
import { ConcessionChart, NegotiationEnd, NegotiationStage } from '../components/NegotiationStage'
import { Signature } from '../components/Signature'
import { useStudioName } from '../components/StoryRail'
import { Chip, Empty, Loading, Money, PageHead, PhaseChip, ProblemCard } from '../components/ui'
import { ApiError, api, type NegotiationRequest } from '../lib/api'
import { when } from '../lib/format'
import { useAgentsOn, useDeals, useIsOwner, useOnline, useRefreshDeals, useSession } from '../lib/hooks'
import { centsInput, dollars, parseCents } from '../lib/money'
import type { Deal, NegotiationStyle, NegotiationView, PartyRulesView, Side } from '../lib/types'
import { useNegotiation } from '../lib/useNegotiation'

const newKey = () => `web-deal-${crypto.randomUUID()}`

const PLAYING_CLIENT = 'mandate.deals.playing-client'

/**
 * Whose chair the owner sits in. A client that set its own numbers with its own key owns its seat, and the server
 * seals its numbers from the studio: no button here can unseal them. A client that never did (a demo, or a client not
 * yet on Mandate) can be played by the owner, openly, with the screen saying so. Remembered per browser.
 */
function usePlayingClient(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return window.localStorage.getItem(PLAYING_CLIENT) === '1'
    } catch {
      return false
    }
  })
  const set = (next: boolean) => {
    setOn(next)
    try {
      window.localStorage.setItem(PLAYING_CLIENT, next ? '1' : '0')
    } catch {
      /* storage unavailable: the choice lasts for this visit */
    }
  }
  return [on, set]
}

const useNegotiations = () => useQuery({ queryKey: ['negotiations'], queryFn: api.negotiations, refetchInterval: 15_000 })

export function Deals() {
  const deals = useDeals()
  const owner = useIsOwner()
  const session = useSession()
  const agents = useAgentsOn()
  const online = useOnline()
  const refreshDeals = useRefreshDeals()
  const queryClient = useQueryClient()
  const refresh = () => Promise.all([refreshDeals(), queryClient.invalidateQueries({ queryKey: ['negotiations'] })])
  const toast = useToast()
  const live = useNegotiation(() => void refresh())
  const negotiations = useNegotiations()
  const [highlight, setHighlight] = useState<string | null>(null)
  const [playingClient, setPlayingClient] = usePlayingClient()
  const isDemo = session.data?.workspaceMode === 'demo' || session.data?.demoReset === true
  const rules = useQuery({ queryKey: ['party-rules'], queryFn: api.partyRules, enabled: owner })
  // Not the owner: this key reads its own sheet only. A client key may read nothing else about the other company.
  const mine = useQuery({ queryKey: ['party-rules', 'mine'], queryFn: api.myPartyRules, enabled: session.data !== undefined && !owner, retry: false })
  const warrant = useQuery({ queryKey: ['warrant'], queryFn: api.warrant, enabled: owner, staleTime: 30_000 })
  const running = live.state.phase === 'running'
  const sheetRows = owner ? (rules.data?.data ?? []) : mine.data ? [mine.data] : []
  const buyerSheet = sheetRows.find((item) => item.role === 'buyer')
  const sellerSheet = sheetRows.find((item) => item.role === 'seller')
  // The server's word: a client that wrote its own number is sealed, whatever this browser would like to show.
  const claimed = owner && buyerSheet?.claimed === true
  const sealed = owner && (claimed || !playingClient)
  const buyerMax = sealed ? undefined : buyerSheet?.maxTotalCents
  const sellerMin = sellerSheet?.minTotalCents
  // A deal needs a number from both companies. Until both exist there is nothing for the rules to judge against.
  const buyerSet = buyerSheet ? (buyerSheet.limitSet ?? buyerSheet.maxTotalCents !== undefined) : false
  const bothSet = owner ? Boolean(buyerSet && sellerMin) : Boolean(mine.data)
  // And examples do not count: the agents talk only inside numbers a person chose. The server refuses otherwise.
  const confirmed = bothSet && (!owner || (buyerSheet?.origin === 'written' && sellerSheet?.origin === 'written'))
  const currency = (owner ? warrant.data?.currency : mine.data?.currency) ?? sellerSheet?.currency ?? 'USD'
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
        { key: 'studio', partyId: 'mine', role: 'seller' as const, displayName: sellerSheet?.displayName ?? '', sheet: sellerSheet },
      ]
    : [{ key: 'mine', partyId: 'mine', role: session.data?.side === 'buyer' ? ('buyer' as const) : ('seller' as const), displayName: mine.data?.displayName ?? '', sheet: mine.data }]
  const sheetsReady = owner ? Boolean(rules.data && warrant.data) : Boolean(session.data) && !mine.isLoading
  const offerCategory = (owner ? warrant.data?.categories?.find((item) => buyerSheet?.categories.includes(item)) ?? warrant.data?.categories?.[0] : mine.data?.categories?.[0]) ?? ''
  const jump = () => {
    const id = live.state.result?.agreedDealId
    if (!id) return
    setHighlight(id)
    document.getElementById(`deal-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  // Say how a negotiation ended, once, however the person is looking at the screen.
  const phase = live.state.phase
  const told = useRef('')
  useEffect(() => {
    const result = live.state.result
    const id = `${phase}:${result?.id ?? ''}:${result?.status ?? ''}`
    if (told.current === id || (phase !== 'done' && phase !== 'stopped' && phase !== 'failed')) return
    told.current = id
    if (phase === 'done' && result?.status === 'agreed') toast({ title: 'Deal agreed', body: `${result.ending ? result.ending.charAt(0).toUpperCase() + result.ending.slice(1) : 'Accepted'}. Both companies’ rules were checked and the server signed it.`, action: { label: 'Go to the signed deal', onClick: jump } })
    else if (phase === 'done' && result?.status === 'open') toast({ title: live.state.waitingFor ? 'Waiting for the other side' : 'The negotiation is still open', body: live.state.waitingFor ? 'They answer for themselves, in their own console.' : 'Carry it on below.', tone: 'info' })
    else if (phase === 'done' && result) toast({ title: 'No deal', body: `${result.ending ?? 'It ended without a deal'}. Nothing was agreed and nothing moved.`, tone: 'warn' })
    else if (phase === 'stopped') toast({ title: 'Negotiation stopped', body: 'The moves so far are kept, and either side can carry on below.', tone: 'info' })
    else if (phase === 'failed') toast({ title: 'The negotiation hit an error', body: 'Nothing was agreed and nothing moved.', tone: 'bad' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, live.state.result])
  const rows = deals.data?.data ?? []
  const threads = negotiations.data?.data ?? []
  const noRules = owner && warrant.isError && warrant.error instanceof ApiError && warrant.error.code === 'warrant.missing'
  const zone = owner && !sealed && buyerMax !== undefined && sellerMin !== undefined ? { minCents: sellerMin, maxCents: buyerMax } : null
  const ownLimit = owner ? (sellerMin !== undefined ? { side: 'seller' as Side, cents: sellerMin } : null) : mine.data?.maxTotalCents !== undefined ? { side: 'buyer' as Side, cents: mine.data.maxTotalCents } : null

  return (
    <div className="page">
      <PageHead eyebrow="Two companies agree before any money exists" title="Deals" />

      <p className="lede deals-lede">A deal exists only when one company accepts the other’s exact offer. Offers stand until they are answered, each side may walk away, and both know the deadline. Each company’s limits stay its own: the rules check them, and nobody else sees them.</p>
      <ProblemCard error={live.state.phase === 'failed' ? live.state.error : null} />
      {live.state.phase !== 'idle' ? <NegotiationStage state={live.state} zone={zone} ownLimit={ownLimit} onStop={live.stop} onReset={live.reset} onJump={jump} /> : null}

      {/* The bar that makes first boot honest: these numbers came with the box. Nothing counts until a person keeps them. */}
      {sheetsReady && live.state.phase === 'idle' ? <KeepBar sheets={sheetRows} owner={owner} sealed={sealed} /> : null}

      {owner && rules.data && live.state.phase === 'idle' ? <RuleBand rules={sheetRows} examples={!confirmed} sealed={sealed} /> : null}

      {/* The writer for the numbers above: each company writes its own limit, and nobody else can reach it. */}
      {sheetsReady && live.state.phase === 'idle' ? <PriceSheets parties={parties} owner={owner} sealed={sealed} claimed={claimed} playing={owner && playingClient && !claimed} onPlay={isDemo && !claimed ? setPlayingClient : undefined} /> : null}

      {owner && !noRules ? (
        <NegotiateForm
          disabled={!agents || !online || running || !bothSet || !confirmed}
          why={!bothSet ? 'Both companies need a price limit first: a deal needs a number each company will accept.' : !confirmed ? 'Keep the starting numbers first: the negotiators talk only inside numbers a person chose.' : !agents ? 'The AI negotiators are off on this server. You can still make an offer yourself below.' : null}
          clients={warrant.data?.clients ?? []}
          clientSpeaksForItself={claimed && buyerSheet?.delegate !== true}
          running={running}
          onStart={(request) => void live.start(request)}
        />
      ) : null}

      {deals.isLoading || negotiations.isLoading ? <Loading /> : null}
      <ProblemCard error={deals.error ?? negotiations.error} />
      {noRules && live.state.phase === 'idle' ? (
        <div data-tour="empty">
          <Empty title="Rules come first">A deal is between your studio and a client named on the rules. Write those first, then set the least your studio will take.</Empty>
          <Link className="btn btn-ink" to="/rules">Write your rules</Link>
        </div>
      ) : null}
      {!noRules && negotiations.data && threads.length === 0 && live.state.phase === 'idle' ? (
        <div data-tour="empty"><Empty title="No negotiations yet">{owner
          ? (!bothSet ? 'Set the least your studio will take. Your client sets the most it will pay, with its own key. Until both numbers exist nothing can be agreed; you can still bill a client from New request without a deal.' : !confirmed ? 'Keep the starting numbers first. The negotiators talk only inside numbers a person chose.' : agents ? 'Let the negotiators open the table above, or make the opening offer yourself below.' : 'Make the opening offer below. The negotiators can work for you once a language model is configured.')
          : 'When the studio makes you an offer, it appears here, and you answer it: accept it, counter it or walk away. You can also make the first offer yourself below.'}</Empty></div>
      ) : null}

      <div className="stack-l deal-list">
        {threads.map((thread) => <NegotiationCard key={thread.id} view={thread} deal={rows.find((row) => row.id === thread.agreedDealId) ?? null} owner={owner} agentsOn={agents} highlight={highlight} onChanged={() => void refresh()} onFinish={owner && agents && !running ? () => { void live.start({ threadId: thread.id }); window.scrollTo({ top: 0, behavior: 'smooth' }) } : undefined} />)}
      </div>

      {!noRules && sheetsReady ? (
        <OfferForm
          blocked={!bothSet || !confirmed || !offerCategory}
          blockedHint={!offerCategory ? 'Add a kind of work to your rules first: an offer is for one kind of work.' : !bothSet ? (owner ? 'Both companies need a price limit before an offer can be made. You can bill a client from New request without a deal.' : 'Set the most your company will pay, above, before making an offer.') : 'Keep the starting numbers first: offers wait until a person chose them.'}
          clients={owner ? (warrant.data?.clients ?? []).map((client) => client.displayName) : [mine.data?.displayName ?? '']}
          currency={currency}
          category={offerCategory}
          side={owner ? 'seller' : 'buyer'}
          onMade={() => void refresh()}
        />
      ) : null}
    </div>
  )
}

/**
 * Starting a negotiation: what the job is, what it is paid in, the deadline both sides know, and the studio's brief to
 * its own negotiator. Nothing here sets a price: each negotiator opens and concedes on its own judgement, inside its
 * own company's walk-away.
 */
function NegotiateForm({ disabled, why, clients, clientSpeaksForItself, running, onStart }: {
  disabled: boolean
  why: string | null
  clients: Array<{ id: string; displayName: string }>
  clientSpeaksForItself: boolean
  running: boolean
  onStart: (request: NegotiationRequest) => void
}) {
  const [buyer, setBuyer] = useState('')
  const [task, setTask] = useState('')
  const [milestones, setMilestones] = useState('')
  const [offers, setOffers] = useState(4)
  const [brief, setBrief] = useState('')
  const client = buyer || clients[0]?.displayName || ''
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const titles = milestones.split(',').map((item) => item.trim()).filter(Boolean)
    onStart({ buyer: client || undefined, task: task.trim() || undefined, milestones: titles.length ? titles : undefined, offersPerSide: offers, sellerBrief: brief.trim() || undefined })
  }
  return (
    <section className="panel negotiate-form" data-tour="deal-negotiate">
      <div className="row between wrap gap-s">
        <h2 className="panel-title">Let the negotiators work it out</h2>
        <Chip tone="muted">each move is the model’s decision</Chip>
      </div>
      <p className="fine">Your negotiator opens and concedes on its own judgement, inside your walk-away, and reads the other side as it goes. {clientSpeaksForItself ? `${client || 'This client'} negotiates for itself, so the run stops at its turn and it answers from its own console.` : 'The client’s negotiator works the same way, inside the client’s own numbers.'} It ends when one side accepts the other’s offer, a side walks away, the deadline passes, or nobody moves for three rounds.</p>
      <form className="stack" onSubmit={submit}>
        <div className="field-row">
          {clients.length > 1 ? (
            <label className="field"><span>With</span><select value={client} onChange={(event) => setBuyer(event.target.value)}>{clients.map((item) => <option key={item.id} value={item.displayName}>{item.displayName}</option>)}</select></label>
          ) : null}
          <label className="field"><span>The job</span><input value={task} onChange={(event) => setTask(event.target.value)} maxLength={300} placeholder="What will be delivered" /><small>Becomes the scope of every offer.</small></label>
          <label className="field"><span>Paid in milestones</span><input value={milestones} onChange={(event) => setMilestones(event.target.value)} maxLength={300} placeholder="First half, Second half" /><small>Comma-separated, in order. Each is billed when delivered.</small></label>
        </div>
        <div className="field-row">
          <label className="field"><span>Deadline</span><select value={offers} onChange={(event) => setOffers(Number(event.target.value))}>{[2, 3, 4, 5, 6, 8].map((n) => <option key={n} value={n}>{n} offers each</option>)}</select><small>Both sides know it, as at a real table.</small></label>
          <label className="field"><span>Your brief to your negotiator (optional)</span><input value={brief} onChange={(event) => setBrief(event.target.value)} maxLength={600} placeholder="A quick start matters more to us than the last dollar" /><small>Followed inside your walk-away. Your saved brief is used if you leave this empty.</small></label>
        </div>
        <div className="row between wrap gap-s">
          <span className="fine">{why ?? 'Nothing is billed until a deal is signed and a milestone is delivered.'}</span>
          <button type="submit" className="btn btn-lime" disabled={disabled}>{running ? 'Negotiating…' : 'Let the negotiators negotiate'}</button>
        </div>
      </form>
    </section>
  )
}

/**
 * The bar that makes first boot honest. The sample numbers that came with the studio are shown, not hidden — but
 * they count for nothing until a person looks at them and keeps them. One click writes the same numbers as the next
 * version of each sheet, which is exactly what "a person chose them" means in this product. A company that already
 * wrote its sheet never sees this bar.
 */
function KeepBar({ sheets, owner, sealed = false }: { sheets: PartyRulesView[]; owner: boolean; sealed?: boolean }) {
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
        These numbers came with the sample studio so you can try the product: {examples.map((sheet) => sheet.role === 'buyer' ? (sealed ? `${sheet.displayName}’s ceiling (sealed: it is theirs)` : `${sheet.displayName} pays at most ${dollars(sheet.maxTotalCents, sheet.currency)}`) : `${sheet.displayName} takes a job for at least ${dollars(sheet.minTotalCents, sheet.currency)}`).join(' · ')}.{' '}
        Nothing is judged, and the negotiators do not talk, until a person chooses them. Keeping records your choice; changing them in the forms below records a better one.
      </p>
      <div className="row gap-s wrap">
        <button type="button" className="btn btn-ink" disabled={!online || keep.isPending} onClick={() => keep.mutate()}>{keep.isPending ? 'Keeping…' : examples.length === 1 && !owner ? 'Keep this number' : 'Keep these numbers'}</button>
      </div>
      <ProblemCard error={keep.error} />
    </section>
  )
}

/** Each company's limits as a band on a line, so "why could they not agree?" is a picture, not a paragraph. */
function RuleBand({ rules, examples, sealed = false }: { rules: PartyRulesView[]; examples: boolean; sealed?: boolean }) {
  const buyer = rules.find((item) => item.role === 'buyer')
  const seller = rules.find((item) => item.role === 'seller')
  if (!seller?.minTotalCents || !buyer || !(buyer.limitSet ?? buyer.maxTotalCents)) return null
  const currency = seller.currency
  if (sealed || buyer.maxTotalCents === undefined) {
    // The studio's side of the picture only. The client's number is theirs; the rules still judge every offer by it.
    return (
      <section className="rule-band panel" aria-label="Where a deal can exist" data-tour="deal-band">
        <div className="row between wrap gap-s">
          <h2 className="panel-title">Where a deal can exist</h2>
          <Chip tone={examples ? 'need' : 'auto'}>{examples ? 'starting examples' : `from ${dollars(seller.minTotalCents, currency)} · their ceiling sealed`}</Chip>
        </div>
        <div className="band-legend">
          <span><b>{seller.displayName}</b> (you) needs at least {dollars(seller.minTotalCents, currency)}{seller.targetTotalCents ? ` and aims for ${dollars(seller.targetTotalCents, currency)}` : ''}</span>
          <span className="sealed-number"><b>{buyer.displayName}</b> pays at most <span aria-label="sealed">🔒 sealed</span></span>
        </div>
        <p className="fine">A deal can only be accepted above your floor and under {buyer.displayName}’s ceiling. You never see their number and they never see yours. Your negotiator learns theirs only the way people do: from what they offer and accept.</p>
      </section>
    )
  }
  const top = Math.max(buyer.maxTotalCents, seller.minTotalCents, seller.targetTotalCents ?? 0) * 1.25
  const at = (cents: number) => `${Math.min(100, (cents / top) * 100)}%`
  const fits = seller.minTotalCents <= buyer.maxTotalCents
  return (
    <section className="rule-band panel" aria-label="Where the two companies' rules overlap" data-tour="deal-band">
      <div className="row between wrap gap-s">
        <h2 className="panel-title">Where a deal can exist</h2>
        <Chip tone={examples ? 'need' : fits ? 'auto' : 'deny'}>{examples ? 'starting examples' : fits ? `${dollars(seller.minTotalCents, currency)} to ${dollars(buyer.maxTotalCents, currency)}` : 'no overlap'}</Chip>
      </div>
      <div className="band-track" role="img" aria-label={`${buyer.displayName} pays at most ${dollars(buyer.maxTotalCents, currency)}. ${seller.displayName} needs at least ${dollars(seller.minTotalCents, currency)}.`}>
        <i className="band-buyer" style={{ left: 0, width: at(buyer.maxTotalCents) }} />
        <i className="band-seller" style={{ left: at(seller.minTotalCents), right: 0 }} />
        {fits ? <i className="band-zone" style={{ left: at(seller.minTotalCents), width: `calc(${at(buyer.maxTotalCents)} - ${at(seller.minTotalCents)})` }} /> : null}
      </div>
      <div className="band-legend">
        <span><b>{buyer.displayName}</b> pays at most {dollars(buyer.maxTotalCents, currency)}{buyer.targetTotalCents ? `, hopes for ${dollars(buyer.targetTotalCents, currency)}` : ''}</span>
        <span><b>{seller.displayName}</b> needs at least {dollars(seller.minTotalCents, currency)}{seller.targetTotalCents ? `, aims for ${dollars(seller.targetTotalCents, currency)}` : ''}</span>
      </div>
      <p className="fine">You see both because you are playing both chairs. Each company’s negotiator is told its own numbers and never the other’s.</p>
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
 * The writer for the numbers the band above draws. Each company writes its own limit: the form sends only what it
 * shows, the server keeps everything else about the company, and the other side's sheet is not reachable from here.
 */
function PriceSheets({ parties, owner, sealed = false, claimed = false, playing = false, onPlay }: { parties: SheetParty[]; owner: boolean; sealed?: boolean; claimed?: boolean; playing?: boolean; onPlay?: (on: boolean) => void }) {
  const studio = useStudioName()
  const client = parties.find((party) => party.role === 'buyer')?.displayName || 'the client'
  const isSet = (party: SheetParty) => party.role === 'buyer' ? (party.sheet?.limitSet ?? party.sheet?.maxTotalCents !== undefined) : party.sheet?.minTotalCents !== undefined
  const unset = parties.filter((party) => !isSet(party))
  const examples = parties.filter((party) => isSet(party) && party.sheet?.origin === 'seed')
  const state = unset.length > 0 ? 'missing' : examples.length > 0 ? 'examples' : 'set'
  return (
    <section className="panel price-sheets" data-tour="price-sheets">
      <div className="row between wrap gap-s">
        <h2 className="panel-title">{owner ? 'What each company will accept' : 'What your company will accept'}</h2>
        <Chip tone={state === 'set' ? 'auto' : 'need'}>{state === 'set' ? (owner ? 'both numbers are set' : 'your number is set') : state === 'examples' ? (owner || examples.length > 1 ? 'starting examples' : 'starting example') : `${unset.length} still to set`}</Chip>
      </div>
      {owner && onPlay ? (
        <div className={`seat-bar${playing ? ' is-playing' : ''}`} data-testid="seat-bar">
          <p>
            {playing
              ? <><strong>You are playing {client} for this demo.</strong> In a real deal {client} sets its numbers itself, with its own key, in its own console, and from then on you never see them.</>
              : <><strong>You are {studio ?? 'the studio'}.</strong> You set your own floor. {client} sets its own ceiling with its own key, so it is sealed here. This demo has no real {client}, so you can play them.</>}
          </p>
          <button type="button" className="btn btn-ghost btn-small" onClick={() => onPlay(!playing)} data-testid="seat-toggle">
            {playing ? 'Back to your own seat' : `Play ${client} for this demo`}
          </button>
        </div>
      ) : null}
      {owner && claimed ? <p className="fine"><span aria-hidden="true">🔒 </span>{client} set its own numbers with its own key. They are sealed from you on the server: you cannot read them, change them or answer offers for {client}.</p> : null}
      <p className="fine">
        {state === 'missing'
          ? 'A deal can only be accepted where the two numbers overlap. Until both are set there is nothing for the rules to judge against, so offers and negotiation wait.'
          : state === 'examples'
            ? 'These are still the sample numbers that came with the studio. Keep them in the bar above, or change them here — until then nothing is judged.'
            : 'Your walk-away is a hard limit: no offer past it can be made or accepted. Your target and style guide your negotiator; your brief tells it what else matters to you.'}
      </p>
      <div className="stack">
        {parties.map((party) => sealed && party.role === 'buyer'
          ? <SealedSheet key={party.key} party={party} claimed={claimed} onPlay={onPlay ? () => onPlay(true) : undefined} />
          : <PriceSheetForm key={party.key} party={party} owner={owner} />)}
      </div>
    </section>
  )
}

/** The client's sheet as the studio sees it: there, versioned, and not the studio's to read or write. */
function SealedSheet({ party, claimed, onPlay }: { party: SheetParty; claimed: boolean; onPlay?: () => void }) {
  const set = party.sheet?.limitSet ?? party.sheet?.maxTotalCents !== undefined
  return (
    <div className="sheet-form sheet-sealed" data-tour="price-buyer-sealed">
      <div className="row between wrap gap-s">
        <span className="eyebrow">{party.displayName || 'A client on the warrant'} · their number</span>
        {party.sheet ? <span className="mono small">sheet v{party.sheet.version}</span> : <Chip tone="need">not set</Chip>}
      </div>
      <p><span aria-hidden="true">🔒 </span>{set ? `${party.displayName} has set the most it will pay for a whole job. It is sealed: only ${party.displayName} and the rules see it.` : `${party.displayName || 'This client'} has not set a ceiling yet. Only their key can write it. Until they do, a deal waits. You can still bill them for a job.`}</p>
      {claimed ? <p className="fine">{party.sheet?.delegate ? `${party.displayName} lets Mandate’s negotiator speak for it, under its own sealed instructions.` : `${party.displayName} answers offers itself, from its own console or with its own agent.`}</p> : onPlay ? <p className="fine">In this demo there is no real {party.displayName || 'client'}. To see or change their number, <button type="button" className="link" onClick={onPlay}>play {party.displayName || 'the client'}</button>.</p> : <p className="fine">Give them a client key from System. They sign in and set this number themselves. You do not see the amount.</p>}
    </div>
  )
}

const STYLE_HINT: Record<NegotiationStyle, string> = {
  firm: 'Holds its ground and concedes late.',
  balanced: 'Concedes steadily, matching the other side.',
  flexible: 'Reaches a deal early; concedes readily.',
}

function PriceSheetForm({ party, owner }: { party: SheetParty; owner: boolean }) {
  const queryClient = useQueryClient()
  const online = useOnline()
  const toast = useToast()
  const field = party.role === 'buyer' ? 'maxTotalCents' : 'minTotalCents'
  const current = field === 'maxTotalCents' ? party.sheet?.maxTotalCents : party.sheet?.minTotalCents
  const currency = party.sheet?.currency ?? 'USD'
  const [value, setValue] = useState(() => (current === undefined ? '' : centsInput(current)))
  const [target, setTarget] = useState(() => (party.sheet?.targetTotalCents === undefined ? '' : centsInput(party.sheet.targetTotalCents)))
  const [style, setStyle] = useState<NegotiationStyle>(party.sheet?.style ?? 'balanced')
  const [brief, setBrief] = useState(party.sheet?.brief ?? '')
  const [delegate, setDelegate] = useState(party.sheet?.delegate === true)
  const studio = useStudioName()
  // The name is the company's own: the studio's name for the studio, and for a client the name already on the rules
  // (the server fills it in when this is left empty). It can be corrected here at any time.
  const [name, setName] = useState(party.displayName || (party.role === 'seller' ? studio ?? '' : ''))
  useEffect(() => { if (!name && party.role === 'seller' && studio && !party.sheet) setName(studio) }, [studio])
  const cents = parseCents(value)
  const targetCents = target.trim() ? parseCents(target) : null
  const label = party.role === 'buyer' ? 'pays at most' : 'needs at least'
  const noun = party.role === 'buyer' ? 'ceiling' : 'floor'
  // A client key writing its own sheet is the client: it may let Mandate's negotiator speak for it.
  const ownClientSheet = !owner && party.role === 'buyer'
  const targetWrong = targetCents !== null && cents !== null && (party.role === 'seller' ? targetCents < cents : targetCents > cents)
  const save = useMutation({
    mutationFn: () => api.putPartyRules(party.partyId, {
      ...(name.trim() && name.trim() !== party.sheet?.displayName ? { displayName: name.trim() } : {}),
      [field]: cents,
      ...(targetCents !== null ? { targetTotalCents: targetCents } : {}),
      style,
      ...(brief.trim() ? { brief: brief.trim() } : {}),
      ...(ownClientSheet ? { delegate } : {}),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['party-rules'] })
      toast({
        title: `${name.trim() || party.displayName || 'The company'}’s ${noun} is now ${dollars(cents, currency)}`,
        body: 'Saved as the next version of its sheet. Nothing has moved: this is only a limit.',
        tone: 'good',
      })
    },
  })
  return (
    <form className="sheet-form" data-tour={`price-${party.role}`} onSubmit={(event) => { event.preventDefault(); if (cents && !targetWrong) save.mutate() }}>
      <div className="row between wrap gap-s">
        <span className="eyebrow">{party.sheet ? party.displayName : !owner ? 'Your company' : party.role === 'buyer' ? 'A client on the rules' : 'Your studio'}</span>
        {party.sheet ? <span className="mono small">sheet v{party.sheet.version}{party.sheet.writtenBy === 'party' ? ' · written by them' : ''}</span> : <Chip tone="need">not set</Chip>}
      </div>
      <div className="field-row">
        <label className="field"><span>Company name</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required={party.role === 'seller'} placeholder={party.role === 'buyer' && !owner ? 'As the studio’s rules name you' : 'Your company’s name'} /><small>{party.role === 'buyer' && !owner && !name ? 'Leave empty to use the name on the studio’s rules.' : 'How the other side’s negotiator will address you.'}</small></label>
        <label className="field">
          <span>{name || (owner ? 'This company' : 'Your company')} {label} for a whole job</span>
          <span className="dollar-input"><span>{currency}</span><input inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} placeholder={party.role === 'buyer' ? 'The most you will pay' : 'The least you will take'} required aria-label={`Walk-away in ${currency}`} /></span>
          <small>The walk-away: no offer past it can be made or accepted.</small>
        </label>
        <label className="field">
          <span>Hopes for (target)</span>
          <span className="dollar-input"><span>{currency}</span><input inputMode="decimal" value={target} onChange={(event) => setTarget(event.target.value)} placeholder="Where you aim" aria-label={`Target in ${currency}`} /></span>
          <small>{targetWrong ? `A target must be ${party.role === 'seller' ? 'at or above' : 'at or under'} the walk-away.` : 'Where the negotiator aims. Private, like the walk-away.'}</small>
        </label>
      </div>
      <div className="field-row">
        <label className="field"><span>Negotiating style</span><select value={style} onChange={(event) => setStyle(event.target.value as NegotiationStyle)}>{(['firm', 'balanced', 'flexible'] as const).map((item) => <option key={item} value={item}>{item}</option>)}</select><small>{STYLE_HINT[style]}</small></label>
        <label className="field"><span>Brief to the negotiator (optional)</span><input value={brief} onChange={(event) => setBrief(event.target.value)} maxLength={600} placeholder={party.role === 'buyer' ? 'We need the first files within two weeks' : 'Repeat clients matter more than this one job'} /><small>What else matters to you. Private.</small></label>
      </div>
      {ownClientSheet ? (
        <label className="check"><input type="checkbox" checked={delegate} onChange={(event) => setDelegate(event.target.checked)} /> Let Mandate’s negotiator answer the studio’s offers for us, inside these numbers. <span className="fine">Off: you answer each offer yourself, here or with your own agent.</span></label>
      ) : null}
      <div className="row between wrap gap-s">
        <span className="fine">{party.role === 'buyer' ? 'The studio is never told these numbers.' : 'The client is never told these numbers.'}</span>
        <button type="submit" className="btn btn-ink" disabled={!cents || targetWrong || !online || save.isPending}>
          {save.isPending ? 'Saving…' : party.sheet ? 'Save' : 'Set this limit'}
        </button>
      </div>
      <ProblemCard error={save.error} />
    </form>
  )
}

const BY_WORD: Record<string, string> = { agent: 'negotiator', person: 'person', outside: 'own agent', strategy: 'strategy' }
const STATUS_CHIP: Record<NegotiationView['status'], { tone: 'auto' | 'need' | 'deny' | 'muted'; word: string }> = {
  open: { tone: 'need', word: 'Open' },
  agreed: { tone: 'auto', word: 'Agreed' },
  walked_away: { tone: 'deny', word: 'Walked away' },
  expired: { tone: 'muted', word: 'Deadline passed' },
  stalled: { tone: 'muted', word: 'Stalled' },
}

/**
 * One negotiation, for whoever is looking: the moves so far, and — when it is their turn — the three things a side may
 * do. The owner may answer for a client only while that client has not claimed its seat; the server decides that.
 */
function NegotiationCard({ view, deal, owner, agentsOn, highlight, onChanged, onFinish }: { view: NegotiationView; deal: Deal | null; owner: boolean; agentsOn: boolean; highlight: string | null; onChanged: () => void; onFinish?: () => void }) {
  const agreed = view.status === 'agreed'
  const name = (side: Side) => (side === 'seller' ? view.sellerName : view.buyerName)
  // No move yet: whoever may act opens (the studio first, when the owner may speak for both).
  const mySide = view.turn ? (view.you.sides.includes(view.turn) ? view.turn : null) : (view.you.sides[0] ?? null)
  const own = mySide ? view.seats[mySide] : null
  return (
    <article id={agreed && view.agreedDealId ? `deal-${view.agreedDealId}` : undefined} className={`deal-card${agreed ? ' is-agreed' : ''}${agreed && view.agreedDealId === highlight ? ' flash' : ''}`} data-testid="negotiation" data-tour={agreed ? 'deal-agreed' : undefined}>
      <header className="deal-head">
        <div>
          <span className="eyebrow">{view.sellerName} ⇄ {view.buyerName} · {when(view.createdAt)}</span>
          <h2>{view.scope}</h2>
        </div>
        <div className="row gap-s wrap">
          {view.standing?.totalCents != null || agreed ? <Money cents={agreed ? view.moves.find((move) => move.action === 'accept')?.totalCents : view.standing?.totalCents} currency={view.currency} size="lg" /> : null}
          <Chip tone={STATUS_CHIP[view.status].tone}>{STATUS_CHIP[view.status].word}</Chip>
        </div>
      </header>

      {view.moves.length > 0 ? (
        <ol className="offers moves">
          {view.moves.map((move) => (
            <li key={move.seq} className={move.action === 'accept' ? 'yes' : move.action === 'walk_away' ? 'no' : ''}>
              <span className="mono small">{move.side === 'seller' ? 'studio' : 'client'}<br /><span className="muted">{BY_WORD[move.by] ?? move.by}</span></span>
              {move.totalCents !== null ? <Money cents={move.totalCents} currency={view.currency} /> : <span>—</span>}
              <span>
                <b>{move.action === 'offer' ? (move.final ? 'Final offer' : 'Offer') : move.action === 'accept' ? 'Accepted' : 'Walked away'}</b>
                {move.message ? <> · <q>{move.message}</q></> : null}
                {move.assessment ? <details className="private-note fine"><summary>Private note (only {move.side === 'seller' ? view.sellerName : view.buyerName} sees this)</summary>{move.assessment}</details> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {view.moves.filter((move) => move.totalCents !== null).length >= 2 ? <ConcessionChart moves={view.moves} currency={view.currency} offersPerSide={view.offersPerSide} studio={view.sellerName} client={view.buyerName} /> : null}

      {view.status === 'open' && onFinish && view.negotiators.buyer ? (
        <div className="row between wrap gap-s finish-bar">
          <span className="fine">Both sides let Mandate’s negotiators speak for them here: they can play it to the end, move by move, while you watch.</span>
          <button type="button" className="btn btn-lime btn-small" onClick={onFinish} data-testid="finish-negotiation">Let the negotiators finish it</button>
        </div>
      ) : null}
      {view.status === 'open' ? (
        mySide && own ? <YourMove view={view} side={mySide} counterparty={name(mySide === 'seller' ? 'buyer' : 'seller')} owner={owner} agentsOn={agentsOn} onChanged={onChanged} />
          : <p className="fine" data-testid="waiting">Waiting for {view.turn ? name(view.turn) : 'the first offer'}. {view.turn ? `${name(view.turn)} answers in its own console, or its own agent does. ` : ''}Each side may make {view.offersPerSide} offers; this negotiation closes by itself on {new Date(view.expiresAt).toLocaleDateString()} if nobody answers.</p>
      ) : <NegotiationEnd view={view} />}

      {agreed && deal ? <Agreed deal={deal} owner={owner} /> : null}
    </article>
  )
}

/** The side whose turn it is: accept the standing offer, counter it, walk away, or let its negotiator answer. */
function YourMove({ view, side, counterparty, owner, agentsOn, onChanged }: { view: NegotiationView; side: Side; counterparty: string; owner: boolean; agentsOn: boolean; onChanged: () => void }) {
  const toast = useToast()
  const online = useOnline()
  const seat = view.seats[side]
  const advice = seat.visible ? seat.advice : null
  const [amount, setAmount] = useState(() => (advice?.offerCents ? centsInput(advice.offerCents) : ''))
  const [message, setMessage] = useState('')
  const [final, setFinal] = useState(false)
  const [idem, setIdem] = useState(newKey)
  const cents = parseCents(amount)
  const standing = view.standing && view.standing.side !== side ? view.standing : null
  const playingClient = owner && side === 'buyer'
  const done = (title: string, body: string) => { toast({ title, body, tone: 'good' }); setIdem(newKey()); onChanged() }
  const accept = useMutation({ mutationFn: () => api.acceptDeal(standing!.dealId!, message.trim() ? { message: message.trim() } : {}), onSuccess: () => done('Deal agreed', 'You accepted their exact offer. Both companies’ rules were checked and the server signed it.') })
  const counter = useMutation({ mutationFn: () => api.offerDeal({ buyer: view.buyerName, threadId: view.id, totalCents: cents ?? 0, prompt: message.trim() || undefined, final, as: owner ? side : undefined }, idem), onSuccess: (made) => made.status === 'refused' ? toast({ title: 'That offer does not stand', body: made.verdict.violations.map((violation) => violation.detail).join('; '), tone: 'bad' }) : done('Offer made', `It stands until ${counterparty} answers.`) })
  const walk = useMutation({ mutationFn: () => api.walkAway(view.id, message.trim() ? { reason: message.trim() } : {}), onSuccess: () => done('You walked away', 'The negotiation is over with no deal.') })
  const agent = useMutation({ mutationFn: () => api.agentMove(view.id), onSuccess: () => done('Your negotiator answered', 'Its move is on the table.') })
  const busy = accept.isPending || counter.isPending || walk.isPending || agent.isPending
  const left = seat.visible ? seat.offersLeft : null
  return (
    <div className="your-move" data-testid="your-move">
      <div className="row between wrap gap-s">
        <strong>{playingClient ? `Your move, for ${view.buyerName}` : 'Your move'}</strong>
        <span className="fine">{left !== null ? `${left} of ${view.offersPerSide} offers left` : ''}{standing?.final ? ' · their offer is final' : ''}</span>
      </div>
      {playingClient ? <p className="fine">{view.buyerName} has not set its own numbers with its own key, so you answer for it (a demo, or a client not on Mandate yet: record what they told you). Once it sets them, only it can answer.</p> : null}
      {advice ? <p className="fine reference"><b>Reference:</b> {advice.action === 'offer' ? `a ${seat.visible ? seat.style : ''} negotiator would offer about ${dollars(advice.offerCents, view.currency)} now.` : advice.action === 'accept' ? 'accepting is reasonable now.' : 'walking away is reasonable now.'} {advice.why} {advice.mayAccept || !standing ? '' : 'Their offer is past your walk-away, so it cannot be accepted.'}</p> : null}
      <label className="field"><span>What you say to {counterparty} (optional)</span><input value={message} onChange={(event) => setMessage(event.target.value)} maxLength={1000} placeholder="One or two sentences. Your numbers are removed if you type them." /></label>
      <div className="row gap-s wrap">
        {standing ? <button type="button" className="btn btn-lime" disabled={!online || busy || !(advice?.mayAccept ?? true)} onClick={() => accept.mutate()} data-testid="accept">Accept {dollars(standing.totalCents, view.currency)}</button> : null}
        {left !== 0 ? (
          <form className="row gap-s wrap counter" onSubmit={(event) => { event.preventDefault(); if (cents) counter.mutate() }}>
            <span className="dollar-input"><span>{view.currency}</span><input inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value); setIdem(newKey()) }} placeholder="Your offer" aria-label="Your offer for the whole job" /></span>
            <label className="check"><input type="checkbox" checked={final} onChange={(event) => setFinal(event.target.checked)} /> final</label>
            <button type="submit" className="btn btn-ink" disabled={!cents || !online || busy}>{standing ? 'Counter' : 'Offer'}</button>
          </form>
        ) : null}
        <button type="button" className="btn btn-ghost" disabled={!online || busy} onClick={() => walk.mutate()}>Walk away</button>
        {agentsOn && view.you.agentMay.includes(side) ? <button type="button" className="btn btn-ghost" disabled={!online || busy} onClick={() => agent.mutate()} data-testid="agent-move">{agent.isPending ? 'Your negotiator is thinking…' : 'Let my negotiator answer'}</button> : null}
      </div>
      <ProblemCard error={accept.error ?? counter.error ?? walk.error ?? agent.error} />
    </div>
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
        toast({ title: 'Sent to the client to accept', body: 'Nothing is billed until the client accepts the delivery. You can follow it on Today.', tone: 'info' })
        navigate('/')
        return
      }
      const proposal = made.charge
      toast({ title: `Milestone billed · ${dollars(proposal.amountCents, deal.terms.currency)}`, body: proposal.gate === 'DENY' ? 'The rules refused it.' : proposal.gate === 'AUTO' ? 'Your rule covers it: the invoice is on its way, no tap.' : 'Approve it on Today.', tone: proposal.gate === 'DENY' ? 'bad' : 'good' })
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
                <Money cents={item.amountCents} currency={deal.terms.currency} />
                {item.chargeId && owner ? <Link to={`/p/${item.chargeId}`} className="link"><PhaseChip phase={item.phase ?? 'pending_approval'} /></Link> : item.chargeId ? <PhaseChip phase={item.phase ?? 'pending_approval'} /> : <Chip tone="muted">not billed</Chip>}
              </li>
            ))}
          </ol>
          <p className="fine">Job {owner ? <Link to={`/jobs/${deal.jobId}`} className="mono">{deal.jobId}</Link> : <span className="mono">{deal.jobId}</span>}. A charge on this job can bill a milestone only for exactly its agreed amount.</p>
          {owner ? (
            <div className="bill">
              <label className="field">
                <span>Link to the delivered work for the next milestone</span>
                <input type="url" value={proof} onChange={(event) => setProof(event.target.value)} placeholder="https://" />
              </label>
              <div className="row gap-s wrap">
                {milestones.filter((item) => !item.chargeId).slice(0, 1).map((item) => (
                  <button key={item.index} type="button" className="btn btn-ink" disabled={!online || !proof.trim() || bill.isPending} onClick={() => bill.mutate(item.index)}>
                    {bill.isPending ? 'Sending…' : `Deliver milestone ${item.index + 1} · ${dollars(item.amountCents, deal.terms.currency)}`}
                  </button>
                ))}
              </div>
              <ProblemCard error={bill.error} />
            </div>
          ) : null}
        </div>
        <div className="stack">
          <Signature kind="deal" id={deal.id} signature={deal.signature} keyId={deal.keyId} />
          <p className="fine">Agreed under the studio’s rules v{deal.rulesVersions.seller} and {deal.buyerName}’s rules v{deal.rulesVersions.buyer}.</p>
        </div>
      </div>
    </div>
  )
}

/**
 * Making the opening offer yourself, as a person. It opens a negotiation; the other side answers it. The currency and
 * the kind of work are the studio's own, never a sample's.
 */
function OfferForm({ blocked = false, blockedHint = '', clients, currency, category, side, onMade }: { blocked?: boolean; blockedHint?: string; clients: string[]; currency: string; category: string; side: Side; onMade: () => void }) {
  const online = useOnline()
  const toast = useToast()
  const [buyer, setBuyer] = useState('')
  const [total, setTotal] = useState('')
  const [scope, setScope] = useState('')
  const [titles, setTitles] = useState('')
  const [offers, setOffers] = useState(4)
  const [idem, setIdem] = useState(newKey)
  const cents = parseCents(total)
  const client = buyer || clients[0] || ''
  const send = useMutation({ mutationFn: () => {
    const names = titles.split(',').map((item) => item.trim()).filter(Boolean)
    const list = names.length ? names : ['Milestone 1', 'Milestone 2']
    const each = Math.floor((cents ?? 0) / list.length)
    const milestones = list.map((title, index) => ({ title, amountCents: index === list.length - 1 ? (cents ?? 0) - each * (list.length - 1) : each }))
    return api.offerDeal({ buyer: client, offersPerSide: offers, terms: { scope: scope.trim(), category, currency, totalCents: cents, milestones, proofRequired: true } }, idem)
  }, onSuccess: (made) => {
    setIdem(newKey())
    onMade()
    if (made.status === 'refused') toast({ title: 'That offer does not stand', body: made.verdict.violations.map((violation) => violation.detail).join('; '), tone: 'bad' })
    else toast({ title: 'Offer made', body: `It stands until ${side === 'seller' ? client : 'the studio'} answers: accept, counter or walk away.`, tone: 'good' })
  } })
  return (
    <section className="panel offer-form" data-tour="deal-offer">
      <h2 className="panel-title">Make the opening offer yourself</h2>
      <p className="fine">It opens a negotiation with {side === 'seller' ? (client || 'the client') : 'the studio'}. Your offer must be inside your own walk-away; whether it works for them is theirs to say.</p>
      <form className="stack" onSubmit={(event) => { event.preventDefault(); if (cents) send.mutate() }}>
        <div className="field-row">
          {side === 'seller' && clients.length > 1 ? <label className="field"><span>To</span><select value={client} onChange={(event) => setBuyer(event.target.value)}>{clients.map((item) => <option key={item} value={item}>{item}</option>)}</select></label> : null}
          <label className="field"><span>The job</span><input value={scope} onChange={(event) => setScope(event.target.value)} maxLength={300} required placeholder="What will be delivered" /></label>
          <label className="field"><span>Price for the whole job</span><span className="dollar-input"><span>{currency}</span><input inputMode="decimal" value={total} onChange={(event) => { setTotal(event.target.value); setIdem(newKey()) }} placeholder="Your price" required aria-label={`Total in ${currency}`} /></span></label>
        </div>
        <div className="field-row">
          <label className="field"><span>Milestones</span><input value={titles} onChange={(event) => setTitles(event.target.value)} maxLength={300} placeholder="First half, Second half" /><small>Comma-separated; the price is split evenly.</small></label>
          <label className="field"><span>Deadline</span><select value={offers} onChange={(event) => setOffers(Number(event.target.value))}>{[2, 3, 4, 5, 6, 8].map((n) => <option key={n} value={n}>{n} offers each</option>)}</select></label>
        </div>
        <div className="row between wrap gap-s">
          <span className="fine">{blocked ? blockedHint : `In ${currency}, for ${category} work.`}</span>
          <button type="submit" className="btn btn-lime" disabled={!cents || !scope.trim() || !online || send.isPending || blocked}>{send.isPending ? 'Checking your rules…' : 'Make this offer'}</button>
        </div>
      </form>
      <ProblemCard error={send.error} />
    </section>
  )
}
