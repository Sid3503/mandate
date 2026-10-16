import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { harness } from './support'
// @ts-ignore
import { session } from '../../web/src/lib/session'

describe('URL Keys and Production Session', () => {
  it('the production build ignores ?key= and ?mode= in URL search', () => {
    const originalWindow = (globalThis as any).window
    try {
      ;(globalThis as any).window = {
        location: { search: '?key=untrusted-key-123&mode=demo' },
      }
      expect(session.get()).toBeNull()
      expect(session.mode()).toBeNull()
    } finally {
      ;(globalThis as any).window = originalWindow
    }
  })

  it('production web route ignores ?key= query parameter and returns index', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mandate-web-'))
    writeFileSync(join(root, 'index.html'), '<html><body>Mandate</body></html>')
    const h = harness({ webDist: root })
    const res = await h.app.request('http://mandate.test/app/welcome?key=untrusted-key')
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})
