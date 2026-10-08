import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Chip, Loading, PageHead, ProblemCard } from '../components/ui'
import { api, ApiError, type DraftStage } from '../lib/api'
import { StageTrail, type StageView } from '../components/ToolTrail'
import { TryRules } from '../components/TryRules'
import { useToast } from '../components/Toast'
import { when } from '../lib/format'
import { useAgentsOn, useIsOwner, useOnline, useVersions } from '../lib/hooks'
import { centsInput, dollars, parseCents } from '../lib/money'
import type { Party, PolicyResult, PolicySentence, Replay, RulesDraft, SentenceStatus, Warrant } from '../lib/types'
import { wip, type RulesWip } from '../lib/wip'
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
  const location = useLocation()
  const versions = useVersions()
  const owner = useIsOwner()
  const list = versions.data?.data ?? []
  const [selected, setSelected] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [seed, setSeed] = useState<RulesDraft | null>(null)
  // Unpublished work survives leaving the screen and reloading (for this tab), and is set aside if the rules move on.
  const [resume, setResume] = useState<Body | null>(null)
  const [saved, setSaved] = useState<RulesWip | null>(() => wip.read())
  const [notice, setNotice] = useState<string | null>(null)
  const liveVersion = list[0]?.version
  const keep = (patch: Partial<RulesWip>) => setSaved((before) => {
    const next: RulesWip = { baseVersion: liveVersion ?? 0, instruction: '', result: null, body: null, at: Date.now(), ...before, ...patch }
    wip.write(next)
    return next.body || next.result || next.instruction.trim() ? next : null
  })
  const toast = useToast()
  const discard = () => { wip.clear(); setSaved(null); setResume(null); setSeed(null); toast({ title: 'Unpublished changes discarded', body: 'The live rules were not touched.', tone: 'info' }) }
  useEffect(() => {
    if (selected === null && list[0]) setSelected(list[0].version)
  }, [list, selected])
  useEffect(() => {
    if (saved && liveVersion !== undefined && saved.baseVersion !== liveVersion) {
      wip.clear()
      setSaved(null)
      setNotice(`The rules moved to version ${liveVersion} after you started that draft (it began from version ${saved.baseVersion}), so it was set aside rather than undo the newer change. Say it again to start from the live rules.`)
    }
  }, [saved, liveVersion])
  if (versions.isLoading) return <div className="page"><Loading /></div>
  const current = list[0]
  const shown = list.find((item) => item.version === selected) ?? current
  const previous = shown ? list.find((item) => item.version === shown.version - 1) ?? null : null
  if (!current || !shown) return <div className="page"><ProblemCard error={versions.error} /></div>

  return (
    <div className="page">
      <PageHead eyebrow={`Rules · version ${current.version} is live`} title="The rules">
        {owner && !editing ? <button type="button" className="btn btn-ink" data-tour="rules-write" onClick={() => { setSeed(null); setResume(null); keep({ body: null }); setEditing(true) }}>Write version {current.version + 1}</button> : null}
      </PageHead>

      {notice ? <div className="panel wip-note" role="status"><p className="fine">{notice}</p><button type="button" className="link" onClick={() => setNotice(null)}>Dismiss</button></div> : null}
      {owner && !editing && saved?.body ? (
        <div className="panel panel-lime wip-note" role="status" data-testid="wip-banner">
          <div>
            <strong>You have unpublished changes to the rules.</strong>
            <p className="fine">Started {when(new Date(saved.at).toISOString())} from version {saved.baseVersion}. Nothing is live until you publish.</p>
          </div>
          <div className="row gap-s wrap">
            <button type="button" className="btn btn-ink btn-small" onClick={() => { setSeed(null); setResume(saved.body); setEditing(true); toast({ title: 'Picked up where you left off', body: 'Still unpublished. Nothing is live until you publish.', tone: 'info', key: 'wip' }) }}>Continue editing</button>
            <button type="button" className="btn btn-ghost btn-small" onClick={discard}>Discard</button>
          </div>
        </div>
      ) : null}

      {owner && !editing ? (
        <DraftBox
          prefill={(location.state as { draft?: string } | null)?.draft}
          initialInstruction={saved?.instruction ?? ''}
          initialResult={saved?.result ?? null}
          onKeep={(instruction, result) => keep({ instruction, result })}
          onUse={(result) => { setSeed(result); setResume(null); setEditing(true) }}
        />
      ) : null}
      {owner && !editing ? <PolicyBox onUse={(result) => { setSeed(result); setResume(null); setEditing(true) }} /> : null}
      {editing ? (
        <Editor
          key={resume ? 'resume' : seed?.runId ?? 'blank'}
          current={current}
          seed={seed}
          resume={resume}
          onKeep={(next) => keep({ body: next })}
          onDone={(version) => {
            setEditing(false)
            setSeed(null)
            setResume(null)
            if (version) { wip.clear(); setSaved(null); setSelected(version) } else keep({ body: null })
          }}
        />
      ) : null}

      {owner && !editing ? <details className="try-details"><summary>Try a request, or check the rules with cases</summary><TryRules /></details> : null}

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

function Editor({ current, seed, resume, onKeep, onDone }: { current: Warrant; seed: RulesDraft | null; resume: Body | null; onKeep: (body: Body | null) => void; onDone: (version: number | null) => void }) {
  const client = useQueryClient()
  const toast = useToast()
  const online = useOnline()
  const start = useMemo(() => body(current), [current])
  const from: Body = resume ?? seed?.draft ?? start
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
  // Keep the work: leave the screen or reload and it is still here, marked unpublished.
  const snapshot = draft ? JSON.stringify(draft) : null
  useEffect(() => {
    onKeep(draft && changes.length > 0 ? draft : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot])
  const addStanding = () => {
    setFunding(true)
    setStanding((list) => [...list, { id: `standing_${list.length + 1}`, payeeId: payees[0]?.id ?? '', clientIds: clients[0] ? [clients[0].id] : [], requireDeal: true }])
  }
  const publish = useMutation({
    mutationFn: (next: Body) => api.publishWarrant(next, current.version),
    onSuccess: async (saved) => {
      await Promise.all([client.invalidateQueries({ queryKey: ['versions'] }), client.invalidateQueries({ queryKey: ['warrant'] })])
      toast({ title: 'Rules published', body: `Version ${saved.version} is signed and in force. Open requests keep the version they were decided against.` })
      onDone(saved.version)
    },
  })

  return (
    <section className="panel panel-lime editor">
      <div className="row between"><h2 className="panel-title">Write version {current.version + 1}</h2><button type="button" className="link" onClick={() => onDone(null)}>Cancel</button></div>
      {seed ? <DraftNote result={seed} replay={false} /> : null}
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
          </fieldset>
          {problem ? (
            <div className="editor-problem" role="alert">
              <strong>{problem}</strong>
              <span className="row gap-s wrap">
                <button type="button" className="btn btn-ink btn-small" onClick={addStanding}>Add the standing rule it needs</button>
                <button type="button" className="btn btn-ghost btn-small" onClick={() => setPaySettle(false)}>Or turn off “pay when the client pays”</button>
              </span>
            </div>
          ) : null}
          <div className="row between wrap gap-s">
            <span className="muted">{draft ? `${changes.length} change${changes.length === 1 ? '' : 's'}` : 'Some amounts are not valid money'}</span>
            <button type="button" className="btn btn-ink" disabled={!draft || changes.length === 0 || Boolean(problem)} onClick={() => setReview(true)}>Review changes</button>
          </div>
        </div>
      ) : (
        <div className="stack">
          <p>Version {current.version} → {current.version + 1}. Open requests stay judged by version {current.version}.</p>
          <Changes changes={changes} />
          {draft ? <ReplayPanel rules={draft} seed={seed?.replay ?? null} /> : null}
          {draft ? <TryRules rules={draft} /> : null}
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
function DraftBox({ onUse, onKeep, prefill, initialInstruction, initialResult }: { onUse: (result: RulesDraft) => void; onKeep: (instruction: string, result: RulesDraft | null) => void; prefill?: string; initialInstruction: string; initialResult: RulesDraft | null }) {
  const agents = useAgentsOn()
  const online = useOnline()
  const [text, setText] = useState(prefill ?? initialInstruction)
  const [restored] = useState(initialResult)
  const toast = useToast()
  // The steps the server really takes to make a draft, shown as they happen.
  const [stages, setStages] = useState<Array<DraftStage & { at: number }>>([])
  const make = useMutation({
    mutationFn: async (instruction: string) => {
      setStages([])
      let draft: RulesDraft | null = null
      let failure: ApiError | null = null
      await api.streamDraft(instruction, (event) => {
        if (event.type === 'stage') setStages((current) => [...current, { ...event, at: Date.now() }])
        else if (event.type === 'done') draft = event.draft
        else if (event.type === 'error') failure = new ApiError(422, event.code, event.title, event.message, {})
      })
      if (failure) throw failure
      if (!draft) throw new ApiError(502, 'stream.ended', 'The draft did not finish', 'The connection ended before the draft was complete. Nothing was changed.', {})
      return draft as RulesDraft
    },
    onSuccess: (data, instruction) => {
      onKeep(instruction, data)
      toast(data.added.length > 0
        ? { title: 'Draft ready, with a warning', body: 'The model added something you did not ask for. Read the red note before anything else.', tone: 'bad' }
        : { title: data.changed ? 'Draft ready' : 'Nothing to change', body: data.changed ? 'Read what it changes. Nothing is published.' : 'That request did not change any rule.', tone: data.changed ? 'good' : 'info' })
    },
    onError: () => toast({ title: 'The draft did not work', body: 'Nothing was changed. You can say it another way.', tone: 'bad' }),
  })
  const ran = useRef(false)
  useEffect(() => {
    if (prefill && agents && !ran.current) { ran.current = true; make.mutate(prefill) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, agents])
  if (!agents) return null
  const result = make.data ?? restored
  const blocked = Boolean(result && result.added.length > 0)
  return (
    <section className="panel draft-box" data-tour="rules-draft" aria-labelledby="h-draft">
      <h2 className="panel-title" id="h-draft">Say it in your own words</h2>
      <ol className="draft-steps" aria-label="How a change is made"><li>Say it</li><li>See it</li><li>Check it</li><li>Replay it</li><li>Sign it</li></ol>
      <form className="draft-form" onSubmit={(event) => { event.preventDefault(); if (text.trim().length >= 3) make.mutate(text.trim()) }}>
        <label className="sr-only" htmlFor="draft-text">Describe the change you want to the rules</label>
        <textarea id="draft-text" rows={2} maxLength={1000} value={text} placeholder="e.g. pay Priya 60% of what Northwind pays, never more than $180 a month, and only after the client accepts" onChange={(event) => { setText(event.target.value); onKeep(event.target.value, make.data ?? restored) }} />
        <button type="submit" className="btn btn-ink" disabled={!online || text.trim().length < 3 || make.isPending}>{make.isPending ? 'Drafting…' : 'Draft it'}</button>
      </form>
      <p className="fine">A model drafts the change. It cannot publish. Code, not the model, checks the draft against your words, lists what it loosens and replays your history under it. Then you publish.</p>
      {make.isPending ? <StageTrail title="Making the draft" stages={stageViews(stages)} /> : null}
      <ProblemCard error={make.error} />
      {result ? (
        <div className="draft-result" role="status">
          <DraftNote result={result} />
          {result.changed ? <button type="button" className={`btn ${blocked ? 'btn-ghost' : 'btn-lime'}`} onClick={() => onUse(result)}>{blocked ? 'Review this draft anyway' : 'Review this draft'}</button> : null}
        </div>
      ) : null}
    </section>
  )
}

const POLICY_STATUS: Record<SentenceStatus, { label: string; tone: 'deny' | 'auto' | 'need' | 'ink' | 'muted' }> = {
  covered: { label: 'Enforced', tone: 'auto' },
  partly: { label: 'Partly enforced', tone: 'need' },
  not_covered: { label: 'Not enforced', tone: 'need' },
  unenforceable: { label: 'A person’s call', tone: 'muted' },
  context: { label: 'Background', tone: 'muted' },
  untrusted: { label: 'Set aside', tone: 'deny' },
  skipped: { label: 'Not read yet', tone: 'muted' },
  unchecked: { label: 'Not checked', tone: 'need' },
}

const POLICY_LIMIT = 12_000

/**
 * Paste your written policy. Code sorts it into sentences, sets aside what is not yours or not a rule, a model drafts the
 * rest, and then code reads every sentence against the finished draft and says which are enforced and which are not.
 * The model never gives the verdict. Nothing is published.
 */
function PolicyBox({ onUse }: { onUse: (result: RulesDraft) => void }) {
  const agents = useAgentsOn()
  const online = useOnline()
  const toast = useToast()
  const [text, setText] = useState('')
  const [stages, setStages] = useState<Array<DraftStage & { at: number }>>([])
  const [showAll, setShowAll] = useState(false)
  const read = useMutation({
    mutationFn: async (policy: string) => {
      setStages([])
      let result: PolicyResult | null = null
      let failure: ApiError | null = null
      await api.streamPolicy(policy, (event) => {
        if (event.type === 'stage') setStages((current) => [...current, { ...event, at: Date.now() }])
        else if (event.type === 'done') result = event.policy
        else if (event.type === 'error') failure = new ApiError(422, event.code, event.title, event.message, {})
      })
      if (failure) throw failure
      if (!result) throw new ApiError(502, 'stream.ended', 'The reading did not finish', 'The connection ended before the policy was read. Nothing was changed.', {})
      return result as PolicyResult
    },
    onSuccess: (data) => toast({ title: 'Policy read', body: `${data.counts.covered + data.counts.partly} of ${data.sentences.length} sentences are enforced, wholly or in part. Nothing is published.`, tone: 'good' }),
    onError: () => toast({ title: 'The policy could not be read', body: 'Nothing was changed.', tone: 'bad' }),
  })
  if (!agents) return null
  const result = read.data
  const rows = result ? result.sentences.filter((item) => showAll || (item.status !== 'context')) : []
  const blocked = Boolean(result?.draft && result.draft.added.length > 0)
  return (
    <details className="panel policy-box" data-testid="policy-box">
      <summary className="panel-title">Paste your written policy</summary>
      <p className="fine">Paste a spending policy from a document or an email. A model reads it sentence by sentence and says which parts Mandate can enforce, which are a person’s judgment, and which are not your words. Another drafts rules for the rest, and a second reading checks that draft against each sentence. Code checks every claim against the rules. You read the draft and publish it yourself.</p>
      <form className="draft-form" onSubmit={(event) => { event.preventDefault(); if (text.trim().length >= 20) read.mutate(text.trim()) }}>
        <label className="sr-only" htmlFor="policy-text">Your written policy</label>
        <textarea id="policy-text" rows={8} maxLength={POLICY_LIMIT} value={text} placeholder={'Contractors may be paid at most $2,000 a month.\nEvery request needs a link to the work.\nUse good judgment on anything unusual.'} onChange={(event) => setText(event.target.value)} />
        <div className="row between wrap">
          <span className="fine">{text.length.toLocaleString()} of {POLICY_LIMIT.toLocaleString()} characters. Quoted or forwarded text is not treated as yours.</span>
          <button type="submit" className="btn btn-ink" disabled={!online || text.trim().length < 20 || read.isPending}>{read.isPending ? 'Reading…' : 'Read my policy'}</button>
        </div>
      </form>
      {read.isPending ? <StageTrail title="Reading the policy" stages={stageViews(stages)} /> : null}
      <ProblemCard error={read.error} />
      {result ? (
        <div className="policy-result" data-testid="policy-result">
          <p className="policy-counts" role="status">
            {(['covered', 'partly', 'not_covered', 'unchecked', 'unenforceable', 'untrusted', 'skipped'] as SentenceStatus[]).filter((key) => result.counts[key] > 0).map((key) => <Chip key={key} tone={POLICY_STATUS[key].tone}>{result.counts[key]} {POLICY_STATUS[key].label.toLowerCase()}</Chip>)}
          </p>
          <table className="diff policy-table">
            <thead><tr><th scope="col">Line</th><th scope="col">What your policy says</th><th scope="col">What Mandate does with it</th></tr></thead>
            <tbody>
              {rows.map((item) => <PolicyRow key={item.id} item={item} />)}
            </tbody>
          </table>
          {result.counts.context > 0 ? <button type="button" className="link" onClick={() => setShowAll((value) => !value)}>{showAll ? 'Hide' : 'Show'} {result.counts.context} background line{result.counts.context === 1 ? '' : 's'}</button> : null}
          {result.audit === 'failed' ? <p className="draft-added" role="alert"><strong>The check of this draft against your policy failed.</strong> Nothing below is confirmed. Read every change before you sign.</p> : null}
          {result.draft ? (
            <div className="draft-result">
              <DraftNote result={result.draft} />
              {result.draft.changed ? <button type="button" className={`btn ${blocked ? 'btn-ghost' : 'btn-lime'}`} onClick={() => onUse(result.draft!)}>{blocked ? 'Review this draft anyway' : 'Review this draft'}</button> : <p className="fine">Your policy already matches the rules. There is nothing to publish.</p>}
            </div>
          ) : <p className="fine">Nothing in this text could be a rule, so no model was asked and no draft was made.</p>}
        </div>
      ) : null}
    </details>
  )
}

function PolicyRow({ item }: { item: PolicySentence }) {
  const info = POLICY_STATUS[item.status]
  return (
    <tr className={`policy-${item.status}`} data-status={item.status}>
      <td className="mono">{item.line}</td>
      <th scope="row">{item.text}</th>
      <td>
        <Chip tone={info.tone}>{info.label}</Chip>{item.already && item.status === 'covered' ? <span className="fine"> · already in your rules</span> : null}
        {item.carriedBy.length > 0 ? <ul className="policy-by">{item.carriedBy.map((line) => <li key={line}>{line}</li>)}</ul> : null}
        {item.reasons.length > 0 ? <ul className="policy-why">{item.reasons.map((line) => <li key={line}>{line}</li>)}</ul> : null}
      </td>
    </tr>
  )
}

/** What a draft would change, said by code. The model's own summary comes last, because only the code can be trusted to be complete. */
function DraftNote({ result, replay = true }: { result: RulesDraft; replay?: boolean }) {
  return (
    <div className="draft-note">
      <span className="eyebrow">Drafted by {result.model} · {(result.ms / 1000).toFixed(1)}s · nothing is published</span>
      {!result.changed ? <p>That request did not change any rule.</p> : null}
      {result.added.length > 0 ? (
        <div className="draft-added" role="alert">
          <strong>Added by the model. You did not ask for this:</strong>
          <ul>{result.added.map((flag) => <li key={flag.phrase}><b>{flag.phrase}</b> <span>{flag.why}</span></li>)}</ul>
        </div>
      ) : null}
      {result.ignored.length > 0 ? (
        <div className="draft-ignored" role="status">
          <strong>Not in the rule. You said this and nothing carries it out:</strong>
          <ul>{result.ignored.map((flag) => <li key={flag.phrase}><b>“{flag.phrase}”</b> <span>{flag.why}</span></li>)}</ul>
        </div>
      ) : null}
      {result.untrusted.length > 0 ? (
        <div className="draft-untrusted" role="status">
          <strong>Set aside. This looks like someone else’s instruction, not yours:</strong>
          <ul>{result.untrusted.map((line) => <li key={line}>{line}</li>)}</ul>
        </div>
      ) : null}
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
      {result.readBack.length > 0 ? (
        <div className="draft-readback">
          <strong>Read back, in plain words{result.readBackBy === 'model' ? ' (written by the model, every number checked against the rules)' : ''}:</strong>
          <ul>{result.readBack.map((line) => <li key={line}>{line}</li>)}</ul>
        </div>
      ) : null}
      {replay ? <ReplayBody replay={result.replay} /> : null}
      <p className="fine">The model’s summary: “{result.summary}”</p>
    </div>
  )
}

/** Your own history, run again under the proposed rules. Works for a hand edit as well as a draft. */
function ReplayPanel({ rules, seed }: { rules: Body; seed: Replay | null }) {
  const replay = useQuery({ queryKey: ['replay', JSON.stringify(rules)], queryFn: () => api.replayRules(rules), initialData: seed ?? undefined, staleTime: 60_000 })
  return replay.data ? <ReplayBody replay={replay.data} /> : <p className="fine">{replay.isLoading ? 'Replaying your history…' : ''}</p>
}

function ReplayBody({ replay }: { replay: Replay }) {
  return (
    <div className="draft-replay" data-testid="replay">
      <strong>Replay on your history</strong>
      {replay.checked === 0 ? <p className="fine">There are no requests yet to replay.</p> : replay.changed.length === 0 ? <p>Of your last {replay.checked} request{replay.checked === 1 ? '' : 's'}, none would have gone differently.</p> : (
        <>
          <p>Of your last {replay.checked} request{replay.checked === 1 ? '' : 's'}, {replay.changed.length} would have gone differently{replay.nowNoTap > 0 ? `: ${replay.nowNoTap} would now go with no tap` : ''}{replay.nowRefused > 0 ? `${replay.nowNoTap > 0 ? ',' : ':'} ${replay.nowRefused} would now be refused` : ''}{replay.nowAllowed > 0 ? `, ${replay.nowAllowed} refused ${replay.nowAllowed === 1 ? 'one' : 'ones'} would now be allowed` : ''}.</p>
          <ul>{replay.changed.slice(0, 8).map((item) => <li key={item.proposalId}><b>{item.title}</b>: {item.before.words} → <b>{item.after.words}</b></li>)}</ul>
        </>
      )}
    </div>
  )
}

/** Turns the server's stages into the slip: everything before the latest is done, the latest is what it is doing now. */
function stageViews(stages: Array<DraftStage & { at: number }>): StageView[] {
  const label = (stage: DraftStage): { label: string; detail?: string } => {
    switch (stage.stage) {
      case 'reading': return { label: 'Read the live rules', detail: `${stage.people} people and ${stage.standing} standing rule${stage.standing === 1 ? '' : 's'}` }
      case 'drafting': return { label: stage.attempt === 1 ? 'Asked the model to draft it' : `Asked the model again (try ${stage.attempt})`, detail: stage.model }
      case 'patch': return { label: 'The model proposed a change', detail: `“${stage.summary}”` }
      case 'retry': return { label: 'The draft did not fit the rules, so it was sent back', detail: stage.reason }
      case 'checking': return { label: 'Code is checking the draft against your words', detail: 'What it loosens, what it leaves out, what it adds' }
      case 'replaying': return { label: 'Replaying your history under the new rules' }
      case 'reading_back': return { label: 'Writing the read-back in plain words' }
      case 'reading_policy': return { label: 'A model is reading your policy', detail: `${stage.sentences} sentence${stage.sentences === 1 ? '' : 's'}${stage.parts > 1 ? `, in ${stage.parts} parts` : ''}: rule, judgment, someone else’s words, or something Mandate cannot do` }
      case 'classified': return { label: 'Sorted', detail: `${stage.rules} could be rules and go to the drafter; ${stage.setAside} set aside` }
      case 'auditing': return { label: 'A second reading is checking the draft against each sentence', detail: `${stage.sentences} sentence${stage.sentences === 1 ? '' : 's'}, ${stage.changes} change${stage.changes === 1 ? '' : 's'}; every claim is checked against the rules` }
    }
  }
  return stages.map((stage, index) => ({ key: `${index}:${stage.stage}`, ...label(stage), state: stage.stage === 'retry' ? 'retry' : index === stages.length - 1 ? 'active' : 'done' }))
}
