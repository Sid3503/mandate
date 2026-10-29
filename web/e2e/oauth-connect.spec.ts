import { createHash, randomBytes } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'

const OWNER = 'owner-e2e-key-0123456789'
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'

test.beforeEach(({}, info) => {
  test.skip(info.project.name === 'passkey', 'this signs in with the owner key; the passkey server has its own sign-in')
})

async function unlock(page: Page) {
  await page.goto('/app/unlock')
  await page.getByLabel('API key').fill(OWNER)
  await page.getByRole('button', { name: 'Unlock console' }).click()
  await expect(page.getByRole('heading', { name: /Waiting for you/ })).toBeVisible()
}

test('an app that signs in with a browser is approved on the console and gets a key that can only look', async ({ page, request }) => {
  const registered = await request.post('/oauth/register', { data: { client_name: 'Claude', redirect_uris: [REDIRECT] } })
  expect(registered.status()).toBe(201)
  const { client_id: clientId } = await registered.json() as { client_id: string }
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')

  await unlock(page)
  // The client's own site is not on the network here: catch the redirect and read what it carried.
  await page.route('https://claude.ai/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>claude</p>' }))
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'abc123' })
  await page.goto(`/oauth/authorize?${query}`)

  await expect(page).toHaveURL(/\/app\/connect\/authorize\?/)
  await expect(page.getByTestId('oauth-client-name')).toHaveText('Claude')
  await expect(page.getByTestId('oauth-redirect-host')).toHaveText('claude.ai')
  await expect(page.getByTestId('oauth-grant-look')).toBeChecked()

  await page.getByTestId('oauth-approve').click()
  await page.waitForURL(/claude\.ai\/api\/mcp\/auth_callback/)
  const back = new URL(page.url())
  expect(back.searchParams.get('state')).toBe('abc123')
  const code = back.searchParams.get('code')
  expect(code).toBeTruthy()

  const issued = await request.post('/oauth/token', { form: { grant_type: 'authorization_code', code: code!, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier } })
  expect(issued.status()).toBe(200)
  const tokens = await issued.json() as { access_token: string; scope: string }
  expect(tokens.scope).toBe('mcp:look')

  const listed = await request.post('/mcp', { headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
  expect(listed.status()).toBe(200)
  const names = ((await listed.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name)
  expect(names).toContain('get_rules')
  expect(names).not.toContain('propose')

  // The connection is an ordinary agent: it is on the Connect page, where the owner can end it.
  await page.goto('/app/system')
  await expect(page.getByText('Claude (sign-in) · looks only').first()).toBeVisible()
})

test('saying no sends the app back with a refusal and no code', async ({ page, request }) => {
  const registered = await request.post('/oauth/register', { data: { client_name: 'Some app', redirect_uris: [REDIRECT] } })
  const { client_id: clientId } = await registered.json() as { client_id: string }
  const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url')
  await unlock(page)
  await page.route('https://claude.ai/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>claude</p>' }))
  await page.goto(`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' })}`)
  await page.getByTestId('oauth-deny').click()
  await page.waitForURL(/claude\.ai\/api\/mcp\/auth_callback/)
  const back = new URL(page.url())
  expect(back.searchParams.get('error')).toBe('access_denied')
  expect(back.searchParams.has('code')).toBe(false)
})

test('an agent that is turned away at the door shows on the Connect page', async ({ page, request }) => {
  const headers = { authorization: `Bearer ${OWNER}` }
  const made = await request.post('/v1/agents', { headers, data: { name: 'Nosy bot', scopes: ['mcp', 'read'] } })
  expect(made.status()).toBe(201)
  const { apiKey } = await made.json() as { apiKey: string }
  const denied = await request.post('/v1/proposals', { headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': `nosy-${Date.now()}` }, data: { kind: 'payment', payee: 'Priya', amountCents: 9000, currency: 'USD', category: 'design', description: 'x', evidenceUrl: 'https://www.figma.com/file/x' } })
  expect(denied.status()).toBe(403)
  await unlock(page)
  await page.goto('/app/connect')
  const row = page.getByTestId('agent-activity-refused').filter({ hasText: 'Nosy bot' })
  await expect(row).toBeVisible()
  await expect(row).toContainText('Outside its scope')
})
