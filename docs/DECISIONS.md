# Decisions

## Gate commands

Recorded on the phase 0 branch, from this checkout. Counts are the commands below, not a fresh model run.

- Fast gate: `npm run gates:fast` (hygiene, typecheck, API tests, secret check).
- Full gate: `npm run gates` (the fast gate, the web build, and browser tests).
- There is no separate linter. `npm run hygiene` is the lint step. A new linter was not added.

The numbers from the last run of those commands are filled in under "Baseline" after the commands finish.

## Baseline

- Audit gate on 12 October 2026, before this repair: `cd api && npx vitest run` was 45 files, 522 tests, 8.24s. Playwright was 112 passed (7.4m), including axe on the receipt tour and every signed-in screen, WCAG 2.1 AA. Lighthouse is not part of `npm run gates` and was not run. The earlier 509 line was phase 0 and did not include that browser run.
- Red team: `api/test/redteam.test.ts` is 56 tests inside that 522. That matches the written "56-case red team".
- P0.T1 records that audit run. It does not claim that later tasks passed. The repair pass adds tests on top.
- Repair gate on 12 October 2026: `npm run gates` exited 0. Hygiene 23. Typecheck clean. API tests were 46 files, 542 tests, 8.50s. Secret check passed for 302 tracked files. The web build warned that `ControlRoom` is 4,602.45 kB. Playwright was 114 passed (7.6m): the existing 112, including axe, plus 2 passkey tests. Lighthouse was not run.

## Assumptions that did not match the code

- `docs/` has no `package.json`. It is markdown. Gates live in the root `package.json`. No docs package was added.
- `.gitignore` covered `.env`, `api/data/`, and `*.sqlite`. It did not cover `backups/`. That line was added.
- The plan text says the default model is Bedrock. That was true only in commit `47875a7`. Commit `9fa19b6` removed it on purpose. Ollama Cloud is the only provider: `gpt-oss:20b` for the clerk, negotiators, and reviewer, and `gemma4:31b` for the drafter. Product docs now say that. One history note in `docs/REFERENCE.md` keeps both commit ids.
- Ask Mandate is a row in the feature table and a section that explains it. That is one feature, not two competing claims. It was left as written.
- The product docs already say the unbroken live PayPal chain was not run in one go. That sentence was left as written.

## Flags

`GET /v1/flags` reads switches from the environment and returns them to the owner. Defaults are off, except `legacyOwnerKeyEnabled` and `modelEnabled`, which match this studio today. The route does not approve, pay, or turn a feature on by itself.

## D1 to D6

Recorded while building phases 1 to 12. The human asked to implement every phase. These are the defaults that request named. No new paid service was added.

- D1. Tenancy is a cached app per workspace behind `/w/:id`. Handlers still close over their own services. The change stayed under 40 files. The single-studio fallback was not taken.
- D2. `@simplewebauthn/server` 14.0.3 (modified 2026-09-25, MIT) and `@simplewebauthn/browser` 14.0.0 (2026-09-02, MIT). `fast-check` 4.10.2 (2026-09-19, MIT) is an api dev dependency. Each is pinned exact and older than 14 days.
- D3. Studio workspaces and demos use Fake PayPal only. A row marked live is not opened.
- D4. A new payee waits 24 hours unless the server sets `NEW_PAYEE_WAIT_HOURS`. A demo workspace waits 0 hours. Seeded payees stay `owner_attested`, so the wait does not catch them.
- D5. `PAYPAL_LOGIN_ENABLED` stays off. Log in with PayPal was not built.
- D6. `npm audit` of `@simplewebauthn/browser` reported 0 vulnerabilities. The api audit still reports highs inside `@paypal/agent-toolkit` (langchain, langsmith, mathjs, jsondiffpatch) and a moderate `@hono/node-server`. Those were already in the tree. They were not introduced by the new packages and were not force-fixed.

`npm run preflight` checks that the new secrets exist when the doors are on. It does not print the values.

## D2 age check

Checked against the npm registry on 12 October 2026. Fourteen days before that date is 28 September 2026. All three pins are older than that.

| Package | Version | Published | Age on 12 October 2026 |
|---|---|---|---|
| `@simplewebauthn/server` | 14.0.3 | 2026-09-25 | 17 days |
| `@simplewebauthn/browser` | 14.0.0 | 2026-09-02 | 40 days |
| `fast-check` | 4.10.2 | 2026-09-19 | 23 days |

License remains MIT. The pins stay exact. This check does not approve a newer release.

## Repair pass pins and caps

Checked on 12 October 2026.

- `@hono/node-server` is pinned exact at 1.19.17 (published 2026-07-27, MIT, about 77 days old). 1.19.12 was still inside the moderate advisory for `serveStatic` (versions `<=1.19.14`). 2.1.3 (2026-09-29) and 2.1.4 (2026-10-08) were not taken: each was under 14 days. The server imports `serve` only. It does not import `serveStatic`.
- Default model caps are 500,000 tokens a day for the process and 30,000 for the workspace (`OPEN_CAPS`). `MODEL_GLOBAL_DAILY_TOKENS` and `MODEL_WORKSPACE_DAILY_TOKENS` raise them. A missing or invalid value keeps the default. Zero still refuses. `TRUSTED_PROXY_HOPS` is how many proxies sit in front, from the right of `X-Forwarded-For`, default 1, cap 8. Empty or invalid stays 1.
- The 7 October product text that names Bedrock matches commit `47875a7` (Amazon Bedrock through `@ai-sdk/openai-compatible`, model `us.openai.gpt-6-luna`). Commit `9fa19b6` on 8 October removed it. That removal is an ancestor of every local and origin branch. `git stash list` was empty. The live default on this branch is Ollama. Bedrock was not put back. The budget and the kill switch wrap `AgentService`, so they cover whatever model that service is given.
