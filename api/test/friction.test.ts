import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { decide, Clause } from '../src/domain/gate'
import { LINE_STUDIO_WARRANT, WARRANT_ID } from '../src/domain/schemas'
import { createApp } from '../src/app'
import { migrate, openDatabase, seed } from '../src/db/database'
import { Repo } from '../src/db/repo'
import { machineKeyHash } from '../src/services/machine-key'

const NOW = new Date('2026-10-28T12:00:00Z')
const KEY = 'test-mandate-key-32chars'

const validBase = {
  kind: 'payment' as const,
  payeeId: 'payee_priya',
  currency: 'USD',
  category: 'design',
  evidenceUrl: 'https://example.com/proof.pdf',
  parent: null,
  jobId: 'job_northwind_logo',
  fundingCaptureId: 'CAP-NW-1',
  funding: {
    kind: 'charge',
    phase: 'captured',
    jobId: 'job_northwind_logo',
    currency: 'USD',
    capturedCents: 15000,
    refundHeldCents: 0,
    payoutHeldCents: 0,
  },
}

describe('Friction Budget & Invariant: AI may only add friction, never reduce it', () => {
  it('allows owner to get AUTO on eligible proposals', () => {
    const warrant = {
      ...LINE_STUDIO_WARRANT,
      fundingRequired: false,
      autoSettleUnderCents: 5000,
      frictionBudget: { modelFloor: 'needs_approval' as const },
    }
    const proposal: any = {
      ...validBase,
      amountCents: 1500, // < 5000
      actor: 'owner',
    }
    const decision = decide(warrant, proposal, { reservedCents: 0, priorCaptureIds: [] })
    expect(decision.gate).toBe('AUTO')
    expect(decision.clause).toBe(Clause.amountAuto)
  })

  it('clamps agent actor proposal from AUTO to NEEDS_APPROVAL when modelFloor is needs_approval', () => {
    const warrant = {
      ...LINE_STUDIO_WARRANT,
      fundingRequired: false,
      autoSettleUnderCents: 5000,
      frictionBudget: { modelFloor: 'needs_approval' as const },
    }
    const proposal: any = {
      ...validBase,
      amountCents: 1500, // normally AUTO
      actor: 'agent:clerk_v1',
    }
    const decision = decide(warrant, proposal, { reservedCents: 0, priorCaptureIds: [] })
    expect(decision.gate).toBe('NEEDS_APPROVAL')
    expect(decision.clause).toBe(Clause.frictionFloor)
    expect(decision.detail).toContain('AI may only add friction')
  })

  it('denies agent actor proposal when modelFloor is deny', () => {
    const warrant = {
      ...LINE_STUDIO_WARRANT,
      fundingRequired: false,
      autoSettleUnderCents: 5000,
      frictionBudget: { modelFloor: 'deny' as const },
    }
    const proposal: any = {
      ...validBase,
      amountCents: 1500,
      actor: 'agent:clerk_v1',
    }
    const decision = decide(warrant, proposal, { reservedCents: 0, priorCaptureIds: [] })
    expect(decision.gate).toBe('DENY')
    expect(decision.clause).toBe(Clause.frictionFloor)
  })

  it('logs model.override_attempt event when proposal is created via service', async () => {
    const db = openDatabase(':memory:')
    migrate(db)
    seed(db, NOW)
    
    const repo = new Repo(db)
    // Set warrant with fundingRequired: false so payments can be auto-approved
    repo.insertWarrant(WARRANT_ID, 2, {
      ...LINE_STUDIO_WARRANT,
      fundingRequired: false,
      autoSettleUnderCents: 5000,
      frictionBudget: { modelFloor: 'needs_approval' },
    }, NOW.toISOString())

    // Register an active agent with 'propose' and 'read' scopes
    const agentToken = 'test_agent_token_secret_12345678'
    const agentHash = machineKeyHash(agentToken)
    repo.createAgent({
      id: 'subagent_42',
      name: 'Subagent 42',
      scopes_json: JSON.stringify(['propose', 'read']),
      limits_json: JSON.stringify({ proposalsPerHour: 100, centsPerHour: 100000 }),
      status: 'active',
      key_hash: agentHash,
      key_prefix: 'test',
      created_at: NOW.toISOString(),
      last_seen_at: null,
      expires_at: null,
    })

    const app = createApp({
      db,
      paypal: null,
      now: () => NOW,
      config: { apiKey: KEY, proposerKey: 'test_proposer', rateLimitPerMinute: 1000, paypalConfigured: false, log: false, publicUrl: 'http://localhost:3000' },
    })

    // Agent proposes spend of $15 (which would be AUTO if human asked)
    const res = await app.request('/v1/proposals', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agentToken}`,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        kind: 'payment',
        payee: 'Priya Shah',
        amountCents: 1500,
        currency: 'USD',
        category: 'design',
        description: 'Banner design fee',
        evidenceUrl: 'https://example.com/banner.png',
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.gate).toBe('NEEDS_APPROVAL')
    expect(body.clause).toBe('friction.floor')

    // Verify model.override_attempt was recorded in ledger
    const ledgerRes = await app.request('/v1/ledger/export', {
      headers: { authorization: `Bearer ${KEY}` },
    })
    expect(ledgerRes.status).toBe(200)
    const exportData = await ledgerRes.json() as any
    const overrideEvent = exportData.entries.find((e: any) => e.eventType === 'model.override_attempt')
    expect(overrideEvent).toBeDefined()
    expect(overrideEvent.proposalId).toBe(body.id)
    expect(overrideEvent.clause).toBe('friction.floor')
  })
})
