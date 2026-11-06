import { useState } from 'react'
import { parseCents, dollars } from '../lib/money'
import { addDaysIso, daysFromToday, when, type StageInput } from '../lib/projects'

/**
 * The plan as the studio edits it: each stage, what it delivers, its price and when it is due. Stages already under
 * way are shown but cannot be edited: their terms are what the client agreed to and paid against.
 */

export type EditableStage = StageInput & { key: string; locked?: boolean; lockedWhy?: string }

let seq = 0
export const newKey = () => `s${Date.now().toString(36)}${(seq += 1)}`

export function PlanEditor({ stages, currency, onChange, ceilingCents }: { stages: EditableStage[]; currency: string; onChange: (next: EditableStage[]) => void; ceilingCents?: number | null }) {
  const set = (key: string, patch: Partial<EditableStage>) => onChange(stages.map((stage) => (stage.key === key ? { ...stage, ...patch } : stage)))
  const remove = (key: string) => onChange(stages.filter((stage) => stage.key !== key))
  const move = (key: string, by: -1 | 1) => {
    const index = stages.findIndex((stage) => stage.key === key)
    const next = [...stages]
    const target = index + by
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    onChange(next)
  }
  const add = () => onChange([...stages, { key: newKey(), title: '', description: '', deliverables: [], amountCents: 0, dueDate: addDaysIso(Math.max(7, ...stages.map((stage) => daysFromToday(stage.dueDate) + 7))) }])
  return (
    <div className="plan-editor" data-testid="plan-editor">
      {stages.map((stage, index) => (
        <StageCard key={stage.key} stage={stage} index={index} count={stages.length} currency={currency} ceilingCents={ceilingCents ?? null}
          onSet={(patch) => set(stage.key, patch)} onRemove={() => remove(stage.key)} onMove={(by) => move(stage.key, by)} />
      ))}
      <button type="button" className="btn btn-ghost btn-block plan-add" onClick={add} data-testid="add-stage">＋ Add a stage</button>
    </div>
  )
}

function StageCard({ stage, index, count, currency, ceilingCents, onSet, onRemove, onMove }: { stage: EditableStage; index: number; count: number; currency: string; ceilingCents: number | null; onSet: (patch: Partial<EditableStage>) => void; onRemove: () => void; onMove: (by: -1 | 1) => void }) {
  const [draft, setDraft] = useState('')
  const [price, setPrice] = useState(stage.amountCents > 0 ? (stage.amountCents / 100).toString() : '')
  const days = daysFromToday(stage.dueDate)
  const addDeliverable = () => {
    const text = draft.trim()
    if (!text) return
    onSet({ deliverables: [...stage.deliverables, text.slice(0, 120)] })
    setDraft('')
  }
  const over = ceilingCents !== null && stage.amountCents > ceilingCents
  return (
    <section className={`stage-edit${stage.locked ? ' is-locked' : ''}`} data-testid="stage-edit" aria-label={`Stage ${index + 1}`}>
      <header className="row between gap-s">
        <span className="stage-num">{index + 1}</span>
        <input className="stage-title-input" aria-label="Stage name" value={stage.title} disabled={stage.locked} placeholder="What this stage is" onChange={(event) => onSet({ title: event.target.value })} />
        <div className="row gap-s">
          <button type="button" className="icon-btn" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
          <button type="button" className="icon-btn" aria-label="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>↓</button>
          {!stage.locked ? <button type="button" className="icon-btn" aria-label="Remove stage" disabled={count <= 1} onClick={onRemove}>✕</button> : null}
        </div>
      </header>
      {stage.locked ? <p className="fine">{stage.lockedWhy ?? 'Under way: its terms are fixed.'}</p> : null}
      <input className="stage-desc-input" aria-label="What it covers" value={stage.description} disabled={stage.locked} placeholder="One line on what this covers (optional)" onChange={(event) => onSet({ description: event.target.value })} />
      <div className="deliverables" aria-label="Deliverables">
        {stage.deliverables.map((item, at) => (
          <span key={`${item}-${at}`} className="deliverable-chip">
            {item}
            {!stage.locked ? <button type="button" aria-label={`Remove ${item}`} onClick={() => onSet({ deliverables: stage.deliverables.filter((_, i) => i !== at) })}>×</button> : null}
          </span>
        ))}
        {!stage.locked ? (
          <input className="deliverable-add" value={draft} placeholder="Add deliverable ↵" aria-label="Add a deliverable"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addDeliverable() } }}
            onBlur={addDeliverable} />
        ) : null}
      </div>
      <div className="stage-money">
        <label className="field">
          <span>Price</span>
          <div className="dollar-input">
            <span>{currency === 'USD' ? '$' : currency}</span>
            <input inputMode="decimal" value={price} disabled={stage.locked} aria-label="Price" data-testid="stage-price"
              onChange={(event) => { setPrice(event.target.value); const cents = parseCents(event.target.value); if (cents !== null) onSet({ amountCents: cents }) }} />
          </div>
          {over ? <small className="warn-text">Over your one-payment ceiling of {dollars(ceilingCents, currency)}. Split it, or raise the ceiling in Rules.</small> : null}
        </label>
        <label className="field">
          <span>Due in</span>
          <div className="dollar-input">
            <input type="number" min={1} max={365} value={Number.isFinite(days) ? days : 7} disabled={stage.locked} aria-label="Due in days"
              onChange={(event) => { const n = Math.max(1, Math.min(365, Number(event.target.value) || 1)); onSet({ dueDate: addDaysIso(n) }) }} />
            <span>days</span>
          </div>
          <small>{when(stage.dueDate)}</small>
        </label>
      </div>
    </section>
  )
}

export function totalOf(stages: Array<{ amountCents: number }>): number {
  return stages.reduce((sum, stage) => sum + (stage.amountCents || 0), 0)
}
