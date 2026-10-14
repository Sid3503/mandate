import { describe, expect, it } from 'vitest'
import { runGuarantees } from '../../scripts/guarantees.mjs'

describe('Guarantees Verification Runner', () => {
  it('marks guarantee as fail when a named test fails', () => {
    // Override test/gate.test.ts as failed (false) and others as true
    const result = runGuarantees({
      write: false,
      testResultsOverride: {
        'test/gate.test.ts': false,
      },
    })

    expect(result.failures).toBeGreaterThan(0)
    const share = result.guarantees.find((g: any) => g.id === 'share')
    expect(share).toBeDefined()
    expect(share?.status).toBe('fail')
    expect(share?.failureDetails?.failed).toContain('test/gate.test.ts')
  })

  it('marks guarantees as pass when all named tests pass', () => {
    // Generate overrides where every unique test passes
    const base = runGuarantees({ write: false, runTests: false })
    const allTests = [...new Set(base.guarantees.flatMap((g: any) => g.tests ?? []))]
    const passOverrides: Record<string, boolean> = {}
    for (const t of allTests) {
      passOverrides[t] = true
    }

    const result = runGuarantees({
      write: false,
      testResultsOverride: passOverrides,
    })

    expect(result.failures).toBe(0)
    expect(result.passed).toBe(result.total)
    for (const g of result.guarantees) {
      expect(g.status).toBe('pass')
      expect(g.failureDetails).toBeUndefined()
    }
  })
})
