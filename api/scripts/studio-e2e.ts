// End-to-end check of the "Create your studio" door: a name, a passkey, a sign-in, a studio of its own, and money that
// waits for a signature.
//
//   npm run studio:e2e -- http://localhost:8791
//
// The passkey is a software one, so this needs no browser and no device. Everything happens on the server it is given.
// The studio it opens runs on that server's simulated PayPal: no real money moves and no card is charged.
//
// The server must have the door open: FLAG_TENANCY=1 and FLAG_PASSKEYS=1, with MASTER_KEY, KEY_PEPPER, WEBAUTHN_RP_ID
// and WEBAUTHN_ORIGINS set. If the door is off, the first check says so and the script stops.
import { randomUUID } from 'node:crypto'
import { SoftAuthenticator } from '../test/soft-authenticator'

const args = process.argv.slice(2)
const target = args.find((arg) => /^https?:\/\//.test(arg))
if (!target) {
  console.error('Usage: npm run studio:e2e -- http://localhost:8791')
  process.exit(2)
}
const base = target.replace(/\/$/, '')
const origin = new URL(base).origin
// The relying party id must match the host the browser is on. A server on 127.0.0.1 is reached as localhost, because
// Chrome refuses an IP address as a relying party id.
const rpID = process.env.WEBAUTHN_RP_ID ?? 'localhost'
const ownerKey = process.env.STUDIO_E2E_OWNER_KEY ?? 'dev-mandate-key-change-me'

let failed = 0
const pass = (message: string) => console.log(`  ✓ ${message}`)
const fail = (message: string) => { failed += 1; console.log(`  ✗ ${message}`) }
const check = (ok: boolean, good: string, bad: string) => (ok ? pass(good) : fail(bad))

type Answer = { status: number; headers: Headers; text: string; json: any }
async function request(path: string, init: RequestInit = {}): Promise<Answer> {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(30_000), redirect: 'manual' })
  const text = await response.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  return { status: response.status, headers: response.headers, text, json }
}

// The console keeps its session in a cookie. Once it knows which studio it is in, it sends the tenant routes to that
// studio and says it is the web. This mirrors what web/src/lib/api.ts does, so the check runs the same path a person does.
let cookie = ''
let workspaceId = ''
function scope(path: string): string {
  const tenant = Boolean(workspaceId) && (path.startsWith('/v1/') || path.startsWith('/auth/'))
  return tenant ? `/w/${workspaceId}${path}` : path
}
function asWeb(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra }
  if (cookie) headers.cookie = cookie
  return headers
}
/** A write from the console: the browser's own origin, and the marker the console sends. */
function fromConsole(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra, origin, 'x-mandate-client': 'web' }
  if (cookie) headers.cookie = cookie
  return headers
}

async function main() {
  console.log(`Mandate studio end-to-end · ${base}`)
  const studioName = `Studio E2E ${new Date().toISOString().slice(0, 16).replace(/[^0-9]/g, '')}`

  const health = await request('/healthz')
  if (health.status !== 200) {
    fail(`the server does not answer /healthz (${health.status})`)
    return finish()
  }
  pass('the server answers')

  // 1. The name. This is the first thing a person types.
  const opened = await request('/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: studioName }),
  })
  if (opened.status === 404) {
    fail('the studio door is off on this server (FLAG_TENANCY and FLAG_PASSKEYS must be on)')
    return finish()
  }
  const started = opened.json ?? {}
  const studioId = String(started.workspaceId ?? '')
  check(opened.status === 200 && /^ws_[a-z2-7]{20}$/.test(studioId), `the studio is created (${studioId})`, `the studio was not created (${opened.status}: ${opened.text.slice(0, 120)})`)
  check(typeof started.memberId === 'string' && typeof started.challengeId === 'string', 'it names the owner and the challenge', 'it named no owner or no challenge')
  check(['sandbox', 'fake'].includes(String(started.paypal)), `it says which PayPal the studio moves money on (${String(started.paypal)})`, `it did not say which PayPal it uses (${String(started.paypal)})`)
  if (failed > 0) return finish()

  // 2. The passkey. The browser makes this one; the software authenticator speaks the same messages.
  const auth = new SoftAuthenticator(origin, rpID)
  const registered = await request('/auth/register/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId: started.challengeId, response: auth.register(started.options.challenge) }),
  })
  const fingerprint = String(registered.json?.fingerprint ?? '')
  check(registered.status === 200 && /^[0-9a-f]{16}$/.test(fingerprint), `the passkey is saved (fingerprint ${fingerprint})`, `the passkey was not accepted (${registered.status}: ${registered.text.slice(0, 120)})`)

  // 3. The sign-in that follows, exactly as the console does it.
  const login = await request('/auth/login/options', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  check(login.status === 200 && typeof login.json?.challengeId === 'string', 'the server offers a sign-in challenge', `the server did not offer a challenge (${login.status})`)
  const signedIn = await request('/auth/login/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId: login.json.challengeId, response: auth.authenticate(login.json.options.challenge) }),
  })
  const setCookie = signedIn.headers.get('set-cookie') ?? ''
  cookie = setCookie.split(';')[0] ?? ''
  check(signedIn.status === 200 && cookie.startsWith('mnd_session='), 'the passkey signs in and the session cookie is set', `the sign-in failed (${signedIn.status}: ${signedIn.text.slice(0, 120)})`)
  check(signedIn.json?.workspaceId === studioId && signedIn.json?.role === 'owner', 'the sign-in lands in the new studio as its owner', `the sign-in landed somewhere else (${String(signedIn.json?.workspaceId)} / ${String(signedIn.json?.role)})`)
  workspaceId = studioId

  // 4. The studio is its own place.
  const me = await request(scope('/auth/me'), { headers: asWeb() })
  check(me.status === 200 && me.json?.workspaceId === studioId && me.json?.role === 'owner', 'the studio knows its owner', `the studio does not know its owner (${me.status}: ${me.text.slice(0, 120)})`)

  const session = await request(scope('/v1/session'), { headers: asWeb() })
  check(session.status === 200 && session.json?.studioName === studioName, 'the console is told the studio\'s own name', `the console was told the wrong name (${String(session.json?.studioName)})`)
  check(session.status === 200 && ['fake', 'sandbox'].includes(String(session.json?.paypalMode)), `the console is told which PayPal the studio moves money on (${String(session.json?.paypalMode)})`, `the console was not told which PayPal the studio uses (${String(session.json?.paypalMode)})`)

  const today = await request(scope('/v1/today'), { headers: asWeb() })
  check(today.status === 200, 'Today opens in the new studio', `Today does not open (${today.status}: ${today.text.slice(0, 120)})`)

  const listed = await request(scope('/v1/warrant'), { headers: asWeb() })
  check(listed.status === 404, 'the studio starts with no rules of its own', `the studio starts with rules (${listed.status}: ${listed.text.slice(0, 120)})`)
  const asked0 = await request(scope('/v1/proposals'), {
    method: 'POST',
    headers: fromConsole({ 'content-type': 'application/json', 'idempotency-key': `studio-e2e-${randomUUID()}` }),
    body: JSON.stringify({ kind: 'charge', payee: 'Northwind', amountCents: 9000, currency: 'USD', category: 'design', description: 'Before the rules', evidenceUrl: 'https://example.com/logo', jobId: 'studio_e2e_logo' }),
  })
  check(asked0.status === 404, 'nothing may be asked for money before the rules exist', `money was asked for without rules (${asked0.status})`)

  // 5. Its own ledger, its own key, its own money.
  const studioKeys = await request(`/w/${studioId}/.well-known/mandate-keys.json`)
  const homeKeys = await request('/.well-known/mandate-keys.json')
  const studioKey = JSON.stringify(studioKeys.json ?? {})
  const homeKey = JSON.stringify(homeKeys.json ?? {})
  check(studioKeys.status === 200 && homeKeys.status === 200 && studioKey !== homeKey && studioKey.length > 20, 'the studio signs with its own key', 'the studio shares the default studio\'s signing key')

  // 6. A second key and the recovery codes: the wizard asks for one of the two before Today.
  const second = await request(scope('/auth/register/options'), { method: 'POST', headers: fromConsole(), body: '{}' })
  check(second.status === 200, 'the account can take a second passkey', `a second passkey was refused (${second.status}: ${second.text.slice(0, 120)})`)
  const secondAuth = new SoftAuthenticator(origin, rpID)
  const secondSaved = await request(scope('/auth/register/verify'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId: second.json?.challengeId, response: secondAuth.register(second.json?.options?.challenge) }),
  })
  check(secondSaved.status === 200, 'the second passkey is saved', `the second passkey was not accepted (${secondSaved.status})`)
  const keys = await request(scope('/auth/credentials'), { headers: asWeb() })
  check(keys.status === 200 && (keys.json?.credentials ?? []).length === 2, 'the account holds two passkeys', `the account holds ${(keys.json?.credentials ?? []).length} passkeys`)

  const codes = await request(scope('/auth/recovery/issue'), { method: 'POST', headers: fromConsole() })
  check(codes.status === 200 && (codes.json?.codes ?? []).length === 8, 'the recovery codes are issued', `the recovery codes were not issued (${codes.status}: ${codes.text.slice(0, 120)})`)
  const ack = await request(scope('/auth/recovery/ack'), { method: 'POST', headers: fromConsole({ 'content-type': 'application/json' }), body: JSON.stringify({ saved: true }) })
  check(ack.status === 200, 'the owner says the codes are saved', `the codes were not acknowledged (${ack.status})`)

  // 7. The owner's own words become the rules, and the rules are signed with the passkey like everything else.
  const words = await request(scope('/v1/rules/words'), { method: 'POST', headers: fromConsole({ 'content-type': 'application/json' }), body: JSON.stringify({ text: 'Pay a contractor only when the client has paid.' }) })
  check(words.status === 200, 'the words in the owner\'s own words are kept on the server', `the words were not kept (${words.status}: ${words.text.slice(0, 120)})`)
  const rules = {
    currency: 'USD',
    autoSettleUnderCents: 2000,
    monthlyCapCents: 18000,
    perPaymentCeilingCents: 50000,
    evidenceRequired: true,
    timezone: 'UTC',
    payees: [{ id: 'payee_priya', displayName: 'Priya Shah', email: 'priya.shah@example.com', aliases: ['Priya'] }],
    categories: ['design'],
    clients: [{ id: 'client_northwind', displayName: 'Northwind', email: 'ap@northwind.example', aliases: ['Northwind'] }],
    fundingRequired: true,
    contractorShareBps: 10000,
    clearingDays: 0,
    allowPartialPayment: false,
    standing: [],
    automation: { billSignedDeals: false, requireAcceptance: false, payOnSettle: false, remindUnpaidAfterDays: null, maxReminders: 2 },
  }
  const ruleStep = await request(scope('/auth/stepup/options'), { method: 'POST', headers: fromConsole({ 'content-type': 'application/json' }), body: JSON.stringify({ kind: 'rules', rules }) })
  const ruleSigned = await request(scope('/auth/stepup/verify'), { method: 'POST', headers: fromConsole({ 'content-type': 'application/json' }), body: JSON.stringify({ challengeId: ruleStep.json?.challengeId, response: secondAuth.authenticate(ruleStep.json?.options?.challenge) }) })
  check(ruleStep.status === 200 && ruleSigned.status === 200, 'the server asks for the rules to be signed', `the rules were not asked to be signed (${ruleStep.status}/${ruleSigned.status})`)
  const published = await request(scope('/v1/warrant'), { method: 'PUT', headers: fromConsole({ 'content-type': 'application/json', 'x-mandate-stepup': String(ruleSigned.json?.grant ?? ''), 'x-expected-version': '0' }), body: JSON.stringify(rules) })
  check(published.status === 200 || published.status === 201, 'the studio has its first version of the rules', `the rules were not published (${published.status}: ${published.text.slice(0, 160)})`)
  check(published.json?.version === 1, 'it is version 1', `it is version ${String(published.json?.version)}`)
  const wordsGone = await request(scope('/v1/rules/words'), { headers: asWeb() })
  check(wordsGone.status === 200 && wordsGone.json?.words === null, 'the words are done once they are rules', 'the words are still there after the rules were published')

  // 8. Money waits for a signature. A new studio asks for a passkey before it lets money move.
  const asked = await request(scope('/v1/proposals'), {
    method: 'POST',
    headers: fromConsole({ 'content-type': 'application/json', 'idempotency-key': `studio-e2e-${randomUUID()}` }),
    body: JSON.stringify({ kind: 'charge', payee: 'Northwind', amountCents: 9000, currency: 'USD', category: 'design', description: 'Spring launch logo', evidenceUrl: 'https://example.com/logo', jobId: 'studio_e2e_logo' }),
  })
  const proposalId = String(asked.json?.id ?? '')
  check(asked.status === 201 && proposalId.length > 0, 'a request for money is accepted', `the request was refused (${asked.status}: ${asked.text.slice(0, 120)})`)
  check(asked.json?.gate === 'NEEDS_APPROVAL' && asked.json?.phase === 'pending_approval', `the request waits for the owner (${String(asked.json?.gate)}, ${String(asked.json?.phase)})`, `the request did not wait (${String(asked.json?.gate)}: ${String(asked.json?.detail)})`)

  const bare = await request(scope(`/v1/proposals/${proposalId}/approve`), { method: 'POST', headers: fromConsole() })
  check(bare.status === 401 && bare.json?.code === 'auth/stepup-required', 'the money waits for a signature', `the money did not wait (${bare.status}: ${bare.text.slice(0, 120)})`)

  const step = await request(scope('/auth/stepup/options'), {
    method: 'POST',
    headers: fromConsole({ 'content-type': 'application/json' }),
    body: JSON.stringify({ kind: 'approve', proposalId }),
  })
  check(step.status === 200 && typeof step.json?.challengeId === 'string', 'the server asks for the signature on that request', `the server did not ask for a signature (${step.status}: ${step.text.slice(0, 120)})`)
  const signed = await request(scope('/auth/stepup/verify'), {
    method: 'POST',
    headers: fromConsole({ 'content-type': 'application/json' }),
    body: JSON.stringify({ challengeId: step.json?.challengeId, response: secondAuth.authenticate(step.json?.options?.challenge) }),
  })
  const grant = String(signed.json?.grant ?? '')
  check(signed.status === 200 && grant.length > 0, 'the passkey signs it', `the signature was not accepted (${signed.status}: ${signed.text.slice(0, 120)})`)

  const approved = await request(scope(`/v1/proposals/${proposalId}/approve`), { method: 'POST', headers: fromConsole({ 'x-mandate-stepup': grant }) })
  check(approved.status === 200, 'the request is approved with the signature', `the request was not approved (${approved.status}: ${approved.text.slice(0, 120)})`)
  check(approved.json?.phase === 'locked' && typeof approved.json?.lockSignature === 'string', `the request is locked and signed (${String(approved.json?.phase)})`, `the request is ${String(approved.json?.phase)} with no lock signature`)

  // The money itself, on the PayPal the studio really uses. A stand-in takes it at once; a real sandbox account opens
  // an order for the client to pay. Either way it is the server's own PayPal, not a second code path.
  const captured = await request(scope(`/v1/proposals/${proposalId}/capture`), { method: 'POST', headers: fromConsole() })
  const tookMoney = typeof captured.json?.captureId === 'string'
  const openedOrder = typeof captured.json?.orderId === 'string'
  const sentInvoice = typeof captured.json?.invoiceId === 'string'
  check(captured.status === 200 && (tookMoney || openedOrder || sentInvoice), tookMoney ? 'the studio took the money' : openedOrder ? 'the studio opened a PayPal order for the client to pay' : sentInvoice ? 'the studio sent the client a PayPal invoice' : 'the money did not move', `the money did not move (${captured.status}: ${captured.text.slice(0, 200)})`)

  // 8. One studio's money is not another's.
  const home = await request('/v1/proposals', { headers: { authorization: `Bearer ${ownerKey}` } })
  const homeIds = ((home.json?.data ?? []) as Array<{ id: string }>).map((row) => row.id)
  check(home.status === 200 && !homeIds.includes(proposalId), 'the default studio cannot see the new studio\'s request', `the default studio cannot be read (${home.status}) or it can see the new studio's request`)

  finish()
}

function finish() {
  console.log(failed === 0 ? '\nThe studio door works end to end.' : `\n${failed} check(s) failed.`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`studio end-to-end crashed: ${String((error as Error).message).slice(0, 240)}`)
  process.exit(1)
})
