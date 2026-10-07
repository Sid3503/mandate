import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Chip, Loading, PageHead, ProblemCard } from '../components/ui'
import { api } from '../lib/api'
import { when } from '../lib/format'
import { useIsOwner } from '../lib/hooks'
import type { AuditCheck } from '../lib/types'

/**
 * The proof. One button re-verifies the whole ledger from scratch, in the server, and lists what it looked at. If the
 * product's promise is "nothing moved without a signed lock and a yes", this is where you can watch it be checked.
 */
export function Proof() {
  const owner = useIsOwner()
  const [withPayPal, setWithPayPal] = useState(false)
  const audit = useQuery({ queryKey: ['audit', withPayPal], queryFn: () => api.audit(withPayPal), enabled: owner, staleTime: 0 })
  const report = audit.data
  const promises = useQuery({ queryKey: ['guarantees'], queryFn: api.guarantees, staleTime: 5 * 60_000 })

  return (
    <div className="page proof">
      <PageHead eyebrow="Checked by the server, from the ledger, on demand" title="Proof">
        <label className="check"><input type="checkbox" checked={withPayPal} onChange={(event) => setWithPayPal(event.target.checked)} /> Also compare with PayPal’s history</label>
        <button type="button" className="btn btn-ink" disabled={!owner || audit.isFetching} onClick={() => void audit.refetch()}>{audit.isFetching ? 'Checking…' : 'Check again'}</button>
      </PageHead>

      {!owner ? <p className="muted">Only the owner key can run the audit.</p> : null}
      {audit.isLoading ? <Loading label="Re-verifying the ledger" /> : null}
      <ProblemCard error={audit.error} />

      {report ? (
        <>
          <section className={`verdict ${report.ok ? 'ok' : 'bad'}`} data-tour="proof-verdict" role="status">
            <div>
              <span className="eyebrow">{report.ok ? 'Everything checks out' : 'Something does not check out'}</span>
              <h2>{report.ok ? `${report.checks.filter((c) => c.status === 'pass').length} of ${report.checks.filter((c) => c.status !== 'info').length} checks pass` : `${report.checks.filter((c) => c.status === 'fail').length} check${report.checks.filter((c) => c.status === 'fail').length === 1 ? '' : 's'} failed`}</h2>
              <p className="fine">Over {report.totals.requests} request{report.totals.requests === 1 ? '' : 's'} ({report.totals.moved} that moved money), {report.totals.locks} signed lock{report.totals.locks === 1 ? '' : 's'}, {report.totals.events} ledger events and {report.totals.deals} signed deal{report.totals.deals === 1 ? '' : 's'}. Run {when(report.ranAt)}.</p>
            </div>
            <Chip tone={report.ok ? 'auto' : 'deny'}>{report.ok ? 'verified' : 'failed'}</Chip>
          </section>

          <section className="section" data-tour="proof-checks" aria-labelledby="h-checks">
            <h2 className="section-title" id="h-checks">What was checked</h2>
            <ul className="checks-list">
              {report.checks.map((check) => <Check key={check.id} check={check} />)}
            </ul>
          </section>

          {promises.data ? (
            <section className="section" aria-labelledby="h-promises" data-testid="promises">
              <h2 className="section-title" id="h-promises">What Mandate promises, and where each promise is held up</h2>
              <p className="fine">Every promise below names the live check that re-verifies it on this ledger, the tests that guard it on every change, or both. {promises.data.everyChange.months} random months of {promises.data.everyChange.stepsPerMonth} requests are played against the rules on every change; the deepest run recorded played {promises.data.deepRun.months.toLocaleString('en-US')} months ({(promises.data.deepRun.months * promises.data.deepRun.stepsPerMonth).toLocaleString('en-US')} requests, bills, payments, approvals, refunds, rule changes and pauses) and found {promises.data.deepRun.violations} violations.</p>
              <ul className="checks-list">
                {promises.data.guarantees.map((item) => {
                  const live = item.audit ? report.checks.find((check) => check.id === item.audit) : undefined
                  return (
                    <li key={item.id} className="check-row">
                      <div className="check-head">
                        <strong>{item.promise}</strong>
                        {live ? <Chip tone={live.status === 'pass' ? 'auto' : live.status === 'fail' ? 'deny' : 'muted'}>{live.status === 'pass' ? 'Pass now' : live.status === 'fail' ? 'Fails now' : 'Info'}</Chip> : <Chip tone="muted">By test</Chip>}
                        {item.random ? <Chip tone="ink">Random months</Chip> : null}
                      </div>
                      <p className="fine">Tests: {item.tests.map((test) => test.replace('test/', '').replace('.test.ts', '')).join(', ')}.</p>
                    </li>
                  )
                })}
              </ul>
            </section>
          ) : null}

          <section className="panel" data-tour="proof-reach">
            <h2 className="panel-title">How Mandate uses PayPal’s Agent Toolkit</h2>
            <p className="payout-lead"><strong>PayPal’s Agent Toolkit has {report.agentReach.toolkitTools} tools. Mandate’s server uses {report.agentReach.serverUses}. The AI can call {report.agentReach.agentCanCallDirectly === 0 ? 'none' : report.agentReach.agentCanCallDirectly} of them to move money.</strong></p>
            <p className="fine">The server calls those {report.agentReach.serverUses} (invoices, reminders, transactions, disputes) from a locked, signed request or from what PayPal reports, never from text a model wrote, and refuses the rest. The AI’s own door has {report.agentReach.mcpTools} tools and none can approve, pay or change the rules. Every tool and why is on the <Link to="/system" className="link">System</Link> screen.</p>
          </section>

          <section className="panel">
            <h2 className="panel-title">Check it yourself</h2>
            <p className="fine">This page is the same report as <code>GET /v1/audit</code>. The locks are checked against the public keys at <a href="/.well-known/mandate-keys.json" target="_blank" rel="noreferrer">/.well-known/mandate-keys.json</a>, so an auditor does not have to trust this page. Each receipt also has its own <strong>Verify</strong> button.</p>
          </section>
        </>
      ) : null}
    </div>
  )
}

function Check({ check }: { check: AuditCheck }) {
  const tone = check.status === 'pass' ? 'auto' : check.status === 'fail' ? 'deny' : 'muted'
  const label = check.status === 'pass' ? 'Pass' : check.status === 'fail' ? 'Fail' : 'Info'
  return (
    <li className={`check-row ${check.status}`}>
      <div className="row between wrap gap-s">
        <strong>{check.title}</strong>
        <span className="row gap-s"><span className="muted small">{check.checked} checked</span><Chip tone={tone}>{label}</Chip></span>
      </div>
      <p className="fine">{check.why}</p>
      {check.note ? <p className="fine note">{check.note}</p> : null}
      {check.failures.length > 0 ? (
        <ul className="failures">
          {check.failures.map((failure, index) => (
            <li key={index}>{failure.proposalId ? <Link to={`/p/${failure.proposalId}`} className="mono">{failure.proposalId.slice(0, 8)}</Link> : null} {failure.detail}</li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}
