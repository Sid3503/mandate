# Decisions

## Gate commands

Recorded on the phase 0 branch, from this checkout. Counts are the commands below, not a fresh model run.

- Fast gate: `npm run gates:fast` (hygiene, typecheck, API tests, secret check).
- Full gate: `npm run gates` (the fast gate, the web build, and browser tests).
- There is no separate linter. `npm run hygiene` is the lint step. A new linter was not added.

The numbers from the last run of those commands are filled in under "Baseline" after the commands finish.

## Baseline

- `cd api && npx vitest run`: 44 files, 509 tests passed, 6.77s, on 12 October 2026. Four of those tests are the new flag tests. The count before this change was 505 on this tree.
- Red team: `api/test/redteam.test.ts` is 56 tests inside the 509. That matches the written "56-case red team".
- Browser tests and Lighthouse were not re-run for this change. The written 112 runs and 99 / 100 / 100 stay as the last recorded numbers.

## Assumptions that did not match the code

- `docs/` has no `package.json`. It is markdown. Gates live in the root `package.json`. No docs package was added.
- `.gitignore` covered `.env`, `api/data/`, and `*.sqlite`. It did not cover `backups/`. That line was added.
- The plan text says the default model is Bedrock. The code default is Ollama Cloud: `gpt-oss:20b` for the clerk, negotiators, and reviewer, and `gemma4:31b` for the drafter. Bedrock scores in the docs are a past write-up. Docs were not changed to call Bedrock the default.
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
