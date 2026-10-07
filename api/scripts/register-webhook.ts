// Registers this server's webhook URL with PayPal (sandbox or live, whichever PAYPAL_API points at) and prints the
// webhook id to put in PAYPAL_WEBHOOK_ID. Run: npm run webhook:register -- https://your-public-host
// For a laptop, open a tunnel first (for example `cloudflared tunnel --url http://localhost:8787`) and pass its URL.
// The webhook id is not a secret. Credentials are read from the environment and never printed.
const base = (process.env.PAYPAL_API ?? 'https://api-m.sandbox.paypal.com').replace(/\/$/, '')
const id = process.env.PAYPAL_CLIENT_ID
const secret = process.env.PAYPAL_CLIENT_SECRET
const host = process.argv.slice(2).find((arg) => arg.startsWith('http'))
if (!id || !secret || !host) {
  console.error('Usage: npm run webhook:register -- https://your-public-host   (needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in the environment)')
  process.exit(2)
}
const url = `${host.replace(/\/$/, '')}/v1/webhooks/paypal`
const EVENTS = [
  'INVOICING.INVOICE.PAID', 'INVOICING.INVOICE.CANCELLED', 'INVOICING.INVOICE.REFUNDED',
  'PAYMENT.PAYOUTSBATCH.SUCCESS', 'PAYMENT.PAYOUTSBATCH.DENIED', 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', 'PAYMENT.PAYOUTS-ITEM.FAILED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED', 'PAYMENT.PAYOUTS-ITEM.RETURNED', 'PAYMENT.PAYOUTS-ITEM.BLOCKED', 'PAYMENT.PAYOUTS-ITEM.CANCELED',
  'PAYMENT.CAPTURE.COMPLETED', 'CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED',
]

async function main() {
  const tokenResponse = await fetch(`${base}/v1/oauth2/token`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })
  if (!tokenResponse.ok) throw new Error(`token request failed: ${tokenResponse.status}`)
  const { access_token: token } = (await tokenResponse.json()) as { access_token: string }
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  const existing = await fetch(`${base}/v1/notifications/webhooks`, { headers })
  if (!existing.ok) throw new Error(`listing webhooks failed: ${existing.status} (does the app have the Webhooks feature on?)`)
  const list = ((await existing.json()) as { webhooks?: Array<{ id: string; url: string }> }).webhooks ?? []
  const same = list.find((hook) => hook.url === url)
  if (same) {
    console.log(`Already registered.\nPAYPAL_WEBHOOK_ID=${same.id}`)
    return
  }
  const created = await fetch(`${base}/v1/notifications/webhooks`, { method: 'POST', headers, body: JSON.stringify({ url, event_types: EVENTS.map((name) => ({ name })) }) })
  const body = (await created.json()) as { id?: string; message?: string; details?: unknown }
  if (!created.ok || !body.id) throw new Error(`registering failed: ${created.status} ${body.message ?? ''} ${JSON.stringify(body.details ?? '')}`)
  console.log(`Registered ${url}\nPAYPAL_WEBHOOK_ID=${body.id}`)
  if (list.length > 0) console.log(`Note: this app has ${list.length} other webhook(s). PayPal allows a limited number per app; delete old tunnel URLs in the developer dashboard if a future registration fails.`)
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error))
  process.exit(1)
})
