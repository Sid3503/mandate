# Mandate master plan

Status audit on 12 October 2026. No new product work in this pass. Nothing pushed. Nothing deployed.
Commits: `65a30b4` is phase 0. `9a2ea0b` is phases 1 to 12 in one commit on `phase/0-baseline`. Older behavior is already on main at `1ac59cd`.
A box is ticked only when the task is done and a test or file proves the whole task. Partial and not started stay unticked.

## P0

- [x] P0.T1 The 12 October 2026 audit run is in `docs/DECISIONS.md`: 45 files, 522 API tests, 112 browser tests, axe on the receipt tour and every signed-in screen. Lighthouse was not run. This tick records that run. `0b8659c`
- [x] P0.T2 `package.json` scripts `gates` and `gates:fast`. `65a30b4`
- [x] P0.T3 `scripts/check-secrets.mjs` and `scripts/check-secrets.allow`. `65a30b4`
- [x] P0.T4 Ollama is the only provider. `PRODUCT.md`, `README.md`, and `docs/REFERENCE.md` say so. The API count is 543. The drafter default is `gemma4:31b`, stated on the Model row. One history note keeps commits `47875a7` and `9fa19b6`. `docs/DECISIONS.md`
- [x] P0.T5 `api/test/flags.test.ts`. `65a30b4`
- [x] P0.T6 `docs/DECISIONS.md`, `docs/SECURITY.md`, `CHANGELOG.md`. `65a30b4`
- [x] P0.T7 `api/.env.example` lists current and planned names. `65a30b4`

## Task table

| Task | Status | Proof | Commit |
|---|---|---|---|
| P0.T1 | done | Audit run in `docs/DECISIONS.md`: 45 files, 522 API tests, 112 browser tests, axe pass. Lighthouse was not run. The tick records that run | `0b8659c` |
| P0.T2 | done | root `package.json` `gates`, `gates:fast` | `65a30b4` |
| P0.T3 | done | `scripts/check-secrets.mjs` | `65a30b4` |
| P0.T4 | done | Ollama only in `PRODUCT.md`, `README.md`, and `docs/REFERENCE.md`. History note names `47875a7` and `9fa19b6`. API count 543. Drafter default `gemma4:31b` | `docs/DECISIONS.md` |
| P0.T5 | done | `api/test/flags.test.ts` | `65a30b4` |
| P0.T6 | done | `docs/DECISIONS.md`, `docs/SECURITY.md`, `CHANGELOG.md` | `65a30b4` |
| P0.T7 | done | `api/.env.example` | `65a30b4` |
| P1.T1 | done | Boot secrets wrapped in SecretString and redacted on inspect/stringify. Proof: `api/test/ops-readyz-secret.test.ts` | `0fa31c3` |
| P1.T2 | partial | `api/test/phases.test.ts` "redacts a canary and a bearer token". Not every route class | `9a2ea0b` |
| P1.T3 | done | RateLimiter classes (auth, key-unlock, ask, write, read), pruneBuckets, and route mappings. Proof: `api/test/ops-ratelimit-budget.test.ts` | `70fce9f` |
| P1.T4 | done | Model budget 0 blocks model reservations while quick asks still work (case 28). Proof: `api/test/ops-ratelimit-budget.test.ts` | `70fce9f` |
| P1.T5 | done | Headers on `/healthz`, `/app`, `/v1`, and `/auth`. `api/test/phases.test.ts` "sends the extra security headers and the health alias". `api/test/repair-pass.test.ts` "refuses paths that leave the web build and still serves a file inside it" | `9a2ea0b` |
| P1.T6 | done | Pre-migration backup on file database, older seeded-copy upgrade test, checksum protection. Proof: `api/test/ops-backup-migration.test.ts` | `64aba97` |
| P1.T7 | done | Real /readyz endpoint with full datastore check and 50-connection SSE cap. Proof: `api/test/ops-readyz-secret.test.ts` | `0fa31c3` |
| P1.T8 | partial | `api/test/phases.test.ts` "serves metrics only to the admin key" | `9a2ea0b` |
| P1.T9 | done | db:backup and db:restore script tests with safety backups and validation. Proof: `api/test/ops-backup-migration.test.ts` | `64aba97` |
| P2.T1 | partial | `api/src/control/store.ts` `ensureDefault`. `api/test/phases.test.ts` "stays a single studio when the flags are off" | `9a2ea0b` |
| P2.T2 | partial | `api/src/tenancy/registry.ts` max 50, idle 10 minutes. Handlers were not moved onto the request | `9a2ea0b` |
| P2.T3 | done | MCP under /w/:workspace/mcp and routing under /w/:workspace/... Proof: `api/test/ops-tenant-routing.test.ts` | `dc7f00a` |
| P2.T4 | done | Per-workspace signing keys with envelope encryption and public keys at GET /w/:id/.well-known/mandate-keys.json. Proof: `api/test/ops-tenant-routing.test.ts` | `dc7f00a` |
| P2.T5 | done | Webhook routing through external_refs across payout, invoice, and order events. Proof: `api/test/ops-tenant-routing.test.ts` | `dc7f00a` |
| P2.T6 | done | npm run seed:template script and frozen numbers test for Line Studio template. Proof: `api/test/ops-demo-template.test.ts` | `d14906b` |
| P2.T7 | done | Integration tests for demo reset (/v1/demo/reset), role switch (/v1/demo/switch), and simulate (/v1/demo/simulate). Proof: `api/test/ops-demo-template.test.ts` | `d14906b` |
| P2.T8 | done | Demo workspace daily model cap (50k tokens), IP rate limiting (sixth demo 429). Proof: `api/test/ops-ratelimit-budget.test.ts` | `70fce9f` |
| P2.T9 | done | 15-minute cleanup job removes expired demo workspaces and SQLite files, preserving default, studio, and live workspaces. Proof: `api/test/ops-cleanup-scheduler.test.ts` | `9306be5` |
| P2.T10 | done | Single tenant scheduler sweeps active invoice/payout tenants without per-tenant timers; on-demand demo ticks. Proof: `api/test/ops-cleanup-scheduler.test.ts` | `9306be5` |
| P2.T11 | done | Tenant isolation tests (Appendix B cases 22, 23, 24, 27). Proof: `api/test/ops-cleanup-scheduler.test.ts` | `9306be5` |
| P3.T1 | partial | `api/src/control/store.ts` schema. No migration test | `9a2ea0b` |
| P3.T2 | partial | `api/test/phases.test.ts` "registers a passkey and signs in with it" | `9a2ea0b` |
| P3.T3 | partial | `api/src/auth/cookies.ts`, CSRF in `api/src/app.ts`. No origin test | `9a2ea0b` |
| P3.T4 | partial | bearer then cookie in `api/src/app.ts`. Old key tests still pass in the API suite. No new test names this | `9a2ea0b` |
| P3.T5 | partial | role checks in `api/src/app.ts`. No role-matrix test | `9a2ea0b` |
| P3.T6 | partial | `actor_json` written in `api/src/db/repo.ts`. No test | `9a2ea0b` |
| P3.T7 | done | Sessions list, revoke, revoke others, and owner sign-in history. The list hides the token. Screen `/app/sessions`. Proof: `api/test/identity.test.ts` | `52fde09` |
| P3.T8 | done | Issue, confirm with "I saved these", use once, and regenerate with a passkey step-up. Codes are hashed. Proof: `api/test/identity.test.ts` | `5f7d0c5` |
| P3.T9 | done | Add a passkey and refuse to remove the last one. Another member's id is 404. The screen is `/app/sessions`. Proof: `api/test/identity.test.ts` | `2904707` |
| P3.T10 | done | Chromium virtual authenticator covers register, sign in again, step-up approve, a second passkey, and recovery replace. Proof: `web/e2e/passkey-repair.spec.ts` | `a9df7ed` |
| P4.T1 | done | `workspaces.passkey_for_money` is on for a new studio and off for the default studio and a demo. Turning it on is tested. Proof: `api/test/stepup.test.ts` | `fd1432b` |
| P4.T2 | done | Approve grant is one use, 120 seconds, member plus cart hash. Parallel approve and both rollback outcomes are tested. Proof: `api/test/stepup.test.ts` | `283544d` |
| P4.T3 | done | `proposal.approved` stores the assertion. `0002_warrant_signature` adds `warrants.signature_json` and a file copy is taken first. An older file still reads `{ actor, cartHash }`. Existing money routes require a step-up. The missing key, member, invite-revoke, and payee routes stay 404. Proof: `api/test/stepup.test.ts` | `751ac9f` |
| P4.T4 | done | Enrollment shows the fingerprint with "Save this". The receipt line is who, how, when, and 8 hex characters. A missing passkey assertion is red. Owner-key and demo are amber. Old rows are grey and marked legacy. Proof: `web/e2e/passkey-repair-receipt.spec.ts`, `api/test/audit.test.ts` | `b6cb07f` |
| P4.T5 | done | Verify checks ES256 from a Chromium virtual-authenticator vector, including five one-bit changes. Wording is "valid signature by this key". Unknown algorithms say "cannot verify here". One passkey Playwright test signs in, approves, verifies, and sees a tampered receipt fail. Proof: `web/e2e/passkey-repair-receipt.spec.ts`, `api/test/verify.test.ts` | `e5913da` |
| P4.T6 | done | A passkey approval with no assertion is red and fails `approval.proof`. Owner-key and demo are amber and do not fail. Old rows are grey and marked legacy. A standing rule with no signature stays grey and says that version has no signature. Proof: `api/test/audit.test.ts` | `6968dcd` |
| P4.T7 | done | Demo tap sends `x-mandate-demo-tap` and stores method `demo`. The receipt proof is amber. The Today card shows Demo tap and Try with my passkey. The same header outside a demo stores owner-key. gates:fast 567. Proof: `api/test/stepup.test.ts`, `web/e2e/job.spec.ts` | `1cdbfef` |
| P4.T8 | done | The Today approval card shows amount, payee, category, evidence, a short cart hash, and the clause before the prompt. The success toast says Signed and sent. Approved · locked stays. Proof: `web/e2e/job.spec.ts` | `1cdbfef` |
| P5.T1 | done | Welcome headline, line of proof, three doors, trust strip with verify link. Proof: `web/e2e/onboarding-doors.spec.ts` | `fda497e` |
| P5.T2 | done | Demo banner, role switcher, reset, and live-proof page. Proof: `api/test/demo-onboarding.test.ts` and `web/e2e/passkey-repair-demo.spec.ts`. Screenshot `docs/evidence/q2/demo-banner.png`. | `fdd1ca4` |
| P5.T3 | done | Studio wizard: name, passkey, second passkey or recovery codes required, simulated PayPal text, rules in words can skip, progress in local storage. Proof: `web/e2e/passkey-repair-wizard.spec.ts` | `0a41958` |
| P5.T4 | partial | `web/src/screens/Unlock.tsx` has the authority sentence. Route `/app/unlock`. Cites source file, not a test | `9a2ea0b` |
| P5.T5 | done | Role landings: owner/approver on Today, proposer on Ask Mandate, viewer on Proof, payee on Payments, client on Deals. Proof: `web/e2e/passkey-repair-role-landings.spec.ts` with axe. Screenshot `docs/evidence/q2/payee-landing.png`. | `8dbab75` |
| P5.T6 | done | PWA Unlock with Face ID on expired session, workbox denylist for authenticated paths. Proof: `web/e2e/passkey-repair-pwa-unlock.spec.ts` with axe. Screenshot `docs/evidence/q2/unlock-faceid.png`. | `7706128` |
| P5.T7 | done | First-run 3-mark coach tour (Waiting, Ask, Rules), mandate.coach.seen persistence, screen states (loading, empty, error). Proof: `web/e2e/passkey-repair-coach.spec.ts` with axe. Screenshot `docs/evidence/q2/coach-marks.png`. | `434b93c` |
| P5.T8 | done | Unlock and Studio show plain fallback when WebAuthn is unavailable. Proof: `web/e2e/passkey-repair-pwa-unlock.spec.ts` | `c5dbeb3` |
| P5.T9 | done | Mobile and desktop browser validation with axe, docs/PHONE_CHECKLIST.md runbook. Proof: `web/e2e/onboarding-doors.spec.ts` and `docs/PHONE_CHECKLIST.md` | `c5dbeb3` |
| P6.T1 | done | Create needs a passkey when the rule is on. Revoke is owner-only. The join page names the inviter and the role. Two joins: one wins. Proof: `api/test/identity.test.ts` | `6105e8d` |
| P6.T2 | done | Role change and revoke. The last owner stays. Revoke ends sessions and passkeys and lists open requests. `npm run admin:reset-owner` writes `admin_audit`. Screen `/app/members`. Proof: `api/test/identity.test.ts` | `f37e3e6` |
| P6.T3 | done | Machine key upgrade (POST /v1/agents/{id}/upgrade) with mnd_<type>_<workspace_id>_<secret> format, HMAC-SHA256 with pepper hash, legacy hash migration on first use, expiry dates, daily limits, last used tracking, prefix display. Proof: `api/test/agent-keys.test.ts`, `api/test/client-keys.test.ts` | `d7e13cf` |
| P6.T4 | done | Connect an agent screen with template wizard, scope checklist, can and cannot preview, expiry, and key testing. Screen /app/connect. Proof: `web/e2e/passkey-repair-agent-connect.spec.ts` | `d534bdb` |
| P6.T5 | done | Agent scorecard (requests, refusals, auto, needs-tap, last seen, breaker status). Screen /app/system. Proof: `api/test/agent-keys.test.ts`, `web/e2e/passkey-repair-agent-scorecard.spec.ts` | `3c432e1` |
| P6.T6 | done | Delegation end date: `expires_at` on members and invites, session refusal on expiration, and owner renewal. Proof: `api/test/identity.test.ts` | `d5dbb61` |
| P7.T1 | done | `safety` is a plain gate input to decide, matching request returns `DENY system.paused`, and reads still work while paused. Proof: `api/test/safety.test.ts` | `64d0882` |
| P7.T2 | done | Pause controls for all, autopilot, and one agent key. Approver can pause, only owner can resume, step-up required for resume when passkey rule active. Proof: `api/test/safety.test.ts` | `3499191` |
| P7.T3 | done | Auto-trip breakers (3 refusals/2m, 2 unknown payees/10m, 20 agent req/m, 3 autopilot failures) and owner edits settings with step-up. Proof: `api/test/safety.test.ts` | `4f3b355` |
| P7.T4 | done | UI pause banner with reason/time, header Pause button for owner and approver, and "Stopped" card and refused section on Today. Proof: `web/e2e/job.spec.ts` | `837a2df` |
| P7.T5 | done | `GET /v1/payees` lists payees with verification, cooling status, and diagnostics. Seeded Priya is active and attested. Proof: `api/test/phases.test.ts`, `api/test/safety.test.ts` | `805a9c8` |
| P7.T6 | done | Payee cooling period (first payment to new payee needs approval: `NEEDS_APPROVAL payee.not_active`), owner attestation with step-up, and pending payout account change lock (`DENY payee.change_pending`). Cases 31 and 32. Proof: `api/test/safety.test.ts`, `api/test/repair-pass.test.ts` | `805a9c8` |
| P7.T7 | done | Payee screen (/app/payees) with contractor accounts list, status chips, "Why can I not pay this account?" card with payability diagnostics, payout history, and passkey-guarded payout account change form. Proof: `web/e2e/passkey-repair-payees.spec.ts`, `docs/evidence/q4/payees.png` | `6ee890b` |
| P8.T1 | done | `api/test/phases.test.ts` "tries a payment without writing a row" | `9a2ea0b` |
| P8.T2 | done | Try-it box and boundary cases verified with side-by-side draft comparison. Proof: `api/test/try.test.ts`, `web/e2e/job.spec.ts` | `c3ebdb5` |
| P8.T3 | done | Tap to rule with suggestion drafter navigation and monthly tap count on Today. Proof: `web/e2e/job.spec.ts` | `c3ebdb5` |
| P8.T4 | done | Passkey publish ceremony cryptographically bound to warrant body and grant reuse rejection. Proof: `api/test/stepup.test.ts`, `web/src/lib/api.ts` | `c3ebdb5` |
| P8.T5 | done | Policy paste with 20,000 character cap, FLAG_POLICY_PASTE gating, at most 3 passes, segment table, and fenced untrusted prompt. Proof: `api/test/policy.test.ts`, `web/e2e/job.spec.ts` | `86984ae` |
| P8.T6 | done | Second reader wired behind FLAG_SECOND_READER off by default, executes when on. Proof: `api/test/drafter.test.ts` | `4a30cac` |
| P8.T7 | done | Eval of 30 wordings across 5 groups with scripted model in CI (checker only: 0 hidden loosenings), and real model eval (`gemma4:31b`: 11/11, 0 hidden loosenings, 52,697 tokens at 50,000 token cap). Proof: `api/test/eval-wordings.test.ts`, `api/scripts/eval-drafter.ts` | `59d7431` |
| P9.T1 | done | Ask Mandate opens from any screen, answers from ledger with no model, prepares button, navigates. Proof: `web/e2e/job.spec.ts` | `e18d30c` |
| P9.T2 | done | Clerk context includes receiptId and dealId across api schemas, agents service screenFor, AskService, Ask UI and web api. Proof: `api/test/ask.test.ts` | `06f34de` |
| P9.T3 | done | Payee-role payments screen with settled shares and read-only access. Proof: `web/src/screens/PayeePayments.tsx`, `api/test/shares.test.ts`, `web/e2e/passkey-repair-role-landings.spec.ts` | `3c64831` |
| P9.T4 | done | Build log in with PayPal behind PAYPAL_LOGIN_ENABLED with fake provider, login button on Unlock screen, verified off by default. Proof: `api/test/paypal-login.test.ts` | `df610b3` |
| P10.T1 | done | fast-check sequences for all invariants (pure gate, integer cents, idempotency, append-only) and multi-tenancy isolation over tenant A and B. Proof: `api/test/property.test.ts` | `bd55ea2` |
| P10.T2 | done | History replay as a Proof control under `POST /v1/replay` and on the Proof screen (`/app/proof`). Proof: `api/test/replay.test.ts`, `web/src/screens/Proof.tsx` | `be69728` |
| P10.T3 | done | Proof lines for members, assertions, signed rules, safety events, and key fingerprints. Proof: `api/test/audit.test.ts`, `api/src/services/audit.ts` | `97a89b6` |
| P10.T4 | done | `docs/guarantees.json`, `npm run guarantees`, and the Proof page reads it (`/app/proof`). Proof: `docs/guarantees.json`, `scripts/guarantees.mjs`, `web/src/screens/Proof.tsx`, `web/e2e/job.spec.ts` | `138212b` |
| P10.T5 | done | Appendix B cases 1 to 35 in the red team file. Proof: `api/test/redteam.test.ts` | `410c40f` |
| P11.T1 | done | Propose calls POST /v1/proposals through injected client in withMandate, read tier passes through, unknown tool throws. Proof: `api/test/phases.test.ts` | `c3a5567` |
| P11.T2 | done | `packages/guard/README.md` and that same test | `9a2ea0b` |
| P11.T3 | done | MCP_EXPOSE_READ_TOOLS wired behind flag in McpContext, http and app, Proof and System text reflects state when on, exposeReadTools disables read tools when false. Proof: `api/test/mcp.test.ts` | `925a11e` |
| P12.T1 | done | 14-item security checklist with evidence for each control. Proof: docs/SECURITY.md | `562234f` |
| P12.T2 | done | Chaos test suite covering PayPal timeout, model timeout, db lock, disk full, and model refusal. Proof: `api/test/chaos.test.ts` | `e89293c` |
| P12.T3 | done | Performance: p95 read test under 50ms, ControlRoom chunk split to 15.85 kB, mobile Lighthouse default throttling 56/98/96/100 (56/100/100/100 on Welcome and Today in demo); 4 vendor chunks > 1,000 kB. Proof: `api/test/p95.test.ts`, `docs/evidence/q8/lighthouse-mobile-unlock-default.json` | `1a4ced7` |
| P12.T4 | done | Passkey keyboard walk: pure keyboard navigation for studio creation, unlock sign-in, and passkey management with axe scan verification. Proof: `web/e2e/passkey-repair-keyboard.spec.ts`, `docs/evidence/q8/passkey-keyboard.png` | `40ebb61` |
| P12.T5 | done | Retention trimming: trim auth events at 90 days and logs/client errors at 14 days in cleanup job and store; updated docs/DATA.md. Proof: `api/test/ops-cleanup-scheduler.test.ts`, `docs/DATA.md` | `7c736c8` |
| P12.T6 | done | Documentation hardening: ONBOARDING.md, SECURITY.md (known limits), REFERENCE.md, README.md, CHANGELOG.md, OpenAPI types, Postman. Proof: `docs/ONBOARDING.md`, `docs/SECURITY.md`, `CHANGELOG.md` | `ac370c9` |
| P12.T7 | done | Deploy readiness: render.yaml configured with persistent disk mount /var/data and /var/data/mandate.sqlite, healthcheck /ready verified, preflight verified, docs/FINAL_REPORT.md produced. Proof: `render.yaml`, `scripts/preflight.mjs`, `docs/FINAL_REPORT.md` | `d28c9d9` |

## Appendix B cases 1 to 35

| Case | Test | Gap |
|---|---|---|
| 1 Cookie fails after logout | `web/e2e/passkey-repair.spec.ts` "a cookie from a finished session fails after logout" | separate Playwright project, virtual authenticator |
| 2 Cookie from before login fails after login | `web/e2e/passkey-repair.spec.ts` "a cookie planted before login is not the session after login" | same project |
| 3 Wrong Origin on a cookie POST is 403 | `api/test/repair-pass.test.ts` "rejects a cookie write from the wrong origin or without the web client header" | same test as case 4 |
| 4 Cookie POST without `X-Mandate-Client` is 403 | `api/test/repair-pass.test.ts` "rejects a cookie write from the wrong origin or without the web client header" | same test as case 3 |
| 5 Recovery code once, and that session cannot approve | `api/test/repair-pass.test.ts` "uses a recovery code once and that session cannot pause" | no recovery screen was added. The blocked call is pause, which is a non-GET outside `/auth/` |
| 6 Key brute force 429 and lockout, timing-safe | `api/test/repair-pass.test.ts` "counts wrong keys on the client ip and still accepts the real key" | wrong keys share one bucket per client IP |
| 7 Revoked member loses every session | `api/test/repair-pass.test.ts` "drops a revoked member session and will not remove the last owner" | store call, then the cookie. No members route. Same test as case 8 |
| 8 Last owner cannot be removed or demoted | `api/test/repair-pass.test.ts` "drops a revoked member session and will not remove the last owner" | store call. No members route. Same test as case 7 |
| 9 Assertion replay fails | `api/test/stepup.test.ts` "a step-up assertion cannot be used twice" | |
| 10 Assertion for lock A fails on lock B | `api/test/stepup.test.ts` "an assertion bound to one cart hash does not approve another" | title is "changed since you looked" |
| 11 UV flag off fails | `api/test/stepup.test.ts` "a step-up with user verification off is refused" | |
| 12 Revoked credential fails | `api/test/stepup.test.ts` "a revoked passkey cannot sign a step-up" | |
| 13 Assertion from another member fails | `api/test/stepup.test.ts` "a passkey from another member cannot approve" | |
| 14 Wrong origin or RP ID fails | `api/test/stepup.test.ts` "a step-up from the wrong origin or relying party id is refused" | |
| 15 Counter rollback revokes the credential | `api/test/stepup.test.ts` "a step-up counter that moves backwards revokes the passkey when another one exists" and "marks the last passkey suspect and keeps it" | login has the same two outcomes |
| 16 Approver over the limit is `approval.over_limit` | `api/test/stepup.test.ts` "an approver over their limit gets approval.over_limit" | cookie approver limit 1000 against a 15000 cent charge |
| 17 Proposer approve is 403 | `api/test/api.test.ts` "lets a proposer key ask and read, but never decide, capture, or change the warrant" and `api/test/stepup.test.ts` "a cookie proposer cannot approve" | |
| 18 Changed stored approval turns Proof red | `api/test/audit.test.ts` "turns a missing passkey signature red and leaves owner-key, demo, and legacy grey or amber", `api/test/verify.test.ts` "checks a Chromium virtual-authenticator vector and five one-bit changes", `web/e2e/passkey-repair-receipt.spec.ts` "sign in, approve, verify the receipt, then see a tampered one fail" | cart tamper remains in the job spec |
| 19 Reused, expired, or revoked invite fails | `api/test/repair-pass.test.ts` "does not burn an invite on the wrong studio, and a used, expired, or revoked invite fails" | no HTTP revoke route. The test sets `revoked_at` in the row. Same test as case 21 |
| 20 Two parallel joins, one wins | `api/test/repair-pass.test.ts` "lets one of two joins win" | |
| 21 Invite for A fails on B | `api/test/repair-pass.test.ts` "does not burn an invite on the wrong studio, and a used, expired, or revoked invite fails" | a join on the wrong studio does not consume the invite. Same test as case 19 |
| 22 Cookie, key, or id from A on B is 404 | `api/test/ops-cleanup-scheduler.test.ts` "Case 22: cookie, key, or id from A on B is 404" | |
| 23 Workspace id with `../` is 400 | `api/test/repair-pass.test.ts` "rejects a workspace id that is not an id", `api/test/ops-cleanup-scheduler.test.ts` "Case 23: workspace id with path traversal or invalid format is 400" | |
| 24 Random work in A leaves B's checksum unchanged | `api/test/repair-pass.test.ts` "hashes table rows, so work in one studio does not change the other", `api/test/ops-cleanup-scheduler.test.ts` "Case 24: random work in A leaves B checksum completely unchanged" | hash of ledger rows, not file bytes |
| 25 Demo switch, simulate, and demo tap fail outside a demo | `api/test/repair-pass.test.ts` "hides demo doors on the default studio and ignores a demo tap there" | |
| 26 Sixth demo from one IP in an hour is 429 | `api/test/repair-pass.test.ts` "shares one direct bucket when the proxy is not trusted", "gives two real addresses their own five demos", "with two trusted hops the client is the address two from the right" | two addresses get separate fives when the proxy is trusted |
| 27 Cleanup never deletes default, studio, or live | `api/test/ops-cleanup-scheduler.test.ts` "never deletes default, studio, or live workspaces even if expires_at is set (Appendix B Case 27)" | |
| 28 Budget 0 means zero model calls, quick asks still work | `api/test/ops-ratelimit-budget.test.ts` "budget 0 blocks reservations while quick asks still succeed" | |
| 29 Kill switch stops all agents | `api/test/repair-pass.test.ts` "a kill stops the clerk path and a drafter that already has a model" | studio turn and a drafter that already has a model |
| 30 Spam trips the breaker, resume needs step-up, proposer cannot pause | `api/test/safety.test.ts` "P7.T3 (Case 30): auto-trip breakers (unknown payees, agent spam, autopilot failures) and owner edits settings with step-up" | |
| 31 First payment to a new payee needs approval | `api/test/safety.test.ts` "P7.T5 & P7.T6 (Cases 31-32): payee cooling period, owner attestation, and pending change lock with step-up", `api/test/repair-pass.test.ts` "holds a first payment and refuses one while a change is pending" | |
| 32 Pending payee change blocks payouts | `api/test/safety.test.ts` "P7.T5 & P7.T6 (Cases 31-32): payee cooling period, owner attestation, and pending change lock with step-up", `api/test/repair-pass.test.ts` "holds a first payment and refuses one while a change is pending" | |
| 33 Pasted policy with a hidden instruction is flagged and not published | `api/test/intent.test.ts` "does not treat a forwarded note"; e2e "a pasted policy is read sentence by sentence" | |
| 34 Simulate writes zero rows | `api/test/phases.test.ts` "tries a payment without writing a row" | |
| 35 No test output or log contains a canary | `api/test/ops-readyz-secret.test.ts` "Case 35: secret and canary log redaction sweep", `api/test/phases.test.ts` "redacts a canary and a bearer token", and `scripts/check-secrets.mjs` | |

Cases 9 to 18 have the tests named in the table. Cases 1, 2, 3, 4, 5, 6, 7, 8, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, and 35 gained tests in the repair pass, Q3 ops suites, and Q4 safety suites. Under Q6.5 (P10.T5), every single Appendix B case (cases 1 to 35) was added to `api/test/redteam.test.ts` under the suite "Appendix B red team: cases 1 to 35". Cases with no test: none. Every case in Appendix B has verified test proof.

## Confirmed facts, not changes

- The workspace cache caps at 50 open apps and closes one that has been idle for 10 minutes (`api/src/tenancy/registry.ts`).
- Model caps are numbers: 500,000 global tokens a day, 30,000 per workspace, 4,096 output tokens, 8 steps (`OPEN_CAPS`). `MODEL_GLOBAL_DAILY_TOKENS` and `MODEL_WORKSPACE_DAILY_TOKENS` raise them. A cap of 0 refuses the call. The day's counters and an ops kill are stored on the ledger. `POST /ops/model/resume` with the admin key clears the kill row. The test is `api/test/repair-pass.test.ts` "a resume clears the kill row and the clerk can run again".
- `POST /demo/start` is off unless both tenancy and the demo flag are on. With `TRUST_PROXY=0`, `clientIp` is `direct` for every caller, so the per-IP demo cap (default 5 an hour) is one bucket for the whole server. With `TRUST_PROXY=1`, the client is the hop counted from the right (`TRUSTED_PROXY_HOPS`, default 1, maximum 8). A chosen value that is not an IP is `direct`. IPv6 is grouped by `/64`. Unknown keys share one per-minute bucket per client IP. A known key keeps its own.

## Gates

The baseline before Phase 4 is the repair pass in `docs/DECISIONS.md`: 46 files, 543 API tests, 114 Playwright tests, axe pass. The 522 API tests and 112 Playwright tests below are the earlier audit on the same day, before that repair. They are not the Phase 4 baseline.

Q0 on `q0-verify`, later the same day: `npm run gates` exited 0. 47 files, 568 API tests, 7.71s. Secret check 313 tracked files. `ControlRoom` still 4,602.45 kB. Playwright 116 passed (7.5m), axe included. The counts are in `docs/DECISIONS.md`.

`npm run gates` on 12 October 2026. Exit code 0. The command is hygiene, typecheck, the API suite, the secret check, the web build, then Playwright. Lighthouse is not part of this command and was not run. This run ticks no extra task.

Hygiene (`node scripts/ci/hygiene.mjs`): 23 checks passed. Node pin, both lockfiles, no tracked secret files, Render deploy-after-checks and `/ready`, production `NODE_ENV`, no secrets in `render.yaml`, and the four workflows declare permissions, pin actions to a SHA, and do not use `pull_request_target`.

Typecheck: `tsc --noEmit` in `api` and `web`. Both clean.

API tests: vitest 5.0.3, 45 files passed, 522 tests passed. Started 11:59:24. Duration 8.24s. The only warning is the Node SQLite experimental warning.

Secret check: passed, 302 tracked files.

Web build: vite 8.3.2, 2452 modules, built in 875ms. Warning: some chunks are larger than 1600 kB. `ControlRoom-hQ7W4Fko.js` is 4,602.45 kB (gzip 1,281.49 kB). `index.esm` is 1,194.65 kB. PWA precache is 40 entries (2454.12 KiB).

Playwright (`npm --prefix web run e2e`): 112 passed (7.4m), 1 worker. Desktop tests 1 to 56 and phone tests 57 to 112, all in `web/e2e/job.spec.ts`. Axe runs inside that suite. "a receipt has a guide, and the open tour passes axe" is desktop 10 and phone 66. "every signed-in screen passes axe (WCAG 2.1 AA)" is desktop 30 and phone 86. No failures.

P12.T3 complete: p95 read test passes in api/test/p95.test.ts, ControlRoom chunk split to 15.85 kB, mobile Lighthouse default throttling scored 56 perf / 98 a11y / 96 best practices / 100 SEO on Unlock (56/100/100/100 on Welcome and Today in demo); 4 vendor chunks exceed 1,000 kB uncompressed.
