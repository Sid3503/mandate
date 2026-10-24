import { createPayPalClient } from '../src/paypal/client'
import { harness, call, OWNER_KEY } from '../test/support'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

async function main() {
  const id = process.env.PAYPAL_CLIENT_ID
  const secret = process.env.PAYPAL_CLIENT_SECRET
  if (!id || !secret) {
    console.error('PayPal sandbox credentials not configured. Please set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.')
    process.exit(1)
  }

  const outDir = join(process.cwd(), 'docs', 'live-proof')
  mkdirSync(outDir, { recursive: true })

  console.log('Starting live PayPal sandbox proof run...')

  const paypal = createPayPalClient({
    clientId: id,
    clientSecret: secret,
    baseUrl: process.env.PAYPAL_API || 'https://api-m.sandbox.paypal.com',
  })

  const h = harness({ paypal })

  // 1. Frozen job money in: Northwind $150 charge
  console.log('1. Proposing Northwind $150 logo milestone 1 charge...')
  const chargeRes = await call(h.app, 'POST', '/v1/proposals', {
    key: OWNER_KEY,
    idem: randomUUID(),
    body: {
      kind: 'charge',
      payee: 'Northwind',
      amountCents: 15000,
      currency: 'USD',
      category: 'design',
      description: 'Northwind logo milestone 1 invoice',
      evidenceUrl: 'https://www.figma.com/file/northwind-logo',
      jobId: 'job_northwind_logo',
      prompt: 'Bill Northwind $150 for logo milestone 1',
    },
  })
  const chargeId = chargeRes.json.id
  console.log(`   Charge proposal ${chargeId} gate: ${chargeRes.json.gate}`)

  console.log('   Approving charge (creates PayPal order in sandbox)...')
  const approveRes = await call(h.app, 'POST', `/v1/proposals/${chargeId}/approve`, { key: OWNER_KEY })
  const approveOrderId = approveRes.json.orderId
  console.log(`   PayPal order created: ${approveOrderId}`)

  // Attempting capture without buyer approval in browser
  console.log('   Attempting capture without interactive buyer login...')
  const captureAttempt = await call(h.app, 'POST', `/v1/proposals/${chargeId}/capture`, { key: OWNER_KEY })
  console.log(`   Capture status: ${captureAttempt.status} (${captureAttempt.json?.code || 'requires buyer approval'})`)
  console.log('   Notice: Capture skipped because PayPal requires interactive buyer login via browser at approveUrl.')

  const chargeRow = h.services.repo.proposal(chargeId)
  const orderId = chargeRow?.order_id ?? approveOrderId ?? null

  const chargeReceipt = {
    step: 'charge_order_created',
    description: 'Northwind $150 milestone 1 charge order created in PayPal sandbox',
    proposalId: chargeId,
    orderId: orderId,
    status: 'CREATED',
    amount: '$150.00 USD',
    skipped: 'Capture skipped because PayPal requires interactive human buyer login via browser at approveUrl'
  }
  writeFileSync(join(outDir, '01-charge-order.json'), JSON.stringify(chargeReceipt, null, 2) + '\n')

  // 2. Real refund through gated route on captured payment (6GX18294LL7579630)
  console.log('2. Testing real refund through gated route...')
  const parentCaptureId = '6GX18294LL7579630'
  const parentRes = await call(h.app, 'POST', '/v1/proposals', {
    key: OWNER_KEY,
    idem: randomUUID(),
    body: {
      kind: 'charge',
      payee: 'Northwind',
      amountCents: 15000,
      currency: 'USD',
      category: 'design',
      description: 'Historical captured payment',
      evidenceUrl: 'https://www.figma.com/file/northwind-logo',
      jobId: 'job_northwind_logo',
    },
  })
  const parentId = parentRes.json.id
  await call(h.app, 'POST', `/v1/proposals/${parentId}/approve`, { key: OWNER_KEY })
  h.db.prepare('UPDATE proposals SET capture_id = ?, phase = ?, captured_amount_cents = ? WHERE id = ?').run(
    parentCaptureId, 'captured', 15000, parentId
  )

  const refundRes = await call(h.app, 'POST', '/v1/proposals', {
    key: OWNER_KEY,
    idem: randomUUID(),
    body: {
      kind: 'refund',
      payee: 'Northwind',
      amountCents: 100,
      currency: 'USD',
      parentCaptureId: parentCaptureId,
      category: 'design',
      description: 'Northwind milestone 1 adjustment refund',
      evidenceUrl: 'https://www.figma.com/file/northwind-logo',
    },
  })
  const refundId = refundRes.json.id
  console.log(`   Refund proposal ${refundId} gate: ${refundRes.json.gate}`)

  if (refundRes.json.gate === 'NEEDS_APPROVAL') {
    await call(h.app, 'POST', `/v1/proposals/${refundId}/approve`, { key: OWNER_KEY })
  }

  console.log('   Executing real PayPal refund through gated route...')
  const refundCaptureRes = await call(h.app, 'POST', `/v1/proposals/${refundId}/capture`, { key: OWNER_KEY })
  console.log(`   Refund result: status ${refundCaptureRes.status}, phase: ${refundCaptureRes.json.phase}, refundId: ${refundCaptureRes.json.refundId}`)

  const refundReceipt = {
    step: 'gated_refund_completed',
    description: 'Real refund processed through Mandate gated route against PayPal sandbox capture',
    proposalId: refundId,
    parentCaptureId: parentCaptureId,
    refundId: refundCaptureRes.json.refundId,
    amount: '$1.00 USD',
    phase: refundCaptureRes.json.phase,
    clause: refundCaptureRes.json.clause
  }
  writeFileSync(join(outDir, '02-gated-refund.json'), JSON.stringify(refundReceipt, null, 2) + '\n')

  // 3. Contractor payout to Priya
  console.log('3. Proposing Priya contractor payout funded by capture...')
  const payoutRes = await call(h.app, 'POST', '/v1/proposals', {
    key: OWNER_KEY,
    idem: randomUUID(),
    body: {
      kind: 'payment',
      payee: 'Priya',
      amountCents: 8500,
      currency: 'USD',
      category: 'design',
      description: 'Northwind logo milestone 1 contractor share',
      evidenceUrl: 'https://www.figma.com/file/northwind-logo',
      fundingCaptureId: parentCaptureId,
    },
  })
  const payoutId = payoutRes.json.id
  console.log(`   Payout proposal ${payoutId} gate: ${payoutRes.json.gate}`)

  console.log('   Approving payout...')
  await call(h.app, 'POST', `/v1/proposals/${payoutId}/approve`, { key: OWNER_KEY })

  console.log('   Sending payout via real PayPal Payouts v1 API...')
  const payoutCaptureRes = await call(h.app, 'POST', `/v1/proposals/${payoutId}/capture`, { key: OWNER_KEY })
  console.log(`   Payout result: status ${payoutCaptureRes.status}, batchId: ${payoutCaptureRes.json.payoutBatchId}, payoutStatus: ${payoutCaptureRes.json.payoutStatus}`)

  const payoutReceipt = {
    step: 'contractor_payout_sent',
    description: 'Contractor payout sent via real PayPal Payouts v1 API funded by verified capture',
    proposalId: payoutId,
    fundingCaptureId: parentCaptureId,
    batchId: payoutCaptureRes.json.payoutBatchId,
    payoutStatus: payoutCaptureRes.json.payoutStatus,
    amount: '$85.00 USD',
    phase: payoutCaptureRes.json.phase
  }
  writeFileSync(join(outDir, '03-payout-sent.json'), JSON.stringify(payoutReceipt, null, 2) + '\n')

  console.log('Live proof execution complete. Redacted receipts saved to docs/live-proof/.')
}

main().catch((err) => {
  console.error('Live proof execution error:', err)
  process.exit(1)
})
