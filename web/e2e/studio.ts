import { expect, type Page } from '@playwright/test'

/**
 * The rules a studio starts with when its owner writes them: one client, one contractor, and the numbers that decide
 * what pays without a tap. The server refuses anything else, so a test that needs a populated studio writes them the
 * way the owner does: a passkey signs them.
 */
export const FIRST_RULES = {
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

const b64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer)
  let out = ''
  for (const byte of bytes) out += String.fromCharCode(byte)
  return btoa(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Asks the browser's authenticator to sign a challenge, and returns the answer the server expects. */
async function sign(page: Page, challengeId: string, options: Record<string, unknown>) {
  const answer = await page.evaluate(async (opts) => {
    const fromB64 = (value: string): ArrayBuffer => {
      const padded = value.replace(/-/g, '+').replace(/_/g, '/')
      const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
      const bytes = new Uint8Array(raw.length)
      for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index)
      return bytes.buffer
    }
    const toB64 = (value: ArrayBuffer): string => {
      const bytes = new Uint8Array(value)
      let out = ''
      for (const byte of bytes) out += String.fromCharCode(byte)
      return btoa(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    }
    // The server sends the options as JSON; the browser wants the binary form.
    const wanted = opts as unknown as { challenge: string; allowCredentials?: Array<{ id: string; type: string }> }
    const credential = await navigator.credentials.get({
      publicKey: {
        ...wanted,
        challenge: fromB64(wanted.challenge),
        allowCredentials: (wanted.allowCredentials ?? []).map((item) => ({ ...item, id: fromB64(item.id) })),
      } as unknown as PublicKeyCredentialRequestOptions,
    })
    if (!credential) throw new Error('no credential')
    const response = credential.response as AuthenticatorAssertionResponse
    return {
      id: credential.id,
      rawId: toB64(credential.rawId),
      type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: toB64(response.clientDataJSON),
        authenticatorData: toB64(response.authenticatorData),
        signature: toB64(response.signature),
        userHandle: response.userHandle ? toB64(response.userHandle) : null,
      },
    }
  }, options)
  return { challengeId, response: answer }
}

/**
 * Publishes the studio's first version of the rules. The owner signs them with a passkey, and the server refuses
 * anything else, so this signs with the browser's own authenticator: the same path a person takes.
 */
export async function writeFirstRules(page: Page, workspace: string): Promise<void> {
  const headers = { origin: 'http://localhost:8777', 'x-mandate-client': 'web' }
  const asked = await page.request.post(`/w/${workspace}/auth/stepup/options`, { headers, data: { kind: 'rules', rules: FIRST_RULES } })
  expect(asked.ok()).toBe(true)
  const { challengeId, options } = await asked.json() as { challengeId: string; options: Record<string, unknown> }
  const signed = await sign(page, challengeId, options)
  const verified = await page.request.post(`/w/${workspace}/auth/stepup/verify`, { headers: { ...headers, 'content-type': 'application/json' }, data: signed })
  expect(verified.ok()).toBe(true)
  const { grant } = await verified.json() as { grant: string }
  const published = await page.request.put(`/w/${workspace}/v1/warrant`, {
    headers: { ...headers, 'content-type': 'application/json', 'x-mandate-stepup': grant, 'x-expected-version': '0' },
    data: FIRST_RULES,
  })
  expect(published.ok()).toBe(true)
}

/** The workspace the console is in, as the console itself remembers it. */
export async function currentWorkspace(page: Page): Promise<string> {
  const workspace = await page.evaluate(() => sessionStorage.getItem('mandate.workspace'))
  expect(workspace).toBeTruthy()
  return workspace as string
}

/**
 * The owner attests a payee they have just written into the rules. A payee nobody has paid before waits first, so the
 * owner says so with a passkey: the same path the Payees screen takes.
 */
export async function attestPayee(page: Page, workspace: string, payeeId: string): Promise<void> {
  const headers = { origin: 'http://localhost:8777', 'x-mandate-client': 'web' }
  const asked = await page.request.post(`/w/${workspace}/auth/stepup/options`, { headers, data: { kind: 'payee.attest', payeeId } })
  expect(asked.ok()).toBe(true)
  const { challengeId, options } = await asked.json() as { challengeId: string; options: Record<string, unknown> }
  const signed = await sign(page, challengeId, options)
  const verified = await page.request.post(`/w/${workspace}/auth/stepup/verify`, { headers: { ...headers, 'content-type': 'application/json' }, data: signed })
  expect(verified.ok()).toBe(true)
  const { grant } = await verified.json() as { grant: string }
  const attested = await page.request.post(`/w/${workspace}/v1/payees/${payeeId}/attest`, { headers: { ...headers, 'x-mandate-stepup': grant } })
  expect(attested.ok()).toBe(true)
}
