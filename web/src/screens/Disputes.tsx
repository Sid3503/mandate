import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ActivityTabs } from '../components/ActivityTabs'
import { Chip, Empty, Loading, Money, PageHead, ProblemCard, Spinner } from '../components/ui'
import { disputesApi, dueWords, type DisputeDetail, type DisputeListItem } from '../lib/disputes'
import { useSession } from '../lib/hooks'

/** The words under every part of this screen that touches PayPal: it cannot be tried on a live dispute. */
const NOT_LIVE = 'Built to PayPal’s documented request shape; not run on a live dispute. The PayPal sandbox cannot open one.'

function statusWords(status: string): string {
  return status.toLowerCase().replace(/_/g, ' ')
}

function DueChip({ item }: { item: Pick<DisputeListItem, 'dueInMs' | 'urgent' | 'response' | 'status'> }) {
  if (item.response === 'sent') return <Chip tone="auto">Response sent</Chip>
  if (item.status === 'RESOLVED') return <Chip tone="muted">Resolved</Chip>
  return <Chip tone={item.urgent ? 'deny' : 'muted'}>{dueWords(item.dueInMs)}</Chip>
}

export function Disputes() {
  const session = useSession()
  const { id } = useParams()
  const owner = session.data?.role === 'owner'
  if (session.data && !owner) return <div className="page"><PageHead eyebrow="Disputes" title="Owner only" /><p className="muted">Only the owner answers a dispute.</p></div>
  return id ? <DisputeDetailView id={id} /> : <DisputeList />
}

function DisputeList() {
  const navigate = useNavigate()
  const list = useQuery({ queryKey: ['disputes'], queryFn: disputesApi.list, refetchInterval: 60_000 })
  const rows = list.data?.data ?? []
  return (
    <div className="page">
      <ActivityTabs />
      <PageHead eyebrow="Disputes" title="Client disputes">
        <p className="muted">When a client disputes a payment with PayPal, Mandate answers with its signed records. A person approves every response.</p>
      </PageHead>
      <ProblemCard error={list.error} onRetry={() => void list.refetch()} />
      {list.isLoading ? <Loading label="Reading disputes" /> : null}
      {list.data && rows.length === 0 ? (
        <Empty title="No client disputes">
          Nothing has been disputed. When a client opens a dispute on a payment, it shows up here with the time left to answer. Mandate checks PayPal every minute; the System page can check now.
        </Empty>
      ) : null}
      {rows.length > 0 ? (
        <ul className="plain-list" aria-label="Disputes">
          {rows.map((row) => (
            <li key={row.id}>
              <button type="button" className="panel" style={{ width: '100%', textAlign: 'left', cursor: 'pointer' }} onClick={() => navigate(`/disputes/${encodeURIComponent(row.id)}`)} aria-label={`Open dispute ${row.id}`}>
                <div className="row between">
                  <strong className="mono">{row.id}</strong>
                  <span className="row" style={{ gap: 8 }}>
                    <Chip tone={row.status === 'RESOLVED' ? 'muted' : 'need'}>{statusWords(row.status)}</Chip>
                    <DueChip item={row} />
                  </span>
                </div>
                <div className="row between">
                  <span className="muted">{row.reason ? statusWords(row.reason) : 'No reason given'}{row.inRecords ? '' : ' · not a payment in Mandate'}</span>
                  <Money cents={row.amountCents} currency={row.currency ?? undefined} />
                </div>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="fine muted">{NOT_LIVE}</p>
    </div>
  )
}

function Checklist({ detail }: { detail: DisputeDetail }) {
  const packet = detail.packet
  return (
    <section className="panel" aria-label="Evidence packet">
      <div className="row between">
        <h2 className="panel-title">Evidence from the signed records</h2>
        <Chip tone={packet.strength.present === packet.strength.total ? 'auto' : 'need'}>{packet.strength.present} of {packet.strength.total}</Chip>
      </div>
      <ul className="plain-list" data-testid="evidence-checklist">
        {packet.checklist.map((item) => (
          <li key={item.id} data-present={item.present ? 'yes' : 'no'}>
            <strong><span aria-hidden="true">{item.present ? '✓' : '✗'}</span> <span className="sr-only">{item.present ? 'Present: ' : 'Missing: '}</span>{item.label}</strong>
            <div className="fine muted">{item.detail}</div>
          </li>
        ))}
      </ul>
      <div className="row" style={{ gap: 16 }}>
        {packet.proposalId ? <Link to={`/p/${packet.proposalId}`}>Open the receipt</Link> : null}
        {packet.links.verify && packet.proposalId ? <Link to={`/verify?proposal=${packet.proposalId}`}>Verify the lock yourself</Link> : null}
      </div>
    </section>
  )
}

function DisputeDetailView({ id }: { id: string }) {
  const client = useQueryClient()
  const detail = useQuery({ queryKey: ['dispute', id], queryFn: () => disputesApi.get(id) })
  const [text, setText] = useState('')
  const [touched, setTouched] = useState(false)
  const data = detail.data
  // Show the latest saved draft until the owner types; after that, their words stay put.
  useEffect(() => {
    if (data?.draft && !touched) setText(data.draft.text)
  }, [data?.draft?.text, touched, data?.draft])
  const refresh = () => { void client.invalidateQueries({ queryKey: ['dispute', id] }); void client.invalidateQueries({ queryKey: ['disputes'] }) }
  const draft = useMutation({ mutationFn: () => disputesApi.draft(id), onSuccess: (row) => { setTouched(false); setText(row.text); refresh() } })
  const save = useMutation({ mutationFn: () => disputesApi.save(id, text), onSuccess: refresh })
  const send = useMutation({ mutationFn: async () => { await disputesApi.save(id, text); return disputesApi.send(id, text) }, onSuccess: refresh })

  if (detail.isLoading) return <div className="page"><Loading label="Reading the dispute" /></div>
  if (!data) return <div className="page"><ProblemCard error={detail.error} onRetry={() => void detail.refetch()} /><Link to="/disputes">Back to disputes</Link></div>
  const d = data.dispute
  const sent = data.sent
  return (
    <div className="page">
      <PageHead eyebrow="Dispute" title={<span className="mono">{d.id}</span>}>
        <p className="row" style={{ gap: 8 }}>
          <Chip tone={d.status === 'RESOLVED' ? 'muted' : 'need'}>{statusWords(d.status)}</Chip>
          <DueChip item={{ dueInMs: d.dueInMs, urgent: d.urgent, response: sent ? 'sent' : 'none', status: d.status }} />
        </p>
      </PageHead>
      <Link to="/disputes">All disputes</Link>

      <section className="panel" aria-label="The dispute">
        <h2 className="panel-title">What the client says</h2>
        <div className="row between"><span>Reason</span><strong>{d.reason ? statusWords(d.reason) : 'not stated'}</strong></div>
        <div className="row between"><span>Amount disputed</span><Money cents={d.amountCents} currency={d.currency ?? undefined} /></div>
        <div className="row between"><span>PayPal capture</span><span className="mono">{d.transactionId}</span></div>
        <div className="row between"><span>Stage</span><span>{d.stage ? statusWords(d.stage) : 'not read from PayPal'}</span></div>
        {d.messages.map((m, index) => <p key={index} className="fine"><strong>{m.postedBy.toLowerCase()}:</strong> {m.content}</p>)}
        {!data.live.read ? <p className="fine" role="status">{data.live.error} Showing what Mandate last stored.</p> : null}
      </section>

      <Checklist detail={data} />

      <p className="panel panel-ink" role="note" data-testid="approval-banner"><strong>A person approves every dispute response. Nothing is sent until you do.</strong></p>

      {sent ? (
        <section className="panel" aria-label="What was sent" data-testid="sent-request">
          <h2 className="panel-title">Sent</h2>
          <p className="fine">Approved by {sent.approvedBy} ({sent.approvedVia}) and sent at {sent.at}. This is the exact request.</p>
          <pre className="mono small" style={{ whiteSpace: 'pre-wrap', overflowX: 'auto' }}>{`${sent.request.method} ${sent.request.path}\nPayPal-Request-Id: ${sent.request.requestId}\n\n${JSON.stringify(sent.request.body, null, 2)}`}</pre>
        </section>
      ) : (
        <section className="panel" aria-label="The response">
          <div className="row between">
            <h2 className="panel-title">The response</h2>
            {data.draft ? <Chip tone="muted">{data.draft.source === 'model' ? 'worded by the model, checked against the packet' : data.draft.source === 'template' ? 'written from the packet by code' : 'your words'}</Chip> : null}
          </div>
          <textarea aria-label="Response text" rows={12} maxLength={2000} value={text} onChange={(event) => { setTouched(true); setText(event.target.value) }} style={{ width: '100%', font: 'inherit' }} placeholder="Draft a response from the evidence, or write your own." />
          <div className="fine muted">{text.length} of 2000 characters. Only facts from the checklist above belong here; what is missing stays missing.</div>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn" disabled={draft.isPending} onClick={() => draft.mutate()}>{draft.isPending ? <Spinner /> : null}{data.draft ? 'Draft again' : 'Draft from the evidence'}</button>
            <button type="button" className="btn" disabled={!text.trim() || save.isPending} onClick={() => save.mutate()}>Save my edit</button>
            <button type="button" className="btn btn-ink" disabled={!text.trim() || send.isPending} onClick={() => send.mutate()}>{send.isPending ? <Spinner /> : null}Approve with passkey and send</button>
          </div>
          <ProblemCard error={draft.error ?? save.error ?? send.error} />
        </section>
      )}
      <p className="fine muted">{NOT_LIVE}</p>
    </div>
  )
}
