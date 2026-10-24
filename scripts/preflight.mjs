// Checks the environment for the flagged doors. Prints names, never values.
const need = []
const on = (name) => {
  const value = process.env[name]
  return value === '1' || value === 'true' || value === 'on'
}
if (on('FLAG_TENANCY') || on('DEMO_ENABLED') || on('FLAG_PASSKEYS') || on('FLAG_INVITES')) {
  if (!process.env.MASTER_KEY || process.env.MASTER_KEY.length < 16) need.push('MASTER_KEY')
  if (!process.env.KEY_PEPPER || process.env.KEY_PEPPER.length < 16) need.push('KEY_PEPPER')
  if ((process.env.DATABASE_PATH ?? './data/mandate.sqlite') === ':memory:') need.push('DATABASE_PATH file')
}
if (on('FLAG_PASSKEYS')) {
  if (!process.env.WEBAUTHN_RP_ID) need.push('WEBAUTHN_RP_ID')
  if (!process.env.WEBAUTHN_ORIGINS) need.push('WEBAUTHN_ORIGINS')
}
if (need.length > 0) {
  console.error(`preflight missing: ${need.join(', ')}`)
  process.exit(1)
}
console.log('preflight ok')
