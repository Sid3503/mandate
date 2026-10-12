# Mandate master plan

Status: phase 0 built on branch `phase/0-baseline`. Later phases are not started.
Date of this run: 12 October 2026.

The full phase text (P1 through P12), the shared contracts, and the appendices are the plan the human supplied with `/phase-run 0`. This file records what phase 0 verified and what it changed. Do not start phase 1 until the human accepts this phase.

## Assumptions checked for phase 0

- `api/` and `web/` each have a `package.json`. `docs/` does not. Docs stay markdown. Gates live in the root `package.json`. See `docs/DECISIONS.md`.
- API tests run offline with the scripted model and Fake PayPal. 509 passed.
- `.gitignore` covered env files, `api/data/`, and `*.sqlite`. `backups/` was missing and is now ignored.
- The plan's phrase "default is Bedrock" does not match the code. The default model is Ollama Cloud. Docs were not rewritten to say Bedrock.

## P0 tasks

- [x] P0.T1 API test count recorded in `docs/DECISIONS.md`. Browser tests were not re-run.
- [x] P0.T2 `npm run gates` and `npm run gates:fast`.
- [x] P0.T3 `scripts/check-secrets.mjs` and `scripts/check-secrets.allow`.
- [x] P0.T4 Doc conflicts that were real: the API count is 509. Bedrock was not made the default. The live-chain sentence already said the unbroken chain was not run.
- [x] P0.T5 `api/src/flags.ts`, `GET /v1/flags` (owner only), switches on System.
- [x] P0.T6 `docs/DECISIONS.md`, `docs/SECURITY.md`, `CHANGELOG.md`.
- [x] P0.T7 Planned flag names added to `api/.env.example` as comments and empty placeholders.

## Not started

P1 guards, P2 workspaces, P3 passkeys, P4 step-up, P5 welcome doors, and every later phase. Each one still needs its own recon, and the human decisions D1 to D6 are unanswered.
