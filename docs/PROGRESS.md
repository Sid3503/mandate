# Progress

## Done

- P4.T1 `fd1432b`, P4.T2 `283544d`, P4.T3 `751ac9f`, P4.T4 `b6cb07f`, P4.T5 `e5913da`, P4.T6 `b6cb07f`, P4.T7 `6968dcd`, P4.T8 `1cdbfef`.
- Q0.1 `8624506` on `q0-verify`. Q0.2 `bf2e482`. Q0 is complete.
- Q1.1 P3.T7 `52fde09`: session list, revoke, revoke others, owner sign-in history, screen `/app/sessions`.
- Q1.2 P3.T8 `5f7d0c5`: recovery codes issued, confirmed with "I saved these", used once, and replaced only with a passkey step-up. Proof: `api/test/identity.test.ts` and `web/e2e/passkey-repair-recovery.spec.ts`.
- Q1.3 P3.T9 `2904707`: add a passkey and refuse to remove the last one. Another member's id is 404. A call without the web client header is 403. Proof: `api/test/identity.test.ts` and `web/e2e/passkey-repair-passkeys.spec.ts`. Screenshot `docs/evidence/q1/passkeys.png` shows a fingerprint and no codes.
- Q1.4 P3.T10 `a9df7ed`: Chromium virtual authenticator on register (`passkey-repair.spec.ts`), sign in again (`passkey-repair-login.spec.ts`), step-up approve (`passkey-repair-receipt.spec.ts`), a second passkey (`passkey-repair-passkeys.spec.ts`), and recovery replace (`passkey-repair-recovery.spec.ts`). Unlock has "Sign in with a passkey". Screenshot `docs/evidence/q1/passkey-login.png` shows one active session, one ended session, and no codes.
- Run book v2 `31d78b3`. No checkpoints. A blocked task is logged and the queue continues.
- Q1.5 P6.T1 `6105e8d`: invite create needs a passkey when the rule is on. Revoke is owner-only, a proposer is 403, an unknown token is 404. The join page names the inviter and the role. Race: `api/test/repair-pass.test.ts` "lets one of two joins win". Screenshot `docs/evidence/q1/invite.png` shows no token.
- Q1.6 P6.T2 `f37e3e6`: members list, role change, and revoke. The last owner stays. Revoke ends sessions and passkeys and lists open requests. `npm run admin:reset-owner` writes `admin_audit`. Proof: `api/test/identity.test.ts` and `web/e2e/passkey-repair-members.spec.ts`. Screenshot `docs/evidence/q1/members.png` shows the refusal and no codes.
- Q1.7 P5.T3 `0a41958`: studio wizard. A second passkey or recovery codes are required before Today. PayPal text says the charge is simulated. Rules in words can be skipped. Progress is in local storage. Proof: `web/e2e/passkey-repair-wizard.spec.ts`. Screenshot `docs/evidence/q1/wizard.png` shows no codes.
- Q1.8 P6.T3: an owner can replace an `mnd_ag_` or `mnd_cl_` secret and keep the same agent or client. A legacy hash of the bare secret is rewritten on first use. Proof: `api/test/agent-keys.test.ts` and `api/test/client-keys.test.ts`.
- Q1.9 P6.T4: connect an agent screen with templates, preview, expiry, and key testing. Screen `/app/connect`. Proof: `api/test/agent-keys.test.ts` and `web/e2e/passkey-repair-agent-connect.spec.ts`. Screenshot `docs/evidence/q1/connect-agent.png` shows no secret.
- Q1.10 P6.T5: agent scorecard feeding the safety breaker. Proof: `api/test/agent-keys.test.ts` and `web/e2e/passkey-repair-agent-scorecard.spec.ts`. Screenshot `docs/evidence/q1/scorecard.png` shows no secret.
- Q1.11 P6.T4 `cded03b`: button label alignment with e2e job suite. Full `npm run gates` complete for Q1.
- Q2.1 P5.T1 `fda497e`: welcome headline, line of proof, three doors, trust strip with verify link. Proof: `web/e2e/onboarding-doors.spec.ts`. Screenshot `docs/evidence/q2/doors.png`.
- Q2.2 P5.T2 `fdd1ca4`: demo banner, role switcher (owner, approver, proposer, viewer, payee), reset, and live proof page. Proof: `api/test/demo-onboarding.test.ts` and `web/e2e/passkey-repair-demo.spec.ts`. Screenshot `docs/evidence/q2/demo-banner.png`.
- Q2.3 P5.T5 `8dbab75`: role landings for owner/approver on Today, proposer on Ask Mandate, viewer on Proof, payee on Payments, client on Deals. Proof: `web/e2e/passkey-repair-role-landings.spec.ts` with axe. Screenshot `docs/evidence/q2/payee-landing.png`.
- Q2.4 P5.T6 `7706128`: PWA unlock with Face ID on expired session, workbox denylist for authenticated paths. Proof: `web/e2e/passkey-repair-pwa-unlock.spec.ts` with axe. Screenshot `docs/evidence/q2/unlock-faceid.png`.
- Q2.5 P5.T7 `434b93c`: first-run 3-mark coach tour (Waiting, Ask, Rules), mandate.coach.seen persistence, screen states (loading, empty, error). Proof: `web/e2e/passkey-repair-coach.spec.ts` with axe. Screenshot `docs/evidence/q2/coach-marks.png`.
- Q2.6 P5.T8 P5.T9: mobile and desktop browser validation with axe, docs/PHONE_CHECKLIST.md runbook, Unlock and Studio WebAuthn fallback notice. Proof: `web/e2e/passkey-repair-pwa-unlock.spec.ts`, `web/e2e/onboarding-doors.spec.ts`, `docs/PHONE_CHECKLIST.md`.
- Q3.1 P1.T1 P1.T7: Boot secrets wrapped in SecretString and redacted on inspect/JSON. Real /readyz endpoint with sqlite datastore check (no redirect). SSE stream connections capped to 50 with 429 refusal on cap overflow. Proof: `api/test/ops-readyz-secret.test.ts`.
- Q3.2 P1.T3 P1.T4 P2.T8: RateLimiter classes (auth, key-unlock, ask, write, read), pruneBuckets, method/path mappings. Model budget 0 blocks model reservations while quick asks still work (case 28). Per-demo workspace model daily cap (50k tokens) and IP rate limiting (sixth demo 429, case 26). Proof: `api/test/ops-ratelimit-budget.test.ts`.
- Q3.3 P1.T6 P1.T9: Pre-migration backup on file database before applying new steps, seeded-copy upgrade test, migration checksum tamper rejection, db:backup and db:restore script tests with automatic safety backups. Proof: `api/test/ops-backup-migration.test.ts`.
- Q3.4 P2.T6 P2.T7: npm run seed:template script with frozen numbers test (warrants, buyer rules, seller rules, payees). Integration tests for demo reset (/v1/demo/reset), role switcher (/v1/demo/switch), and simulate (/v1/demo/simulate). Proof: `api/test/ops-demo-template.test.ts`.
- Q3.5 P2.T3 P2.T4 P2.T5: MCP under `/w/:workspaceId/mcp`, per-workspace public keys route `GET /w/:workspaceId/.well-known/mandate-keys.json`, and tenant webhook routing via `external_refs`. Proof: `api/test/ops-tenant-routing.test.ts`.
- Q3.6 P2.T9 P2.T10 P2.T11: 15-minute cleanup job (`cleanupExpiredDemos`) deletes only expired demo workspaces and SQLite files, preserving default, studio, and live workspaces. Single tenant scheduler (`runTenantSchedulerSweep`) sweeps active external_refs without per-tenant timers; on-demand demo ticks on simulate and Today. Isolation test suite (Cases 22, 23, 24, 27). Proof: `api/test/ops-cleanup-scheduler.test.ts`.
- Q3.7 Case 35: Suite-wide secret and canary log redaction sweep test. Proof: `api/test/ops-readyz-secret.test.ts`.
- Q4.1 P7.T1: Gate receives plain `safety` input in `GateProposal` and `decide`, returning `DENY system.paused` on paused matching request while reads still work completely. Proof: `api/test/safety.test.ts`.

## Test counts

- Baseline before Phase 4: 46 files, 543 API tests, 114 Playwright, axe pass. The 522 and 112 numbers are the earlier audit.
- Full `npm run gates` on 12 October 2026, `q0-verify`: 47 files, 568 API tests, 7.71s, secret check 313, Playwright 116, axe included.
- Full `npm run gates` after Q1 on 13 October 2026: 48 files, 594 API tests, 10.00s, secret check 345 tracked files, Playwright 125 passed (8.1m), axe included, exit 0.
- `gates:fast` after Q2.5: 49 files, 596 API tests, 9.97s, secret check 356 tracked files, exit 0.
- Full `npm run gates` after Q2 on 13 October 2026: 49 files, 596 API tests, 10.40s, secret check 356 tracked files, Playwright 133 passed (8.5m), axe included, exit 0.
- `gates:fast` after Q3.1: 50 files, 599 API tests, 9.83s, secret check 359 tracked files, exit 0.
- `gates:fast` after Q3.2: 51 files, 609 API tests, 9.62s, secret check 360 tracked files, exit 0.
- `gates:fast` after Q3.3: 52 files, 615 API tests, 12.27s, secret check 361 tracked files, exit 0.
- `gates:fast` after Q3.4: 53 files, 623 API tests, 11.73s, secret check 362 tracked files, exit 0.
- `gates:fast` after Q3.7: 55 files, 635 API tests, 12.25s, secret check 368 tracked files, exit 0.
- Full `npm run gates` after Q3 on 13 October 2026: 55 files, 635 API tests, 12.35s, secret check 368 tracked files, Playwright 133 passed (9.5m), axe included, exit 0.
- `gates:fast` after Q4.1: 55 files, 636 API tests, 11.27s, secret check 368 tracked files, exit 0.

## Open items

- Appendix B cases still partial: 30. (Cases 22, 27, 28, 35 complete).

## Human todo

- Two real sandbox receipts in `docs/live-proof/`.

## False assumptions

- Appendix B said cases 10 to 16 had no test. The table already named the tests.
- The 522 and 112 counts were treated as the Phase 4 baseline. The repair pass is 543 and 114.

## Decisions

- This queue runs in Grok. Reports go in this file. Do not push.
- Master-plan P4.T6 is the proof-color check. The demo tap stays on P4.T7.
- `DEMO_ENABLED` is on only inside `api/src/dev/passkey-server.ts`.
- A session's public id is a random id, not the token hash. Revoke of another member's id is 404.
- `FLAG_INVITES` is on only inside `api/src/dev/passkey-server.ts`, same as `DEMO_ENABLED`. A bearer key cannot revoke an invite.
- Member role and revoke are `POST /v1/members/:id/role` and `POST /v1/members/:id/revoke`. `POST /v1/members` stays absent. Open requests are proposals in `pending_approval`, because the ledger has no member column. Revoke clears every passkey, including the last one. Role change ends sessions and keeps passkeys.
- The studio wizard stores progress in `mandate.studio.progress`. It does not store recovery codes. Rules in words are not published. Today stays closed until a second passkey or saved codes.
- Machine key upgrade keeps the same id. New secrets still use `mnd_ag_` and `mnd_cl_`, because the browser suite matches those prefixes. A hash of the bare secret is accepted once and then stored as the hash of the whole key.
- Demo role switch and demo reset are allowed for viewer, payee, and approver in demo workspace mode.
- Live proof reads `docs/live-proof/*.json`. If empty, the page displays "not added yet".
- Role landings: owner and approver land on Today, proposer on Ask Mandate (/app/clerk), viewer on Proof (/app/proof), payee on Payments (/app/payments), client on Deals (/app/deals). Direct navigation to /app/ redirects non-owner roles to their role landing in demo mode. useToday query only runs for owner/approver.
- PWA unlock with Face ID: on expired session (401 or ?reason=expired or mandate.session.expired), /app/unlock presents an immediate biometric unlock button "Unlock with Face ID" alongside manual key unlock. Workbox denylists /v1/, /auth/, /w/, and /mcp/ paths from navigation fallback.
- First-run coach marks: exactly 3 marks on initial onboarding (Today Waiting, Ask Mandate, Rules). Tracked in mandate.coach.seen and mandate.tour.welcome, dismissable and never repeated. Loading, empty, and error states provided across all screens.
- WebAuthn fallback: when window.PublicKeyCredential is unavailable, Unlock displays a plain warning notice guiding user to unlock via API key or modern browser, matching Studio fallback.
- Tour compatibility: classic console maintains full welcome walkthrough while demo onboarding delivers streamlined 3-mark coach tour.
- Boot secrets: loadConfig wraps boot secrets in SecretString so secrets are never leaked in logs or JSON serializations.
- Real /readyz: /readyz executes identical datastore readiness check directly, avoiding probe redirect loops.
- SSE cap: /v1/stream caps active connections at 50, returning 429 when capacity is reached.
- MCP under /w: mounted per workspace under /w/:workspaceId/mcp and isolated to that tenant.
- Public keys under /w: per-workspace public key endpoint under GET /w/:workspaceId/.well-known/mandate-keys.json.
- Webhook routing: top-level webhook deliveries resolve recipient tenant via external_refs ('payout', 'invoice', 'order').
- 15-minute cleanup job: cleanupExpiredDemos sweeps every 15 minutes, deleting only expired demo workspaces (mode='demo' and expires_at < now) and their SQLite files from disk, while unconditionally preserving default, studio, and live workspaces.
- Tenant scheduler: runTenantSchedulerSweep sweeps only workspaces with active external_refs without per-tenant timers. Demo workspaces tick sweeps on demand on simulate actions and when Today is opened.
- Isolation suite: verified Appendix B cases 22 (session cookie, key, or id from A on B is 404/401), 23 (path traversal ../ is 400), 24 (operations in A leave B database checksum identical), and 27 (cleanup never deletes default, studio, or live).

## Next

Cut branch `q4-safety` and execute Q4 Safety (P7.T1 through P7.T7).
