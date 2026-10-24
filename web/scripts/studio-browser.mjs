// Drives the "Create your studio" screen in a real browser against a server you name.
//
//   node scripts/studio-browser.mjs http://localhost:8787
//
// It uses Chrome with a virtual passkey, so it needs no device and no Touch ID, and it walks the same path a person
// does: type a name, save a passkey, sign in, save a second key or the recovery codes, write the rules in words, open
// Today. The server must have the door open (FLAG_TENANCY=1, FLAG_PASSKEYS=1) and must be reached on the host the
// relying party id names, which is normally localhost.
//
// It reads and writes one studio on that server. The studio runs on the server's simulated PayPal, so nothing is charged.
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const base = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '')
const shots = process.argv[3] ?? 'docs/evidence/studio'

let failed = 0
const pass = (message) => console.log(`  ✓ ${message}`)
const fail = (message) => { failed += 1; console.log(`  ✗ ${message}`) }
const check = (ok, good, bad) => (ok ? pass(good) : fail(bad))
const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
const page = await context.newPage()

// A passkey that lives in the browser instead of on a device: the same messages a real one sends.
const client = await context.newCDPSession(page)
await client.send('WebAuthn.enable')
await client.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
})

// The tour would sit over the buttons.
await page.addInitScript(() => localStorage.setItem('mandate.tour.welcome', '1'))
await page.goto(`${base}/app/studio`)

const studioName = `Studio ${new Date().toISOString().slice(0, 16).replace(/[^0-9]/g, '')}`
await page.getByLabel('Studio name').fill(studioName)
await page.getByRole('button', { name: 'Create and save a passkey' }).click()

const ready = page.getByRole('heading', { name: 'Studio ready' })
const door = page.getByText('This door is off')
try {
  await ready.waitFor({ timeout: 30_000 })
  pass('the studio is created and the passkey is saved')
} catch {
  const text = await page.locator('.unlock-card').innerText().catch(() => '')
  if (text.includes('This door is off')) fail('the studio door is off on this server (FLAG_TENANCY and FLAG_PASSKEYS must be on)')
  else fail(`the studio was not created: ${text.slice(0, 160).replace(/\s+/g, ' ')}`)
  await browser.close()
  process.exit(1)
}

const fingerprint = (await page.getByTestId('passkey-fingerprint').innerText()).trim()
check(/^[0-9a-f]{16}$/.test(fingerprint), `the passkey has a fingerprint (${fingerprint})`, `the fingerprint looks wrong: ${fingerprint}`)
const paypalLine = await page.getByTestId('paypal-sim').innerText()
check(/sandbox account|PayPal here is simulated|not connected/.test(paypalLine), 'the screen says which PayPal this studio uses', `the screen does not say which PayPal it uses: ${paypalLine.slice(0, 120)}`)
check(await page.getByRole('button', { name: 'Open Today' }).count() === 0, 'Today stays closed until the account has a backup', 'Today opened before the account had a backup')

// The second key, or the recovery codes. One of the two has to be there.
await page.getByRole('button', { name: 'Create recovery codes' }).click()
await page.getByTestId('wizard-codes').waitFor({ timeout: 15_000 })
const codes = await page.getByTestId('wizard-codes').locator('li').allInnerTexts()
check(codes.length === 8, `the recovery codes are shown (${codes.length})`, `the recovery codes are missing (${codes.length})`)
await page.getByRole('button', { name: 'I saved these' }).click()
await page.getByTestId('studio-rules').waitFor({ timeout: 15_000 })
pass('the account has a way back in')

await page.getByLabel('Rules in words').fill('Pay a contractor only when the client has paid and the work is delivered.')
await page.getByRole('button', { name: 'Save these words' }).click()
await page.getByTestId('studio-done').waitFor({ timeout: 15_000 })
pass('the rules in words are saved')
await page.getByTestId('studio-words-kept').waitFor({ timeout: 15_000 })
pass('the screen says the words are kept')

mkdirSync(shots, { recursive: true })
await page.locator('.unlock').screenshot({ path: `${shots}/studio-done.png` })

// The words are on the server, so the Rules screen starts from them.
await page.getByRole('button', { name: 'Write your rules' }).click()
await page.waitForURL(/\/app\/rules/, { timeout: 20_000 })
await page.getByTestId('rules-first').waitFor({ timeout: 20_000 })
pass('the Rules screen says the studio has no rules yet')
const kept = await page.getByTestId('rules-words-kept').innerText()
check(kept.includes('Pay a contractor only when the client has paid'), 'the Rules screen shows the words the owner wrote', 'the Rules screen did not show the words')
await page.screenshot({ path: `${shots}/studio-rules.png`, fullPage: false })

// Back to Today, in the studio the owner named.
await page.goto(`${base}/app/`)
await page.waitForURL(/\/app\/?$/, { timeout: 20_000 })
await page.getByRole('heading', { level: 1, name: /today/i }).waitFor({ timeout: 20_000 })
pass('Today opens in the new studio')
const header = await page.locator('.topbar, header').first().innerText().catch(() => '')
check(header.includes(studioName), `the console says the studio's own name (${studioName})`, `the console does not say the studio's name: ${header.slice(0, 120).replace(/\s+/g, ' ')}`)
await page.screenshot({ path: `${shots}/studio-today.png`, fullPage: false })

// The session belongs to the studio that was just made, and to nobody else.
const me = await page.evaluate(async () => {
  const response = await fetch('/auth/me', { credentials: 'include' })
  return response.ok ? response.json() : null
})
check(me?.role === 'owner', 'the browser is signed in as the owner of the studio', 'the browser is not signed in as an owner')

await browser.close()
console.log(failed === 0 ? '\nThe studio screen works end to end in a browser.' : `\n${failed} check(s) failed.`)
process.exit(failed === 0 ? 0 : 1)
