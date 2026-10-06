import { PayPalAgentToolkit, ALL_TOOLS_ENABLED } from '@paypal/agent-toolkit/ai-sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { createToolkit } from '../src/paypal/toolkit'
import { toolSummary, TOOL_TIERS, USED_BY_MANDATE } from '../src/paypal/tiers'
import { createMandateMcpServer } from '../src/mcp/server'
import { call, closeAll, harness, STUDIO_KEY } from './support'

afterEach(closeAll)

const everyToolkitTool = () => Object.keys(new PayPalAgentToolkit({ clientId: 'x', clientSecret: 'y', configuration: { actions: ALL_TOOLS_ENABLED, context: { sandbox: true } } }).getTools())

describe('PayPal tool tiers', () => {
  it('puts every tool in PayPal\'s toolkit in a tier, so a new tool cannot arrive unreviewed', () => {
    const real = everyToolkitTool().sort()
    const listed = Object.keys(TOOL_TIERS).sort()
    expect(real.filter((name) => !listed.includes(name)), 'toolkit tools with no tier').toEqual([])
    expect(listed.filter((name) => !real.includes(name)), 'tiers naming a tool the toolkit no longer has').toEqual([])
  })

  it('keeps anything that moves money or changes state out of the read tier, and never uses an out-of-scope tool', () => {
    for (const name of ['pay_order', 'create_order', 'create_refund', 'accept_dispute_claim', 'create_subscription', 'cancel_subscription', 'record_payment_for_invoice', 'send_invoice']) {
      expect(TOOL_TIERS[name]!.tier, name).toBe('propose')
    }
    for (const [name, policy] of Object.entries(TOOL_TIERS)) {
      if (policy.usedByMandate) expect(policy.tier, name).not.toBe('out_of_scope')
      if (/^(get|list|show|search)_/.test(name)) expect(policy.tier, name).not.toBe('propose')
    }
  })

  it('lets the server run only the tools written down as its own, even if the toolkit has every action switched on', async () => {
    const toolkit = createToolkit({ clientId: 'x', clientSecret: 'y', sandbox: true, actions: ALL_TOOLS_ENABLED as never })
    for (const name of ['pay_order', 'create_refund', 'accept_dispute_claim', 'record_payment_for_invoice', 'create_product']) {
      await expect(toolkit.run(name, {}), name).rejects.toMatchObject({ paypalName: 'toolkit_tool_not_allowed' })
    }
    expect(USED_BY_MANDATE.sort()).toEqual(['cancel_sent_invoice', 'create_invoice', 'get_dispute', 'get_invoice', 'list_disputes', 'list_invoices', 'list_transactions', 'send_invoice', 'send_invoice_reminder'])
  })

  it('exposes no PayPal tool on the agent door', async () => {
    const { services } = harness()
    const server = createMandateMcpServer({ services, principal: { role: 'proposer', side: 'studio' } as never, runId: 'r', budget: { asks: 1 } })
    const registered = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)
    expect(registered.length).toBe(6)
    expect(registered.filter((name) => name in TOOL_TIERS)).toEqual([])
  })

  it('tells the owner, and only the owner, what an agent can reach', async () => {
    const { app } = harness()
    const summary = (await call(app, 'GET', '/v1/paypal/tools')).json
    expect(summary).toMatchObject({ total: 47, agentCanCallDirectly: 0, usedByMandate: 9 })
    expect(summary.read + summary.propose + summary.outOfScope).toBe(47)
    expect((await call(app, 'GET', '/v1/paypal/tools', { key: STUDIO_KEY })).status).toBe(403)
    expect(toolSummary().tools.length).toBe(47)
  })
})
