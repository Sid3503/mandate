import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

/**
 * The pipeline's own guards (scripts/ci). They exist to stop a specific mistake each, so each one is shown failing on that
 * mistake, not only passing on today's repo.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
let rules: any

beforeAll(async () => {
  // A variable path: the module is plain JavaScript outside this package, so the type checker has nothing to say about it.
  const path = join(repo, 'scripts/ci/repo-rules.mjs')
  rules = await import(path)
})

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1'
const RENDER = `services:
  - type: web
    name: mandate
    healthCheckPath: /ready
    autoDeployTrigger: checksPass
    buildFilter:
      ignoredPaths:
        - '**/*.md'
        - docs/**
    envVars:
      - key: NODE_VERSION
        value: 24.14.1
      - key: NODE_ENV
        value: production
      - key: API_KEY
        generateValue: true
      - key: PAYPAL_CLIENT_SECRET
        sync: false
`
const WORKFLOW = `name: x
on: push
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA} # v7
`

/** A tiny repo that satisfies every rule, with one thing changed by the test. */
function fixture(change: { render?: string; workflow?: string; nvmrc?: string; tracked?: string[]; engines?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-rules-'))
  made.push(dir)
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  write('.nvmrc', change.nvmrc ?? '24.14.1\n')
  write('render.yaml', change.render ?? RENDER)
  write('api/package.json', JSON.stringify({ engines: { node: change.engines ?? '>=22' } }))
  write('api/package-lock.json', '{}')
  write('web/package-lock.json', '{}')
  write('.github/workflows/ci.yml', change.workflow ?? WORKFLOW)
  return { dir, tracked: change.tracked ?? ['api/package.json', '.env.example', 'README.md'] }
}

const failures = (result: Array<{ ok: boolean; name: string; detail: string }>) => result.filter((item) => !item.ok).map((item) => item.name)
const run = (change?: Parameters<typeof fixture>[0]) => {
  const { dir, tracked } = fixture(change)
  return failures(rules.checkRepo(dir, { tracked }))
}

describe('the repo rules', () => {
  it('pass on this repository, as it is committed', () => {
    expect(failures(rules.checkRepo(repo))).toEqual([])
  })

  it('pass on a minimal good repository, so the cases below fail for the reason they name', () => {
    expect(run()).toEqual([])
  })

  it('catch a Node version that differs between .nvmrc and Render, or is too old for the API', () => {
    expect(run({ nvmrc: '24.14.0\n' })).toContain('render.yaml NODE_VERSION equals .nvmrc')
    expect(run({ nvmrc: 'lts\n' })).toContain('.nvmrc names one exact Node version')
    expect(run({ nvmrc: '20.11.0\n', render: RENDER.replace('24.14.1', '20.11.0') })).toContain('the pinned Node satisfies the API\'s engines')
  })

  it('refuse a Render config that would deploy every push, tested or not', () => {
    const name = 'Render deploys only after checks pass (or not at all)'
    expect(run({ render: RENDER.replace('    autoDeployTrigger: checksPass\n', '') })).toContain(name)
    expect(run({ render: RENDER.replace('checksPass', 'commit') })).toContain(name)
    expect(run({ render: RENDER.replace('checksPass', 'off') })).not.toContain(name)
  })

  it('refuse a secret written into render.yaml, but allow one Render generates or asks for', () => {
    const name = 'no secret value is written in render.yaml'
    expect(run({ render: RENDER.replace('generateValue: true', 'value: hunter2hunter2') })).toContain(name)
    expect(run({ render: RENDER.replace('sync: false', 'value: abc123abc123') })).toContain(name)
    expect(run()).not.toContain(name)
  })

  it('refuse a workflow with an unpinned action, no permissions block, or pull_request_target', () => {
    expect(run({ workflow: WORKFLOW.replace(`@${SHA} # v7`, '@v4') })).toContain('ci.yml: every action is pinned to a commit SHA')
    expect(run({ workflow: WORKFLOW.replace(`@${SHA} # v7`, '@main') })).toContain('ci.yml: every action is pinned to a commit SHA')
    expect(run({ workflow: WORKFLOW.replace('permissions:\n  contents: read\n', '') })).toContain('ci.yml: permissions are declared at the top')
    expect(run({ workflow: WORKFLOW.replace('on: push', 'on: pull_request_target') })).toContain('ci.yml: does not use pull_request_target')
    // A local action needs no pin.
    expect(run({ workflow: WORKFLOW.replace(`actions/checkout@${SHA} # v7`, './.github/actions/thing') })).toEqual([])
  })

  it('refuse tracked secrets and databases, and allow the example env file', () => {
    const name = 'no secret-bearing files are tracked'
    for (const file of ['.env', 'api/.env', '.env.local', 'key.pem', 'api/data/mandate.sqlite', 'api/data/mandate.sqlite-wal', 'cookies.txt', 'signing.key']) {
      expect(run({ tracked: [file, 'README.md'] }), file).toContain(name)
    }
    for (const file of ['.env.example', 'api/.env.example', 'api/src/main.ts']) expect(run({ tracked: [file] }), file).not.toContain(name)
  })
})

describe('whether a push needs a deploy (the same ignoredPaths list Render gets)', () => {
  const ignored = ['**/*.md', 'docs/**', 'pitch/**', '.github/**', 'scripts/**', 'api/test/**', 'web/e2e/**', 'LICENSE']
  const needed = (...files: string[]) => rules.deployNeeded(files, ignored)

  it('says no for documentation, tests, workflows and scripts, at any depth', () => {
    expect(needed('README.md')).toBe(false)
    expect(needed('web/README.md', 'docs/a/b/c.md', 'pitch/demo-video-script.md')).toBe(false)
    expect(needed('.github/workflows/ci.yml', 'scripts/ci/hygiene.mjs', 'api/test/gate.test.ts', 'web/e2e/job.spec.ts', 'LICENSE')).toBe(false)
  })

  it('says yes when any changed file is part of what runs, even next to ignored ones', () => {
    expect(needed('api/src/domain/gate.ts')).toBe(true)
    expect(needed('docs/REFERENCE.md', 'web/src/main.tsx')).toBe(true)
    expect(needed('package.json')).toBe(true)
    expect(needed('api/package-lock.json')).toBe(true)
    expect(needed('.nvmrc')).toBe(true)
    // Not fooled by a lookalike folder.
    expect(needed('api/testing/helper.ts')).toBe(true)
    expect(needed('docsfoo/x.ts')).toBe(true)
  })

  it('always deploys for render.yaml, and for nothing at all says no', () => {
    expect(needed('render.yaml')).toBe(true)
    expect(needed('render.yaml', 'docs/x.md')).toBe(true)
    expect(needed()).toBe(false)
  })

  it('reads the list from render.yaml, so there is one source of truth', () => {
    expect(rules.ignoredPathsFrom(RENDER)).toEqual(['**/*.md', 'docs/**'])
    expect(rules.ignoredPathsFrom('services: []')).toEqual([])
    const real = rules.ignoredPathsFrom(readFileSync(join(repo, 'render.yaml'), 'utf8'))
    expect(real).toContain('**/*.md')
    expect(real).toContain('api/test/**')
    // Nothing that runs may be on it.
    for (const runtime of ['api/src/main.ts', 'web/src/main.tsx', 'web/index.html', 'api/package.json', 'package.json', 'render.yaml']) {
      expect(rules.deployNeeded([runtime], real), runtime).toBe(true)
    }
  })

  it('answers "deploy" when it cannot compare the commits, because a missed deploy is worse than an extra one', () => {
    const cli = join(repo, 'scripts/ci/deploy-needed.mjs')
    const ask = (...args: string[]) => execFileSync('node', [cli, ...args], { encoding: 'utf8' })
    expect(ask()).toContain('needed=true')
    expect(ask('not-a-sha', 'abc1234')).toContain('needed=true')
    expect(ask('0000000', '1111111')).toContain('needed=true')
    expect(ask('HEAD', 'HEAD')).toContain('needed=true')
    // Two real, identical commits changed nothing, so nothing needs deploying.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    expect(ask(head, head)).toContain('needed=false')
  })
})
