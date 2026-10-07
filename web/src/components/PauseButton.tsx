import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useIsOwner, useOnline } from '../lib/hooks'
import { useToast } from './Toast'
import { ProblemCard } from './ui'

/**
 * The emergency stop. One press pauses everything automatic and every agent. It says, before it is pressed, what it does
 * and what it cannot do (a payout PayPal has already accepted cannot be called back), so nobody has to guess in a hurry.
 */
export function PauseButton({ paused }: { paused: boolean }) {
  const owner = useIsOwner()
  const online = useOnline()
  const client = useQueryClient()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  const pause = useMutation({
    mutationFn: () => api.pause(reason.trim()),
    onSuccess: () => {
      setOpen(false)
      setReason('')
      toast({ title: 'Mandate is paused', body: 'Nothing automatic runs and agents are refused. Resume it from the banner.', tone: 'warn', key: 'safety', ms: 9000 })
      void Promise.all(['status', 'safety', 'today', 'proposals'].map((key) => client.invalidateQueries({ queryKey: [key] })))
    },
  })
  useEffect(() => {
    if (open) field.current?.focus()
  }, [open])
  if (!owner || paused) return null
  return (
    <div className="pause-wrap">
      <button type="button" className="btn btn-ghost btn-small pause-button" aria-expanded={open} onClick={() => setOpen(!open)}>Pause</button>
      {open ? (
        <div className="pause-panel" role="dialog" aria-label="Pause Mandate" onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false) }}>
          <strong>Pause everything automatic?</strong>
          <ul className="fine">
            <li>Autopilot stops: no bills, no payouts, no reminders.</li>
            <li>Every agent and staff key is refused, and the refusal is written down.</li>
            <li>Your own requests still work, but each one waits for your tap.</li>
            <li>A payout PayPal has already accepted cannot be called back.</li>
          </ul>
          <label className="field">
            <span>Why (optional)</span>
            <textarea ref={field} rows={2} maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. odd requests from an agent" />
          </label>
          <ProblemCard error={pause.error} />
          <div className="row gap-s">
            <button type="button" className="btn btn-ink btn-small pause-confirm" disabled={!online || pause.isPending} onClick={() => pause.mutate()}>{pause.isPending ? 'Pausing…' : 'Pause everything'}</button>
            <button type="button" className="btn btn-ghost btn-small" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
