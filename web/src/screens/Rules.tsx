import { useMutation } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Chip, Loading, PageHead, ProblemCard } from '../components/ui'
import { api } from '../lib/api'
import { when } from '../lib/format'
import { useAgentsOn, useIsOwner, useOnline, useVersions } from '../lib/hooks'
import { centsInput, dollars, parseCents } from '../lib/money'
import type { Party, RulesDraft, Warrant } from '../lib/types'
import { ruleSentences } from '../lib/words'
import { useQueryClient } from '@tanstack/react-query'

type Body = Omit<Warrant, 'id' | 'version' | 'createdAt'>
type Change = { field: string; before: string; after: string }
type Standing = NonNullable<Warrant['standing']>[number]

const automationWords = (a: Body['automation'] | undefined) => {
  const on = [a?.billSignedDeals ? (a.requireAcceptance ? 'bill signed-deal milestones once the client accepts the delivery' : 'bill signed-deal milestones on delivery') : null, a?.payOnSettle ? 'pay contractors when the client pays' : null, a?.remindUnpaidAfterDays ? `remind after ${a.remindUnpaidAfterDays} days (max ${a.maxReminders})` : null].filter(Boolean)
  return on.length > 0 ? on.join(', ') : 'off'
}

const nameOf = (b: Body, id: string) => [...b.payees, ...(b.clients ?? [])].find((party) => party.id === id)?.displayName ?? id

function body(warrant: Warrant): Body {
  const { id: _id, version: _version, createdAt: _createdAt, ...rest } = warrant
  return rest
}

const LABELS: Array<{ key: keyof Body; label: string; show: (body: Body) => string }> = [
  { key: 'autoSettleUnderCents', label: 'Automatic under', show: (b) => dollars(b.autoSettleUnderCents) },
  { key: 'monthlyCapCents', label: 'Monthly contractor cap', show: (b) => dollars(b.monthlyCapCents) },
  { key: 'perPaymentCeilingCents', label: 'Per-payment ceiling', show: (b) => dollars(b.perPaymentCeilingCents) },
  { key: 'contractorShareBps', label: 'Contractor share of client money', show: (b) => `${(b.contractorShareBps ?? 10000) / 100}%` },
  { key: 'fundingRequired', label: 'Payouts need client money', show: (b) => (b.fundingRequired ? 'yes' : 'no') },
  { key: 'evidenceRequired', label: 'Proof link required', show: (b) => (b.evidenceRequired ? 'yes' : 'no') },
  { key: 'currency', label: 'Currency', show: (b) => b.currency },
  { key: 'timezone', label: 'Month boundary', show: (b) => b.timezone },
  { key: 'categories', label: 'Allowed work', show: (b) => b.categories.join(', ') },
  { key: 'payees', label: 'Who can be paid', show: (b) => b.payees.map((p) => `${p.displayName} (${p.id}) · ${p.email}`).join(', ') },
  { key: 'standing', label: 'Standing rules (no tap)', show: (b) => (b.standing ?? []).map((r) => `${nameOf(b, r.payeeId)} from ${r.clientIds.map((id) => nameOf(b, id)).join(' or ')}${r.requireDeal ? ', signed deal only' : ''}${r.shareBps ? `, ${r.shareBps / 100}% share` : ''}`).join('; ') || 'none' },
  { key: 'automation', label: 'Autopilot', show: (b) => automationWords(b.automation) },
  { key: 'clients', label: 'Who can be billed', show: (b) => (b.clients ?? []).map((p) => `${p.displayName} (${p.id}) · ${p.email}`).join(', ') || 'nobody' },
]

export function diff(before: Body | null, after: Body): Change[] {
  if (!before) return LABELS.map((item) => ({ field: item.label, before: '—', after: item.show(after) }))
  return LABELS.filter((item) => item.show(before) !== item.show(after)).map((item) => ({ field: item.label, before: item.show(before), after: item.show(after) }))
}

export function Rules() {
  const versions = useVersions()
  const owner = useIsOwner()
  const list = versions.data?.data ?? []
  const [selected, setSelected] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [seed, setSeed] = useState<RulesDraft | null>(null)
  useEffect(() => {
    if (selected === null && list[0]) setSelected(list[0].version)
  }, [list, selected])
  if (versions.isLoading) return <div className="page"><Loading /></div>
  const current = list[0]
  const shown = list.find((item) => item.version === selected) ?? current
  const previous = shown ? list.find((item) => item.version === shown.version - 1) ?? null : null
  if (!current || !shown) return <div className="page"><ProblemCard error={versions.error} /></div>

  return (
    <div className="page">
      <PageHead eyebrow={`Rules · version ${current.version} is live`} title="The rules">
        {owner && !editing ? <button type="button" className="btn btn-ink" data-tour="rules-write" onClick={() => { setSeed(null); setEditing(true) }}>Write version {current.version + 1}</button> : null}
      </PageHead>

      {owner && !editing ? <DraftBox onUse={(result) => { setSeed(result); setEditing(true) }} /> : null}
      {editing ? <Editor key={seed?.runId ?? 'blank'} current={current} seed={seed} onDone={(version) => { setEditing(false); setSeed(null); if (version) setSelected(version) }} /> : null}

      <div className="rules-grid">
        <section className="panel" data-tour="rules-words">
          <div className="row between"><h2 className="panel-title">Version {shown.version} in plain words</h2>{shown.version === current.version ? <Chip tone="auto">live</Chip> : <Chip tone="muted">past</Chip>}</div>
          <ol className="rule-list">{ruleSentences(shown).map((line) => <li key={line}>{line}</li>)}</ol>
          <p className="fine">A request is always judged against the version live when it was asked. Publishing a new version never rewrites an open request.</p>
        </section>

        <aside className="stack-l">
          <section className="panel" data-tour="rules-history">
            <h2 className="panel-title">History</h2>
            <ol className="versions">
              {list.map((item) => (
                <li key={item.version}>
                  <button type="button" className={item.version === shown.version ? 'on' : ''} onClick={() => setSelected(item.version)}>
                    <span className="mono">v{item.version}</span>
                    <span>{when(item.createdAt)}</span>
                    <span className="muted small">{(() => {
                      const before = list.find((v) => v.version === item.version - 1)
                      if (!before) return 'first'
                      const count = diff(body(before), body(item)).length
                      return `${count} change${count === 1 ? '' : 's'}`
                    })()}</span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
          <section className="panel" data-tour="rules-diff">
            <h2 className="panel-title">{previous ? `What changed from v${previous.version}` : 'Starting rules'}</h2>
            <Changes changes={diff(previous ? body(previous) : null, body(shown))} first={!previous} />
          </section>
        </aside>
      </div>
    </div>
  )
}

function Changes({ changes, first = false }: { changes: Change[]; first?: boolean }) {
  if (changes.length === 0) return <p className="muted">No differences.</p>
  return (
    <table className={`diff${first ? ' first' : ''}`}>
      <tbody>
        {changes.map((change) => (
          <tr key={change.field}>
            <th scope="row">{change.field}</th>
            <td className="was">{change.before}</td>
            <td className="now">{change.after}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Editor({ current, seed, onDone }: { current: Warrant; seed: RulesDraft | null; onDone: (version: number | null) => void }) {
  const client = useQueryClient()
  const online = useOnline()
  const start = useMemo(() => body(current), [current])
  const from: Body = seed?.draft ?? start
  const [auto, setAuto] = useState(centsInput(from.autoSettleUnderCents))
  const [cap, setCap] = useState(centsInput(from.monthlyCapCents))
  const [ceiling, setCeiling] = useState(centsInput(from.perPaymentCeilingCents))
  const [share, setShare] = useState(String((from.contractorShareBps ?? 10000) / 100))
  const [funding, setFunding] = useState(Boolean(from.fundingRequired))
  const [evidence, setEvidence] = useState(from.evidenceRequired)
  const [categories, setCategories] = useState(from.categories.join(', '))
  const [payees, setPayees] = useState<Party[]>(from.payees)
  const [clients, setClients] = useState<Party[]>(from.clients ?? [])
  const [standing, setStanding] = useState<Standing[]>(from.standing ?? [])
  const [billSigned, setBillSigned] = useState(from.automation?.billSignedDeals ?? false)
  const [needAccept, setNeedAccept] = useState(from.automation?.requireAcceptance ?? false)
  const [paySettle, setPaySettle] = useState(from.automation?.payOnSettle ?? false)
  const [remindDays, setRemindDays] = useState(from.automation?.remindUnpaidAfterDays ? String(from.automation.remindUnpaidAfterDays) : '')
  const [maxReminders, setMaxReminders] = useState(String(from.automation?.maxReminders ?? 2))
  const [review, setReview] = useState(false)

  const draft: Body | null = (() => {
    const a = parseCents(auto)
    const c = parseCents(cap)
    const ce = parseCents(ceiling)
    const sh = Number(share)
    if (a === null || c === null || ce === null || !Number.isFinite(sh)) return null
    return {
      ...start,
      autoSettleUnderCents: a,
      monthlyCapCents: c,
      perPaymentCeilingCents: ce,
      contractorShareBps: Math.round(sh * 100),
      fundingRequired: funding,
      evidenceRequired: evidence,
      categories: categories.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean),
      payees,
      clients,
      standing: funding ? standing : [],
      automation: {
        billSignedDeals: billSigned,
        requireAcceptance: billSigned && needAccept,
        payOnSettle: paySettle,
        remindUnpaidAfterDays: remindDays.trim() === '' ? null : Math.max(1, Math.min(60, Math.round(Number(remindDays)) || 1)),
        maxReminders: Math.max(0, Math.min(5, Math.round(Number(maxReminders)) || 0)),
      },
    }
  })()
  const problem = draft && draft.automation?.payOnSettle && draft.standing.length === 0 ? 'Paying when the client pays needs at least one standing rule, to say whom to pay.' : null
  const changes = draft ? diff(start, draft) : []
  const publish = useMutation({
    mutationFn: (next: Body) => api.publishWarrant(next),
    onSuccess: async (saved) => {
      await Promise.all([client.invalidateQueries({ queryKey: ['versions'] }), client.invalidateQueries({ queryKey: ['warrant'] })])
      onDone(saved.version)
    },
  })

  return (
    <section className="panel panel-lime editor">
      <div className="row between"><h2 className="panel-title">Write version {current.version + 1}</h2><button type="button" className="link" onClick={() => onDone(null)}>Cancel</button></div>
      {seed ? <DraftNote result={seed} /> : null}
      {!review ? (
        <div className="stack">
          <div className="field-row three">
            <label className="field"><span>Automatic under</span><span className="dollar-input"><span>$</span><input inputMode="decimal" value={auto} onChange={(e) => setAuto(e.target.value)} /></span></label>
            <label className="field"><span>Monthly contractor cap</span><span className="dollar-input"><span>$</span><input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} /></span></label>
            <label className="field"><span>Per-payment ceiling</span><span className="dollar-input"><span>$</span><input inputMode="decimal" value={ceiling} onChange={(e) => setCeiling(e.target.value)} /></span></label>
          </div>
          <div className="field-row three">
            <label className="field"><span>Contractor share of client money</span><span className="dollar-input"><input inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} /><span>%</span></span></label>
            <label className="check"><input type="checkbox" checked={funding} onChange={(e) => setFunding(e.target.checked)} /> Payouts need client money first</label>
            <label className="check"><input type="checkbox" checked={evidence} onChange={(e) => setEvidence(e.target.checked)} /> Proof link required</label>
          </div>
          <label className="field"><span>Allowed work, comma separated</span><input value={categories} onChange={(e) => setCategories(e.target.value)} /></label>
          <Parties title="Who can be paid" prefix="payee_" list={payees} onChange={setPayees} />
          <Parties title="Who can be billed" prefix="client_" list={clients} onChange={setClients} />
          <StandingRules list={standing} payees={payees} clients={clients} enabled={funding} onChange={setStanding} />
          <fieldset className="parties autopilot" data-tour="rules-autopilot">
            <legend>Autopilot · what runs without you</legend>
            <p className="fine">Each switch only removes a tap or sends a nudge. None of them lets a payment be bigger, go to someone new, or skip proof, the cap, or the dispute check.</p>
            <label className="check"><input type="checkbox" checked={billSigned} onChange={(e) => setBillSigned(e.target.checked)} /> Bill a milestone of a signed deal, and send the invoice, as soon as proof of the work is attached</label>
            <label className="check sub"><input type="checkbox" checked={needAccept} disabled={!billSigned} onChange={(e) => setNeedAccept(e.target.checked)} /> …but only after the client’s own agent has accepted the delivery (recommended: it makes the proof link something the client has looked at)</label>
            <label className="check"><input type="checkbox" checked={paySettle} onChange={(e) => setPaySettle(e.target.checked)} /> When a client payment settles, pay each contractor whose standing rule covers it</label>
            <div className="field-row three">
              <label className="field"><span>Remind unpaid invoices after (days)</span><input inputMode="numeric" value={remindDays} placeholder="off" onChange={(e) => setRemindDays(e.target.value)} /></label>
              <label className="field"><span>At most this many reminders</span><input inputMode="numeric" value={maxReminders} onChange={(e) => setMaxReminders(e.target.value)} /></label>
            </div>
            {problem ? <p className="fine" role="alert"><strong>{problem}</strong></p> : null}
          </fieldset>
          <div className="row between wrap gap-s">
            <span className="muted">{draft ? `${changes.length} change${changes.length === 1 ? '' : 's'}` : 'Some amounts are not valid money'}</span>
            <button type="button" className="btn btn-ink" disabled={!draft || changes.length === 0 || Boolean(problem)} onClick={() => setReview(true)}>Review changes</button>
          </div>
        </div>
      ) : (
        <div className="stack">
          <p>Version {current.version} → {current.version + 1}. Open requests stay judged by version {current.version}.</p>
          <Changes changes={changes} />
          <div className="row gap-s wrap">
            <button type="button" className="btn btn-ghost" onClick={() => setReview(false)}>Back</button>
            <button type="button" className="btn btn-lime btn-big" disabled={!draft || !online || publish.isPending} onClick={() => draft && publish.mutate(draft)}>
              {publish.isPending ? 'Publishing…' : `Publish version ${current.version + 1}`}
            </button>
          </div>
          <ProblemCard error={publish.error} />
        </div>
      )}
    </section>
  )
}

/** The owner says yes once to a kind of payout. A payout that matches needs no tap; every other rule still applies. */
function StandingRules({ list, payees, clients, enabled, onChange }: { list: Standing[]; payees: Party[]; clients: Party[]; enabled: boolean; onChange: (next: Standing[]) => void }) {
  const update = (index: number, patch: Partial<Standing>) => onChange(list.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  const add = () => onChange([...list, { id: `standing_${list.length + 1}`, payeeId: payees[0]?.id ?? '', clientIds: clients[0] ? [clients[0].id] : [], requireDeal: true }])
  return (
    <fieldset className="parties standing" data-tour="rules-standing">
      <legend>Standing rules · say yes once</legend>
      <p className="fine">A payout that matches a standing rule is sent without asking you. It must still be funded by settled client money, stay inside the contractor share and the monthly cap, have proof, and pass the dispute check. Anything that does not match waits for your tap, as before.</p>
      {!enabled ? <p className="fine"><strong>Switch on “Payouts need client money first” to use standing rules.</strong></p> : null}
      {list.map((rule, index) => (
        <div key={index} className="standing-row">
          <label className="field"><span>Pay</span>
            <select value={rule.payeeId} onChange={(e) => update(index, { payeeId: e.target.value })}>
              {payees.map((party) => <option key={party.id} value={party.id}>{party.displayName || party.id}</option>)}
            </select>
          </label>
          <div className="field"><span>From settled payments by</span>
            <div className="chips-row">
              {clients.map((client) => (
                <label key={client.id} className="check">
                  <input type="checkbox" checked={rule.clientIds.includes(client.id)} onChange={(e) => update(index, { clientIds: e.target.checked ? [...rule.clientIds, client.id] : rule.clientIds.filter((id) => id !== client.id) })} /> {client.displayName || client.id}
                </label>
              ))}
            </div>
          </div>
          <label className="check"><input type="checkbox" checked={rule.requireDeal} onChange={(e) => update(index, { requireDeal: e.target.checked })} /> Only money that came through a signed deal</label>
          <label className="field share-field"><span>This person’s share of each payment (%), blank for the whole contractor share</span><input inputMode="decimal" value={rule.shareBps ? String(rule.shareBps / 100) : ''} placeholder="all" onChange={(e) => { const n = Number(e.target.value); update(index, { shareBps: e.target.value.trim() === '' || !Number.isFinite(n) || n <= 0 ? undefined : Math.min(100, Math.round(n * 100)) }) }} /></label>
          <button type="button" className="link" onClick={() => onChange(list.filter((_, i) => i !== index))} aria-label="Remove standing rule">Remove</button>
        </div>
      ))}
      <button type="button" className="link" disabled={!enabled || payees.length === 0 || clients.length === 0} onClick={add}>+ Add a standing rule</button>
    </fieldset>
  )
}

function Parties({ title, prefix, list, onChange }: { title: string; prefix: string; list: Party[]; onChange: (next: Party[]) => void }) {
  const update = (index: number, patch: Partial<Party>) => onChange(list.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  return (
    <fieldset className="parties">
      <legend>{title}</legend>
      {list.map((party, index) => (
        <div key={index} className="party-row">
          <input aria-label="Name" value={party.displayName} onChange={(e) => update(index, { displayName: e.target.value })} placeholder="Name" />
          <input aria-label="Id" className="mono" value={party.id} onChange={(e) => update(index, { id: e.target.value })} placeholder={`${prefix}name`} />
          <input aria-label="Email" type="email" value={party.email} onChange={(e) => update(index, { email: e.target.value })} placeholder="email" />
          <input aria-label="Also known as" value={(party.aliases ?? []).join(', ')} onChange={(e) => update(index, { aliases: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} placeholder="also known as" />
          <button type="button" className="link" onClick={() => onChange(list.filter((_, i) => i !== index))} aria-label={`Remove ${party.displayName}`}>Remove</button>
        </div>
      ))}
      <button type="button" className="link" onClick={() => onChange([...list, { id: prefix, displayName: '', email: '', aliases: [] }])}>+ Add</button>
    </fieldset>
  )
}

/** Describe a change in your own words. A model drafts it; you read the before-and-after and publish it yourself. */
function DraftBox({ onUse }: { onUse: (result: RulesDraft) => void }) {
  const agents = useAgentsOn()
  const online = useOnline()
  const [text, setText] = useState('')
  const make = useMutation({ mutationFn: (instruction: string) => api.draftRules(instruction) })
  if (!agents) return null
  const result = make.data
  return (
    <section className="panel draft-box" data-tour="rules-draft" aria-labelledby="h-draft">
      <h2 className="panel-title" id="h-draft">Say it in your own words</h2>
      <form className="draft-form" onSubmit={(event) => { event.preventDefault(); if (text.trim().length >= 3) make.mutate(text.trim()) }}>
        <label className="sr-only" htmlFor="draft-text">Describe the change you want to the rules</label>
        <textarea id="draft-text" rows={2} maxLength={1000} value={text} placeholder="e.g. let Priya be paid automatically from Northwind as soon as the client pays" onChange={(event) => setText(event.target.value)} />
        <button type="submit" className="btn btn-ink" disabled={!online || text.trim().length < 3 || make.isPending}>{make.isPending ? 'Drafting…' : 'Draft it'}</button>
      </form>
      <p className="fine">A model drafts the change. It cannot publish: you read exactly what differs, and what it would let happen without you, and then you publish.</p>
      <ProblemCard error={make.error} />
      {result ? (
        <div className="draft-result" role="status">
          <DraftNote result={result} />
          {result.changed ? <button type="button" className="btn btn-lime" onClick={() => onUse(result)}>Review this draft</button> : null}
        </div>
      ) : null}
    </section>
  )
}

/** What a draft would change, said by code. The model's own summary is shown second, because only the code can be trusted to be complete. */
function DraftNote({ result }: { result: RulesDraft }) {
  return (
    <div className="draft-note">
      <span className="eyebrow">Drafted by {result.model} · {(result.ms / 1000).toFixed(1)}s · nothing is published</span>
      {!result.changed ? <p>That request did not change any rule.</p> : null}
      {result.loosens.length > 0 ? (
        <div className="draft-loosens">
          <strong>This lets more happen without you:</strong>
          <ul>{result.loosens.map((line) => <li key={line}>{line}</li>)}</ul>
        </div>
      ) : null}
      {result.tightens.length > 0 ? (
        <div className="draft-tightens">
          <strong>This narrows what can happen:</strong>
          <ul>{result.tightens.map((line) => <li key={line}>{line}</li>)}</ul>
        </div>
      ) : null}
      {result.notes.length > 0 ? <ul className="draft-notes">{result.notes.map((line) => <li key={line}>{line}</li>)}</ul> : null}
      <p className="fine">The model’s summary: “{result.summary}”</p>
    </div>
  )
}
