import { useMutation } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Chip, Loading, PageHead, ProblemCard } from '../components/ui'
import { api } from '../lib/api'
import { when } from '../lib/format'
import { useIsOwner, useOnline, useVersions } from '../lib/hooks'
import { centsInput, dollars, parseCents } from '../lib/money'
import type { Party, Warrant } from '../lib/types'
import { ruleSentences } from '../lib/words'
import { useQueryClient } from '@tanstack/react-query'

type Body = Omit<Warrant, 'id' | 'version' | 'createdAt'>
type Change = { field: string; before: string; after: string }

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
  { key: 'payees', label: 'Who can be paid', show: (b) => b.payees.map((p) => `${p.displayName} (${p.id})`).join(', ') },
  { key: 'clients', label: 'Who can be billed', show: (b) => (b.clients ?? []).map((p) => `${p.displayName} (${p.id})`).join(', ') || 'nobody' },
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
        {owner && !editing ? <button type="button" className="btn btn-ink" onClick={() => setEditing(true)}>Write version {current.version + 1}</button> : null}
      </PageHead>

      {editing ? <Editor current={current} onDone={(version) => { setEditing(false); if (version) setSelected(version) }} /> : null}

      <div className="rules-grid">
        <section className="panel">
          <div className="row between"><h2 className="panel-title">Version {shown.version} in plain words</h2>{shown.version === current.version ? <Chip tone="auto">live</Chip> : <Chip tone="muted">past</Chip>}</div>
          <ol className="rule-list">{ruleSentences(shown).map((line) => <li key={line}>{line}</li>)}</ol>
          <p className="fine">A request is always judged against the version live when it was asked. Publishing a new version never rewrites an open request.</p>
        </section>

        <aside className="stack-l">
          <section className="panel">
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
          <section className="panel">
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

function Editor({ current, onDone }: { current: Warrant; onDone: (version: number | null) => void }) {
  const client = useQueryClient()
  const online = useOnline()
  const start = useMemo(() => body(current), [current])
  const [auto, setAuto] = useState(centsInput(start.autoSettleUnderCents))
  const [cap, setCap] = useState(centsInput(start.monthlyCapCents))
  const [ceiling, setCeiling] = useState(centsInput(start.perPaymentCeilingCents))
  const [share, setShare] = useState(String((start.contractorShareBps ?? 10000) / 100))
  const [funding, setFunding] = useState(Boolean(start.fundingRequired))
  const [evidence, setEvidence] = useState(start.evidenceRequired)
  const [categories, setCategories] = useState(start.categories.join(', '))
  const [payees, setPayees] = useState<Party[]>(start.payees)
  const [clients, setClients] = useState<Party[]>(start.clients ?? [])
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
    }
  })()
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
          <div className="row between wrap gap-s">
            <span className="muted">{draft ? `${changes.length} change${changes.length === 1 ? '' : 's'}` : 'Some amounts are not valid money'}</span>
            <button type="button" className="btn btn-ink" disabled={!draft || changes.length === 0} onClick={() => setReview(true)}>Review changes</button>
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
