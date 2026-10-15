#!/usr/bin/env node
// scripts/render-env.mjs
// Checks and prints the required Render environment variables for running with
// multi-tenancy, hosted demos, WebAuthn passkeys, and live PayPal sandbox.
// Names and descriptions only. Never prints secret values.

export const RENDER_ENV_SPEC = [
  // Flags
  { name: 'FLAG_TENANCY', desc: 'Enables multi-tenant workspace isolation', category: 'Flags' },
  { name: 'DEMO_ENABLED', desc: 'Enables ephemeral sandbox demo workspace creation', category: 'Flags' },
  { name: 'FLAG_PASSKEYS', desc: 'Enables WebAuthn FIDO2 passkeys and cookie sessions', category: 'Flags' },
  
  // Storage & Network
  { name: 'DATABASE_PATH', desc: 'Persistent SQLite database path (/var/data/mandate.sqlite)', category: 'Storage' },
  { name: 'WEBAUTHN_RP_ID', desc: 'WebAuthn Relying Party ID (hostname without protocol or port)', category: 'Passkeys' },
  { name: 'WEBAUTHN_ORIGINS', desc: 'Allowed WebAuthn origins (e.g. https://<app>.onrender.com)', category: 'Passkeys' },
  { name: 'COOKIE_SECURE', desc: 'Enforces Secure flag on session cookies (set 1 in production)', category: 'Security' },
  { name: 'TRUST_PROXY', desc: 'Enables reverse proxy header parsing for client IP rate limiting', category: 'Security' },
  { name: 'TRUSTED_PROXY_HOPS', desc: 'Number of trusted reverse proxy hops (1 for Render)', category: 'Security' },
  
  // Cryptographic Secrets
  { name: 'MASTER_KEY', desc: '32-byte hex key for encrypting tenant workspace keys at rest', category: 'Secrets', gen: 'openssl rand -hex 32' },
  { name: 'KEY_PEPPER', desc: '32-byte hex pepper for HMAC-SHA256 machine key hashing', category: 'Secrets', gen: 'openssl rand -hex 32' },
  { name: 'ADMIN_KEY', desc: '32-byte hex key for administrative actions and resets', category: 'Secrets', gen: 'openssl rand -hex 32' },
  { name: 'SIGNING_KEY', desc: 'Ed25519 PKCS8 PEM private key for signing immutable receipts', category: 'Secrets', gen: "node -e \"console.log(require('crypto').generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}))\"" },
  
  // AI Model Configuration
  { name: 'OLLAMA_API_KEY', desc: 'API key for Ollama Cloud model calls', category: 'AI Model' },
  { name: 'MODEL_GLOBAL_DAILY_TOKENS', desc: 'Global daily token spending ceiling across all tenants', category: 'AI Model' },
  { name: 'MODEL_WORKSPACE_DAILY_TOKENS', desc: 'Per-workspace daily token spending ceiling', category: 'AI Model' },
  
  // PayPal Sandbox
  { name: 'PAYPAL_CLIENT_ID', desc: 'PayPal developer sandbox application Client ID', category: 'PayPal' },
  { name: 'PAYPAL_CLIENT_SECRET', desc: 'PayPal developer sandbox application Client Secret', category: 'PayPal' },
  { name: 'PAYPAL_API', desc: 'PayPal sandbox API endpoint (https://api-m.sandbox.paypal.com)', category: 'PayPal' },
  { name: 'PAYPAL_WEBHOOK_ID', desc: 'PayPal webhook ID registered for https://<host>/v1/webhooks/paypal', category: 'PayPal' },
]

export function checkRenderEnv(env = process.env) {
  const missing = []
  const present = []

  console.log('=== Render Production Environment Check ===\n')

  let currentCategory = ''
  for (const item of RENDER_ENV_SPEC) {
    if (item.category !== currentCategory) {
      currentCategory = item.category
      console.log(`[${currentCategory}]`)
    }
    const val = env[item.name]
    const isSet = typeof val === 'string' && val.trim().length > 0
    if (isSet) {
      present.push(item.name)
      console.log(`  OK      ${item.name.padEnd(30)} - ${item.desc}`)
    } else {
      missing.push(item.name)
      const genHint = item.gen ? ` (Generate with: ${item.gen})` : ''
      console.log(`  MISSING ${item.name.padEnd(30)} - ${item.desc}${genHint}`)
    }
  }

  console.log('\n=== Summary ===')
  console.log(`Total checked: ${RENDER_ENV_SPEC.length}`)
  console.log(`Configured:    ${present.length}`)
  console.log(`Missing:       ${missing.length}`)

  return { missing, present }
}

if (process.argv[1]?.endsWith('render-env.mjs')) {
  const { missing } = checkRenderEnv()
  if (missing.length > 0) {
    console.error(`\nError: ${missing.length} required environment variable(s) missing.`)
    process.exit(1)
  } else {
    console.log('\nAll required Render environment variables are configured.')
    process.exit(0)
  }
}
