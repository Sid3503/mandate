// Smoke test for a deployed Mandate: is it the build we meant to ship, and does it behave?
//
//   npm run smoke -- https://your-host                       checks what is running now
//   npm run smoke -- https://your-host --commit <sha>        first waits until that commit is the one running
//   MANDATE_OWNER_KEY=... npm run smoke -- https://your-host adds a check through the MCP door with a short-lived key
//
// It is safe to point at a live demo: everything it does is a read, except that the optional check makes one read-only
// agent key and revokes it again before it finishes. Keys are read from the environment and never printed. It never asks
// for money to move, so it leaves nothing on the ledger.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const args = process.argv.slice(2)
const flag = (name: string) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const target = args.find((arg) => /^https?:\/\//.test(arg))
const commit = flag('--commit')?.trim().toLowerCase()
const waitSeconds = Number(flag('--wait') ?? 900)
const ownerKey = process.env.MANDATE_OWNER_KEY
if (!target || (commit !== undefined && !/^[0-9a-f]{7,40}$/.test(commit)) || !Number.isFinite(waitSeconds)) {
  console.error('Usage: npm run smoke -- https://your-host [--commit <sha>] [--wait <seconds>]   (MANDATE_OWNER_KEY in the environment adds the MCP check)')
  process.exit(2)
}
const base = target.replace(/\/$/, '')
const origin = new URL(base).origin
const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)

// Tools that could move money. The door never offers one.
const FORBIDDEN = ['approve', 'reject', 'capture', 'pay', 'send_payout', 'refund', 'publish_rules', 'cancel', 'settle']

let failed = 0
const pass = (message: string) => console.log(`  ✓ ${message}`)
const warn = (message: string) => console.log(`  ! ${message}`)
const fail = (message: string) => { failed += 1; console.log(`  ✗ ${message}`) }
const check = (ok: boolean, good: string, bad: string) => (ok ? pass(good) : fail(bad))
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(20_000), redirect: 'manual' })
  const text = await response.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  return { status: response.status, headers: response.headers, text, json }
}

/** Waits for the service to answer /ready: a free instance that was asleep takes about a minute to wake. */
async function ready(untilCommit: string | undefined, seconds: number) {
  const deadline = Date.now() + seconds * 1000
  let lastNote = 0
  let last: Awaited<ReturnType<typeof request>> | null = null
  while (Date.now() < deadline) {
    try {
      last = await request('/ready')
      const running = typeof last.json?.releaseId === 'string' ? last.json.releaseId : null
      const same = running !== null && untilCommit !== undefined && (running.startsWith(untilCommit.slice(0, 7)) || untilCommit.startsWith(running.slice(0, 7)))
      if (last.status === 200 && (untilCommit === undefined || same)) return { response: last, timedOut: false }
      if (Date.now() - lastNote > 30_000) {
        lastNote = Date.now()
        console.log(`  … waiting${untilCommit ? ` for ${untilCommit.slice(0, 7)}` : ''}: ready answers ${last.status}${running ? `, running ${running.slice(0, 7)}` : ''}`)
      }
    } catch {
      if (Date.now() - lastNote > 30_000) { lastNote = Date.now(); console.log('  … waiting: no answer yet') }
    }
    await pause(10_000)
  }
  return { response: last, timedOut: true }
}

async function main() {
  console.log(`Mandate smoke test · ${base}${commit ? ` · expecting ${commit.slice(0, 7)}` : ''}`)

  const { response: readyAnswer, timedOut } = await ready(commit, commit ? waitSeconds : 120)
  if (!readyAnswer || timedOut) {
    fail(commit ? `the service did not report commit ${commit.slice(0, 7)} within ${waitSeconds}s${readyAnswer?.json?.releaseId ? ` (it reports ${String(readyAnswer.json.releaseId).slice(0, 7)})` : ''}` : 'the service did not answer /ready within 2 minutes')
    return finish()
  }
  const body = readyAnswer.json ?? {}
  check(readyAnswer.status === 200 && body.status === 'pass', `/ready passes (${body.version ? `v${body.version}` : 'no version'})`, `/ready says ${readyAnswer.status} ${body.status ?? ''}`)
  check(body.checks?.['sqlite:read']?.[0]?.status === 'pass', 'the database answers', 'the database check did not pass')
  if (commit) pass(`running commit ${String(body.releaseId).slice(0, 7)}`)
  else if (body.releaseId) pass(`running commit ${String(body.releaseId).slice(0, 7)}`)
  else warn('the service does not say which commit it runs (RENDER_GIT_COMMIT or GIT_COMMIT is not set)')
  if (body.checks?.['paypal:credentials']?.[0]?.observedValue !== 'configured') warn('PayPal credentials are not configured on this server')
  if (body.checks?.['agents:model']?.[0]?.observedValue === 'off') warn('the AI model is off (OLLAMA_API_KEY is not set)')

  const health = await request('/health')
  check(health.status === 200 && health.json?.status === 'pass', '/health passes', `/health says ${health.status}`)
  check(health.headers.get('x-content-type-options') === 'nosniff' && health.headers.get('x-frame-options') === 'DENY', 'security headers are on', 'security headers are missing (nosniff, frame deny)')

  const spec = await request('/openapi.json')
  const server: string | undefined = spec.json?.servers?.[0]?.url
  check(spec.status === 200 && typeof server === 'string' && !server.includes('0.0.0.0') && (local || server.replace(/\/$/, '') === origin), `public links point at ${server}`, `public links point at ${String(server)}, not at ${origin} (PUBLIC_URL or RENDER_EXTERNAL_URL is wrong)`)

  const app = await request('/app/', { headers: { accept: 'text/html' } })
  check(app.status === 200 && (app.headers.get('content-type') ?? '').includes('text/html'), 'the console page loads', `/app/ says ${app.status}`)
  check(Boolean(app.headers.get('content-security-policy')), 'the console sends a content security policy', 'the console has no content security policy')
  const script = /src="(\/app\/assets\/[^"]+\.js)"/.exec(app.text)?.[1]
  if (script) {
    const asset = await request(script)
    check(asset.status === 200 && (asset.headers.get('content-type') ?? '').includes('javascript'), 'the console\'s script loads', `the console script answers ${asset.status}`)
  } else {
    fail('the console page names no script (the web build may be missing)')
  }

  const keys = await request('/.well-known/mandate-keys.json')
  check(keys.status === 200 && keys.text.length > 20, 'the public signing keys are published', `/.well-known/mandate-keys.json says ${keys.status}`)

  const wall = await request('/v1/warrant')
  check(wall.status === 401, 'the API refuses a caller with no key', `/v1/warrant with no key says ${wall.status}, not 401`)
  const door = await request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer mnd_ag_smoketestwrongkeysmoketest' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })
  check(door.status === 401, 'the MCP door refuses a wrong key', `/mcp with a wrong key says ${door.status}, not 401`)

  if (ownerKey) await deep(ownerKey)
  else console.log('  · set MANDATE_OWNER_KEY to also check the MCP door with a short-lived key')
  finish()
}

/** One read-only agent key, used through MCP and revoked again. The key lives only in this function. */
async function deep(owner: string) {
  const auth = { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }
  const made = await request('/v1/agents', { method: 'POST', headers: auth, body: JSON.stringify({ name: `ci-smoke ${new Date().toISOString().slice(0, 16)}`, scopes: ['mcp', 'read'] }) })
  if (made.status !== 201 || typeof made.json?.apiKey !== 'string') {
    fail(`could not make a short-lived agent key (${made.status}${made.status === 401 ? ': the owner key was not accepted' : ''})`)
    return
  }
  const { apiKey, agent } = made.json as { apiKey: string; agent: { id: string } }
  try {
    const client = new Client({ name: 'mandate-smoke', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${apiKey}` } } }))
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort()
    check(names.includes('get_rules'), `a read-only key connects and sees: ${names.join(', ')}`, `a read-only key sees ${names.join(', ') || 'no tools'}`)
    check(!names.includes('propose') && !names.includes('offer_deal'), 'the key\'s scopes bind its tools (a read-only key cannot ask)', 'a read-only key was offered a tool that asks: scopes are not binding')
    check(!names.some((name) => FORBIDDEN.includes(name)), 'no tool can approve, pay or change the rules', `a tool that could move money is listed: ${names.filter((name) => FORBIDDEN.includes(name)).join(', ')}`)
    const rules = await client.callTool({ name: 'get_rules', arguments: {} })
    check(rules.isError !== true && typeof (rules.structuredContent as { version?: unknown } | undefined)?.version === 'number', 'the rules can be read through the door', 'get_rules failed through the door')
    await client.close()
  } catch (error) {
    fail(`the MCP door check failed: ${String((error as Error).message).slice(0, 160).replace(apiKey, '<key>')}`)
  } finally {
    const revoked = await request(`/v1/agents/${agent.id}/revoke`, { method: 'POST', headers: auth })
    check(revoked.status === 200, 'the short-lived key was revoked again', `the short-lived key could NOT be revoked (${revoked.status}): revoke "ci-smoke" on System`)
    const after = await request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })
    check(after.status === 403, 'a revoked key is refused at the door', `a revoked key still answers ${after.status}`)
  }
}

function finish() {
  console.log(failed === 0 ? '\nThe deploy looks healthy.' : `\n${failed} check(s) failed.`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`smoke test crashed: ${String((error as Error).message).slice(0, 240)}`)
  process.exit(1)
})
