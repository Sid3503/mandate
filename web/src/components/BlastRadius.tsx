import { useMutation, useQuery } from '@tanstack/react-query'
import { motion, useReducedMotion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { useIsOwner, useOnline } from '../lib/hooks'
import { dollars } from '../lib/money'
import type { Attack, AttackOutcome, AttackReport, BlastLever, BlastRadius as Blast } from '../lib/types'
import { Chip, ProblemCard, Spinner } from './ui'

/**
 * The number that answers "what is the worst that can happen?": the most money that can leave if every person, key and
 * AI agent that may ask is fooled, hostile or wrong. It is computed on the server from the signed rules and the ledger
 * by the same arithmetic the gate uses, and a randomised test plays a hostile proposer against the real gate to check
 * that it never moves more than this says.
 */
export function BlastTile() {
  const owner = useIsOwner()
  const online = useOnline()
  const blast = useQuery({ queryKey: ['blast'], queryFn: api.blastRadius, enabled: owner && online, staleTime: 10_000, refetchInterval: 30_000, retry: false })
  if (!owner || !blast.data) return null
  const radius = blast.data
  const sealed = radius.alone.totalCents === 0
  const send = Math.max(0, radius.queued.totalCents - radius.alone.totalCents)
  const scale = Math.max(radius.monthCapCents, radius.queued.totalCents, 1)
  const pct = (cents: number) => `${Math.min(100, (cents / scale) * 100)}%`
  return (
    <section className={`blast${sealed ? ' blast-sealed' : ''}`} data-tour="today-blast" data-testid="blast" aria-labelledby="h-blast">
      <div className="blast-head">
        <span className="eyebrow" id="h-blast">Blast radius · if everyone who can ask were fooled right now</span>
        <Link className="btn btn-ghost btn-small" to="/rules" state={{ attack: true }} data-testid="blast-attack">Attack my rules</Link>
      </div>
      <div className="blast-main">
        <div className="blast-num">
          <strong data-testid="blast-alone">{dollars(radius.alone.totalCents, radius.currency)}</strong>
          <span>{radius.paused ? 'can leave: Mandate is paused, so nothing runs' : sealed ? 'can leave without you. Nothing goes by itself.' : 'can leave with nobody pressing anything'}</span>
        </div>
        <dl className="blast-sub">
          <div><dt>A fooled AI agent</dt><dd>{dollars(radius.aloneAgent.totalCents, radius.currency)}</dd></div>
          <div><dt>If you also pressed Send on everything the rules locked</dt><dd>{dollars(radius.queued.totalCents, radius.currency)}</dd></div>
          <div><dt>Monthly cap left</dt><dd>{dollars(radius.capLeftCents, radius.currency)}<small> of {dollars(radius.monthCapCents, radius.currency)}</small></dd></div>
        </dl>
      </div>
      <div className="blast-bar" role="img" aria-label={`${dollars(radius.alone.totalCents, radius.currency)} goes alone, a further ${dollars(send, radius.currency)} waits for your Send, against a ${dollars(radius.monthCapCents, radius.currency)} monthly cap`}>
        <span className="blast-alone" style={{ width: pct(radius.alone.totalCents) }} />
        <span className="blast-send" style={{ width: pct(send) }} />
      </div>
      <p className="fine blast-key"><i className="k k-alone" /> goes with nobody pressing anything <i className="k k-send" /> locked by the rules, moves only when you press Send</p>
      <details className="blast-why">
        <summary>How this is worked out{radius.levers.length > 0 ? ` · ${radius.levers.length} way${radius.levers.length === 1 ? '' : 's'} to bring it down` : ''}</summary>
        <ul className="blast-lines">
          {radius.lines.map((line) => <li key={line.id}>{line.words}</li>)}
        </ul>
        {radius.levers.length > 0 ? <Levers levers={radius.levers} radius={radius} /> : null}
        <p className="fine">Computed from your signed rules and the ledger, by the same arithmetic the gate uses. Billing a client moves money in, so it is not counted. The risk engine can only add friction, so this is the same or worse than live.</p>
      </details>
    </section>
  )
}

function Levers({ levers, radius }: { levers: BlastLever[]; radius: Blast }) {
  return (
    <ul className="levers" aria-label="Ways to bring the number down">
      {levers.map((lever) => (
        <li key={lever.id}>
          <span>{lever.sentence} <b>{lever.id === 'agents-tap' ? `AI agents: ${dollars(radius.aloneAgent.totalCents, radius.currency)} → ${dollars(lever.toCents, radius.currency)}` : `${dollars(radius.alone.totalCents, radius.currency)} → ${dollars(lever.toCents, radius.currency)}`}</b></span>
          <Link className="btn btn-ghost btn-small" to="/rules" state={{ patch: lever.patch }}>Preview in Rules</Link>
        </li>
      ))}
    </ul>
  )
}

/**
 * A draft's blast radius beside the live one, as the owner writes it: the number moves while the amount is typed, so a
 * loosening is seen as money before it is signed. Nothing is stored or sent.
 */
export function BlastDelta({ rules, compact = false }: { rules: unknown; compact?: boolean }) {
  const online = useOnline()
  const text = JSON.stringify(rules)
  const [settled, setSettled] = useState(text)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(text), 350)
    return () => window.clearTimeout(timer)
  }, [text])
  const result = useQuery({ queryKey: ['blast', 'draft', settled], queryFn: () => api.blastFor(JSON.parse(settled)), enabled: online, staleTime: 10_000, retry: false })
  if (!result.data?.draft) return null
  const { live, draft } = result.data
  const move = draft.alone.totalCents - live.alone.totalCents
  const moveQueued = draft.queued.totalCents - live.queued.totalCents
  const tone = move > 0 ? 'deny' : move < 0 ? 'auto' : 'muted'
  return (
    <div className={`blast-delta blast-delta-${tone}${compact ? ' compact' : ''}`} role="status" data-testid="blast-delta">
      <Chip tone={tone}>{move > 0 ? 'Widens' : move < 0 ? 'Narrows' : 'Same reach'}</Chip>
      <span>
        Most that can leave with nobody pressing anything: <b>{dollars(live.alone.totalCents, live.currency)}</b> → <b>{dollars(draft.alone.totalCents, draft.currency)}</b>
        {moveQueued !== 0 || !compact ? <>. If you also pressed Send on everything the rules lock: <b>{dollars(live.queued.totalCents, live.currency)}</b> → <b>{dollars(draft.queued.totalCents, draft.currency)}</b></> : null}.
      </span>
    </div>
  )
}

const OUTCOME: Record<AttackOutcome, { label: string; tone: 'deny' | 'need' | 'ink' | 'muted' }> = {
  refused: { label: 'Refused', tone: 'ink' },
  tap: { label: 'Waits for your tap', tone: 'muted' },
  send: { label: 'Locked, waits for Send', tone: 'need' },
  alone: { label: 'Went through', tone: 'deny' },
}

const VERDICT: Record<AttackReport['verdict'], { title: string; words: (report: AttackReport) => string }> = {
  sealed: { title: 'Held', words: (report) => `Nothing a hostile proposer tried moved money without you: ${report.held} of ${report.total} tricks were refused or waited for your tap, and so did ${report.fuzz.tried - report.fuzz.waitForSend - report.fuzz.wentAlone} of ${report.fuzz.tried} random requests.` },
  send: { title: 'Held, with one door ajar', words: (report) => `Nothing went by itself, but money was locked without your approval and waits only for your Send: up to ${dollars(report.radius.queued.totalCents, report.currency)}. It moves only if you press Send.` },
  alone: { title: 'Money got through', words: (report) => `A hostile proposer could move up to ${dollars(report.radius.alone.totalCents, report.currency)} with nobody pressing anything. This is what your rules say, so decide whether it is what you meant.` },
}

/**
 * Plays a hostile proposer against the owner's real rules, on a copy of the ledger, and shows what was held and what
 * got through, with a fix found by running the same attack again under that change. Nothing is filed, written or sent
 * to PayPal. Pass `rules` to attack a draft before it is published.
 */
export function AttackPanel({ rules, auto = false, onFix }: { rules?: unknown; auto?: boolean; onFix?: (patch: BlastLever['patch']) => void }) {
  const owner = useIsOwner()
  const online = useOnline()
  const run = useMutation({ mutationFn: () => api.attackRules(rules) })
  useEffect(() => {
    if (auto && owner && online && !run.data && !run.isPending) run.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, owner, online])
  if (!owner) return null
  const report = run.data
  return (
    <section className="attack" data-testid="attack" aria-labelledby="h-attack">
      <div className="row between wrap gap-s">
        <div>
          <h2 className="panel-title" id="h-attack">{rules ? 'Attack this draft' : 'Attack my rules'}</h2>
          <p className="fine">A hostile proposer is played against the real gate on a copy of your ledger: strangers, lookalikes, split payouts, refund loops, a fooled AI agent, and a few hundred random requests. Nothing is filed and PayPal is never called.</p>
        </div>
        <button type="button" className="btn btn-ink" onClick={() => run.mutate()} disabled={!online || run.isPending} data-testid="attack-run">
          {run.isPending ? <><Spinner />Attacking…</> : report ? 'Attack again' : rules ? 'Attack the draft' : 'Attack my rules'}
        </button>
      </div>
      <ProblemCard error={run.error} />
      {report ? <AttackResult report={report} onFix={onFix} /> : null}
    </section>
  )
}

function AttackResult({ report, onFix }: { report: AttackReport; onFix?: (patch: BlastLever['patch']) => void }) {
  const reduce = useReducedMotion()
  const verdict = VERDICT[report.verdict]
  const rank: Record<AttackOutcome, number> = { alone: 0, send: 1, tap: 2, refused: 3 }
  const ordered = [...report.attacks].sort((a, b) => rank[a.outcome] - rank[b.outcome])
  return (
    <div className="attack-result" data-testid="attack-result">
      <div className={`verdict-banner verdict-${report.verdict}`} role="status">
        <strong>{verdict.title}</strong>
        <span>{verdict.words(report)}</span>
      </div>
      {report.hypothetical && report.imagined ? <p className="fine" data-testid="attack-hypothetical">No settled client payment has money left to fund a payout, so the tricks that need client money ran on an imagined {dollars(report.imagined.cents, report.currency)} payment from {report.imagined.clientName}. Nothing here was real money.</p> : null}
      <ul className="attacks">
        {ordered.map((attack, index) => (
          <motion.li
            key={attack.id}
            className={`attack-row attack-${attack.outcome}`}
            initial={reduce ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reduce ? 0 : Math.min(index * 0.04, 0.5), duration: 0.18 }}
            data-testid={`attack-${attack.id}`}
          >
            <AttackLine attack={attack} currency={report.currency} onFix={onFix} />
          </motion.li>
        ))}
      </ul>
      <p className="fine" data-testid="attack-fuzz">
        Then <b>{report.fuzz.tried}</b> random requests, in a random order: <b>{report.fuzz.refused}</b> refused, <b>{report.fuzz.needTap}</b> wanted your tap, <b>{report.fuzz.waitForSend}</b> locked and waited for Send, <b>{report.fuzz.wentAlone}</b> went through. The most they moved with nobody pressing anything was <b>{dollars(report.fuzz.alone.totalCents, report.currency)}</b>; your Blast Radius says <b>{dollars(report.radius.alone.totalCents, report.currency)}</b>, and the first can never be higher than the second.
      </p>
      <p className="fine">{report.caveat}</p>
    </div>
  )
}

function AttackLine({ attack, currency, onFix }: { attack: Attack; currency: string; onFix?: (patch: BlastLever['patch']) => void }) {
  const out = OUTCOME[attack.outcome]
  return (
    <>
      <div className="attack-top">
        <Chip tone={out.tone}>{out.label}</Chip>
        <strong>{attack.name}</strong>
        {attack.movedCents > 0 ? <span className="attack-moved">{dollars(attack.movedCents, currency)} {attack.outcome === 'alone' ? 'moved' : 'locked'}</span> : null}
        <code className="attack-clause">{attack.clause}</code>
        {attack.hypothetical ? <Chip tone="build">imagined payment</Chip> : null}
      </div>
      <p className="fine">{attack.tried}</p>
      <p className="attack-detail">{attack.detail}</p>
      {attack.fix ? (
        <div className="attack-fix">
          <span><b>A fix:</b> {attack.fix.sentence} It stops this: {attack.movedCents > 0 ? `${dollars(attack.movedCents, currency)} → ${dollars(attack.fix.toCents, currency)}` : 'it would no longer go through'}.</span>
          {onFix ? (
            <button type="button" className="btn btn-ghost btn-small" onClick={() => onFix(attack.fix!.patch)}>Apply to the draft</button>
          ) : (
            <Link className="btn btn-ghost btn-small" to="/rules" state={{ patch: attack.fix.patch }}>Preview in Rules</Link>
          )}
        </div>
      ) : null}
    </>
  )
}
