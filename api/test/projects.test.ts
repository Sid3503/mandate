import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { call, closeAll, harness, NOW, OWNER_KEY, STUDIO_KEY } from './support'
import { manifestFor, manifestHash, planFlags, promisedCount, ruleCheck, statedBudgetCents, statedDeadlineDays } from '../src/domain/project'
import { importBrief } from '../src/services/briefImport'

afterEach(closeAll)

/**
 * Two-sided projects, end to end, against the fake PayPal: the plan becomes a signed deal, the stage's bill goes through
 * the gate with the delivery's fingerprints as its proof, the client's money waits in a hold that only they (or the
 * review window they agreed to) can release, and the originals never leave the server before it is captured.
 */

const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString().slice(0, 10)

const plan = (over: Record<string, unknown> = {}) => ({
  title: 'Brand identity for Kola Press',
  summary: 'Three paid stages over three weeks.',
  clientName: 'Kola Press',
  clientEmail: 'hello@kolapress.example',
  currency: 'USD',
  category: 'design',
  reviewDays: 3,
  reviseDays: 3,
  brief: 'We need a logo and six launch posts. Budget is about $1,400 and we want everything in 3 weeks.',
  stages: [
    { title: 'Discovery and logo concepts', description: 'Direction and first routes.', deliverables: ['Moodboard', '3 logo concepts'], amountCents: 40_000, dueDate: day(6) },
    { title: 'Logo refinement', description: '', deliverables: ['Final logo (SVG, PNG)'], amountCents: 49_000, dueDate: day(14) },
  ],
  ...over,
})

async function png(seed: number, size = 1200): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width: size, height: size, channels: 3, background: { r: seed % 255, g: (seed * 7) % 255, b: (seed * 13) % 255 } } }).png().toBuffer())
}

async function upload(app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }, projectId: string, stageId: string, name: string, bytes: Uint8Array, key = OWNER_KEY) {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)]), name)
  const response = await app.request(`http://mandate.test/v1/projects/${projectId}/stages/${stageId}/files`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form })
  return { status: response.status, json: await response.json() }
}

async function portal(app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }, method: string, path: string, body?: unknown) {
  const response = await app.request(`http://mandate.test/v1/portal/${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const type = response.headers.get('content-type') ?? ''
  return { status: response.status, json: type.includes('json') ? await response.json() : null, bytes: type.includes('json') ? null : new Uint8Array(await response.arrayBuffer()), headers: response.headers }
}

/** A project the client has approved, with its link token. */
async function agreedProject(h: ReturnType<typeof harness>, over: Record<string, unknown> = {}) {
  const made = await call(h.app, 'POST', '/v1/projects', { body: plan(over) })
  expect(made.status).toBe(201)
  const sent = await call(h.app, 'POST', `/v1/projects/${made.json.id}/send`)
  expect(sent.status).toBe(200)
  const token = String(sent.json.link.url).split('/app/c/')[1]!
  const agreed = await portal(h.app, 'POST', `${token}/plan/agree`, { version: 1 })
  expect(agreed.status).toBe(200)
  return { id: made.json.id as string, token, stages: (made.json.stages as Array<{ id: string }>).map((stage) => stage.id) }
}

/** Delivers a stage and has the owner approve its bill. Returns the charge id. */
async function deliver(h: ReturnType<typeof harness>, id: string, stageId: string, files: Array<[string, Uint8Array]>) {
  for (const [name, bytes] of files) expect((await upload(h.app, id, stageId, name, bytes)).status).toBe(201)
  const sent = await call(h.app, 'POST', `/v1/projects/${id}/stages/${stageId}/send`)
  expect(sent.status).toBe(200)
  const stage = sent.json.stages.find((item: { id: string }) => item.id === stageId)
  expect(stage.status).toBe('delivered')
  const chargeId = stage.charge.id as string
  if (stage.charge.phase === 'pending_approval') {
    const approved = await call(h.app, 'POST', `/v1/proposals/${chargeId}/approve`, { body: { instrument: 'invoice' } })
    expect(approved.status).toBe(200)
    // A stage paid into a hold is always paid on the client's page, whatever the tap asked for.
    expect(approved.json.payInstrument).toBe('checkout')
    expect(approved.json.settleMode).toBe('hold')
  }
  return chargeId
}

async function payIntoHold(h: ReturnType<typeof harness>, token: string, stageId: string) {
  const session = await portal(h.app, 'POST', `${token}/stages/${stageId}/pay/session`, { instrument: 'paypal' })
  expect(session.status).toBe(200)
  expect(session.json.intent).toBe('authorize')
  expect(String(session.json.orderId)).toMatch(/-HOLD$/)
  const confirmed = await portal(h.app, 'POST', `${token}/stages/${stageId}/pay/confirm`)
  expect(confirmed.status).toBe(200)
  return confirmed.json
}

describe('projects: nobody goes first', () => {
  it('runs the whole job: signed plan, sealed delivery, a hold only the client releases, then the originals', async () => {
    const h = harness()
    const { id, token, stages } = await agreedProject(h)
    const [first] = stages

    // The approved plan is a signed deal on the project's job.
    const project = await call(h.app, 'GET', `/v1/projects/${id}`)
    expect(project.json.status).toBe('agreed')
    expect(project.json.plan.studioSignatureValid).toBe(true)
    expect(project.json.plan.clientSignatureValid).toBe(true)
    const verify = await call(h.app, 'GET', `/v1/deals/${project.json.dealId}/verify`)
    expect(verify.json.verdict).toBe('valid')

    const a = await png(1)
    const b = await png(2)
    const chargeId = await deliver(h, id, first!, [['concept-1.png', a], ['concept-2.png', b]])

    // The bill's proof is the manifest of the exact files, so the signed lock names them.
    const charge = await call(h.app, 'GET', `/v1/proposals/${chargeId}`)
    const manifestUrl = new URL(charge.json.evidenceUrl)
    const manifest = await call(h.app, 'GET', manifestUrl.pathname)
    expect(manifest.status).toBe(200)
    expect(manifest.json.recomputed).toBe(true)
    expect(manifestUrl.searchParams.get('sha256')).toBe(manifest.json.sha256)
    expect(manifest.json.manifest.files.map((file: { sha256: string }) => file.sha256).sort()).toEqual([createHash('sha256').update(a).digest('hex'), createHash('sha256').update(b).digest('hex')].sort())

    // The check ran against the plan: three concepts were promised, two arrived.
    const view = await portal(h.app, 'GET', token)
    const stageView = view.json.stages.find((stage: { id: string }) => stage.id === first)
    expect(stageView.canPay).toBe(true)
    expect(stageView.check.items.some((item: { label: string; status: string }) => item.label === '3 logo concepts' && item.status === 'partial')).toBe(true)

    // Before paying: a sealed thumbnail only. No review copy, no original.
    const fileId = stageView.files[0].id
    expect((await portal(h.app, 'GET', `${token}/files/${fileId}/thumb`)).status).toBe(200)
    expect((await portal(h.app, 'POST', `${token}/files/${fileId}/session`)).status).toBe(402)
    expect((await portal(h.app, 'GET', `${token}/files/${fileId}/download`)).status).toBe(402)

    // Paying puts the money in a hold. Nothing is captured.
    const held = await payIntoHold(h, token, first!)
    expect(held.stages.find((stage: { id: string }) => stage.id === first).status).toBe('held')
    expect(h.paypal!.captureCalls).toBe(0)
    expect(h.paypal!.authorizeCalls).toBe(1)
    expect((await call(h.app, 'GET', `/v1/proposals/${chargeId}`)).json.phase).toBe('authorized')

    // Nobody but the client's release can take held money: not the owner's Settle, not an agent.
    const grab = await call(h.app, 'POST', `/v1/proposals/${chargeId}/capture`, { body: {} })
    expect(grab.status).toBe(409)
    expect(grab.json.code).toBe('hold.client_decides')
    expect(h.paypal!.captureCalls).toBe(0)

    // A hold is not money: no contractor payout may cite it.
    const payout = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: 'payout-from-hold-1', body: { kind: 'payment', payee: 'Priya', amountCents: 9_000, currency: 'USD', category: 'design', description: 'Priya share', evidenceUrl: 'https://www.figma.com/file/x', jobId: project.json.jobId, fundingCaptureId: 'AUTH-anything' } })
    expect(payout.json.gate).toBe('DENY')

    // While held: a watermarked review copy and close-ups, still no original.
    const session = await portal(h.app, 'POST', `${token}/files/${fileId}/session`)
    expect(session.status).toBe(200)
    const copy = await portal(h.app, 'GET', `${token}/review/${session.json.session}`)
    expect(copy.status).toBe(200)
    expect(copy.headers.get('cache-control')).toContain('no-store')
    const meta = await sharp(copy.bytes!).metadata()
    expect(meta.format).toBe('jpeg')
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1200)
    expect(createHash('sha256').update(copy.bytes!).digest('hex')).not.toBe(createHash('sha256').update(a).digest('hex'))
    const zoom = await portal(h.app, 'GET', `${token}/review/${session.json.session}/closeup?x=0.5&y=0.5`)
    expect(zoom.status).toBe(200)
    expect((await sharp(zoom.bytes!).metadata()).width).toBe(300)
    expect((await portal(h.app, 'GET', `${token}/files/${fileId}/download`)).status).toBe(402)

    // Changes: the money stays held, the studio gets a deadline, and the client cannot cancel before it.
    const changes = await portal(h.app, 'POST', `${token}/stages/${first}/changes`, { note: 'Please add the third concept we agreed.' })
    expect(changes.status).toBe(200)
    expect(changes.json.stages.find((stage: { id: string }) => stage.id === first).status).toBe('changes')
    expect((await portal(h.app, 'POST', `${token}/stages/${first}/cancel`)).status).toBe(409)
    expect((await portal(h.app, 'POST', `${token}/stages/${first}/approve`)).status).toBe(409)

    // The revision is the next round, checked again, with a fresh review window. Same bill, same hold.
    const c = await png(3)
    expect((await upload(h.app, id, first!, 'concept-1.png', a)).status).toBe(201)
    expect((await upload(h.app, id, first!, 'concept-2.png', b)).status).toBe(201)
    expect((await upload(h.app, id, first!, 'concept-3.png', c)).status).toBe(201)
    const revised = await call(h.app, 'POST', `/v1/projects/${id}/stages/${first}/send`)
    const revisedStage = revised.json.stages.find((stage: { id: string }) => stage.id === first)
    expect(revisedStage.status).toBe('held')
    expect(revisedStage.round).toBe(2)
    expect(revisedStage.charge.id).toBe(chargeId)
    expect(revisedStage.delivery.check.items.some((item: { label: string; status: string }) => item.label === '3 logo concepts' && item.status === 'met')).toBe(true)

    // Approve: the hold is captured through the gate's capture path, and the release is signed over round 2's files.
    const approved = await portal(h.app, 'POST', `${token}/stages/${first}/approve`)
    expect(approved.status).toBe(200)
    const done = approved.json.stages.find((stage: { id: string }) => stage.id === first)
    expect(done.status).toBe('released')
    expect(done.receipt.paypalCaptureId).toBeTruthy()
    expect(done.receipt.manifestHash).toBe(revisedStage.delivery.manifestHash)
    expect(h.paypal!.captureCalls).toBe(1)
    const after = await call(h.app, 'GET', `/v1/projects/${id}`)
    const released = after.json.stages.find((stage: { id: string }) => stage.id === first)
    expect(released.release.signatureValid).toBe(true)
    expect(released.release.decidedBy).toBe('client')
    expect(released.hold.status).toBe('captured')
    expect((await call(h.app, 'GET', `/v1/proposals/${chargeId}`)).json.phase).toBe('captured')

    // The originals unlock, byte for byte.
    const third = done.files.find((file: { name: string }) => file.name === 'concept-3.png')
    const original = await portal(h.app, 'GET', `${token}/files/${third.id}/download`)
    expect(original.status).toBe(200)
    expect(createHash('sha256').update(original.bytes!).digest('hex')).toBe(createHash('sha256').update(c).digest('hex'))

    // Only a client who paid can review, and the review is signed with the capture that proves it.
    await call(h.app, 'PUT', '/v1/profile', { body: { handle: 'line-studio', displayName: 'Line Studio', headline: 'Brand identity', bio: 'We design.' } })
    const review = await portal(h.app, 'POST', `${token}/review`, { stars: 5, text: 'Clear stages and we saw everything before paying.' })
    expect(review.status).toBe(200)
    const profile = await call(h.app, 'GET', '/v1/profiles/line-studio', { key: '' })
    expect(profile.status).toBe(200)
    expect(profile.json.rating).toBe(5)
    expect(profile.json.reviews[0].verified).toBe(true)
    expect(profile.json.track.stagesPaid).toBe(1)
    expect((await portal(h.app, 'POST', `${token}/review`, { stars: 1, text: 'A second review is not allowed.' })).status).toBe(409)

    // The freelancer's headline counts held and banked money.
    const summary = await call(h.app, 'GET', '/v1/projects')
    expect(summary.json.bankedCents).toBe(40_000)
    expect(summary.json.owedCents).toBe(49_000)
  })

  it('releases by itself when the review window the client agreed to runs out', async () => {
    const h = harness()
    const { id, token, stages } = await agreedProject(h)
    const chargeId = await deliver(h, id, stages[0]!, [['a.png', await png(4)], ['b.png', await png(5)], ['c.png', await png(6)]])
    await payIntoHold(h, token, stages[0]!)
    await h.services.projects.sweep()
    expect((await call(h.app, 'GET', `/v1/proposals/${chargeId}`)).json.phase).toBe('authorized')
    h.setNow(new Date(NOW.getTime() + 3 * 86_400_000 + 60_000))
    await h.services.projects.sweep()
    const project = await call(h.app, 'GET', `/v1/projects/${id}`)
    const stage = project.json.stages[0]
    expect(stage.status).toBe('released')
    expect(stage.release.decidedBy).toBe('review_window')
    expect(stage.release.signatureValid).toBe(true)
  })

  it('lets the client cancel after a missed revision deadline, and voids the hold so they are never charged', async () => {
    const h = harness()
    const { id, token, stages } = await agreedProject(h)
    const chargeId = await deliver(h, id, stages[0]!, [['a.png', await png(7)]])
    await payIntoHold(h, token, stages[0]!)
    await portal(h.app, 'POST', `${token}/stages/${stages[0]}/changes`, { note: 'This is not what we agreed on.' })
    h.setNow(new Date(NOW.getTime() + 4 * 86_400_000))
    const cancelled = await portal(h.app, 'POST', `${token}/stages/${stages[0]}/cancel`)
    expect(cancelled.status).toBe(200)
    expect(cancelled.json.stages[0].status).toBe('cancelled')
    expect(h.paypal!.voidCalls).toBe(1)
    expect(h.paypal!.captureCalls).toBe(0)
    expect((await call(h.app, 'GET', `/v1/proposals/${chargeId}`)).json.phase).toBe('voided')
    // Nothing unlocks for a cancelled stage.
    expect((await portal(h.app, 'GET', `${token}/files/${cancelled.json.stages[0].files[0].id}/download`)).status).toBe(402)
  })

  it('renews a hold past PayPal\'s three-day honor period before capturing it', async () => {
    const h = harness()
    const { id, token, stages } = await agreedProject(h, { reviewDays: 5 })
    h.paypal!.clock = () => NOW
    await deliver(h, id, stages[0]!, [['a.png', await png(8)]])
    await payIntoHold(h, token, stages[0]!)
    h.setNow(new Date(NOW.getTime() + 4 * 86_400_000))
    const approved = await portal(h.app, 'POST', `${token}/stages/${stages[0]}/approve`)
    expect(approved.json.stages[0].status).toBe('released')
    expect(h.paypal!.reauthorizeCalls).toBe(1)
  })

  it('sends a changed plan back: an open stage cannot be paid until the client approves again', async () => {
    const h = harness()
    const { id, token, stages } = await agreedProject(h)
    await deliver(h, id, stages[0]!, [['a.png', await png(9)]])
    const view = await call(h.app, 'GET', `/v1/projects/${id}`)
    const edited = await call(h.app, 'PUT', `/v1/projects/${id}/plan`, { body: { stages: view.json.stages.map((stage: { id: string; title: string; description: string; deliverables: string[]; amountCents: number; dueDate: string }, index: number) => ({ id: stage.id, title: stage.title, description: stage.description, deliverables: stage.deliverables, amountCents: index === 1 ? 45_000 : stage.amountCents, dueDate: stage.dueDate })) } })
    expect(edited.status).toBe(200)
    expect(edited.json.plan.version).toBe(2)
    expect(edited.json.status).toBe('sent')
    const blocked = await portal(h.app, 'POST', `${token}/stages/${stages[0]}/pay/session`, { instrument: 'paypal' })
    expect(blocked.status).toBe(409)
    const portalView = await portal(h.app, 'GET', token)
    expect(portalView.json.plan.diff.stages[1].was.amountCents).toBe(49_000)
    expect((await portal(h.app, 'POST', `${token}/plan/agree`, { version: 2 })).status).toBe(200)
    expect((await portal(h.app, 'POST', `${token}/stages/${stages[0]}/pay/session`, { instrument: 'paypal' })).status).toBe(200)
  })

  it('refuses a stage under way being edited, a wrong link, and studio keys reaching owner-only steps', async () => {
    const h = harness()
    const { id, token, stages } = await agreedProject(h)
    await deliver(h, id, stages[0]!, [['a.png', await png(10)]])
    const view = await call(h.app, 'GET', `/v1/projects/${id}`)
    const changed = await call(h.app, 'PUT', `/v1/projects/${id}/plan`, { body: { stages: view.json.stages.map((stage: { id: string; title: string; description: string; deliverables: string[]; amountCents: number; dueDate: string }) => ({ id: stage.id, title: stage.title, description: stage.description, deliverables: stage.deliverables, amountCents: stage.amountCents + 100, dueDate: stage.dueDate })) } })
    expect(changed.status).toBe(409)
    expect((await portal(h.app, 'GET', `${token.slice(0, -2)}xx`)).status).toBe(404)
    expect((await call(h.app, 'POST', `/v1/projects/${id}/link/rotate`, { key: STUDIO_KEY })).status).toBe(403)
    // A new client is the owner's call.
    expect((await call(h.app, 'POST', '/v1/projects', { key: STUDIO_KEY, body: plan({ clientName: 'Bean There', clientEmail: 'hi@bean.example' }) })).status).toBe(403)
    // Rotating the link retires the old one.
    await call(h.app, 'POST', `/v1/projects/${id}/link/rotate`)
    expect((await portal(h.app, 'GET', token)).status).toBe(404)
  })

  it('keeps project deals off the old billing path', async () => {
    const h = harness()
    const { id } = await agreedProject(h)
    const view = await call(h.app, 'GET', `/v1/projects/${id}`)
    const billed = await call(h.app, 'POST', `/v1/deals/${view.json.dealId}/milestones/0/bill`, { body: { evidenceUrl: 'https://www.figma.com/file/x' } })
    expect(billed.status).toBe(409)
    expect(billed.json.code).toBe('deal.project')
  })
})

describe('the stage ledger', () => {
  it('lists every stage with PayPal ids, and an inline price edit sends the plan back for approval', async () => {
    const h = harness()
    const { id, token, stages } = await agreedProject(h)
    await deliver(h, id, stages[0]!, [['a.png', await png(11)]])
    await payIntoHold(h, token, stages[0]!)
    const ledger = await call(h.app, 'GET', '/v1/projects/ledger')
    expect(ledger.status).toBe(200)
    const held = ledger.json.data.find((row: { stageId: string }) => row.stageId === stages[0])
    expect(held.bucket).toBe('held')
    expect(held.paypalIdKind).toBe('hold')
    expect(held.editable).toBe(false)
    // A stage under way cannot be edited from the grid.
    expect((await call(h.app, 'PATCH', `/v1/projects/${id}/stages/${stages[0]}`, { body: { amountCents: 1000 } })).status).toBe(409)
    const edited = await call(h.app, 'PATCH', `/v1/projects/${id}/stages/${stages[1]}`, { body: { amountCents: 45_000 } })
    expect(edited.status).toBe(200)
    expect(edited.json.plan.version).toBe(2)
    expect(edited.json.plan.status).toBe('sent')
    // Overdue is counted from the due date.
    h.setNow(new Date(NOW.getTime() + 20 * 86_400_000))
    const late = await call(h.app, 'GET', '/v1/projects/ledger')
    const open = late.json.data.find((row: { stageId: string }) => row.stageId === stages[1])
    expect(open.bucket).toBe('unpaid')
  })
})

describe('project facts read by code', () => {
  it('reads counts, budgets and deadlines from plain words', () => {
    expect(promisedCount('3 logo concepts')).toBe(3)
    expect(promisedCount('Six Instagram launch posts')).toBe(6)
    expect(promisedCount('Final logo (SVG, PNG)')).toBeNull()
    expect(statedBudgetCents('Budget is about $1,400 and we want everything in 3 weeks.')).toBe(140_000)
    expect(statedDeadlineDays('we want everything in 3 weeks')).toBe(21)
    const flags = planFlags('Budget is about $1,400, in 3 weeks. We need a logo.', [{ title: 'A', deliverables: ['3 logo concepts'], amountCents: 150_000, dueDate: '2026-12-30' }], '2026-11-06T00:00:00Z')
    expect(flags.some((flag) => flag.level === 'red' && /over the/.test(flag.text))).toBe(true)
    expect(flags.some((flag) => /after the 21-day deadline/.test(flag.text))).toBe(true)
    expect(flags.some((flag) => /count the brief does not state/.test(flag.text))).toBe(true)
  })

  it('checks a delivery against what was promised with file facts only', () => {
    const items = ruleCheck(['3 logo concepts', 'Final logo (SVG, PNG)', '6 posts at 1080x1080'], [
      { name: 'a.png', mime: 'image/png', size: 50_000, sha256: 'x1', width: 1080, height: 1080, kind: 'image' },
      { name: 'b.png', mime: 'image/png', size: 50_000, sha256: 'x1', width: 600, height: 600, kind: 'image' },
    ])
    expect(items.find((item) => item.label === '3 logo concepts')?.status).toBe('partial')
    expect(items.find((item) => item.label === 'Final logo (SVG, PNG)' && /SVG promised/.test(item.note))?.status).toBe('missing')
    expect(items.some((item) => item.label === 'Duplicates')).toBe(true)
    expect(items.find((item) => item.label === '6 posts at 1080x1080' && /smaller/.test(item.note))?.status).toBe('partial')
  })

  it('reads a Word brief as text: tags never survive, and entities are decoded once', async () => {
    const xml = Buffer.from('<w:document><w:body><w:p><w:t>We need a logo &amp;lt;script&amp;gt;</w:t></w:p><w:p><w:t>&lt;sc&lt;x&gt;ript&gt; Budget $900</w:t></w:p><sc<w:t/>ript>x</sc<w:t/>ript></w:body></w:document>')
    const name = Buffer.from('word/document.xml')
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt32LE(xml.length, 18); local.writeUInt32LE(xml.length, 22); local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt32LE(xml.length, 20); central.writeUInt32LE(xml.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42)
    const body = Buffer.concat([local, name, xml])
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(body.length, 16)
    const read = await importBrief({ name: 'brief.docx', bytes: new Uint8Array(Buffer.concat([body, central, name, end])) }, [])
    expect(read.text).toContain('We need a logo &lt;script&gt;')
    expect(read.text).toContain('Budget $900')
    expect(read.text).not.toMatch(/<script/i)
  })

  it('hashes the same files to the same manifest, in any order', () => {
    const files = [{ name: 'a', sha256: 'b'.repeat(64), size: 1, mime: 'image/png' }, { name: 'b', sha256: 'a'.repeat(64), size: 2, mime: 'image/png' }]
    expect(manifestHash(manifestFor('p', 's', 1, files))).toBe(manifestHash(manifestFor('p', 's', 1, [...files].reverse())))
    expect(manifestHash(manifestFor('p', 's', 1, files))).not.toBe(manifestHash(manifestFor('p', 's', 2, files)))
  })
})
