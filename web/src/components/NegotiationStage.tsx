import { Chip, Money } from './ui'
import { ToolTrail } from './ToolTrail'
import { dollars } from '../lib/money'
import type { LiveTurn, Negotiation, Seat } from '../lib/useNegotiation'
import type { NegotiationDebrief, NegotiationSeat, NegotiationView } from '../lib/types'

/** A small robot, the same character as the pitch deck. Its eyes blink while the agent is thinking. */
function Robot({ thinking, tone }: { thinking: boolean; tone: 'paper' | 'stone' }) {
  const fill = tone === 'paper' ? 'var(--surface)' : 'var(--stone)'
  return (
    <svg className={`robot${thinking ? ' is-thinking' : ''}`} width="52" height="68" viewBox="0 0 100 130" aria-hidden="true">
      <line x1="50" y1="2" x2="50" y2="14" stroke="var(--ink)" strokeWidth="4" />
      <circle className="robot-bulb" cx="50" cy="5" r="5" fill="var(--lime)" stroke="var(--ink)" strokeWidth="3" />
      <rect x="22" y="14" width="56" height="46" rx="8" fill={fill} stroke="var(--ink)" strokeWidth="4" />
      <circle className="robot-eye" cx="40" cy="37" r="6" fill="var(--ink)" />
      <circle className="robot-eye" cx="60" cy="37" r="6" fill="var(--ink)" />
      <path d="M12 128 L12 92 Q12 70 34 70 L66 70 Q88 70 88 92 L88 128 Z" fill={fill} stroke="var(--ink)" strokeWidth="4" />
    </svg>
  )
}

const seconds = (ms: number) => (ms / 1000).toFixed(ms < 10_000 ? 1 : 0)
const clock = (ms: number) => `${String(Math.floor(ms / 60_000)).padStart(2, '0')}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`

export const ACTION_WORD = { offer: 'Offered', accept: 'Accepted', walk_away: 'Walked away' } as const

function seatState(turns: LiveTurn[], side: Seat, running: boolean, waiting: boolean, currency: string): { label: string; detail: string; active: boolean; tone: 'need' | 'auto' | 'deny' | 'muted' } {
  const mine = turns.filter((item) => item.side === side)
  const last = mine[mine.length - 1]
  const current = turns[turns.length - 1]
  if (waiting) return { label: 'Their move', detail: 'Answers for itself, in its own console', active: false, tone: 'need' }
  if (current && current.side === side && current.status === 'thinking' && running) return { label: 'Thinking', detail: 'Reading the table and its own mandate', active: true, tone: 'need' }
  if (last?.status === 'moved') {
    const tone = last.action === 'accept' ? 'auto' : last.action === 'walk_away' ? 'deny' : 'muted'
    return { label: ACTION_WORD[last.action], detail: last.totalCents !== null ? `${last.action === 'offer' ? (last.final ? 'Final offer' : 'Offer') : 'At'} ${dollars(last.totalCents, currency)}` : '', active: false, tone }
  }
  if (last?.status === 'failed') return { label: 'Stopped', detail: last.error, active: false, tone: 'deny' }
  return { label: running ? 'Waiting' : 'Idle', detail: running ? 'Not its turn yet' : '', active: false, tone: 'muted' }
}

export type ChartMove = { seq: number; side: Seat; action: 'offer' | 'accept' | 'walk_away'; totalCents: number | null }

/**
 * The negotiation dance: each side's offers over the moves, as two lines that close in on each other. Where the
 * viewer may see both limits (a demo, played from both chairs), the overlap is drawn as a band; otherwise the viewer's
 * own walk-away is a single dashed line. The accepted price is the lime point where the lines meet.
 */
export function ConcessionChart({ moves, currency, offersPerSide, zone, ownLimit, studio, client }: {
  moves: ChartMove[]
  currency: string
  offersPerSide: number
  zone?: { minCents: number; maxCents: number } | null
  ownLimit?: { side: Seat; cents: number } | null
  studio: string
  client: string
}) {
  const priced = moves.filter((move) => move.totalCents !== null)
  if (priced.length === 0) return null
  const values = [...priced.map((move) => move.totalCents!), ...(zone ? [zone.minCents, zone.maxCents] : []), ...(ownLimit ? [ownLimit.cents] : [])]
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const pad = Math.max(1, (hi - lo) * 0.15)
  const top = hi + pad
  const bottom = Math.max(0, lo - pad)
  const width = 640
  const height = 230
  const left = 70
  const right = 20
  const slots = Math.max(offersPerSide * 2 + 1, priced.at(-1)!.seq + 1)
  const x = (seq: number) => left + ((seq - 1) / Math.max(1, slots - 1)) * (width - left - right)
  const y = (cents: number) => 16 + (1 - (cents - bottom) / Math.max(1, top - bottom)) * (height - 44)
  const line = (side: Seat) => priced.filter((move) => move.side === side && move.action === 'offer').map((move) => `${x(move.seq)},${y(move.totalCents!)}`).join(' ')
  const accepted = priced.find((move) => move.action === 'accept')
  const label = priced.map((move) => `${move.side === 'seller' ? studio : client} ${move.action === 'accept' ? 'accepted' : 'offered'} ${dollars(move.totalCents!, currency)}`).join(', ')
  return (
    <figure className="dance" aria-label={`Offers over the negotiation: ${label}`}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
        {zone && zone.minCents <= zone.maxCents ? <rect className="dance-zone" x={left} width={width - left - right} y={y(zone.maxCents)} height={Math.max(2, y(zone.minCents) - y(zone.maxCents))} /> : null}
        {ownLimit ? <line className="dance-limit" x1={left} x2={width - right} y1={y(ownLimit.cents)} y2={y(ownLimit.cents)} /> : null}
        <line className="dance-axis" x1={left} x2={left} y1={10} y2={height - 26} />
        <polyline className="dance-line dance-seller" points={line('seller')} />
        <polyline className="dance-line dance-buyer" points={line('buyer')} />
        {priced.map((move) => (
          <g key={move.seq} className={`dance-point dance-${move.side}${move.action === 'accept' ? ' is-accepted' : ''}`}>
            <circle cx={x(move.seq)} cy={y(move.totalCents!)} r={move.action === 'accept' ? 9 : 5} />
            <text x={x(move.seq)} y={y(move.totalCents!) + (move.side === 'seller' ? -12 : 20)} textAnchor="middle">{dollars(move.totalCents!, currency)}</text>
          </g>
        ))}
        {accepted ? <text className="dance-tick" x={x(accepted.seq)} y={height - 8} textAnchor="middle">deal</text> : null}
      </svg>
      <figcaption className="dance-legend">
        <span><i className="key key-seller" /> {studio}</span>
        <span><i className="key key-buyer" /> {client}</span>
        {zone ? <span><i className="key key-zone" /> where both could agree</span> : ownLimit ? <span><i className="key key-limit" /> your walk-away</span> : null}
      </figcaption>
    </figure>
  )
}

const VERDICT_WORDS = { beat_target: 'Beat the target', met_target: 'Hit the target', good: 'A good deal', fair: 'A fair deal', at_limit: 'At the walk-away' } as const
const SATISFACTION = { satisfied: { tone: 'auto', word: 'Satisfied' }, acceptable: { tone: 'need', word: 'Acceptable' }, dissatisfied: { tone: 'deny', word: 'Not satisfied' } } as const

/**
 * How it went for one side, in that side's own terms: the margin over its walk-away and how far it got towards its
 * target (worked out by code), and its negotiator's own debrief (the model's judgement). Only the side itself sees it.
 */
export function SeatResult({ seat, company, currency, debrief }: { seat: NegotiationSeat; company: string; currency: string; debrief?: NegotiationDebrief | null }) {
  if (!seat.visible) {
    return (
      <div className="seat-result is-sealed">
        <span className="eyebrow">{company}</span>
        <p className="fine"><span aria-hidden="true">🔒 </span>How this went for {company} is theirs to know: their numbers and their negotiator’s debrief are sealed.</p>
      </div>
    )
  }
  const said = debrief ?? seat.debrief
  const pct = seat.outcome ? Math.max(0, Math.min(100, seat.outcome.towardTargetPct)) : null
  return (
    <div className="seat-result" data-testid={`seat-result-${seat.side}`}>
      <div className="row between wrap gap-s">
        <span className="eyebrow">{company} · {seat.side === 'seller' ? 'selling' : 'buying'}</span>
        {seat.outcome ? <Chip tone={seat.outcome.verdict === 'at_limit' ? 'need' : 'auto'}>{VERDICT_WORDS[seat.outcome.verdict]}</Chip> : null}
      </div>
      {seat.outcome && pct !== null ? (
        <>
          <div className="toward" role="img" aria-label={`${seat.outcome.towardTargetPct}% of the way from the walk-away to the target`}>
            <span className="toward-end">walk-away {dollars(seat.reservationCents, currency)}</span>
            <span className="toward-bar"><i style={{ width: `${pct}%` }} /></span>
            <span className="toward-end">target {dollars(seat.targetCents, currency)}{seat.targetChosen ? '' : '*'}</span>
          </div>
          <p className="fine">{seat.outcome.summary}{seat.targetChosen ? '' : ' *No target was set, so 25% better than the walk-away stands in for one.'}</p>
        </>
      ) : <p className="fine">No deal, so nothing was given away: the walk-away was {dollars(seat.reservationCents, currency)}.</p>}
      {said ? (
        <div className="debrief">
          <div className="row between wrap gap-s">
            <strong>Its negotiator’s debrief</strong>
            <Chip tone={SATISFACTION[said.satisfaction].tone}>{SATISFACTION[said.satisfaction].word}</Chip>
          </div>
          <p>{said.summary}</p>
          <dl className="ratings">
            {(['outcome', 'process', 'relationship', 'self'] as const).map((key) => (
              <div key={key}><dt>{key}</dt><dd aria-label={`${said.ratings[key]} of 5`}>{'●'.repeat(said.ratings[key])}<span className="muted">{'●'.repeat(5 - said.ratings[key])}</span></dd></div>
            ))}
          </dl>
          <p className="fine"><b>Next time:</b> {said.lesson} {said.wouldSignAgain ? 'It would sign this again.' : 'It would not sign this again.'}</p>
        </div>
      ) : null}
    </div>
  )
}

/** The end of a negotiation, for any screen: how it ended, and what it meant for each side the viewer may see. */
export function NegotiationEnd({ view, debriefs = {} }: { view: NegotiationView; debriefs?: Partial<Record<Seat, NegotiationDebrief>> }) {
  const agreed = view.status === 'agreed'
  const price = agreed ? view.moves.find((move) => move.action === 'accept')?.totalCents ?? null : null
  return (
    <div className={`negotiation-end${agreed ? ' is-agreed' : ''}`} data-testid="negotiation-end">
      <p className="ending"><strong>{agreed ? `Agreed at ${dollars(price, view.currency)}.` : 'No deal.'}</strong> {capital(view.ending ?? '')}{view.ending ? '.' : ''} {agreed ? 'The deal is signed and binds both companies; each milestone is billed when it is delivered.' : 'Nothing was agreed and nothing was billed.'}</p>
      <div className="seat-results">
        <SeatResult seat={view.seats.seller} company={view.sellerName} currency={view.currency} debrief={debriefs.seller} />
        <SeatResult seat={view.seats.buyer} company={view.buyerName} currency={view.currency} debrief={debriefs.buyer} />
      </div>
      {view.fairness && price !== null ? (
        <p className="fine">Seen from both chairs (a demo): the overlap was {dollars(view.fairness.zone.minCents, view.currency)} to {dollars(view.fairness.zone.maxCents, view.currency)}. The studio took {view.fairness.sellerSharePct}% of it; an even split (the Nash bargaining point) would have been {dollars(view.fairness.nashCents, view.currency)}.</p>
      ) : null}
    </div>
  )
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

export function NegotiationStage({ state, zone, ownLimit, onStop, onReset, onJump }: {
  state: Negotiation
  zone?: { minCents: number; maxCents: number } | null
  ownLimit?: { side: Seat; cents: number } | null
  onStop: () => void
  onReset: () => void
  onJump: () => void
}) {
  const running = state.phase === 'running'
  const last = state.turns[state.turns.length - 1]
  const studio = seatState(state.turns, 'seller', running, state.waitingFor === 'seller', state.currency)
  const client = seatState(state.turns, 'buyer', running, state.waitingFor === 'buyer', state.currency)
  const result = state.result
  const agreed = result?.status === 'agreed'
  const moves: ChartMove[] = result
    ? result.moves.map((move) => ({ seq: move.seq, side: move.side, action: move.action, totalCents: move.totalCents }))
    : state.turns.flatMap((item, index) => (item.status === 'moved' ? [{ seq: index + 1, side: item.side, action: item.action, totalCents: item.totalCents }] : []))
  const offersMade = (side: Seat) => state.turns.filter((item) => item.side === side && item.status === 'moved' && item.action === 'offer').length
  const liveSummary = last?.status === 'thinking'
    ? `${last.side === 'seller' ? state.studio : state.client}'s negotiator is thinking.`
    : last?.status === 'moved'
      ? `${last.side === 'seller' ? state.studio : state.client} ${last.action === 'offer' ? `offered ${dollars(last.totalCents, state.currency)}` : last.action === 'accept' ? `accepted ${dollars(last.totalCents, state.currency)}` : 'walked away'}.`
      : ''

  return (
    <section className={`panel stage${running ? ' is-running' : ''}`} data-tour="deal-story" aria-label="Live negotiation">
      <span className="sr-only" role="status" aria-live="polite">{liveSummary}</span>

      <header className="stage-head">
        <div className="row gap-s">
          {running ? <span className="pulse-dot" aria-hidden="true" /> : null}
          <h2 className="panel-title">{running ? 'Live negotiation' : 'The negotiation, move by move'}</h2>
        </div>
        <div className="row gap-s wrap">
          <span className="mono small muted" aria-hidden="true">{clock(state.elapsedMs)}</span>
          {running ? <button type="button" className="btn btn-ghost btn-small" onClick={onStop}>Stop</button> : null}
          {result ? <Chip tone={agreed ? 'auto' : result.status === 'open' ? 'need' : 'deny'}>{agreed ? 'agreed' : result.status === 'open' ? 'open' : result.status.replace('_', ' ')}</Chip> : null}
          {state.phase === 'stopped' ? <Chip tone="muted">stopped</Chip> : null}
          {state.phase === 'failed' ? <Chip tone="deny">stopped by an error</Chip> : null}
          {!running ? <button type="button" className="link" onClick={onReset}>Clear</button> : null}
        </div>
      </header>
      {state.scope ? <p className="fine stage-scope"><b>{state.scope}</b> · each side may make {state.offersPerSide} offers, and both know it · a deal exists only when one side accepts the other’s offer</p> : null}

      <div className="seats">
        {([['seller', state.studio, studio, 'paper'], ['buyer', state.client, client, 'stone']] as const).map(([side, company, seat, tone]) => (
          <div key={side} className={`seat seat-${side}${seat.active ? ' is-active' : ''}`}>
            <Robot thinking={seat.active} tone={tone} />
            <div className="seat-text">
              <span className="eyebrow">{side === 'seller' ? 'Studio’s negotiator' : state.seats.buyer === 'client' ? 'The client, for itself' : 'Client’s negotiator'}</span>
              <strong>{company}</strong>
              <span className="seat-state"><Chip tone={seat.tone}>{seat.label}{seat.active ? <span className="think-dots" aria-hidden="true"><i /><i /><i /></span> : null}</Chip></span>
              <span className="fine">{seat.detail}{state.phase !== 'idle' ? ` · ${offersMade(side)} of ${state.offersPerSide} offers` : ''}</span>
            </div>
          </div>
        ))}
      </div>

      <ConcessionChart moves={moves} currency={state.currency} offersPerSide={state.offersPerSide} zone={zone} ownLimit={zone ? null : ownLimit} studio={state.studio} client={state.client} />

      <ol className="turns">
        {state.turns.map((item) => <TurnCard key={item.turn} item={item} company={item.side === 'seller' ? state.studio : state.client} currency={state.currency} now={state.elapsedMs} />)}
      </ol>

      {running && state.turns.length === 0 ? (
        <p className="stage-wait" role="status"><span className="pulse-dot" aria-hidden="true" /> Opening the table. The studio’s negotiator makes the first offer.</p>
      ) : null}

      {state.waitingFor ? (
        <footer className="stage-foot">
          <p><strong>Waiting for {state.waitingFor === 'buyer' ? state.client : state.studio}.</strong> {state.waitingFor === 'buyer' ? state.client : state.studio} negotiates for itself: it sees the offer in its own console and accepts, counters or walks away there. This negotiation stays open below.</p>
        </footer>
      ) : null}
      {result && result.status !== 'open' ? (
        <footer className={`stage-foot${agreed ? ' is-agreed' : ''}`}>
          <NegotiationEnd view={result} debriefs={state.debriefs} />
          {agreed ? <button type="button" className="btn btn-ink" onClick={onJump}>Go to the signed deal ↓</button> : null}
        </footer>
      ) : null}
      {state.phase === 'stopped' ? <footer className="stage-foot"><p><strong>Stopped.</strong> The moves so far are kept and the negotiation stays open: either side can carry on below.</p></footer> : null}
      <p className="fine">{state.model ? <>Model <span className="mono">{state.model}</span>. </> : null}Each move is the negotiator’s own decision. The server holds only the walk-away, the turn order and the deadline, and never tells one side the other’s numbers.</p>
    </section>
  )
}

function TurnCard({ item, company, currency, now }: { item: LiveTurn; company: string; currency: string; now: number }) {
  const who = item.side === 'seller' ? 'Studio’s negotiator' : 'Client’s negotiator'
  if (item.status === 'thinking') {
    const waited = Math.max(0, now ? Date.now() - item.startedAt : 0)
    return (
      <li className={`turn turn-${item.side} is-thinking`} aria-hidden="true">
        <span className="turn-who">{who} · {company}</span>
        <div className="skeleton" />
        <div className="skeleton short" />
        <span className="fine">Thinking… {seconds(waited)}s</span>
        {item.calls.length > 0 ? <div aria-hidden="false"><ToolTrail calls={item.calls} title="What this negotiator is doing" live /></div> : null}
      </li>
    )
  }
  if (item.status === 'failed') {
    return (
      <li className={`turn turn-${item.side}`}>
        <span className="turn-who">{who} · {company}</span>
        <p className="turn-why">No valid move (<code>{item.error}</code>){item.detail ? `: ${item.detail}` : '.'} Nothing was agreed. The negotiation stays open.</p>
      </li>
    )
  }
  const accepted = item.action === 'accept'
  return (
    <li className={`turn turn-${item.side} is-in${accepted ? ' is-agreed' : ''}`} data-testid="turn">
      <span className="turn-who">{who} · {company} · move {item.turn} · {seconds(item.ms)}s</span>
      <div className="row between gap-s wrap">
        {item.totalCents !== null ? <Money cents={item.totalCents} currency={currency} size="lg" /> : <strong>No deal</strong>}
        <Chip tone={accepted ? 'auto' : item.action === 'walk_away' ? 'deny' : 'muted'}>{item.action === 'offer' && item.final ? 'Final offer' : ACTION_WORD[item.action]}</Chip>
      </div>
      {item.message ? <p className="quote">“{item.message}”</p> : null}
      {item.assessment ? <p className="turn-why private-note"><b>Private note</b> (only its own company sees this): {item.assessment}</p> : null}
      {accepted ? <p className="turn-why">Accepted the other side’s exact offer. Both companies’ rules were checked again, and the server signed the deal.</p> : null}
      {item.calls.length > 0 ? <ToolTrail calls={item.calls} title="What this negotiator did" /> : null}
    </li>
  )
}
