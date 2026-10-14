import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function runGuarantees(options = {}) {
  const root = options.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const file = resolve(root, 'docs/guarantees.json')

  if (!existsSync(file)) {
    throw new Error('docs/guarantees.json not found')
  }

  const data = JSON.parse(readFileSync(file, 'utf-8'))
  const guarantees = data.guarantees ?? []
  const uniqueTests = [...new Set(guarantees.flatMap((g) => g.tests ?? []))]

  // Check file existence
  const fileMissing = new Map()
  for (const t of uniqueTests) {
    const fullPath = resolve(root, 'api', t)
    if (!existsSync(fullPath)) {
      fileMissing.set(t, true)
    }
  }

  const testFileStatus = new Map()

  if (options.testResultsOverride) {
    // For unit testing guarantees verification
    for (const [t, st] of Object.entries(options.testResultsOverride)) {
      testFileStatus.set(t, st)
    }
  } else if (options.runTests !== false) {
    const tempOutput = join(tmpdir(), `guarantees-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    try {
      execFileSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${tempOutput}`, ...uniqueTests], {
        cwd: join(root, 'api'),
        stdio: 'pipe',
        encoding: 'utf8',
      })
    } catch {
      // Vitest exits 1 on test failures, which is handled below by reading json report
    }

    if (existsSync(tempOutput)) {
      try {
        const report = JSON.parse(readFileSync(tempOutput, 'utf-8'))
        for (const testResult of report.testResults ?? []) {
          const relPath = testResult.name.split('/api/')[1] ?? testResult.name
          testFileStatus.set(relPath, testResult.status === 'passed')
        }
      } catch {
        // Fallback
      }
    }
  }

  const verifiedAt = new Date().toISOString()
  let failures = 0

  for (const g of guarantees) {
    const missing = []
    const failed = []

    for (const t of g.tests ?? []) {
      if (fileMissing.get(t)) {
        missing.push(t)
      } else if (options.runTests !== false || options.testResultsOverride) {
        const passed = testFileStatus.get(t)
        if (passed !== true) {
          failed.push(t)
        }
      }
    }

    const ok = missing.length === 0 && failed.length === 0
    g.status = ok ? 'pass' : 'fail'
    g.lastVerifiedAt = verifiedAt

    if (!ok) {
      failures += 1
      g.failureDetails = { missing, failed }
    } else {
      delete g.failureDetails
    }
  }

  if (options.write !== false) {
    writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  }

  return {
    total: guarantees.length,
    passed: guarantees.length - failures,
    failures,
    guarantees,
  }
}

// CLI execution
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  console.log('Running test suites to verify Mandate Guarantees...\n')
  try {
    const result = runGuarantees({ write: true })
    for (const g of result.guarantees) {
      const marker = g.status === 'pass' ? '✓' : '✗'
      console.log(`  ${marker} [${g.id}] ${g.promise}`)
      if (g.status !== 'pass') {
        if (g.failureDetails?.missing?.length) {
          console.error(`      MISSING FILES: ${g.failureDetails.missing.join(', ')}`)
        }
        if (g.failureDetails?.failed?.length) {
          console.error(`      FAILED TESTS: ${g.failureDetails.failed.join(', ')}`)
        }
      }
    }
    console.log(`\n${result.passed} of ${result.total} guarantees verified.`)
    process.exit(result.failures > 0 ? 1 : 0)
  } catch (err) {
    console.error('Error running guarantees verification:', err)
    process.exit(1)
  }
}
