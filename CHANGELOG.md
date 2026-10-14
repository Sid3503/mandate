# Changelog

## Unreleased

- Phase 12 (Hardening):
  - Passkey accessibility: full keyboard-only walk test covering studio registration, unlock sign-in, and passkey credential management with axe scan verification (`web/e2e/passkey-repair-keyboard.spec.ts`).
  - Chaos test suite: injected PayPal timeout, model timeout, database lock (`SQLITE_BUSY`), disk full (`SQLITE_FULL`), and model provider rate-limit usage refusal, verifying clean rollback, 0 wrong money state, and graceful degradation (`api/test/chaos.test.ts`).
  - Performance: p95 read latency under 50ms across core read endpoints (`api/test/p95.test.ts`), ControlRoom bundle split reducing chunk size from 4,602 kB down to 15.85 kB (`web/vite.config.ts`), and mobile Lighthouse audit scores of 100 Performance, 98 Accessibility, 96 Best Practices, 100 SEO (`docs/evidence/q8/lighthouse-mobile-unlock-provided.json`).
  - Security verification: 14-item security checklist with evidence for each control in `docs/SECURITY.md`.
  - Retention trimming: automated trimming of auth events older than 90 days and logs/client diagnostic errors older than 14 days in the 15-minute background sweep (`api/src/ops/scheduler.ts`, `api/test/ops-cleanup-scheduler.test.ts`, `docs/DATA.md`).
  - Documentation: comprehensive onboarding guide (`docs/ONBOARDING.md`), updated security known limits, reference documentation, OpenAPI definitions, and Postman collections.
- Machine keys: `POST /v1/agents/{id}/upgrade` and `POST /v1/client-keys/{id}/upgrade` replace an `mnd_ag_` or `mnd_cl_` secret and keep the same agent or client. A stored hash of the bare secret is rewritten to the whole key on first use.
- Studio wizard: a second passkey or recovery codes are required before Today. PayPal is described as simulated. Rules in words can be skipped. Progress is saved in this browser and does not include the codes.
- Members: `POST /v1/members/{id}/role` and `POST /v1/members/{id}/revoke`. The last owner stays. Revoke ends sessions and passkeys and lists open requests. `npm run admin:reset-owner` writes an `admin_audit` event. The screen is `/app/members`.
- Invites: `POST /v1/invites/revoke`. The join page names the inviter and the role. Creating an invite needs a passkey when the studio rule is on.
- Unlock has "Sign in with a passkey" for a studio that already enrolled one.
- Passkeys on the account: `GET /auth/credentials` and `POST /auth/credentials/revoke`. The last passkey stays. Another member's id is not found. The screen is `/app/sessions`.
- Recovery codes: `POST /auth/recovery/issue`, `POST /auth/recovery/ack` ("I saved these"), and `POST /auth/recovery/regenerate` with a passkey step-up. Codes are hashed. A used code fails the second time.
- Sessions: `GET /auth/sessions`, `POST /auth/sessions/revoke`, `POST /auth/sessions/revoke-others`, and owner `GET /auth/events`. The list does not return the session token. The screen is `/app/sessions`.
- `POST /ops/model/resume` clears the model kill with the admin key. The day's token counters stay.
- Phase 0. `npm run gates` and `npm run gates:fast`. A secret check over tracked files. `GET /v1/flags` for the owner. Switches on the System screen. `backups/` is gitignored. Planned flag names are listed in `api/.env.example` as placeholders.
- Phases 1 to 12, flags off. Per-workspace apps, demo start, passkeys, invites, a payee book, rule simulate, model budget and kill switch, classed limits when `TRUST_PROXY=1`, backup and restore scripts, and three welcome doors. Studio and demo PayPal is fake. Log in with PayPal was not built. Browser tests and Lighthouse were not re-run.
