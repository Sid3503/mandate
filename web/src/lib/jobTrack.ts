import type { Job } from './types'

export type StageState = 'done' | 'here' | 'todo'
export type Stage = { id: 'agreed' | 'billed' | 'client' | 'contractor'; label: string; detail: string; state: StageState }

/** What to do next on a job. `to` is a screen; `owner` says only the owner can act on it. */
export type NextStep = { text: string; to: string | null; cta: string | null; owner: boolean; waiting: boolean }

const PAYOUT_BUSY = ['payout_sent', 'payout_unclaimed', 'capture_inflight', 'locked', 'order_created']
/** A charge only counts as billed once the owner has said yes. One still waiting for the tap has not reached the client. */
const NOT_BILLED = ['pending_approval', 'denied', 'rejected']
const CLIENT_BUSY = ['order_created', 'capture_inflight', 'invoice_sent', 'invoice_draft']

/** Where a job stands, read only from what the server already says about it. Nothing here decides or moves money. */
export function jobStages(job: Job): Stage[] {
  const milestones = job.deal?.milestones ?? []
  const sent = job.charges.filter((charge) => !NOT_BILLED.includes(charge.phase))
  const billedCount = milestones.filter((item) => item.chargeId && !NOT_BILLED.includes(item.phase ?? '')).length
  const billed = sent.length > 0
  const paidCharges = job.charges.filter((charge) => charge.phase === 'captured')
  const paidOut = job.payouts.filter((payout) => payout.phase === 'captured')
  const stages: Stage[] = []
  if (job.deal) {
    stages.push({ id: 'agreed', label: 'Agreed', detail: job.deal.signatureValid ? 'Signed deal' : 'Signature does not verify', state: job.deal.signatureValid ? 'done' : 'here' })
  }
  stages.push({ id: 'billed', label: 'Billed', detail: milestones.length > 0 ? `${billedCount} of ${milestones.length} milestones` : billed ? `${sent.length} charge${sent.length === 1 ? '' : 's'}` : job.charges.length > 0 ? 'Waiting for your tap' : 'Not yet', state: billed && (milestones.length === 0 || billedCount === milestones.length) ? 'done' : 'todo' })
  stages.push({ id: 'client', label: 'Client paid', detail: paidCharges.length > 0 ? `${paidCharges.length} settled` : 'Not yet', state: paidCharges.length > 0 && paidCharges.length === sent.length ? 'done' : 'todo' })
  stages.push({ id: 'contractor', label: 'Contractor paid', detail: paidOut.length > 0 ? `${paidOut.length} paid` : 'Not yet', state: paidOut.length > 0 && job.totals.heldCents === 0 ? 'done' : 'todo' })
  // The first stage that is not done is where the job is. A stage that has begun but not finished is "here" too.
  const firstOpen = stages.findIndex((stage) => stage.state !== 'done')
  return stages.map((stage, index) => (index === firstOpen ? { ...stage, state: 'here' } : stage))
}

export function jobNext(job: Job, owner: boolean): NextStep {
  const milestones = job.deal?.milestones ?? []
  const unbilled = milestones.find((item) => !item.chargeId)
  const waitingForYou = job.charges.find((charge) => charge.phase === 'pending_approval') ?? job.payouts.find((payout) => payout.phase === 'pending_approval')
  if (waitingForYou) return { text: owner ? 'A request on this job is waiting for your tap.' : 'A request on this job is waiting for the owner.', to: owner ? '/' : null, cta: owner ? 'Open it on Today' : null, owner: true, waiting: !owner }
  const fundable = job.charges.find((charge) => charge.phase === 'captured' && charge.fundableCents > 0 && Boolean(charge.captureId))
  const billing = job.charges.find((charge) => CLIENT_BUSY.includes(charge.phase))
  const paying = job.payouts.find((payout) => PAYOUT_BUSY.includes(payout.phase))
  if (paying) return { text: 'PayPal is moving the contractor’s money. Nothing for you to do.', to: null, cta: null, owner: false, waiting: true }
  if (billing) return { text: 'Waiting for the client to pay. Mandate asks PayPal every few seconds and this page updates by itself.', to: null, cta: null, owner: false, waiting: true }
  const clearing = job.charges.find((charge) => charge.phase === 'captured' && charge.fundableCents > 0 && charge.clearing?.pending)
  if (clearing && fundable === clearing) {
    const until = clearing.clearing?.clearsAt ? new Date(clearing.clearing.clearsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null
    return { text: `The client’s payment is clearing${until ? ` until ${until}` : ''}. Your rule pays the contractor by itself after that. You can still pay sooner yourself.`, to: owner ? `/new?kind=payment&funding=${encodeURIComponent(clearing.captureId ?? '')}` : null, cta: owner ? 'Pay sooner' : null, owner: true, waiting: !owner }
  }
  if (fundable) return { text: `The client’s payment can still fund ${(fundable.fundableCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} for the contractor.`, to: owner ? `/new?kind=payment&funding=${encodeURIComponent(fundable.captureId ?? '')}` : null, cta: owner ? 'Pay the contractor' : null, owner: true, waiting: !owner }
  if (unbilled) return { text: `Next milestone: ${unbilled.title}.`, to: job.deal ? '/deals' : `/new?kind=charge&job=${encodeURIComponent(job.jobId)}`, cta: `Bill milestone ${unbilled.index + 1}`, owner: false, waiting: false }
  if (job.charges.length === 0) return { text: 'Nothing has been billed yet.', to: `/new?kind=charge&job=${encodeURIComponent(job.jobId)}`, cta: 'Bill the client', owner: false, waiting: false }
  return { text: 'Everything on this job is settled and paid.', to: null, cta: null, owner: false, waiting: false }
}
