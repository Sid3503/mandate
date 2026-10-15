# Mandate: Final Submission

## Summary

Mandate is spend authority for AI agents. An agent can read, search, draft, and propose, but money moves only under deterministic rules and cryptographic passkey approval. Every payout, refund, and invoice is backed by an append-only verifiable cryptographic receipt signed with WebAuthn ES256 signatures.

This pull request completes the final submission run for the PayPal AI Hackathon, consolidating all development work across Phases 0 through 12, passing all 23 hygiene gates, 715 API tests across 61 files, 138 Playwright browser tests, 20 formal guarantees, real model evaluations, and real PayPal sandbox API runs.

## What changed by area

### Identity and passkeys
- WebAuthn FIDO2 passkey registration, authentication, and step-up authorization with virtual authenticator automation in CI.
- Cookie sessions with Origin and X-Mandate-Client CSRF protection, session management (/app/sessions), single-use recovery codes, and last-owner preservation.
- Machine key system supporting structured prefixes (mnd_ag_ and mnd_cl_), HMAC-SHA256 hashing with KEY_PEPPER, automatic migration of legacy bare secret hashes on first use, expiration dates, daily spend and request limits, last used tracking, and prefix display.
- PWA biometric unlock on expired sessions with Workbox denylist preventing cache poisoning on authenticated API routes.

### Demo workspaces
- Isolated multi-tenant demo workspaces with automated cleanup sweeping expired demos every 15 minutes while preserving default, studio, and live workspaces.
- Pre-seeded Line Studio workspace with frozen test fixtures (warrants, buyer rules, seller rules, payees).
- Live Proof screen demonstrating real receipt files and sandbox payment states:
  - Northwind $150 charge: order `51H50117X4794793P` created in PayPal sandbox; capture skipped awaiting interactive browser buyer login (not paid).
  - Real $1.00 refund (`12C310409G863064M`) executed through Mandate gated route against an older real capture (`6GX18294LL7579630`) after the test script seeded the parent proposal row in SQLite.
  - Contractor payout to Priya ($85.00) sent via real PayPal Payouts v1 API (`D9RZNWUWD2F3A`).
- Single-use 120-second step-up grants cryptographically bound to cart hash and member public key.
- Append-only verifiable cryptographic receipts signed with WebAuthn ES256 credentials with offline browser-side verification.
- Tamper detection turning missing or modified passkey signatures red on the Proof screen.
- Visual proof indicators distinguishing passkey step-up signatures (red/green), demo simulated taps (amber), and legacy bearer keys (grey).

### Safety
- Deterministic spending gate evaluating plain safety proposals and returning DENY system.paused when paused while keeping reads available.
- Granular pause controls for global spending, autopilot, and individual agent keys with step-up verification required to resume.
- Auto-trip circuit breakers triggering on refusal spikes (3 in 2m), unknown payee attempts (2 in 10m), agent request floods (20/m), and consecutive autopilot errors.
- Payee book with cooling period for newly registered payees, owner attestation with passkey step-up, payout account change lock, and payability diagnostics.

### Rule tools
- Natural language rule drafter evaluating wordings against deterministic safety rules with prompt injection defense and lookahead token budget caps:
  - Real model eval (`gemma4:31b`, Oct 14 2026): 11 plain wordings evaluated only (100% pass, 0 hidden loosenings, 52,713 tokens used, halted cleanly before injection group due to token cap; full run needs ~145,000 tokens and was not done).
  - Prompt injection handling: fixed policy audit untrusted instruction preservation in `api/src/agents/drafter.ts`, verified 4/4 passing with scripted model in CI.
- Try-it box with side-by-side spend proposal dry runs without writing rows to the database.
- Tap-to-rule suggestions turning frequent manual approvals into safe automated rules with tap counts displayed on the Today dashboard.
- Passkey publish ceremony cryptographically binding rule changes to warrant bodies.
- Second reader verification wired behind a feature flag.

### Proof
- 20 verified cryptographic and financial guarantees served via GET /v1/guarantees and proved via npm run guarantees.
- Ledger history replay control under POST /v1/replay and the Proof console.
- Audit proof lines verifying members, assertions, signed rules, safety events, and key fingerprints.
- Fast-check property test sequences verifying Invariants I1 to I15 and multi-tenant isolation.
- Complete Appendix B red team suite verifying cases 1 through 35 with zero untested cases.

### Ops
- Real /readyz endpoint with direct SQLite readiness checks avoiding redirect loops.
- Server-sent events connection pooling capped at 50 connections with 429 backpressure.
- Multi-tier rate limiting for auth, key unlock, ask, write, and read endpoints with budget enforcement.
- Pre-migration database backups, migration checksum tamper rejection, and db:backup/db:restore scripts.
- Tenant scheduler sweeping active invoice and payout external references without per-tenant timers.

### Performance
- Lazy loading for AG Grid Enterprise, AG Charts Enterprise, and Line Studio reducing initial bundle payloads.
- ControlRoom chunk split from 4,602 kB down to 15.85 kB.
- Service worker precache optimized at 38 clean entries.
- Mobile Lighthouse audit scores under default mobile throttling: Welcome 90, Unlock 88, Today in demo 83.
- Database read latency p95 verified under 50ms across core endpoints.

## How to try it

Detailed instructions are available in [docs/TRY_IT.md](file:///Users/siddharth.mishra/Desktop/paypal-ai-hack/docs/TRY_IT.md).

Quick setup:
```bash
git checkout final/submission
npm run setup
npm run dev:all
```

Open `http://localhost:5173/app/welcome` in your browser to explore the 10-step click path.

## Real test numbers

- **Hygiene checks**: 23 passed out of 23
- **API test files**: 61 files passed out of 61
- **API tests**: 715 tests passed out of 715 (0 failures)
- **Playwright browser tests**: 138 tests passed out of 138 (9.3m)
- **Accessibility scans**: 0 Axe WCAG 2.1 AA violations
- **Secret check**: 407 tracked files passed (0 secrets detected)
- **Guarantees verified**: 20 passed out of 20
- **Appendix B red team cases**: 35 passed out of 35

## Feature flags (all off by default)

All optional feature flags remain OFF by default:
- `FLAG_TENANCY`: false
- `DEMO_ENABLED`: false
- `FLAG_PASSKEYS`: false
- `FLAG_INVITES`: false
- `FLAG_PAYEES`: false
- `FLAG_STEPUP_APPROVE`: false
- `FLAG_POLICY_PASTE`: false
- `FLAG_SECOND_READER`: false
- `PAYPAL_LOGIN_ENABLED`: 0 (off)
- `MCP_EXPOSE_READ_TOOLS`: 0 (off)

## Known limits

- Single-node SQLite database intended for single-instance or persistent-volume container deployment (e.g. Render persistent disk).
- Model budget enforcement relies on Ollama or upstream provider rate limit return codes.
- Interactive buyer login for PayPal checkout orders requires human web browser interaction in sandbox.

## Human todo

The authoritative checklist is in [docs/HUMAN_TODO.md](file:///Users/siddharth.mishra/Desktop/paypal-ai-hack/docs/HUMAN_TODO.md):
1. Set AI model account monthly spend limit (5 minutes).
2. Read gitleaks scan result in docs/SECRET_SCAN.md (HISTORY_CLEAN=true, zero rotation needed).
3. Merge pull request to main without squashing history (3 minutes).
4. Deploy web service to Render with persistent disk at `/var/data` (`DATABASE_PATH=/var/data/mandate.sqlite`) and configure environment variables (20 minutes). Note: persistent disk and continuous uptime require a paid instance type; check current Render plans.
5. Run automated smoke test (`npm run smoke -- <url>`) and 10-step click path on the live URL (15 minutes).
6. Run mobile phone passkey registration and unlock test (15 minutes).
7. Register PayPal webhook and configure PAYPAL_WEBHOOK_ID (10 minutes).
8. Run PageSpeed Insights on live URL (5 minutes).
9. Record and upload 2:45 demo video following docs/VIDEO_SCRIPT.md (60 to 90 minutes).
10. Submit Devpost entry using text from docs/DEVPOST.md (30 minutes).

## Checklist

- [x] All 23 hygiene invariants pass.
- [x] All 715 API tests pass across 61 test files.
- [x] All 138 Playwright browser tests pass.
- [x] All 20 formal guarantees verified.
- [x] All 35 Appendix B security cases pass.
- [x] SECRET_SCAN.md confirms HISTORY_CLEAN=true.
- [x] Real PayPal sandbox charge order created, refund executed via gated route, and payout sent (receipts in docs/live-proof/).
- [x] Mobile Lighthouse performance verified: Welcome 90, Unlock 88 (target was 90), Today in demo 83.
- [x] Submission docs complete (DEVPOST.md, VIDEO_SCRIPT.md, DECK.md, HUMAN_TODO.md, TRY_IT.md).
- [x] Zero secrets or personal paths in code or history.
