import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { closeAll, harness } from './support'

afterEach(closeAll)

const SHA = '3d51967a0c1e4b5f6a7b8c9d0e1f2a3b4c5d6e7f'

describe('which build is running', () => {
  it('says the commit on /ready and /health, with no key, so a deploy can be verified by reading it back', async () => {
    const { app } = harness({ commit: SHA })
    for (const path of ['/ready', '/health']) {
      const response = await app.request(path)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/health+json')
      expect(await response.json()).toMatchObject({ status: 'pass', releaseId: SHA })
    }
  })

  it('leaves releaseId out when the host did not say, instead of inventing one', async () => {
    const { app } = harness()
    const body = await (await app.request('/ready')).json() as Record<string, unknown>
    expect(body).not.toHaveProperty('releaseId')
    expect(body.status).toBe('pass')
  })

  it('keeps it while the server is draining, so a deploy that is rolling over still names what it is stopping', async () => {
    const { app } = harness({ commit: SHA, draining: () => true })
    const response = await app.request('/ready')
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ status: 'fail', releaseId: SHA })
  })

  it('reads the commit from the host\'s variable, prefers an explicit one, and ignores anything that is not a commit id', () => {
    const base = { PORT: '8787' }
    expect(loadConfig(base).commit).toBeNull()
    expect(loadConfig({ ...base, RENDER_GIT_COMMIT: SHA }).commit).toBe(SHA)
    expect(loadConfig({ ...base, RENDER_GIT_COMMIT: SHA, GIT_COMMIT: 'abcdef1' }).commit).toBe('abcdef1')
    expect(loadConfig({ ...base, GIT_COMMIT: ` ${SHA.toUpperCase()} ` }).commit).toBe(SHA)
    for (const junk of ['', 'main', 'abc', 'not-a-commit', `${SHA}0`, '<script>alert(1)</script>']) {
      expect(loadConfig({ ...base, GIT_COMMIT: junk }).commit, JSON.stringify(junk)).toBeNull()
    }
  })
})
