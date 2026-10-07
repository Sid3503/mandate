/**
 * What Mandate promises, in plain words, and where each promise is held up. A promise is only listed if something checks it:
 * the audit on every Proof run, a test on every change, or a randomised test that plays months of requests. Nothing here is
 * a claim without a place to look.
 */
export type Guarantee = {
  id: string
  promise: string
  /** The audit check that re-verifies it on the live ledger, if there is one. */
  audit?: string
  /** Where the tests are. */
  tests: string[]
  random?: boolean
}

export const GUARANTEES: Guarantee[] = [
  { id: 'share', promise: 'No payout is ever larger than the contractor\'s share of the client payment it cites.', audit: 'payouts.funded', tests: ['test/property.test.ts', 'test/gate.test.ts', 'test/standing.test.ts'], random: true },
  { id: 'funded', promise: 'Nobody is paid with money that has not arrived: every payout points at a client payment PayPal confirmed.', audit: 'jobs.in_covers_out', tests: ['test/property.test.ts', 'test/api.test.ts'], random: true },
  { id: 'cap', promise: 'In a month, contractors are paid no more than the monthly cap that was in force.', audit: 'cap.respected', tests: ['test/property.test.ts', 'test/gate.test.ts'], random: true },
  { id: 'unknown', promise: 'Someone who is not on the rules is never paid, and neither is work that is not on the rules, whatever the story.', tests: ['test/redteam.test.ts', 'test/property.test.ts'], random: true },
  { id: 'refused', promise: 'A request the rules refused never reaches PayPal: it has no order, no payout and no capture.', tests: ['test/redteam.test.ts', 'test/property.test.ts'], random: true },
  { id: 'once', promise: 'A request is never paid twice, however often it is repeated, retried or replayed.', tests: ['test/property.test.ts', 'test/api.test.ts', 'test/resilience.test.ts'], random: true },
  { id: 'lock', promise: 'Once approved, a request cannot be changed: the payee, amount, proof, job and funding are locked and signed.', audit: 'locks.valid', tests: ['test/api.test.ts', 'test/redteam.test.ts'] },
  { id: 'yes', promise: 'Every payment that moved had the owner\'s tap or a standing rule the owner signed.', audit: 'moved.authorised', tests: ['test/audit.test.ts', 'test/standing.test.ts'] },
  { id: 'agents', promise: 'No AI can approve, pay, change the rules, or call a PayPal tool that moves money.', audit: 'agents.no_reach', tests: ['test/mcp.test.ts', 'test/tiers.test.ts', 'test/redteam.test.ts'] },
  { id: 'words', promise: 'A model\'s sentence never claims that money moved, or states a figure nobody supplied: it is taken back.', tests: ['test/harness.test.ts', 'test/agents.test.ts'] },
  { id: 'paused', promise: 'While Mandate is paused nothing runs on its own, and the history of pauses is signed.', audit: 'safety.respected', tests: ['test/safety.test.ts', 'test/property.test.ts'], random: true },
  { id: 'verify', promise: 'A receipt can be checked in a browser without asking this server.', tests: ['test/verify.test.ts'] },
  { id: 'studio', promise: 'The dashboard has no path to PayPal: it is handed rows, and its agent module imports nothing of Mandate\'s.', tests: ['test/studio.test.ts', 'test/control-room.test.ts'] },
  { id: 'down', promise: 'When PayPal is slow or down, a repeatable call is retried, an unrepeatable one is not, and a person is told which.', tests: ['test/resilience.test.ts', 'test/robust.test.ts'] },
]

/** The deepest randomised run recorded for this build. `PROPERTY_RUNS=3000 npm test -- property` repeats it. */
export const DEEP_RUN = { months: 3000, stepsPerMonth: 36, violations: 0, recordedOn: '2026-10-09' }
export const EVERY_CHANGE_RUN = { months: 40, stepsPerMonth: 36 }
