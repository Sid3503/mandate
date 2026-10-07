import { AgStudio, AgStudioProvider, type AgStudioRef } from 'ag-studio-react'
import { AgStudioAiModule, type AgDataSourcesDefinition, type AgReportState, type AgStudioErrorRaisedEvent } from 'ag-studio'
import { useCallback, useMemo, useRef, useState } from 'react'
import { Chip, Loading, PageHead, ProblemCard } from '../components/ui'
import { useToast } from '../components/Toast'
import { mandateAi } from '../control-room/agents'
import { clearLayout, demoLayout, LEDGER_FIELDS, loadLayout, saveLayout, SOURCE } from '../control-room/layout'
import { toLedgerRows, type LedgerRow } from '../control-room/rows'
import { mandateTheme } from '../control-room/theme'
import { Link } from 'react-router-dom'
import { useAgentsOn, useAllProposals, useIsOwner, useNames, useNarrow, useVersions } from '../lib/hooks'

const LICENSE = import.meta.env.VITE_AG_STUDIO_LICENSE as string | undefined

/**
 * The control room: a second screen on the same ledger, built with AG Studio.
 *
 * The Ledger page is the table of requests. This is the dashboard the owner builds from them: money in and out, the
 * rules' refusals, who still owes what. Studio has no connection to PayPal or to Mandate. It is handed an array of
 * plain rows that this page fetched from the ledger endpoint, and it can only display them. Its chat agent runs on
 * Mandate's model through one route that holds no ledger service, and can only change the dashboard.
 */
export default function ControlRoom() {
  const owner = useIsOwner()
  const narrow = useNarrow()
  const agents = useAgentsOn()
  const names = useNames()
  const toast = useToast()
  const proposals = useAllProposals()
  // People's names come from the rules. Studio is first handed the finished rows, never a draft that changes a moment later:
  // new data in the middle of a widget's first load can leave the widget on "Loading".
  const versions = useVersions()
  const studio = useRef<AgStudioRef>(null)
  // Edit by default: the chat analyst lives in the edit chrome. View hides all of it, for presenting.
  const [mode, setMode] = useState<'edit' | 'view'>('edit')
  const [initial] = useState<AgReportState>(() => loadLayout() ?? demoLayout())
  const [custom, setCustom] = useState(() => loadLayout() !== null)

  const rows = useMemo(() => toLedgerRows(proposals.data ?? [], names), [proposals.data, names])
  // The analyst's totals tool reads the rows as they are now, not as they were when the harness was built.
  const latest = useRef<LedgerRow[]>([])
  latest.current = rows
  // Studio reloads its widgets whenever it is handed new data. The ledger is re-read every few seconds and after every
  // event, usually to the same answer, so new data is handed over only when the rows really changed.
  const signature = useMemo(() => JSON.stringify(rows), [rows])
  const held = useRef({ signature, rows })
  if (held.current.signature !== signature) held.current = { signature, rows }
  const data = useMemo<AgDataSourcesDefinition>(() => ({ sources: [{ id: SOURCE, name: 'Ledger', data: held.current.rows as never, fields: LEDGER_FIELDS }] }), [held.current.signature])
  const ai = useMemo(() => mandateAi(() => latest.current), [])

  const save = useCallback(() => {
    const state = studio.current?.api.getState()
    if (!state) return
    saveLayout(state)
    setCustom(true)
    toast({ title: 'Layout saved', body: 'This browser opens your dashboard next time.' })
  }, [toast])
  const reset = useCallback(() => {
    clearLayout()
    studio.current?.api.setState(demoLayout())
    setCustom(false)
    toast({ title: 'Back to the demo layout', body: 'Your saved layout was removed from this browser.', tone: 'info' })
  }, [toast])
  const copy = useCallback(async () => {
    const state = studio.current?.api.getState()
    if (!state) return
    await navigator.clipboard?.writeText(JSON.stringify(state, null, 2)).catch(() => undefined)
    toast({ title: 'Layout copied', body: 'Paste it into web/src/control-room/layout.ts to make it the default.', tone: 'info' })
  }, [toast])
  // Studio says when a saved layout does not fit the data (a field that is gone, a widget it cannot draw).
  const onError = useCallback((event: AgStudioErrorRaisedEvent) => {
    console.warn('Studio reported a problem with the dashboard:', event.errorType, event.errorDetails)
    toast({ title: event.fatal ? 'This dashboard could not be loaded' : 'Part of the dashboard needs attention', body: event.fatal ? 'Reset to the demo layout.' : event.errorDetails[0] ?? 'A widget could not be drawn.', tone: 'warn', key: 'studio-error' })
  }, [toast])
  const switchMode = useCallback((next: 'edit' | 'view') => {
    // Changing mode keeps what is on the canvas; Studio only changes what can be edited.
    studio.current?.api.setProperty('mode', next)
    setMode(next)
  }, [])

  if (!owner) return <div className="page"><PageHead eyebrow="Control room" title="Owner only" /><p className="muted">The control room shows the whole ledger, so it opens with the owner key.</p></div>
  // A dashboard needs room (Studio asks for 600 px). On a phone the Ledger is the right screen.
  if (narrow) return <div className="page"><PageHead eyebrow="A dashboard on the ledger · built with AG Studio" title="Control room" /><p className="muted" role="status">The control room is a desktop screen: a dashboard needs room to lay out. On a phone, the <Link to="/ledger">Ledger</Link> has the same requests, and <Link to="/">Today</Link> has what needs you.</p></div>
  if (proposals.isLoading || versions.isLoading) return <div className="page page-wide"><Loading label="Opening the control room" /></div>

  return (
    <div className="page page-wide control-room">
      <PageHead eyebrow="A dashboard on the ledger · built with AG Studio" title="Control room">
        <div className="segmented small" role="group" aria-label="Mode">
          <button type="button" aria-pressed={mode === 'view'} className={mode === 'view' ? 'on' : ''} onClick={() => switchMode('view')}>View</button>
          <button type="button" aria-pressed={mode === 'edit'} className={mode === 'edit' ? 'on' : ''} onClick={() => switchMode('edit')}>Edit</button>
        </div>
        <button type="button" className="btn btn-ink btn-small" onClick={save}>Save layout</button>
        <button type="button" className="btn btn-ghost btn-small" onClick={reset} disabled={!custom}>Reset to demo</button>
        <button type="button" className="btn btn-ghost btn-small" onClick={() => void copy()}>Copy layout</button>
      </PageHead>
      <ProblemCard error={proposals.error} />
      <p className="fine cr-note" data-tour="cr-note">
        <Chip tone="muted">no path to PayPal</Chip> Studio is handed {rows.length} plain rows copied from the ledger and can only display them. Money in and out count only what PayPal confirmed.
        {agents ? <> Ask the analyst in the chat panel, for example “show what the rules refused”. It can change this dashboard and nothing else.</> : <> Set <span className="mono">BEDROCK_API_KEY</span> to turn the dashboard agent on.</>}
        {LICENSE ? null : <> Running without a Studio licence key: fine for local work, with a watermark.</>}
      </p>
      <div className="cr-stage" data-tour="cr-stage" data-testid="control-room" style={{ height: 'max(760px, calc(100vh - 250px))' }}>
        <AgStudioProvider modules={agents ? [AgStudioAiModule] : []} licenseKey={LICENSE}>
          <AgStudio ref={studio as never} style={{ height: '100%', width: '100%' }} data={data} mode={mode} theme={mandateTheme} initialState={initial} ai={agents ? ai : undefined} onErrorRaised={onError} />
        </AgStudioProvider>
      </div>
    </div>
  )
}
