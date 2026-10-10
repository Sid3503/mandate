import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { Mark } from '../components/Shell'
import { Chip, Loading, Money } from '../components/ui'
import { api, ApiError } from '../lib/api'
import { relative } from '../lib/format'
import type { ShareView } from '../lib/types'

type Payout = NonNullable<ShareView['contractor']>['payouts'][number]

const PAYOUT: Record<Payout['state'], { label: string; tone: 'deny' | 'auto' | 'need' | 'ink' | 'muted'; note: string }> = {
  asked: { label: 'Waiting for the owner', tone: 'need', note: 'The studio has asked to pay this. The owner has not approved it yet.' },
  approved: { label: 'Approved', tone: 'ink', note: 'Approved and about to be sent through PayPal.' },
  sending: { label: 'On its way', tone: 'need', note: 'PayPal is processing it. It is not counted as paid until PayPal says so.' },
  unclaimed: { label: 'Needs your PayPal account', tone: 'need', note: 'PayPal could not find an account for this email. Create or confirm one to receive it.' },
  paid: { label: 'Paid', tone: 'auto', note: 'PayPal confirmed it was paid.' },
  failed: { label: 'Did not go through', tone: 'deny', note: 'PayPal could not send it. The studio can try again.' },
}

/**
 * What one person is shown when the owner shares a job with them. No sign-in: the link is the proof. It is read-only
 * and shows only that person's own part of the job.
 */
export function SharedStatus() {
  const { token = '' } = useParams()
  const view = useQuery({ queryKey: ['share', token], queryFn: () => api.shareView(token), refetchInterval: 15_000, retry: false })
  useEffect(() => {
    // A link is a secret in the address bar, so tell search engines to look away.
    const meta = document.createElement('meta')
    meta.name = 'robots'
    meta.content = 'noindex, nofollow'
    document.head.appendChild(meta)
    return () => { meta.remove() }
  }, [])
  const gone = view.error instanceof ApiError && view.error.status === 404
  return (
    <div className="share-page">
      <header className="share-head"><div className="brand"><Mark size={28} /><span>Mandate</span></div><span className="eyebrow">Status, read only</span></header>
      <main className="share-main" id="main">
        {view.isLoading ? <Loading label="Opening" /> : null}
        {gone ? (
          <section className="panel" role="alert" data-testid="share-gone">
            <h1>This link is not available</h1>
            <p>It may have expired or been withdrawn. Ask the person who sent it for a new one.</p>
          </section>
        ) : view.error ? (
          <section className="panel" role="alert"><h1>Could not load this page</h1><p>Nothing was changed. Try again in a moment.</p></section>
        ) : null}
        {view.data?.role === 'contractor' ? <Contractor data={view.data} /> : null}
        {view.data?.role === 'client' ? <Client data={view.data} /> : null}
        {view.data ? <p className="fine">Updated {relative(view.data.asOf)} · refreshes itself · this link expires {new Date(view.data.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}. You can only look; nothing here can move money.</p> : null}
      </main>
    </div>
  )
}

function Contractor({ data }: { data: ShareView }) {
  const c = data.contractor!
  const waiting = c.clientPayment.state === 'waiting'
  return (
    <section className="share-card" data-testid="share-contractor">
      <span className="eyebrow">For {data.who}</span>
      <h1>{data.with ? `Your payments on the ${data.with} job` : 'Your payments on this job'}</h1>
      <div className="share-step">
        <strong>{data.with ?? 'The client'}’s payment</strong>
        {waiting ? <Chip tone="need">Not paid yet</Chip> : c.clientPayment.state === 'clearing' ? <Chip tone="need">Received · clearing{c.clientPayment.clearsAt ? ` until ${new Date(c.clientPayment.clearsAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}</Chip> : <Chip tone="auto">Received</Chip>}
      </div>
      <p className="fine">{waiting ? 'Your share is paid from the client’s money, so it starts once they have paid.' : c.clientPayment.state === 'clearing' ? 'The money has arrived. A client can still take a payment back for a short while, so your share is held until it has cleared.' : 'The money has arrived, so your share can be paid.'}</p>
      <h2 className="section-title">Your payouts</h2>
      {c.payouts.length === 0 ? <p className="muted">Nothing has been asked for yet.</p> : (
        <ul className="share-list">
          {c.payouts.map((payout, index) => {
            const info = PAYOUT[payout.state]
            return (
              <li key={`${payout.at}-${index}`}>
                <div className="row between wrap gap-s"><strong>{payout.label}</strong><Money cents={payout.amountCents} size="lg" /></div>
                <div className="row gap-s wrap"><Chip tone={info.tone}>{info.label}</Chip><span className="fine">{info.note}</span></div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function Client({ data }: { data: ShareView }) {
  const invoices = data.client!.invoices
  return (
    <section className="share-card" data-testid="share-client">
      <span className="eyebrow">For {data.who}</span>
      <h1>Your invoices on this job</h1>
      {invoices.length === 0 ? <p className="muted">There is nothing to pay yet.</p> : (
        <ul className="share-list">
          {invoices.map((invoice, index) => (
            <li key={`${invoice.at}-${index}`}>
              <div className="row between wrap gap-s"><strong>{invoice.description}</strong><Money cents={invoice.amountCents} size="lg" /></div>
              <div className="row gap-s wrap">
                {invoice.state === 'paid' ? <Chip tone="auto">Paid</Chip> : <Chip tone="need">Due</Chip>}
                {invoice.state === 'due' && invoice.payUrl ? <a className="btn btn-lime btn-small" href={invoice.payUrl} target="_blank" rel="noreferrer noopener">Pay on PayPal ↗</a> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
