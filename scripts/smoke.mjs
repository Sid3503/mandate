#!/usr/bin/env node
// scripts/smoke.mjs
// Smoke test for live Mandate deployments.
// Checks /healthz, /readyz, GET /app/welcome, security headers,
// POST /demo/start, demo session cookie, and one read as demo owner.
// NEVER prints a cookie value.

const targetUrl = process.argv[2]
if (!targetUrl) {
  console.error('Usage: npm run smoke -- <url>')
  console.error('Example: npm run smoke -- https://mandate-api.onrender.com')
  process.exit(1)
}

const base = targetUrl.replace(/\/+$/, '')

async function run() {
  console.log(`=== Mandate Smoke Test on ${base} ===\n`)
  let passed = 0
  let failed = 0

  function ok(name, detail = '') {
    passed++
    console.log(`  [PASS] ${name}${detail ? ` (${detail})` : ''}`)
  }

  function fail(name, reason) {
    failed++
    console.error(`  [FAIL] ${name}: ${reason}`)
  }

  // 1. GET /healthz
  try {
    const res = await fetch(`${base}/healthz`)
    if (res.status === 200) {
      ok('GET /healthz', `HTTP 200`)
    } else {
      fail('GET /healthz', `HTTP ${res.status}`)
    }
  } catch (err) {
    fail('GET /healthz', err.message)
  }

  // 2. GET /readyz
  try {
    const res = await fetch(`${base}/readyz`)
    if (res.status === 200) {
      const json = await res.json().catch(() => null)
      if (json?.status === 'ok') {
        ok('GET /readyz', `HTTP 200, status=ok`)
      } else {
        ok('GET /readyz', `HTTP 200`)
      }
    } else {
      fail('GET /readyz', `HTTP ${res.status}`)
    }
  } catch (err) {
    fail('GET /readyz', err.message)
  }

  // 3. GET /app/welcome
  try {
    const res = await fetch(`${base}/app/welcome`)
    if (res.status === 200) {
      ok('GET /app/welcome', `HTTP 200`)
    } else {
      fail('GET /app/welcome', `HTTP ${res.status}`)
    }
  } catch (err) {
    fail('GET /app/welcome', err.message)
  }

  // 4. Security headers check on /app/welcome
  try {
    const res = await fetch(`${base}/app/welcome`)
    const nosniff = res.headers.get('x-content-type-options')
    const frameOptions = res.headers.get('x-frame-options')
    if (nosniff?.toLowerCase() === 'nosniff') {
      ok('Security headers: X-Content-Type-Options', 'nosniff')
    } else {
      fail('Security headers: X-Content-Type-Options', `Expected nosniff, got ${nosniff}`)
    }
    if (frameOptions?.toUpperCase() === 'DENY' || frameOptions?.toUpperCase() === 'SAMEORIGIN') {
      ok('Security headers: X-Frame-Options', frameOptions)
    } else {
      fail('Security headers: X-Frame-Options', `Expected DENY or SAMEORIGIN, got ${frameOptions}`)
    }
  } catch (err) {
    fail('Security headers check', err.message)
  }

  // 5. POST /demo/start
  let sessionCookie = null
  let workspaceId = null
  try {
    const res = await fetch(`${base}/demo/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (res.status === 200) {
      const data = await res.json().catch(() => null)
      workspaceId = data?.workspaceId
      const setCookie = res.headers.get('set-cookie')
      if (setCookie) {
        // Extract cookie name and redact value
        const cookieMatch = setCookie.match(/([^=]+)=([^;]+)/)
        if (cookieMatch) {
          sessionCookie = `${cookieMatch[1]}=${cookieMatch[2]}`
          ok('POST /demo/start', `HTTP 200, workspaceId=${workspaceId || 'unknown'}`)
          ok('Demo session cookie', `Set-Cookie received: ${cookieMatch[1]}=[REDACTED]`)
        } else {
          fail('Demo session cookie', 'Invalid Set-Cookie format')
        }
      } else {
        fail('Demo session cookie', 'Missing Set-Cookie header')
      }
    } else {
      fail('POST /demo/start', `HTTP ${res.status}`)
    }
  } catch (err) {
    fail('POST /demo/start', err.message)
  }

  // 6. One read as demo owner using the session
  if (workspaceId && sessionCookie) {
    try {
      const readUrl = `${base}/w/${workspaceId}/v1/status`
      const res = await fetch(readUrl, {
        headers: {
          cookie: sessionCookie,
          'x-mandate-client': 'web',
        },
      })
      if (res.status === 200) {
        ok(`Read as demo owner (GET /w/:id/v1/status)`, `HTTP 200`)
      } else {
        fail(`Read as demo owner`, `HTTP ${res.status}`)
      }
    } catch (err) {
      fail('Read as demo owner', err.message)
    }
  } else {
    fail('Read as demo owner', 'Skipped because demo/start did not succeed')
  }

  console.log(`\n=== Smoke Test Results ===`)
  console.log(`Passed: ${passed}`)
  console.log(`Failed: ${failed}`)

  if (failed > 0) {
    process.exit(1)
  } else {
    console.log('\nAll smoke checks passed successfully.')
    process.exit(0)
  }
}

run().catch((err) => {
  console.error('Smoke test runtime error:', err)
  process.exit(1)
})
