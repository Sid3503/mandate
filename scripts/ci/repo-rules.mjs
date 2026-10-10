// The rules the pipeline must never silently break, as small pure functions so they can be tested.
// No dependencies: it runs before `npm ci`, on a bare checkout.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (root, path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null)

/** Files that must never be tracked: they are where real secrets and local state live. */
const FORBIDDEN_TRACKED = [
  [/(^|\/)\.env($|\.(?!example$))/, 'an .env file'],
  [/\.pem$/, 'a .pem key file'],
  [/\.key$/, 'a .key file'],
  [/\.sqlite(-wal|-shm)?$/, 'a SQLite database'],
  [/(^|\/)cookies\.txt$/, 'a cookie jar'],
  [/firecrawl_key/, 'an API key file'],
]

/** The `- key: NAME` blocks of a render.yaml, as { name, body }. */
export function renderEnvVars(renderYaml) {
  const parts = renderYaml.split(/^\s*- key: /m).slice(1)
  return parts.map((part) => ({ name: part.split('\n')[0].trim(), body: part }))
}

/** The ignoredPaths list under buildFilter in a render.yaml. */
export function ignoredPathsFrom(renderYaml) {
  const lines = renderYaml.split('\n')
  const start = lines.findIndex((line) => /^\s*ignoredPaths:\s*$/.test(line))
  if (start < 0) return []
  const indent = lines[start].match(/^\s*/)[0].length
  const out = []
  for (const line of lines.slice(start + 1)) {
    const item = line.match(/^(\s*)-\s+(.*?)\s*$/)
    if (!item || item[1].length < indent) break
    out.push(item[2].replace(/^(['"])(.*)\1$/, '$2'))
  }
  return out
}

/** Render's glob syntax: `**` crosses folders, `*` does not. */
export function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i += 1) {
    const rest = glob.slice(i)
    if (rest.startsWith('**/')) { out += '(?:.*/)?'; i += 2 } else if (rest.startsWith('**')) { out += '.*'; i += 1 } else if (glob[i] === '*') out += '[^/]*'
    else out += glob[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/** Would Render deploy for a push that changed these files? Only if one of them is not ignored (render.yaml itself always deploys). */
export function deployNeeded(changedFiles, ignoredPaths) {
  if (changedFiles.length === 0) return false
  const ignored = ignoredPaths.map(globToRegExp)
  return changedFiles.some((file) => file === 'render.yaml' || !ignored.some((pattern) => pattern.test(file)))
}

/** Every check, as { ok, name, detail }. `tracked` lets a test say which files git tracks. */
export function checkRepo(root, { tracked } = {}) {
  const results = []
  const add = (ok, name, detail = '') => results.push({ ok, name, detail })

  // One Node version, everywhere it is named.
  const nvmrc = read(root, '.nvmrc')?.trim() ?? null
  const render = read(root, 'render.yaml')
  const renderNode = render?.match(/key:\s*NODE_VERSION\s*\n\s*value:\s*['"]?([\w.]+)['"]?/)?.[1] ?? null
  add(Boolean(nvmrc && /^\d+\.\d+\.\d+$/.test(nvmrc)), '.nvmrc names one exact Node version', nvmrc ? `found "${nvmrc}"` : 'missing')
  add(nvmrc !== null && renderNode === nvmrc, 'render.yaml NODE_VERSION equals .nvmrc', `.nvmrc ${nvmrc ?? 'none'}, render.yaml ${renderNode ?? 'none'}`)
  const engines = JSON.parse(read(root, 'api/package.json') ?? '{}').engines?.node ?? ''
  const minMajor = Number(engines.match(/(\d+)/)?.[1] ?? 0)
  add(nvmrc !== null && minMajor > 0 && Number(nvmrc.split('.')[0]) >= minMajor, 'the pinned Node satisfies the API\'s engines', `engines "${engines}", pinned ${nvmrc ?? 'none'}`)

  // Reproducible installs.
  for (const dir of ['api', 'web']) add(existsSync(join(root, dir, 'package-lock.json')), `${dir}/package-lock.json exists`, 'npm ci needs a lockfile')

  // No secret-bearing files in git.
  let files = tracked
  if (!files) {
    try { files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean) } catch { files = null }
  }
  if (files) {
    const bad = files.flatMap((file) => FORBIDDEN_TRACKED.filter(([pattern]) => pattern.test(file)).map(([, label]) => `${file} (${label})`))
    add(bad.length === 0, 'no secret-bearing files are tracked', bad.join(', '))
  } else add(true, 'no secret-bearing files are tracked', 'not a git checkout, skipped')

  // The Render blueprint: deploys wait for CI, and no secret is written into it.
  if (render === null) add(false, 'render.yaml exists')
  else {
    const trigger = render.match(/^\s*autoDeployTrigger:\s*(\S+)/m)?.[1]
    add(trigger === 'checksPass' || trigger === 'off', 'Render deploys only after checks pass (or not at all)', `autoDeployTrigger is ${trigger ?? 'not set, which means "commit": every push deploys, tested or not'}`)
    add(/^\s*healthCheckPath:\s*\/ready\s*$/m.test(render), 'Render health-checks /ready', 'healthCheckPath is not /ready')
    add(/key:\s*NODE_ENV\s*\n\s*value:\s*production/.test(render), 'NODE_ENV is production on Render', 'NODE_ENV is not production')
    const inlined = renderEnvVars(render).filter(({ name, body }) => /KEY|SECRET|TOKEN|PASSWORD/i.test(name) && !/sync:\s*false|generateValue:\s*true/.test(body))
    add(inlined.length === 0, 'no secret value is written in render.yaml', `these must be sync: false or generateValue: true: ${inlined.map((item) => item.name).join(', ')}`)
  }

  // Workflows: least privilege and pinned code.
  const dir = join(root, '.github/workflows')
  const workflows = existsSync(dir) ? readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)) : []
  add(workflows.length > 0, 'workflows exist', 'no .github/workflows/*.yml')
  for (const name of workflows) {
    const text = readFileSync(join(dir, name), 'utf8')
    add(/^permissions:/m.test(text), `${name}: permissions are declared at the top`, 'add a top-level permissions: block (contents: read)')
    const unpinned = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]).filter((ref) => !ref.startsWith('./') && !/@[0-9a-f]{40}$/.test(ref))
    add(unpinned.length === 0, `${name}: every action is pinned to a commit SHA`, `unpinned: ${unpinned.join(', ')}`)
    add(!/pull_request_target/.test(text), `${name}: does not use pull_request_target`, 'pull_request_target runs fork code with secrets')
  }
  return results
}
