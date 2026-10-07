import { Chip, Money } from './ui'
import { ToolTrail } from './ToolTrail'
import { dollars } from '../lib/money'
import type { LiveTurn, Negotiation, Seat } from '../lib/useNegotiation'
import { DEAL_RULE } from '../lib/words'

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

function seatState(turns: LiveTurn[], side: Seat, running: boolean): { label: string; detail: string; active: boolean; tone: 'need' | 'auto' | 'deny' | 'muted' } {
  const mine = turns.filter((item) => item.side === side)
  const last = mine[mine.length - 1]
  const current = turns[turns.length - 1]
  if (current && current.side === side && current.status === 'thinking' && running) return { label: 'Thinking', detail: 'Reading the offers so far and its own limits', active: true, tone: 'need' }
  if (last?.status === 'offered') {
    const agreed = last.deal.status === 'agreed'
    return { label: agreed ? 'Agreed' : 'Refused', detail: `Offered ${dollars(last.deal.terms.totalCents)}`, active: false, tone: agreed ? 'auto' : 'deny' }
  }
  if (last?.status === 'failed') return { label: 'Stopped', detail: last.error, active: false, tone: 'deny' }
  return { label: running ? 'Waiting' : 'Idle', detail: running ? 'Not its turn yet' : '', active: false, tone: 'muted' }
}

/**
 * The price line. The client's ceiling and the studio's floor are drawn as a band, and each offer lands on it as a
 * pin: studio offers above the line, client offers below. A refusal is a dark pin on the wrong side of a limit;
 * the agreed price is a lime pin inside the overlap.
 */
function PriceTrack({ turns, buyerMax, sellerMin }: { turns: LiveTurn[]; buyerMax?: number; sellerMin?: number }) {
  const offers = turns.flatMap((item) => (item.status === 'offered' ? [{ turn: item.turn, side: item.side, cents: item.deal.terms.totalCents, agreed: item.deal.status === 'agreed' }] : []))
  const top = Math.max(buyerMax ?? 0, sellerMin ?? 0, ...offers.map((offer) => offer.cents), 1) * 1.18
  const at = (cents: number) => `${Math.min(97, Math.max(3, (cents / top) * 100))}%`
  const zone = buyerMax !== undefined && sellerMin !== undefined && sellerMin <= buyerMax
  return (
    <div className="track" role="img" aria-label={offers.length === 0 ? 'No offers yet' : `Offers so far: ${offers.map((offer) => dollars(offer.cents)).join(', ')}`}>
      <div className="track-line">
        {zone ? <i className="track-zone" style={{ left: at(sellerMin!), width: `calc(${at(buyerMax!)} - ${at(sellerMin!)})` }}><span>deal zone</span></i> : null}
        {offers.map((offer) => (
          <b key={offer.turn} className={`pin pin-${offer.side}${offer.agreed ? ' pin-agreed' : ''}`} style={{ left: at(offer.cents) }}>
            <span>{dollars(offer.cents)}</span>
          </b>
        ))}
      </div>
      <div className="track-legend"><span>Studio offers above the line</span><span>Client offers below</span></div>
    </div>
  )
}

export function NegotiationStage({ state, buyerMax, sellerMin, onStop, onReset, onJump }: {
  state: Negotiation
  buyerMax?: number
  sellerMin?: number
  onStop: () => void
  onReset: () => void
  onJump: () => void
}) {
  const running = state.phase === 'running'
  const offered = state.turns.filter((item) => item.status === 'offered')
  const last = state.turns[state.turns.length - 1]
  const studio = seatState(state.turns, 'seller', running)
  const client = seatState(state.turns, 'buyer', running)
  const agreed = state.phase === 'done' && state.agreedDealId
  const liveSummary = last?.status === 'thinking'
    ? `${last.side === 'seller' ? state.studio : state.client}'s agent is thinking.`
    : last?.status === 'offered'
      ? `${last.side === 'seller' ? state.studio : state.client}'s agent offered ${dollars(last.deal.terms.totalCents)}. ${last.deal.status === 'agreed' ? 'Agreed.' : 'Refused.'}`
      : ''

  return (
    <section className={`panel stage${running ? ' is-running' : ''}`} data-tour="deal-story" aria-label="Live negotiation">
      <span className="sr-only" role="status" aria-live="polite">{liveSummary}</span>

      <header className="stage-head">
        <div className="row gap-s">
          {running ? <span className="pulse-dot" aria-hidden="true" /> : null}
          <h2 className="panel-title">{running ? 'Live negotiation' : 'The negotiation, turn by turn'}</h2>
        </div>
        <div className="row gap-s wrap">
          <span className="mono small muted" aria-hidden="true">{clock(state.elapsedMs)}</span>
          {running ? <button type="button" className="btn btn-ghost btn-small" onClick={onStop}>Stop</button> : null}
          {state.phase === 'done' ? <Chip tone={agreed ? 'auto' : 'deny'}>{agreed ? 'agreed' : 'no deal'}</Chip> : null}
          {state.phase === 'stopped' ? <Chip tone="muted">stopped</Chip> : null}
          {state.phase === 'failed' ? <Chip tone="deny">stopped by an error</Chip> : null}
          {!running ? <button type="button" className="link" onClick={onReset}>Clear</button> : null}
        </div>
      </header>

      <div className="seats">
        {([['seller', state.studio, studio, 'paper'], ['buyer', state.client, client, 'stone']] as const).map(([side, company, seat, tone]) => (
          <div key={side} className={`seat seat-${side}${seat.active ? ' is-active' : ''}`}>
            <Robot thinking={seat.active} tone={tone} />
            <div className="seat-text">
              <span className="eyebrow">{side === 'seller' ? 'Studio agent' : 'Client agent'}</span>
              <strong>{company}</strong>
              <span className="seat-state"><Chip tone={seat.tone}>{seat.label}{seat.active ? <span className="think-dots" aria-hidden="true"><i /><i /><i /></span> : null}</Chip></span>
              <span className="fine">{seat.detail}</span>
            </div>
          </div>
        ))}
      </div>

      <PriceTrack turns={state.turns} buyerMax={buyerMax} sellerMin={sellerMin} />

      <ol className="turns">
        {state.turns.map((item) => <TurnCard key={item.turn} item={item} company={item.side === 'seller' ? state.studio : state.client} now={state.elapsedMs} />)}
      </ol>

      {running && state.turns.length === 0 ? (
        <p className="stage-wait" role="status"><span className="pulse-dot" aria-hidden="true" /> Starting. The studio’s agent opens the bidding.</p>
      ) : null}

      {state.phase === 'done' ? (
        <footer className={`stage-foot${agreed ? ' is-agreed' : ''}`}>
          {agreed ? (
            <>
              <p><strong>Agreed in {offered.length} offer{offered.length === 1 ? '' : 's'} and {seconds(state.elapsedMs)}s.</strong> The server signed the deal. It is listed below, ready to bill.</p>
              <button type="button" className="btn btn-ink" onClick={onJump}>Go to the signed deal ↓</button>
            </>
          ) : (
            <p><strong>No deal after {offered.length} offers.</strong> The agents ran out of turns without finding terms that fit both companies’ rules. Nothing was agreed and nothing moved.</p>
          )}
        </footer>
      ) : null}
      {state.phase === 'stopped' ? <footer className="stage-foot"><p><strong>Stopped.</strong> Offers made so far are kept in the list below. Nothing was agreed unless it says Agreed.</p></footer> : null}
      <p className="fine">{state.model ? <>Model <span className="mono">{state.model}</span>. </> : null}The agents choose the offers. The rules decide every verdict. Only you see both companies’ limits.</p>
    </section>
  )
}

function TurnCard({ item, company, now }: { item: LiveTurn; company: string; now: number }) {
  if (item.status === 'thinking') {
    const waited = Math.max(0, now ? Date.now() - item.startedAt : 0)
    return (
      <li className={`turn turn-${item.side} is-thinking`} aria-hidden="true">
        <span className="turn-who">{item.side === 'seller' ? 'Studio agent' : 'Client agent'} · {company}</span>
        <div className="skeleton" />
        <div className="skeleton short" />
        <span className="fine">Thinking… {seconds(waited)}s</span>
        {item.calls.length > 0 ? <div aria-hidden="false"><ToolTrail calls={item.calls} title="What this agent is doing" live /></div> : null}
      </li>
    )
  }
  if (item.status === 'failed') {
    return (
      <li className={`turn turn-${item.side}`}>
        <span className="turn-who">{item.side === 'seller' ? 'Studio agent' : 'Client agent'} · {company}</span>
        <p className="turn-why">The agent did not make a usable offer (<code>{item.error}</code>). The negotiation stopped.</p>
      </li>
    )
  }
  const { deal } = item
  const agreed = deal.status === 'agreed'
  return (
    <li className={`turn turn-${item.side} is-in${agreed ? ' is-agreed' : ''}`}>
      <span className="turn-who">{item.side === 'seller' ? 'Studio agent' : 'Client agent'} · {company} · offer {item.turn} · {seconds(item.ms)}s</span>
      <div className="row between gap-s wrap"><Money cents={deal.terms.totalCents} size="lg" /><Chip tone={agreed ? 'auto' : 'deny'}>{agreed ? 'Agreed' : 'Refused'}</Chip></div>
      {deal.prompt ? <p className="quote">“{deal.prompt}”</p> : null}
      {deal.verdict.violations.map((violation) => (
        <p key={violation.code} className="turn-why"><code>{violation.code}</code> <b>{DEAL_RULE[violation.code] ?? violation.code}.</b> <span className="muted">{violation.detail}</span> <em>{violation.hint}</em></p>
      ))}
      {agreed ? <p className="turn-why">Inside both companies’ rules. Signed by the server, listed below.</p> : null}
      {item.calls.length > 0 ? <ToolTrail calls={item.calls} title="What this agent did" /> : null}
    </li>
  )
}
