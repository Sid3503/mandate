# Repair and test pass

Status: APPROVED WITH 5 CHANGES. The work is on `repair/hardening`. This file is the plan, not a second copy of the phase report.

No new features. No Phase 4. No push, merge, or deploy. History is not rewritten.

This artifact is the plan. Work starts only after you approve it. The branch, the docs commit, the repairs, and the tests are the work that follows.

## What this pass will change

1. Commit the audit docs on a new branch.
2. Record the audit gate counts and tick P0.T1.
3. Quote the real model provider. No code change for that.
4. Stop trusting a forged `X-Forwarded-For`.
5. Lower the default daily model caps. A higher number stays an env var.
6. Move `@hono/node-server` to a fix that is at least 14 days old, if `npm audit` still reports it. Record every remaining high.
7. Add the named red-team tests. Change product code only when a test shows a real bug.
8. Run `npm run gates` and write the phase report. Stop.

Flags stay off by default. Tests may turn a flag on inside that test only.

## Recon, already checked

### Model provider

`1ac59cd` (main) and this branch (`9a2ea0b`) use the same file. `git show 1ac59cd:api/src/agents/model.ts` matches the working tree.

`api/src/agents/model.ts` line 2:

```
import { createOllama } from 'ai-sdk-ollama'
```

Line 9: "It is one provider: Ollama Cloud's open-weights models."

Lines 12 to 13: `DEFAULT_OLLAMA_MODEL` is `gemma4:31b`. `DEFAULT_OLLAMA_PRIMARY` is `gpt-oss:20b`.

Lines 39 to 40: `buildModels` calls `createAgentModel` with `OLLAMA_API_KEY` and `AGENT_MODEL`, and the primary name falls back to `gpt-oss:20b`.

No file under `api/` imports Bedrock on either commit. `README.md` and `PRODUCT.md` already name Ollama Cloud as the default. Bedrock in `docs/REFERENCE.md` is a past score, labeled historical. The Bedrock sentence was in the plan text, and `docs/DECISIONS.md` already says the code does not match that sentence.

The real default is Ollama Cloud. This pass will not switch the provider and will not rewrite the product docs to say Bedrock.

### Client IP

`api/src/ops/client-ip.ts` returns `direct` when `TRUST_PROXY` is off. When it is on, it takes the first hop from the left.

`api/src/app.ts` around line 264 does not use that helper. The old per-minute bucket reads the first `X-Forwarded-For` hop even when `TRUST_PROXY` is off. It also hashes the `Authorization` header, so each different wrong key gets its own bucket.

`POST /demo/start` uses `clientIp`. With `TRUST_PROXY=0` every caller shares `direct`.

### Model caps

`OPEN_CAPS` in `api/src/ops/budget.ts` is 10,000,000 global tokens a day and 1,000,000 per workspace. `reserve()` adds at most 500 tokens per call. `blocked()` refuses when the spent total has reached the cap. There is no env override.

### Hono

`api/package-lock.json` resolves `@hono/node-server` to 1.19.12. Server code imports `serve` from it in `api/src/main.ts` and `api/src/dev/e2e-server.ts`. It does not import `serveStatic`.

Public advisories on the 1.19 line: path confusion in `serveStatic` is fixed in 1.19.13 (7 April 2026). Snyk lists 1.19.17 (27 July 2026) with no direct vulnerabilities. Both dates are more than 14 days before 12 October 2026. 2.1.3 (29 September 2026) and 2.1.4 are newer than 14 days. This pass will not take 2.x.

The update happens only if `npm audit` still reports 1.19.12. The pin will be exact `1.19.17`, MIT, with a line in `docs/DECISIONS.md`. Reachability of every remaining high is decided by an import search during the pass, then written in `docs/SECURITY.md`. Expected leftovers from the last audit sit inside `@paypal/agent-toolkit` (langchain, langsmith, mathjs, jsondiffpatch). Those are not force-fixed.

### Red team code that already exists

Cookie logout revokes the session (`POST /auth/logout`). Login always issues a new cookie and does not adopt the cookie that arrived with the request. A cookie write that is not GET checks `cookieWriteAllowed`: `X-Mandate-Client: web` and an allowed `Origin`, or `Sec-Fetch-Site: same-origin`. Bearer calls skip that check.

Recovery sessions are rejected on non-GET routes outside `/auth/`. `useRecovery` marks a code used. The store refuses to demote or revoke the last owner and revokes that member's sessions. There is no HTTP route for member revoke, member role, or invite revoke. Tests will call the store, then show the cookie is dead. They will not add those screens or routes.

Invites fail when used, expired, or `revoked_at` is set, and a join on the wrong workspace is rejected. `../` cannot pass `isWorkspaceId`. Demo switch and simulate 404 outside a demo. `x-mandate-demo-tap` is ignored unless the workspace mode is `demo` and `REQUIRE_PASSKEY_FOR_MONEY` is on.

The kill switch calls `budget.kill()`. Agent calls go through `AgentService.need()`, which checks that budget. The payee book can force approval for a new payee and deny a payee with `change_pending`. Seeded Priya is `owner_attested` and active.

The current Playwright projects do not enable passkeys. `api/src/dev/e2e-server.ts` is in-memory and does not open the control database. The 112 existing browser tests stay on that server.

## Files

Change:

- `docs/DECISIONS.md`. Baseline counts, the Hono pin, the cap env vars.
- `docs/MASTER_PLAN.md`. Tick P0.T1 only. Other boxes stay as the audit left them. Appendix B rows gain a test name only where this pass adds one.
- `docs/SECURITY.md`. One line per `npm audit` high: reachable or not, with the file or the reason.
- `api/src/ops/client-ip.ts`. One function for every caller.
- `api/src/app.ts`. The old bucket calls that function. Failed bearer attempts count by client IP, not by the forged or guessed secret. This is the likely case 6 bug. It is not done unless the test fails.
- `api/src/boot.ts` and `api/src/config.ts`. Read `TRUSTED_PROXY_HOPS`, `MODEL_GLOBAL_DAILY_TOKENS`, and `MODEL_WORKSPACE_DAILY_TOKENS`.
- `api/src/ops/budget.ts`. Default caps become 500,000 and 30,000.
- `api/.env.example`. The three names, with the defaults in comments.
- `api/package.json` and `api/package-lock.json`, only if the Hono pin moves to 1.19.17.
- `web/playwright.config.ts`. A third project that does not run the existing job spec.

Add:

- `api/test/repair-pass.test.ts`. Cases 3, 4, 5, 6, 7, 8, 19, 20, 21, 23, 24, 25, 26, 29, 31, 32, plus the IP tests from step 4 and the cap test from step 5.
- `api/src/dev/passkey-server.ts`. Test server only. Flags on, secrets generated in the process, database file under the OS temp dir. It is not the hosted server.
- `web/e2e/passkey-repair.spec.ts`. Cases 1 and 2 through Chromium's virtual authenticator.

No migration. No new flag. No change to `render.yaml`. No edit to the 112 existing browser tests.

## Task order

### 1. Branch and audit commit

From current HEAD `9a2ea0b`, create `phase/4-stepup`. Commit only `docs/MASTER_PLAN.md` and `docs/DECISIONS.md` as `docs: audit`. This plan file stays out of that commit. Do not set upstream. Do not push.

### 2. Baseline and P0.T1

In `docs/DECISIONS.md` Baseline, replace the 509 line and the "browser tests were not re-run" line with the audit run: 45 files, 522 API tests, 112 browser tests, axe pass (receipt tour and every signed-in screen), 12 October 2026. Lighthouse was not run. Tick P0.T1 in `docs/MASTER_PLAN.md`. Leave the proof honest: this tick records that run, not a claim that every later phase task passed.

### 3. Model quote

No commit. The phase report repeats the lines above. The answer is Ollama on both commits.

### 4. Client IP

`clientIp` gains `hops` (default 1).

- `TRUST_PROXY=0`: do not read `X-Forwarded-For`. Return `direct`. The old per-minute bucket uses this too.
- `TRUST_PROXY=1`: split the header on commas and trim. Take the entry `hops` places from the right. `TRUSTED_PROXY_HOPS=1` is the rightmost address, which is what one proxy appends. If the list is shorter than `hops`, return `direct` so a short forged header is not treated as the client.
- A non-numeric or empty hop setting falls back to 1. The value is capped at 8.

Tests in `repair-pass.test.ts`, written before the production edit:

- With `TRUST_PROXY=0` and a per-minute limit of 5, six anonymous requests with different `X-Forwarded-For` values share one bucket. The sixth is 429 `rate.limited`.
- With `TRUST_PROXY=1`, five demos from one rightmost address succeed and the sixth is 429 `rate/limited`. A second rightmost address has its own bucket.
- Header `spoofed, real` with hops 1 is bucketed as `real`. With hops 2, `spoofed, proxy` is bucketed as `direct` because the list is shorter than 2 hops after the untrusted left value is not what we count: the function takes index `length - hops` only when `length >= hops`.

`POST /demo/start` stays 404 unless the test turns on tenancy and the demo flag.

### 5. Model caps

Defaults: `globalDailyTokens` 500,000 and `workspaceDailyTokens` 30,000. `maxOutputTokens` stays 4,096. `maxSteps` stays 8.

`MODEL_GLOBAL_DAILY_TOKENS` and `MODEL_WORKSPACE_DAILY_TOKENS` override them. A missing or invalid value keeps the default. Zero still refuses every call.

Test: a budget built from the defaults, filled to the workspace cap, refuses the next `reserve()`. The spy model is not called. A second budget built with the env override accepts a call the default would refuse.

Quick asks stay outside this budget, as the code comment already says. This pass does not route them through it.

### 6. Hono and the audit record

Run `npm audit --json` in `api/` and `web/`. If `@hono/node-server` 1.19.12 is still reported, install exact 1.19.17, confirm the publish date is on or before 28 September 2026, and record the pin. Do not run `npm audit fix --force`.

For each high: search `api/src` and `web/src` for an import. Reachable means this server calls that package. Not reachable means it is only inside a dependency we do not call. Write that in `docs/SECURITY.md`. Then run the gates once in step 8, not twice unless the pin breaks typecheck.

### 7. Red team tests

Write the tests first. Run them. If one fails, fix the smallest product bug that makes that case true, and name the bug in the report. If the behavior was never built, report the gap and do not build the feature.

Chromium virtual authenticator, cases 1 and 2 only, in `web/e2e/passkey-repair.spec.ts`. The page uses `navigator.credentials` against the test server. The authenticator is CTAP2, internal, resident key, user verified. The spec is a separate Playwright project on port 8777 so the existing desktop and phone projects do not run it and do not share its database. The test server turns passkeys on and uses a temp file. It does not print the generated secrets.

| Case | Assertion | If it fails |
|---|---|---|
| 1 | After logout, the old cookie gets 401 or 404 on `GET /auth/me` | Fix revoke if the cookie still authenticates |
| 2 | A cookie planted before login is not the session issued at login | Fix if login adopts the planted cookie |
| 3 | Cookie POST with a foreign `Origin` is 403 `auth/csrf` | Fix the check if a cookie write skips it |
| 4 | Cookie POST without `X-Mandate-Client: web` is 403 | Same |
| 5 | One recovery code works once. The second use is 401. That session's approve is 403 | Fix a reused code or an approve that slips through. Do not add a recovery-code screen |
| 6 | Many different wrong bearer keys from one IP get 429, then stay locked for the window. The body does not echo the key | Expected bug: the bucket is hashed from the bearer value. Fix by counting failures on the client IP. Compare stays `sameSecret` |
| 7 | `revokeMember` makes every session for that member fail | Store plus a follow-up HTTP call. No new members route |
| 8 | Demoting or revoking the only owner returns `last-owner` and the session still works | Store test. No new members route |
| 19 | A used invite, an expired invite, and a row with `revoked_at` all fail join | Report that no HTTP revoke exists. Do not add one |
| 20 | Two joins of one invite: one succeeds, one is 400 | Fix `takeInvite` if both succeed |
| 21 | An invite created on workspace A fails on B | Fix the workspace compare if it joins |
| 23 | `/w/` with `..` or a non-id is 400, and no file outside the workspace dir is read | Fix if the status is not 400 |
| 24 | A proposal on A leaves B's database file hash unchanged | Test only. No checksum route |
| 25 | On the default studio, demo switch and simulate are 404. With step-up required, `x-mandate-demo-tap: 1` does not approve | Fix if the header skips step-up outside a demo |
| 26 | Covered by the sixth-demo test in step 4 | |
| 29 | After `POST /ops/model/kill`, a clerk call returns 503 and the spy model count stays 0 | Fix any agent entry that ignores `budget.kill()` |
| 31 | With the payee book on, a payee row that is not active becomes `NEEDS_APPROVAL` on a payment the standing rule would have auto-approved | Fix `applyPayeeBook` or the judge call if it stays `AUTO` |
| 32 | `change_pending` on that row makes the same payment `DENY` `payee.change_pending` | Fix if a payout is still allowed |

Case 6 must not lock out a correct owner key that is already known to the server by mixing it into the failure bucket for a different principal. Failures share the IP. A request that presents the real owner key keeps the existing per-credential bucket.

All of these tests use the fake PayPal and a spy model. None call Ollama or the PayPal sandbox.

### 8. Gates and stop

Run `npm run gates`. Paste hygiene, typecheck, API count, secret check, build warning, and Playwright count, including the new passkey project and the axe tests. Write the phase report in the contract format. Stop. Do not start Phase 4.

## Risks

- With `TRUST_PROXY=0`, anonymous callers share one per-minute bucket. That is the point of ignoring a forged header. The host should set `TRUST_PROXY=1` before a public URL. This pass does not set it on Render.
- Rightmost-hop changes who is limited on a host that already sets `TRUST_PROXY=1` and has more than one proxy. Default hops is 1. A second proxy needs `TRUSTED_PROXY_HOPS=2`.
- Lower caps can pause the clerk sooner on a long demo day. Raising them is `MODEL_GLOBAL_DAILY_TOKENS` and `MODEL_WORKSPACE_DAILY_TOKENS`.
- The passkey Playwright project adds time to `npm run gates`. It must not flake the existing 112 tests.

## Rollback

`phase/4-stepup` can be left unmerged. No database migration runs. The Hono pin reverts with the lockfile. Caps and IP behavior revert with `api/src/ops/budget.ts`, `api/src/ops/client-ip.ts`, and `api/src/app.ts`. Nothing is pushed, so dropping the branch drops the pass.

## Out of this pass

Phase 4 assertion storage, recovery-code UI, a second passkey, the members screen, the Control Room chunk size, Lighthouse, and turning any flag on for a public URL.
