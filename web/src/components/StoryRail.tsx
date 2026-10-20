import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { useDeals, useIsOwner, useProposals, useWarrant } from '../lib/hooks'
import { fundedPhase } from '../lib/words'

const HIDDEN = 'mandate.story.hidden'
const PROVED = 'mandate.story.proved'

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    window.localStorage.setItem(key, on ? '1' : '0')
  } catch {
    /* storage unavailable: the choice lasts for this visit */
  }
}

/** The studio's own name, as its price sheet says it. The rules do not carry one. */
export function useStudioName(): string | null {
  const owner = useIsOwner()
  const sheets = useQuery({ queryKey: ['party-rules'], queryFn: api.partyRules, enabled: owner, staleTime: 60_000 })
  return sheets.data?.data.find((sheet) => sheet.role === 'seller')?.displayName || null
}

/** Who is who, in one line: the person at the keyboard is the studio, and everyone else is someone the studio deals with. */
export function useCast() {
  const warrant = useWarrant()
  const studio = useStudioName()
  return {
    studio: studio ?? 'your studio',
    client: warrant.data?.clients?.[0]?.displayName ?? 'your client',
    contractor: warrant.data?.payees?.[0]?.displayName ?? 'your contractor',
  }
}

type Step = { id: string; title: string; who: string; why: string; to: string; cta: string; done: boolean; onGo?: () => void }

/**
 * The first job, start to finish, as a story with one protagonist. Each step says who acts, why it matters and the one
 * thing to do, and is ticked from what the ledger already says, so it can never claim a step that did not happen.
 * It only reads: every button goes to the screen where the real control is.
 */
export function StoryRail() {
  const owner = useIsOwner()
  const proposals = useProposals()
  const deals = useDeals()
  const cast = useCast()
  const [hidden, setHidden] = useState(() => readFlag(HIDDEN))
  const [proved, setProved] = useState(() => readFlag(PROVED))
  if (!owner || hidden || !proposals.data || !deals.data) return null

  const rows = proposals.data.data
  const charges = rows.filter((row) => row.kind === 'charge')
  const payouts = rows.filter((row) => row.kind === 'payment')
  const agreed = deals.data.data.some((deal) => deal.status === 'agreed')
  const billed = charges.some((row) => !['pending_approval', 'denied', 'rejected'].includes(row.phase))
  const paidIn = charges.some((row) => fundedPhase(row.phase))
  const paidOut = payouts.find((row) => row.phase === 'captured')
  const waitingOnYou = rows.some((row) => row.phase === 'pending_approval')
  const job = charges.find((row) => row.jobId)?.jobId ?? null
  const jobPage = job ? `/jobs/${encodeURIComponent(job)}` : '/jobs'

  const steps: Step[] = [
    {
      id: 'agree', done: agreed || billed,
      title: `Agree a price with ${cast.client}`,
      who: `Your agent and ${cast.client}’s, each inside its own company’s limit`,
      why: `No money exists until both companies’ rules agree. You never see ${cast.client}’s limit, and they never see yours.`,
      to: '/deals', cta: 'Open the deal',
    },
    {
      id: 'bill', done: billed,
      title: 'Bill the first milestone',
      who: 'You, with one tap',
      why: 'When you tap, the amount is sealed and signed. Nobody can change it afterwards, not even you.',
      to: waitingOnYou ? '/' : agreed ? '/deals' : jobPage, cta: waitingOnYou ? 'It is waiting below' : 'Bill it',
    },
    {
      id: 'client', done: paidIn,
      title: `${cast.client} pays`,
      who: `${cast.client}, on their own link: a PayPal invoice, or a card on your page`,
      why: `${cast.client}’s money is what pays your team. Nothing goes out before it arrives.`,
      to: jobPage, cta: 'Send them their link',
    },
    {
      id: 'contractor', done: Boolean(paidOut),
      title: `${cast.contractor} gets their share`,
      who: 'Your standing rule, with no tap, or your tap',
      why: `Paid only from ${cast.client}’s money on this job, and only up to the share you set.`,
      to: waitingOnYou ? '/' : '/rules', cta: waitingOnYou ? 'It is waiting below' : 'See the rule',
    },
    {
      id: 'prove', done: proved && Boolean(paidOut),
      title: 'Check the receipt',
      who: 'Anyone, without trusting this server',
      why: 'Every cent has a signed record: who asked, which rule, who approved, which PayPal payment.',
      to: paidOut ? `/p/${paidOut.id}` : '/proof', cta: 'Open the receipt',
      onGo: () => { writeFlag(PROVED, true); setProved(true) },
    },
  ]
  const here = steps.findIndex((step) => !step.done)
  const hide = () => { writeFlag(HIDDEN, true); setHidden(true) }

  return (
    <section className="story-rail panel" aria-labelledby="h-story" data-testid="story-rail">
      <div className="row between wrap gap-s">
        <h2 className="panel-title" id="h-story">{here < 0 ? 'You ran a whole job' : 'Your first job, start to finish'}</h2>
        <button type="button" className="link small" onClick={hide}>Hide this guide</button>
      </div>
      <p className="story-cast" data-testid="story-cast">
        <span><b>You</b> are {cast.studio}</span>
        <span><b>{cast.client}</b> is your client</span>
        <span><b>{cast.contractor}</b> works for you</span>
        <span><b>AI agents</b> can ask, never pay</span>
      </p>
      {here < 0 ? (
        <p className="fine">Agreed, billed, paid in, paid out and proven, with every number sealed and every step on the receipt. From here, Today shows only what needs you.</p>
      ) : (
        <ol className="story-steps">
          {steps.map((step, index) => (
            <li key={step.id} className={step.done ? 'is-done' : index === here ? 'is-here' : 'is-todo'} aria-current={index === here ? 'step' : undefined}>
              <span className="story-mark" aria-hidden="true">{step.done ? '✓' : index + 1}</span>
              <div>
                <strong>{step.title}</strong>
                {index === here ? (
                  <div className="story-now">
                    <p><span className="eyebrow">Who</span> {step.who}</p>
                    <p><span className="eyebrow">Why</span> {step.why}</p>
                    <Link className="btn btn-ink btn-small" to={step.to} onClick={step.onGo}>{step.cta} →</Link>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
