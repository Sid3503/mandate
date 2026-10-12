import { createHash, generateKeyPairSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Hono } from 'hono'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server'
import type { WebAuthnCredential } from '@simplewebauthn/server'
import { clearSessionCookie, cookieWriteAllowed, readSessionCookie, writeSessionCookie } from '../auth/cookies'
import { beginLogin, beginRegistration, finishLogin, finishRegistration, type WebAuthnConfig } from '../auth/passkeys'
import { ControlStore } from '../control/store'
import { defaultFlags, type ServerFlags } from '../flags'
import { Problem } from './problem'
import type { Metrics } from '../ops/metrics'
import type { ModelBudget } from '../ops/budget'
import { isWorkspaceId, newWorkspaceId } from '../tenancy/ids'
import { seal } from '../tenancy/envelope'
import type { TenantRegistry } from '../tenancy/registry'
import { clientIp } from '../ops/client-ip'

export type ProductCtx = {
  flags: ServerFlags
  now: () => Date
  control: ControlStore | null
  registry: TenantRegistry | null
  workspaceId: string
  workspaceMode: 'default' | 'demo' | 'studio' | 'live'
  nested: boolean
  adminKey: string | null
  webauthn: WebAuthnConfig | null
  metrics: Metrics
  budget: ModelBudget | null
  cookieSecure: boolean
  idleHours: number
  absoluteDays: number
  trustProxy: boolean
  demo: { root: string; template: string } | null
  masterKey: string | null
  paypal: { pay?: (invoiceId: string, cents?: number) => void; settlePayouts?: (status?: 'SUCCESS' | 'FAILED') => void } | null
  /** Pure rule try. Absent only in a half-built app. */
  tryOne?: (body: unknown) => unknown
  counts?: () => { proposals: number; events: number; payees: number }
  listPayees?: () => Array<{ id: string; email: string; status: string; verified_method: string; first_seen: string; total_paid_cents: number; change_pending: number }>
}

function sameSecret(presented: string, expected: string): boolean {
  const left = createHash('sha256').update(presented).digest()
  const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}

function flagsOf(ctx: ProductCtx): ServerFlags {
  return ctx.flags ?? defaultFlags()
}

function requireControl(ctx: ProductCtx): ControlStore {
  if (!ctx.control) throw new Problem(404, 'flag/disabled', 'Not available', 'This door is off on this server.')
  return ctx.control
}

function memberFromCookie(c: { req: { header: (name: string) => string | undefined } }, ctx: ProductCtx) {
  const token = readSessionCookie(c.req.header('cookie'), ctx.cookieSecure)
  if (!token || !ctx.control) return null
  const session = ctx.control.session(token, ctx.now().toISOString())
  if (!session) return null
  const member = ctx.control.member(session.member_id)
  if (!member || member.status !== 'active') return null
  return { token, session, member }
}

export function mountExtra(app: Hono<any>, ctx: ProductCtx, selfFetch: (request: Request) => Promise<Response> | Response): void {
  const flags = flagsOf(ctx)

  app.get('/healthz', (c) => c.json({ status: 'pass' }))
  app.get('/readyz', (c) => c.redirect('/ready', 307))

  app.get('/ops/metrics', (c) => {
    if (!ctx.adminKey) throw new Problem(404, 'route.not_found', 'Not found', 'No route matches this path.')
    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (token.length === 0 || !sameSecret(token, ctx.adminKey)) throw new Problem(401, 'auth/required', 'Unauthorized', 'Provide the admin key.')
    return c.json(ctx.metrics.snapshot(ctx.budget ? { budgetPercent: ctx.budget.snapshot().budgetPercent, modelCalls: ctx.budget.snapshot().calls } : {}))
  })

  app.post('/ops/model/kill', (c) => {
    if (!ctx.adminKey) throw new Problem(404, 'route.not_found', 'Not found', 'No route matches this path.')
    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (token.length === 0 || !sameSecret(token, ctx.adminKey)) throw new Problem(401, 'auth/required', 'Unauthorized', 'Provide the admin key.')
    ctx.budget?.kill()
    return c.json({ killed: true })
  })

  if (!ctx.nested) {
    app.all('/w/:workspace/*', async (c) => {
      if (!flags.tenancy) throw new Problem(404, 'flag/disabled', 'Not available', 'Workspaces are off on this server.')
      const id = c.req.param('workspace')
      if (!isWorkspaceId(id)) throw new Problem(400, 'request.invalid', 'Bad workspace id', 'A workspace id is ws_default or ws_ and 20 letters.')
      if (id.includes('..') || id.includes('/') || id.includes('\\')) throw new Problem(400, 'request.invalid', 'Bad workspace id', 'That id is not a workspace.')
      const rest = c.req.path.replace(/^\/w\/[^/]+/, '') || '/'
      const url = new URL(c.req.url)
      url.pathname = rest
      const headers = new Headers(c.req.raw.headers)
      headers.delete('x-mandate-workspace')
      const body = c.req.method === 'GET' || c.req.method === 'HEAD' ? undefined : await c.req.raw.arrayBuffer()
      if (id === 'ws_default') return selfFetch(new Request(url, { method: c.req.method, headers, body }))
      const tenant = ctx.registry?.get(id)
      if (!tenant) throw new Problem(404, 'tenant/not-found', 'Not found', 'No workspace has that id.')
      return tenant.fetch(new Request(url, { method: c.req.method, headers, body }))
    })

    app.post('/demo/start', async (c) => {
      if (!flags.tenancy || !flags.demoEnabled) throw new Problem(404, 'flag/disabled', 'Not available', 'The demo door is off on this server.')
      const control = requireControl(ctx)
      if (!ctx.demo || !ctx.masterKey) throw new Problem(503, 'flag/disabled', 'Demo is not configured', 'The server has no demo template.')
      const ip = clientIp({ get: (name) => c.req.header(name) }, ctx.trustProxy)
      const since = new Date(ctx.now().getTime() - 3_600_000).toISOString()
      if (control.demosFromIp(control.hashIp(ip), since) >= flags.demoMaxPerIpHour) {
        throw new Problem(429, 'rate/limited', 'Too many demos', 'This network has started enough demos for this hour.')
      }
      if (control.countActiveDemos(ctx.now().toISOString()) >= flags.demoMaxActive) {
        throw new Problem(429, 'rate/limited', 'Too many demos', 'The server is hosting as many demos as it allows.')
      }
      const id = newWorkspaceId()
      mkdirSync(ctx.demo.root, { recursive: true })
      const dbPath = join(ctx.demo.root, `${id}.sqlite`)
      copyFileSync(ctx.demo.template, dbPath)
      const { privateKey } = generateKeyPairSync('ed25519')
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
      const now = ctx.now().toISOString()
      const expires = new Date(ctx.now().getTime() + flags.demoTtlHours * 3_600_000).toISOString()
      control.insertWorkspace({
        id,
        slug: id,
        name: 'Demo studio',
        mode: 'demo',
        paypal_mode: 'fake',
        db_path: dbPath,
        status: 'active',
        created_at: now,
        expires_at: expires,
        last_active_at: now,
        signing_key_sealed: seal(ctx.masterKey, pem),
      })
      const memberId = randomUUID()
      control.addMember({ id: memberId, workspaceId: id, name: 'Demo owner', role: 'owner', now })
      const token = randomBytes(32).toString('base64url')
      control.putSession({ token, memberId, workspaceId: id, method: 'demo', now, idleHours: ctx.idleHours, absoluteDays: ctx.absoluteDays, ip })
      control.event({ id: randomUUID(), at: now, workspaceId: id, memberId, event: 'demo.start', result: 'ok', ip })
      ctx.metrics.demos += 1
      c.header('set-cookie', writeSessionCookie(ctx.cookieSecure, token, ctx.absoluteDays * 86_400))
      return c.json({ workspaceId: id, expiresAt: expires, role: 'owner', mode: 'demo' })
    })

    app.post('/workspaces', async (c) => {
      if (!flags.tenancy || !flags.passkeys) throw new Problem(404, 'flag/disabled', 'Not available', 'Creating a studio is off on this server.')
      const control = requireControl(ctx)
      if (!ctx.webauthn || !ctx.demo || !ctx.masterKey) throw new Problem(503, 'flag/disabled', 'Not configured', 'Passkeys need a site name and origin.')
      const body = await c.req.json().catch(() => null) as { name?: string } | null
      const name = body?.name?.trim() ?? ''
      if (name.length < 2 || name.length > 80) throw new Problem(400, 'request.invalid', 'Request is invalid', 'Give the studio a name.')
      const id = newWorkspaceId()
      const now = ctx.now().toISOString()
      mkdirSync(ctx.demo.root, { recursive: true })
      const dbPath = join(ctx.demo.root, `${id}.sqlite`)
      copyFileSync(ctx.demo.template, dbPath)
      const { privateKey } = generateKeyPairSync('ed25519')
      control.insertWorkspace({
        id, slug: id, name, mode: 'studio', paypal_mode: 'fake', db_path: dbPath, status: 'active', created_at: now, expires_at: null, last_active_at: now,
        signing_key_sealed: seal(ctx.masterKey, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
      })
      const memberId = randomUUID()
      control.addMember({ id: memberId, workspaceId: id, name: 'Owner', role: 'owner', now })
      const started = await beginRegistration({ config: ctx.webauthn, store: control, memberId, memberName: name, workspaceId: id, now: ctx.now() })
      return c.json({ workspaceId: id, memberId, ...started, paypal: 'simulated' })
    })
  }

  app.post('/auth/register/options', async (c) => {
    if (!flags.passkeys) throw new Problem(404, 'flag/disabled', 'Not available', 'Passkeys are off on this server.')
    const control = requireControl(ctx)
    if (!ctx.webauthn) throw new Problem(503, 'flag/disabled', 'Not configured', 'Passkeys need a site name and origin.')
    const who = memberFromCookie(c, ctx)
    if (!who) throw new Problem(401, 'auth/required', 'Sign in required', 'Sign in before adding a passkey.')
    const started = await beginRegistration({ config: ctx.webauthn, store: control, memberId: who.member.id, memberName: who.member.display_name, workspaceId: who.member.workspace_id, now: ctx.now() })
    return c.json(started)
  })

  app.post('/auth/register/verify', async (c) => {
    if (!flags.passkeys) throw new Problem(404, 'flag/disabled', 'Not available', 'Passkeys are off on this server.')
    const control = requireControl(ctx)
    if (!ctx.webauthn) throw new Problem(503, 'flag/disabled', 'Not configured', 'Passkeys need a site name and origin.')
    const body = await c.req.json() as { challengeId?: string; response?: RegistrationResponseJSON }
    if (!body.challengeId || !body.response) throw new Problem(400, 'request.invalid', 'Request is invalid', 'Send the challenge and the passkey response.')
    try {
      const saved = await finishRegistration({ config: ctx.webauthn, store: control, challengeId: body.challengeId, response: body.response, now: ctx.now() })
      return c.json(saved)
    } catch {
      throw new Problem(401, 'auth/stepup-failed', 'Passkey was not accepted', 'The passkey did not match this site.')
    }
  })

  app.post('/auth/login/options', async (c) => {
    if (!flags.passkeys) throw new Problem(404, 'flag/disabled', 'Not available', 'Passkeys are off on this server.')
    const control = requireControl(ctx)
    if (!ctx.webauthn) throw new Problem(503, 'flag/disabled', 'Not configured', 'Passkeys need a site name and origin.')
    return c.json(await beginLogin({ config: ctx.webauthn, store: control, now: ctx.now() }))
  })

  app.post('/auth/login/verify', async (c) => {
    if (!flags.passkeys) throw new Problem(404, 'flag/disabled', 'Not available', 'Passkeys are off on this server.')
    const control = requireControl(ctx)
    if (!ctx.webauthn) throw new Problem(503, 'flag/disabled', 'Not configured', 'Passkeys need a site name and origin.')
    const body = await c.req.json() as { challengeId?: string; response?: AuthenticationResponseJSON }
    if (!body.challengeId || !body.response) throw new Problem(400, 'request.invalid', 'Request is invalid', 'Send the challenge and the passkey response.')
    try {
      const found = await finishLogin({ config: ctx.webauthn, store: control, challengeId: body.challengeId, response: body.response, now: ctx.now() })
      const member = control.member(found.memberId)
      if (!member || member.status !== 'active') throw new Error('member')
      const token = randomBytes(32).toString('base64url')
      const now = ctx.now().toISOString()
      control.putSession({ token, memberId: member.id, workspaceId: member.workspace_id, method: 'passkey', now, idleHours: ctx.idleHours, absoluteDays: ctx.absoluteDays })
      c.header('set-cookie', writeSessionCookie(ctx.cookieSecure, token, ctx.absoluteDays * 86_400))
      control.event({ id: randomUUID(), at: now, workspaceId: member.workspace_id, memberId: member.id, event: 'login', result: 'ok' })
      return c.json({ workspaceId: member.workspace_id, role: member.role, displayName: member.display_name })
    } catch {
      throw new Problem(401, 'auth/stepup-failed', 'Passkey was not accepted', 'The passkey did not match this site.')
    }
  })

  app.post('/auth/logout', (c) => {
    const who = memberFromCookie(c, ctx)
    if (who && ctx.control) ctx.control.revokeSession(who.token, ctx.now().toISOString())
    c.header('set-cookie', clearSessionCookie(ctx.cookieSecure))
    return c.json({ ok: true })
  })

  app.get('/auth/me', (c) => {
    const who = memberFromCookie(c, ctx)
    if (!who) throw new Problem(401, 'auth/required', 'Sign in required', 'No session.')
    return c.json({ memberId: who.member.id, workspaceId: who.member.workspace_id, role: who.member.role, displayName: who.member.display_name, method: who.session.method })
  })

  app.post('/auth/stepup/options', async (c) => {
    if (!flags.passkeys && ctx.workspaceMode !== 'demo') throw new Problem(404, 'flag/disabled', 'Not available', 'Passkeys are off on this server.')
    const who = memberFromCookie(c, ctx)
    if (!who) throw new Problem(401, 'auth/required', 'Sign in required', 'Sign in before approving.')
    if (who.session.method === 'recovery') throw new Problem(403, 'auth/forbidden', 'Recovery cannot approve', 'A recovery session can only add a passkey.')
    const control = requireControl(ctx)
    if (!ctx.webauthn) throw new Problem(503, 'flag/disabled', 'Not configured', 'Passkeys need a site name and origin.')
    const body = await c.req.json() as { kind?: string; binding?: string }
    const kind = body.kind ?? ''
    const binding = body.binding ?? ''
    if (!kind || !binding) throw new Problem(400, 'request.invalid', 'Request is invalid', 'Say what this signature is for.')
    const digest = createHash('sha256').update(`mandate/stepup/v1\n${kind}\n${binding}`).digest('base64url')
    const options = await generateAuthenticationOptions({
      rpID: ctx.webauthn.rpID,
      userVerification: 'required',
      challenge: digest,
      allowCredentials: control.credentials(who.member.id).filter((row) => !row.revoked_at).map((row) => ({ id: row.credential_id })),
    })
    const challengeId = randomUUID()
    control.putChallenge({
      id: challengeId,
      purpose: 'stepup',
      challenge: options.challenge,
      expiresAt: new Date(ctx.now().getTime() + 2 * 60_000).toISOString(),
      memberId: who.member.id,
      workspaceId: who.member.workspace_id,
      bindingKind: kind,
      bindingHash: binding,
    })
    return c.json({ challengeId, options })
  })

  app.post('/auth/stepup/verify', async (c) => {
    const who = memberFromCookie(c, ctx)
    if (!who || !ctx.control || !ctx.webauthn) throw new Problem(401, 'auth/required', 'Sign in required', 'Sign in before approving.')
    const body = await c.req.json() as { challengeId?: string; response?: AuthenticationResponseJSON }
    if (!body.challengeId || !body.response) throw new Problem(400, 'request.invalid', 'Request is invalid', 'Send the challenge and the passkey response.')
    const row = ctx.control.takeChallenge(body.challengeId, ctx.now().toISOString())
    if (!row || row.purpose !== 'stepup' || row.member_id !== who.member.id) throw new Problem(401, 'auth/stepup-failed', 'That approval expired', 'Ask for a new signature.')
    const stored = ctx.control.credential(body.response.id)
    if (!stored || stored.revoked_at || stored.member_id !== who.member.id) throw new Problem(401, 'auth/stepup-failed', 'Passkey was not accepted', 'This passkey is not on the account.')
    const credential: WebAuthnCredential = { id: stored.credential_id, publicKey: Buffer.from(stored.public_key, 'base64url'), counter: stored.counter }
    try {
      const verified = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: row.challenge,
        expectedOrigin: ctx.webauthn.origins,
        expectedRPID: ctx.webauthn.rpID,
        credential,
        requireUserVerification: true,
      })
      if (!verified.authenticationInfo.userVerified) throw new Error('uv')
      ctx.control.setCounter(stored.credential_id, verified.authenticationInfo.newCounter, ctx.now().toISOString())
    } catch {
      throw new Problem(401, 'auth/stepup-failed', 'Passkey was not accepted', 'The signature did not match.')
    }
    const grant = randomUUID()
    ctx.control.putGrant({ id: grant, memberId: who.member.id, workspaceId: who.member.workspace_id, kind: row.binding_kind ?? 'approve', binding: row.binding_hash ?? '', now: ctx.now().toISOString() })
    return c.json({ grant, kind: row.binding_kind, binding: row.binding_hash })
  })

  app.post('/auth/recovery/use', async (c) => {
    if (!flags.passkeys) throw new Problem(404, 'flag/disabled', 'Not available', 'Passkeys are off on this server.')
    const control = requireControl(ctx)
    const body = await c.req.json() as { memberId?: string; code?: string }
    if (!body.memberId || !body.code) throw new Problem(400, 'request.invalid', 'Request is invalid', 'Send the account and one code.')
    if (!control.useRecovery(body.memberId, body.code, ctx.now().toISOString())) throw new Problem(401, 'auth/forbidden', 'Code was not accepted', 'That code is used or unknown.')
    const member = control.member(body.memberId)
    if (!member) throw new Problem(401, 'auth/forbidden', 'Code was not accepted', 'That code is used or unknown.')
    const token = randomBytes(32).toString('base64url')
    control.putSession({ token, memberId: member.id, workspaceId: member.workspace_id, method: 'recovery', now: ctx.now().toISOString(), idleHours: 1, absoluteDays: 1 })
    c.header('set-cookie', writeSessionCookie(ctx.cookieSecure, token, 3_600))
    return c.json({ method: 'recovery', can: 'add a passkey' })
  })

  app.get('/auth/sessions', (c) => {
    const who = memberFromCookie(c, ctx)
    if (!who || !ctx.control) throw new Problem(401, 'auth/required', 'Sign in required', 'No session.')
    return c.json({ sessions: ctx.control.listSessions(who.member.id).map((row) => ({ at: row.created_at, lastSeen: row.last_seen_at, revoked: Boolean(row.revoked_at) })) })
  })

  app.get('/auth/events', (c) => {
    const who = memberFromCookie(c, ctx)
    if (!who || !ctx.control) throw new Problem(401, 'auth/required', 'Sign in required', 'No session.')
    if (who.member.role !== 'owner') throw new Problem(403, 'auth/forbidden', 'Owner required', 'Only an owner can read the sign-in history.')
    return c.json({ events: ctx.control.events(who.member.workspace_id) })
  })

  app.post('/v1/demo/simulate', async (c) => {
    if (ctx.workspaceMode !== 'demo') throw new Problem(404, 'tenant/not-found', 'Not found', 'Simulate exists only inside a demo.')
    if (!memberFromCookie(c, ctx)) throw new Problem(401, 'auth/required', 'Sign in required', 'The demo session is missing.')
    const body = await c.req.json().catch(() => ({})) as { action?: string }
    if (body.action === 'pay' && ctx.paypal?.pay) {
      const id = (body as { id?: string }).id
      if (!id) throw new Problem(400, 'request.invalid', 'Request is invalid', 'Name the invoice.')
      ctx.paypal.pay(id)
      return c.json({ ok: true })
    }
    if (body.action === 'payout_success') ctx.paypal?.settlePayouts?.('SUCCESS')
    else if (body.action === 'payout_fail') ctx.paypal?.settlePayouts?.('FAILED')
    else throw new Problem(400, 'request.invalid', 'Request is invalid', 'Use pay, payout_success, or payout_fail.')
    return c.json({ ok: true })
  })

  app.post('/v1/demo/switch', async (c) => {
    if (ctx.workspaceMode !== 'demo') throw new Problem(404, 'tenant/not-found', 'Not found', 'Role switch exists only inside a demo.')
    const control = requireControl(ctx)
    const who = memberFromCookie(c, ctx)
    if (!who || who.member.role !== 'owner') throw new Problem(403, 'auth/forbidden', 'Owner required', 'Only the demo owner can switch roles.')
    const body = await c.req.json() as { role?: 'owner' | 'approver' | 'proposer' | 'viewer' | 'payee' }
    const role = body.role
    if (!role) throw new Problem(400, 'request.invalid', 'Request is invalid', 'Name a role.')
    const memberId = randomUUID()
    control.addMember({ id: memberId, workspaceId: ctx.workspaceId, name: `Demo ${role}`, role, now: ctx.now().toISOString() })
    const token = randomBytes(32).toString('base64url')
    control.putSession({ token, memberId, workspaceId: ctx.workspaceId, method: 'demo', now: ctx.now().toISOString(), idleHours: ctx.idleHours, absoluteDays: ctx.absoluteDays })
    c.header('set-cookie', writeSessionCookie(ctx.cookieSecure, token, ctx.absoluteDays * 86_400))
    return c.json({ role })
  })

  app.post('/v1/invites', async (c) => {
    if (!flags.invites) throw new Problem(404, 'flag/disabled', 'Not available', 'Invites are off on this server.')
    const who = memberFromCookie(c, ctx)
    if (!who || who.member.role !== 'owner' || !ctx.control) throw new Problem(403, 'auth/forbidden', 'Owner required', 'Only an owner can invite.')
    if (!cookieWriteAllowed({ get: (name) => c.req.header(name) }, ctx.webauthn?.origins ?? [])) {
      throw new Problem(403, 'auth/csrf', 'Blocked', 'This browser was not the one that signed in.')
    }
    const body = await c.req.json() as { role?: 'approver' | 'proposer' | 'viewer' | 'payee'; label?: string }
    if (!body.role) throw new Problem(400, 'request.invalid', 'Request is invalid', 'Name a role.')
    const token = randomBytes(32).toString('base64url')
    const now = ctx.now()
    ctx.control.createInvite({
      id: randomUUID(),
      workspaceId: who.member.workspace_id,
      role: body.role,
      token,
      expiresAt: new Date(now.getTime() + flags.inviteTtlHours * 3_600_000).toISOString(),
      createdBy: who.member.id,
      now: now.toISOString(),
      label: body.label ?? null,
    })
    return c.json({ token, join: `/app/join#t=${token}` })
  })

  app.post('/join/preview', async (c) => {
    if (!flags.invites) throw new Problem(404, 'flag/disabled', 'Not available', 'Invites are off on this server.')
    const control = requireControl(ctx)
    const body = await c.req.json().catch(() => null) as { token?: string } | null
    if (!body?.token) throw new Problem(400, 'request.invalid', 'Request is invalid', 'Send the invite.')
    const peek = control.peekInvite(body.token, ctx.now().toISOString())
    if (!peek || peek.expired) throw new Problem(400, 'invite/invalid', 'Invite is not valid', 'That invite is used, expired, or unknown.')
    const workspace = control.workspace(peek.workspace_id)
    return c.json({ workspaceId: peek.workspace_id, name: workspace?.name ?? 'Studio', role: peek.role })
  })

  app.post('/join', async (c) => {
    if (!flags.invites) throw new Problem(404, 'flag/disabled', 'Not available', 'Invites are off on this server.')
    const control = requireControl(ctx)
    const body = await c.req.json() as { token?: string; name?: string }
    if (!body.token || !body.name) throw new Problem(400, 'request.invalid', 'Request is invalid', 'Send the invite and a name.')
    const invite = control.takeInvite(body.token, ctx.now().toISOString())
    if (!invite || invite.workspace_id !== ctx.workspaceId) throw new Problem(400, 'invite/invalid', 'Invite is not valid', 'That invite is used, expired, or for another studio.')
    const memberId = randomUUID()
    control.addMember({ id: memberId, workspaceId: invite.workspace_id, name: body.name, role: invite.role, now: ctx.now().toISOString(), createdBy: 'invite' })
    const sessionToken = randomBytes(32).toString('base64url')
    control.putSession({ token: sessionToken, memberId, workspaceId: invite.workspace_id, method: 'invite', now: ctx.now().toISOString(), idleHours: ctx.idleHours, absoluteDays: ctx.absoluteDays })
    c.header('set-cookie', writeSessionCookie(ctx.cookieSecure, sessionToken, ctx.absoluteDays * 86_400))
    return c.json({ memberId, role: invite.role, workspaceId: invite.workspace_id })
  })

  app.get('/v1/members', (c) => {
    const who = memberFromCookie(c, ctx)
    if (!who || !ctx.control) throw new Problem(401, 'auth/required', 'Sign in required', 'No session.')
    if (who.member.role !== 'owner') throw new Problem(403, 'auth/forbidden', 'Owner required', 'Only an owner can list members.')
    return c.json({ members: ctx.control.members(who.member.workspace_id) })
  })

  app.post('/v1/rules/simulate', async (c) => {
    const text = await c.req.text()
    let body: unknown = {}
    if (text.trim()) {
      try {
        body = JSON.parse(text) as unknown
      } catch {
        throw new Problem(400, 'request.invalid', 'Request is invalid', 'Body is not JSON.')
      }
    }
    const before = ctx.counts?.() ?? null
    let verdict: unknown = null
    if (body && typeof body === 'object' && 'request' in body) {
      if (!ctx.tryOne) throw new Problem(503, 'flag/disabled', 'Not configured', 'Simulate is not wired on this server.')
      verdict = ctx.tryOne(body)
    }
    const after = ctx.counts?.() ?? null
    if (before && after && (before.proposals !== after.proposals || before.events !== after.events || before.payees !== after.payees)) {
      throw new Problem(500, 'simulate.wrote', 'Simulate wrote rows', 'The try changed the ledger. That is a bug.')
    }
    return c.json({ ok: true, wrote: false, verdict })
  })

  app.get('/v1/payees', (c) => {
    if (!flags.payeeBook) throw new Problem(404, 'flag/disabled', 'Not available', 'The payee book is off on this server.')
    if (!ctx.listPayees) throw new Problem(503, 'flag/disabled', 'Not configured', 'The payee book is not wired on this server.')
    return c.json({ payees: ctx.listPayees() })
  })
}
