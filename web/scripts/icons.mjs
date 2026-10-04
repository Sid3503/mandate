// Renders the Mandate mark to PNG icons with the local Chrome. Run: npm run icons
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const dir = mkdtempSync(join(tmpdir(), 'mandate-icons-'))
const mark = (pad) => `<!doctype html><html><body style="margin:0;background:#050505">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" style="width:100vw;height:100vh;display:block">
<rect width="100" height="100" fill="#050505"/>
<g transform="translate(${pad} ${pad}) scale(${(100 - 2 * pad) / 100})">
<rect x="0" y="0" width="100" height="100" fill="#e2ff41"/>
<rect x="0" y="0" width="33.4" height="33.4" fill="#050505"/>
<rect x="33.3" y="33.3" width="33.4" height="33.4" fill="#050505"/>
<rect x="66.6" y="66.6" width="33.4" height="33.4" fill="#050505"/>
</g></svg></body></html>`
const jobs = [
  ['icon-192.png', 192, 16],
  ['icon-512.png', 512, 16],
  ['icon-maskable-512.png', 512, 24],
  ['apple-touch-icon.png', 180, 16],
]
for (const [name, size, pad] of jobs) {
  const html = join(dir, `${name}.html`)
  writeFileSync(html, mark(pad))
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${size},${size}`, `--screenshot=${join(process.cwd(), 'public', name)}`, `file://${html}`], { stdio: 'ignore' })
  console.log('wrote', name)
}
