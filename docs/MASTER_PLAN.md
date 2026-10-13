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
| P1.T1 | partial | `api/src/config.ts` already parsed env. `api/src/ops/secret.ts` `SecretString` is not wrapped around boot secrets | `9a2ea0b` |
| P1.T2 | partial | `api/test/phases.test.ts` "redacts a canary and a bearer token". Not every route class | `9a2ea0b` |
| P1.T3 | partial | `api/test/phases.test.ts` "limits auth attempts with an injected clock". Classed limits run only when `TRUST_PROXY=1`. `auth_throttle` is not what the live bucket uses | `9a2ea0b` |
| P1.T4 | partial | `api/test/phases.test.ts` "does not call the model when the budget is zero". `OPEN_CAPS` in `api/src/ops/budget.ts`. Kill route exists. Quick asks are not in that test | `9a2ea0b` |
| P1.T5 | done | Headers on `/healthz`, `/app`, `/v1`, and `/auth`. `api/test/phases.test.ts` "sends the extra security headers and the health alias". `api/test/repair-pass.test.ts` "refuses paths that leave the web build and still serves a file inside it" | `9a2ea0b` |
| P1.T6 | partial | `api/test/phases.test.ts` "refuses a migration whose checksum changed". No backup before migrate. No seeded-copy test | `9a2ea0b` |
| P1.T7 | partial | same health alias test. `GET /readyz` redirects. No SSE caps. Shutdown in `api/src/main.ts` is older | `9a2ea0b` |
| P1.T8 | partial | `api/test/phases.test.ts` "serves metrics only to the admin key" | `9a2ea0b` |
| P1.T9 | partial | `scripts/db-backup.mjs`, `scripts/db-restore.mjs`. No test | `9a2ea0b` |
| P2.T1 | partial | `api/src/control/store.ts` `ensureDefault`. `api/test/phases.test.ts` "stays a single studio when the flags are off" | `9a2ea0b` |
| P2.T2 | partial | `api/src/tenancy/registry.ts` max 50, idle 10 minutes. Handlers were not moved onto the request | `9a2ea0b` |
| P2.T3 | partial | `api/test/phases.test.ts` "isolates a demo, rejects a bad id, and will not delete a studio". MCP is not under `/w` | `9a2ea0b` |
| P2.T4 | partial | seal and open in that same test. No per-workspace public key route | `9a2ea0b` |
| P2.T5 | not started | `external_refs` methods exist. Webhooks do not write them | `9a2ea0b` |
| P2.T6 | partial | template is built in `api/src/boot.ts` when flags are on. No `npm run seed:template`. No number test | `9a2ea0b` |
| P2.T7 | partial | demo start is in the isolation test. `reset`, `switch`, and `simulate` are in `api/src/http/extra.ts` and have no test | `9a2ea0b` |
| P2.T8 | partial | caps are read in `POST /demo/start`. No sixth-demo test, no disk quota, no separate demo model cap | `9a2ea0b` |
| P2.T9 | partial | isolation test: `deleteDemo` on a studio returns false. No 15 minute job. The file is not removed by a scheduler | `9a2ea0b` |
| P2.T10 | not started | no tenant scheduler | |
| P2.T11 | partial | isolation test covers 404, 400, and studio delete. Not the full Appendix B set | `9a2ea0b` |
| P3.T1 | partial | `api/src/control/store.ts` schema. No migration test | `9a2ea0b` |
| P3.T2 | partial | `api/test/phases.test.ts` "registers a passkey and signs in with it" | `9a2ea0b` |
| P3.T3 | partial | `api/src/auth/cookies.ts`, CSRF in `api/src/app.ts`. No origin test | `9a2ea0b` |
| P3.T4 | partial | bearer then cookie in `api/src/app.ts`. Old key tests still pass in the API suite. No new test names this | `9a2ea0b` |
| P3.T5 | partial | role checks in `api/src/app.ts`. No role-matrix test | `9a2ea0b` |
| P3.T6 | partial | `actor_json` written in `api/src/db/repo.ts`. No test | `9a2ea0b` |
| P3.T7 | done | Sessions list, revoke, revoke others, and owner sign-in history. The list hides the token. Screen `/app/sessions`. | `52fde09` |
| P3.T8 | done | Issue, confirm with "I saved these", use once, and regenerate with a passkey step-up. Codes are hashed. | `5f7d0c5` |
| P3.T9 | done | Add a passkey and refuse to remove the last one. Another member's id is 404. The screen is `/app/sessions`. | `2904707` |
| P3.T10 | done | Chromium virtual authenticator covers register, sign in again, step-up approve, a second passkey, and recovery replace. | `a9df7ed` |
| P4.T1 | done | `workspaces.passkey_for_money` is on for a new studio and off for the default studio and a demo. Turning it on is tested | `fd1432b` |
| P4.T2 | done | Approve grant is one use, 120 seconds, member plus cart hash. Parallel approve and both rollback outcomes are tested | `283544d` |
| P4.T3 | done | `proposal.approved` stores the assertion. `0002_warrant_signature` adds `warrants.signature_json` and a file copy is taken first. An older file still reads `{ actor, cartHash }`. Existing money routes require a step-up. The missing key, member, invite-revoke, and payee routes stay 404 | `751ac9f` |
| P4.T4 | done | Enrollment shows the fingerprint with "Save this". The receipt line is who, how, when, and 8 hex characters. A missing passkey assertion is red. Owner-key and demo are amber. Old rows are grey and marked legacy | `b6cb07f` |
| P4.T5 | done | Verify checks ES256 from a Chromium virtual-authenticator vector, including five one-bit changes. Wording is "valid signature by this key". Unknown algorithms say "cannot verify here". One passkey Playwright test signs in, approves, verifies, and sees a tampered receipt fail | `e5913da` |
| P4.T6 | done | A passkey approval with no assertion is red and fails `approval.proof`. Owner-key and demo are amber and do not fail. Old rows are grey and marked legacy. A standing rule with no signature stays grey and says that version has no signature | `b6cb07f` |
| P4.T7 | done | Demo tap sends `x-mandate-demo-tap` and stores method `demo`. The receipt proof is amber. The Today card shows Demo tap and Try with my passkey. The same header outside a demo stores owner-key. gates:fast 567 | `6968dcd` |
| P4.T8 | done | The Today approval card shows amount, payee, category, evidence, a short cart hash, and the clause before the prompt. The success toast says Signed and sent. Approved · locked stays | `1cdbfef` |
| P5.T1 | partial | `web/src/screens/Landing.tsx` has the three doors and the trust strip. The h1 is still "Agents can ask." No test of the new doors | `9a2ea0b` |
| P5.T2 | partial | `api.demoStart` and the demo banner in `web/src/components/Shell.tsx`. No role switcher, reset, or live-proof page. No test | `9a2ea0b` |
| P5.T3 | done | Studio wizard: name, passkey, second passkey or recovery codes required, simulated PayPal text, rules in words can skip, progress in local storage. | `q1-identity` |
| P5.T4 | done | `web/src/screens/Unlock.tsx` has the authority sentence. Route `/app/unlock` | `9a2ea0b` |
| P5.T5 | not started | no role landings | |
| P5.T6 | partial | `web/vite.config.ts` `id` and shortcuts. No "Unlock with Face ID" on an expired session | `9a2ea0b` |
| P5.T7 | not started | the old tour is unchanged. No 3-mark coach | |
| P5.T8 | partial | `web/src/screens/Studio.tsx` says the browser cannot use passkeys | `9a2ea0b` |
| P5.T9 | not started | no new browser tests. Phone checklist not run | |
| P6.T1 | done | Create needs a passkey when the rule is on. Revoke is owner-only. The join page names the inviter and the role. Two joins: one wins. | `6105e8d` |
| P6.T2 | done | Role change and revoke. The last owner stays. Revoke ends sessions and passkeys and lists open requests. `npm run admin:reset-owner` writes `admin_audit`. Screen `/app/members`. | `f37e3e6` |
| P6.T3 | not started | old `mnd_ag_` and `mnd_cl_` keys were left as they are | |
| P6.T4 | partial | `web/e2e/job.spec.ts` "Connect any agent shows how to plug in an MCP agent". Not the new template wizard | `1ac59cd` |
| P6.T5 | partial | `api/test/agent-keys.test.ts` hourly counts and last seen. Not a scorecard into a new breaker | `1ac59cd` |
| P6.T6 | not started | no delegation end date | |
| P7.T1 | partial | `safety_events` and pause already deny. `api/test/safety.test.ts`. Not a new gate input from this commit | `1ac59cd` |
| P7.T2 | partial | `web/e2e/job.spec.ts` "the owner can stop everything with one button". Resume does not require a passkey. One-agent pause is the older suspend | `1ac59cd` |
| P7.T3 | partial | `api/test/agent-keys.test.ts` "suspends only the misbehaving agent". Not the full trip list, and the owner cannot edit it with step-up | `1ac59cd` |
| P7.T4 | partial | same e2e pause test. No "Stopped" proof on Today | `1ac59cd` |
| P7.T5 | partial | `api/test/phases.test.ts` "tries a payment without writing a row" sees Priya in `GET /v1/payees` | `9a2ea0b` |
| P7.T6 | partial | `api/src/domain/payee-book.ts`. `api/test/phases.test.ts` "never turns a refusal into an approval". No test that a new payee needs approval | `9a2ea0b` |
| P7.T7 | not started | no payee screen | |
| P8.T1 | done | `api/test/phases.test.ts` "tries a payment without writing a row" | `9a2ea0b` |
| P8.T2 | partial | `web/e2e/job.spec.ts` "the owner can try a request and check the rules with cases" | `1ac59cd` |
| P8.T3 | partial | same e2e test | `1ac59cd` |
| P8.T4 | partial | `web/e2e/job.spec.ts` "a suggested rule shows on Today". Publishing does not require a passkey | `1ac59cd` |
| P8.T5 | partial | `api/test/policy.test.ts`, `api/test/intent.test.ts`, e2e "a pasted policy is read sentence by sentence". The 20,000 character cap and `FLAG_POLICY_PASTE` are not what that screen uses | `1ac59cd` |
| P8.T6 | not started | `FLAG_SECOND_READER` is parsed and unused | `9a2ea0b` |
| P8.T7 | not started | no 30-wording eval | |
| P9.T1 | partial | `web/e2e/job.spec.ts` "Ask Mandate opens from any screen" | `1ac59cd` |
| P9.T2 | partial | clerk context is `jobId` and `proposalId` in `web/src/lib/api.ts`. Not `receiptId` or `dealId` | `1ac59cd` |
| P9.T3 | partial | `api/test/shares.test.ts`. No payee-role payments page | `1ac59cd` |
| P9.T4 | not started | `PAYPAL_LOGIN_ENABLED` stays off. No fake IdP | `9a2ea0b` |
| P10.T1 | partial | `api/test/property.test.ts` "keep every promise, in 40 runs of 36 random steps". Not fast-check over tenant A and B | `1ac59cd` |
| P10.T2 | partial | `api/test/replay.test.ts`. Not added as a Proof control in this work | `1ac59cd` |
| P10.T3 | partial | `api/test/audit.test.ts`. No member, assertion, or safety-event lines from this plan | `1ac59cd` |
| P10.T4 | partial | `web/e2e/job.spec.ts` "the Proof page lists what Mandate promises". No `docs/guarantees.json` or `npm run guarantees` | `1ac59cd` |
| P10.T5 | not started | Appendix B cases are not in the red team file | |
| P11.T1 | partial | `api/test/phases.test.ts` "removes an unknown tool and forwards propose". Propose calls the callback, not `POST /v1/proposals` | `9a2ea0b` |
| P11.T2 | done | `packages/guard/README.md` and that same test | `9a2ea0b` |
| P11.T3 | not started | `MCP_EXPOSE_READ_TOOLS` is parsed in `api/src/flags.ts` and never read by the MCP server | `9a2ea0b` |
| P12.T1 | not started | no recorded checklist pass | |
| P12.T2 | not started | no chaos tests | |
| P12.T3 | not started | no p95 test, no Lighthouse number from this run | |
| P12.T4 | partial | `web/e2e/job.spec.ts` "every signed-in screen passes axe". Passkey keyboard walk was not done | `1ac59cd` |
| P12.T5 | partial | `docs/DATA.md` says what is actually kept. It does not trim logs at 14 days or auth events at 90 | `9a2ea0b` |
| P12.T6 | partial | `CHANGELOG.md`, `docs/SECURITY.md`, two OpenAPI lines, one Postman request. No `docs/ONBOARDING.md` | `9a2ea0b` |
| P12.T7 | partial | `npm run preflight` in `scripts/preflight.mjs`. `render.yaml` was not given a workspace disk. Not deployed | `9a2ea0b` |

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
| 22 Cookie, key, or id from A on B is 404 | partial: "isolates a demo, rejects a bad id, and will not delete a studio" | demo cookie on `ws_default` only |
| 23 Workspace id with `../` is 400 | `api/test/repair-pass.test.ts` "rejects a workspace id that is not an id" | |
| 24 Random work in A leaves B's checksum unchanged | `api/test/repair-pass.test.ts` "hashes table rows, so work in one studio does not change the other" | hash of ledger rows, not file bytes |
| 25 Demo switch, simulate, and demo tap fail outside a demo | `api/test/repair-pass.test.ts` "hides demo doors on the default studio and ignores a demo tap there" | |
| 26 Sixth demo from one IP in an hour is 429 | `api/test/repair-pass.test.ts` "shares one direct bucket when the proxy is not trusted", "gives two real addresses their own five demos", "with two trusted hops the client is the address two from the right" | two addresses get separate fives when the proxy is trusted |
| 27 Cleanup never deletes default, studio, or live | partial: same isolation test, `deleteDemo` on a studio is false | no cleanup job, no default or live row |
| 28 Budget 0 means zero model calls, quick asks still work | partial: "does not call the model when the budget is zero" | quick asks are not asserted |
| 29 Kill switch stops all agents | `api/test/repair-pass.test.ts` "a kill stops the clerk path and a drafter that already has a model" | studio turn and a drafter that already has a model |
| 30 Spam trips the breaker, resume needs step-up, proposer cannot pause | partial: `api/test/agent-keys.test.ts` "suspends only the misbehaving agent" and e2e pause | no step-up resume, no proposer pause test |
| 31 First payment to a new payee needs approval | `api/test/repair-pass.test.ts` "holds a first payment and refuses one while a change is pending" | same test as case 32 |
| 32 Pending payee change blocks payouts | `api/test/repair-pass.test.ts` "holds a first payment and refuses one while a change is pending" | same test as case 31 |
| 33 Pasted policy with a hidden instruction is flagged and not published | `api/test/intent.test.ts` "does not treat a forwarded note"; e2e "a pasted policy is read sentence by sentence" | |
| 34 Simulate writes zero rows | `api/test/phases.test.ts` "tries a payment without writing a row" | |
| 35 No test output or log contains a canary | partial: "redacts a canary and a bearer token" and `scripts/check-secrets.mjs` | not a log sweep of the suite |

Cases 9 to 18 have the tests named in the table. Cases 1, 2, 3, 4, 5, 6, 7, 8, 19, 20, 21, 23, 24, 25, 26, 29, 31, and 32 gained a test in the repair pass. Cases still partial, with no full test, are 22, 27, 28, 30, and 35.

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

P12.T3 stays not started. There is no p95 number and no Lighthouse number.
