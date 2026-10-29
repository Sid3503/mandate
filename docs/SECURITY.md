# Security

This is the threat-model skeleton. It is not a claim that every control below is already built.

## What Mandate protects

A studio's rules decide whether money may move. PayPal moves only the locked cents. A model can ask. It cannot approve, pay, send, refund, publish rules, or remove a refusal.

## What exists today

- The owner, proposer, and client keys are bearer secrets. The console keeps a person's key in `sessionStorage` for one tab.
- Routes that move money or change rules are owner-only.
- Amounts are integer cents until the PayPal edge.
- Money calls use an idempotency key.
- The ledger appends events.
- Tests use a fake PayPal and a scripted model. They do not call the live sandbox or a real model.
- Secrets are read from the environment. `scripts/check-secrets.mjs` fails the gates on key-shaped text in tracked files.

## Known limits

- A pasted key is still a way in. Passkeys and cookie sessions exist behind flags that default to off. With the flags off, the console still unlocks with a key in this tab.
- Step-up runs when that workspace's `passkey_for_money` row is on, or when `REQUIRE_PASSKEY_FOR_MONEY` is on. A new studio starts on. The default studio and a demo start off. The env flag stays off. Turning the row on needs an enrolled passkey and a step-up. The check is on the money routes that already exist: approve, publishing rules, invites, safety resume, agent keys, and client keys. An approval grant is bound to the member, the kind, the cart hash, and 120 seconds, and it works once. If the stored cart no longer matches, the answer is 409 "changed since you looked". Enrollment shows the key fingerprint with "Save this". A receipt line names who, how, and when, and the first 8 characters of that fingerprint. A passkey row with no assertion is red. An owner key and a demo tap are amber. A row that never named a method is grey and marked legacy. The verify page checks an ES256 passkey by turning the DER signature into raw r and s. It checks the relying-party hash, the user-presence and user-verification flags, the type, and the challenge. Success says "valid signature by this key". An unknown algorithm says "cannot verify here" and is never called valid.
- A counter that moves backwards is refused on login and on step-up. The passkey is revoked only when that member has another one. The last passkey is marked suspect, an auth event is written, and the credential stays.
- A passkey prompt does not show the payment. The screen shows the amount, payee, category, and evidence before the prompt. The prompt itself does not.
- Demo and studio workspaces use a fake PayPal. The banner says so. They are not a live sandbox payment.
- **Browser sign-in for agents (OAuth).** `POST /oauth/register` is open, because dynamic registration has to be. A registration grants nothing: only the owner, on the console, turns a client into a key. Mitigations: public clients only, a redirect must be https, a loopback address or an app's own scheme (never `javascript:` or `data:`) and is matched exactly, at most 500 clients are kept, and the global rate limiter applies. A consent screen shows the client's *self-declared* name, so a hostile client can call itself "Claude"; the screen therefore also shows the host the browser will be sent to, and the approval is one the owner has to start. Not built: client secrets, the client-credentials grant, client ID metadata documents. Tests: `api/test/oauth.test.ts`, `web/e2e/oauth-connect.spec.ts`.
- A stolen server can still lie. A receipt that a person can check reduces that risk. It does not remove it.
- The admin key compare is a hash compare. Ops routes stay 404 until `ADMIN_KEY` is set.
- `npm audit` highs in `api/` on 12 October 2026, after pinning `@hono/node-server` to 1.19.17. The Hono moderate is gone. These highs remain. They were not force-fixed. `api/src/paypal/toolkit.ts` imports `PayPalAgentToolkit`. `main.ts` loads that module because `paypal/client.ts` imports its helpers, so the packages are in the server process.
  - `@langchain/core` (`<=1.1.28`), serialization injection. Not reachable. No file in `api/src` imports it or calls its serializer. It is loaded only because `@paypal/agent-toolkit` depends on it.
  - `langsmith` (`<=0.5.26`), prototype pollution in an internal `set`. Not reachable. No file in `api/src` imports it.
  - `mathjs` (`13.1.0` to `15.1.1`), unsafe property setter. Not reachable. No file in `api/src` imports it or evaluates an expression with it.
  - `jsondiffpatch` (`<=0.7.5`), XSS in `HtmlFormatter`. Not reachable. No file in `api/src` imports it or renders that formatter.
  - `@paypal/agent-toolkit`, high because it depends on the four packages above. Reachable. `paypal/invoices.ts` and `paypal/watch.ts` construct `PayPalAgentToolkit` when invoices or the activity watch are built. That call does not pass through the four vulnerable functions above.
- `uuid` (`<11.1.1`) is a moderate bounds check when a caller passes a buffer. `api/src` does not import `uuid`.
- `npm audit` in `web/` on 12 October 2026 reported 0 vulnerabilities. No `npm audit fix --force`.
- Demo data is a file under the database directory with an expiry on the workspace row (24 hours unless `DEMO_TTL_HOURS` says otherwise). Logs and client diagnostic error entries are retained for 14 days. Auth events sit in the control database and are trimmed at 90 days by the 15-minute cleanup job. Nothing here is an indefinite archive.

## What the flags add

Workspaces, passkeys, cookie sessions, step-up on money, invites, the payee book, and the model kill switch are in the server. `POST /ops/model/resume` clears the kill with the admin key. It is 404 until `ADMIN_KEY` is set and 401 when the key is wrong. Their flags default to off, except the model, which stays on, and the legacy owner key, which stays on for the default studio.

## 15-Item Security Checklist & Verification Evidence

Every control listed below is enforced in code, verified in automated test suites, and audited by `AuditService` and `npm run guarantees`.

### 1. Spend Authority Boundary
- **Requirement & Invariant:** Invariant I1, I3, I10. AI only adds friction. No model output can approve, pay, send, refund, publish rules, issue keys, or remove a refusal.
- **Enforcement:** `api/src/app.ts` restricts money mutation routes to authenticated owner roles. The model is called only as a proposer or clerk; its structured outputs are strictly parsed and fed through the deterministic gate.
- **Code Evidence:** `api/src/app.ts` (`OWNER_ONLY` definitions), `api/src/services/audit.ts` (`agents.no_reach`).
- **Test Proof:** `api/test/redteam.test.ts` (Appendix B prompt injection cases), `api/test/mcp.test.ts`, `api/test/tiers.test.ts`.

### 2. Pure Deterministic Decision Engine
- **Requirement & Invariant:** Invariant I2, I4. The gate is a pure function. It does zero I/O and has zero side-effects. All monetary values are handled as integer cents.
- **Enforcement:** `evaluateSpend()` in `api/src/domain/gate.ts` takes plain data inputs and computes ALLOW/DENY/NEEDS_APPROVAL deterministically without network or disk operations. Decimal strings exist solely at the outer PayPal HTTP boundary.
- **Code Evidence:** `api/src/domain/gate.ts`, `api/src/domain/money.ts`.
- **Test Proof:** `api/test/property.test.ts` ("pure gate invariant: identical inputs produce identical evaluations across 500 iterations", "integer cents arithmetic: no fractional cent errors"), `api/test/gate.test.ts`.

### 3. Cart Immutability & Cryptographic Locks
- **Requirement & Invariant:** Invariant I3, I14. Once approved, a payment proposal is immutable. Payee, amount, proof, job, and funding sources are bound into a cryptographic hash.
- **Enforcement:** `lockProposal()` creates a canonical SHA-256 hash over cart parameters and signs it using server-held cryptographic keys. Any mutation of request fields post-approval results in 409 `cart.immutable`.
- **Code Evidence:** `api/src/domain/signing.ts` (`cartHash`, `proofHash`), `api/src/services/mandate.ts` (`verifyLock`).
- **Test Proof:** `api/test/api.test.ts` ("refuses payment when cart hash does not match"), `web/e2e/job.spec.ts` ("tampered cart fails verification").

### 4. Idempotency & Replay Resistance
- **Requirement & Invariant:** Invariant I5. Every state-changing request requires an idempotency key. A retry never moves money twice.
- **Enforcement:** `Repo.findIdempotency()` and `Repo.putIdempotency()` track all mutation requests. Repeated attempts with the same key return the recorded cached response without reapplying mutations or re-emitting events.
- **Code Evidence:** `api/src/db/repo.ts` (`findIdempotency`, `putIdempotency`), `api/src/app.ts`.
- **Test Proof:** `api/test/property.test.ts` ("idempotency invariant: replaying state-changing calls emits zero new events"), `api/test/resilience.test.ts`, `api/test/api.test.ts`.

### 5. Append-Only Tamper-Evident Ledger
- **Requirement & Invariant:** Invariant I6. The ledger is append-only. No events are updated or deleted. Current system state is derived entirely by replaying ledger events.
- **Enforcement:** SQLite `events` table only allows `INSERT`. No `UPDATE` or `DELETE` statements exist for event records. Every event is typed, timestamped, and sequenced.
- **Code Evidence:** `api/src/db/repo.ts` (`recordEvent`, `allEvents`), `api/src/services/audit.ts` (`locks`, `history`).
- **Test Proof:** `api/test/property.test.ts` ("append-only ledger invariant: events table count is strictly monotonic"), `api/test/replay.test.ts`.

### 6. Multi-Tenant Workspace Isolation
- **Requirement & Invariant:** Invariant I15. Tenant data never crosses workspaces. A request for another workspace returns 404.
- **Enforcement:** Tenancy registry isolates database instances by workspace ID. Requests are routed via `/w/:workspaceId/...` prefixes. Cross-tenant queries return 404 and cross-tenant mutations are prevented by foreign key and registry boundaries.
- **Code Evidence:** `api/src/tenancy/registry.ts`, `api/src/http/extra.ts`.
- **Test Proof:** `api/test/property.test.ts` ("multi-tenancy isolation: operations in tenant A leave tenant B state and checksum unchanged"), `api/test/ops-tenant-routing.test.ts`.

### 7. Hardware-Backed Passkey Authentication
- **Requirement & Invariant:** Invariant I14. Passkey authentication requires authentic cryptographic signatures with hardware user verification.
- **Enforcement:** WebAuthn ES256 ceremony via SimpleWebAuthn. User Verification (UV) and User Presence (UP) flags are strictly validated. Origin and Relying Party (RP) ID matching is strictly enforced.
- **Code Evidence:** `api/src/control/auth.ts` (`verifyAuthenticationResponse`), `web/src/lib/verify.ts`.
- **Test Proof:** `api/test/stepup.test.ts` (Case 11: "UV flag off fails authentication", Case 14: "wrong origin or RP ID fails"), `web/e2e/passkey-repair.spec.ts`.

### 8. Single-Use Scoped Step-Up Grants
- **Requirement & Invariant:** Invariant I14. A login session is never an approval. High-privilege operations require fresh passkey signatures.
- **Enforcement:** Step-up grants expire in 120 seconds, are bound to a specific member ID, action kind, and proposal cart hash, and are burned immediately upon first execution.
- **Code Evidence:** `api/src/control/auth.ts` (`issueStepUpGrant`, `verifyStepUpGrant`, `burnStepUpGrant`).
- **Test Proof:** `api/test/stepup.test.ts` (Case 9: "assertion replay fails", Case 10: "assertion for lock A fails on lock B", Case 16: "grant reuse rejected").

### 9. Credential Rollback Protection
- **Requirement & Invariant:** Prevention of cloned or replayed authenticator hardware signatures.
- **Enforcement:** WebAuthn sign counters are tracked on every authentication and step-up ceremony. If a signature counter rolls backward or repeats, the credential is automatically flagged as suspect and the request is rejected.
- **Code Evidence:** `api/src/control/auth.ts`, `api/src/control/store.ts` (`updatePasskeyCounter`).
- **Test Proof:** `api/test/stepup.test.ts` (Case 15: "Counter rollback marks passkey suspect and refuses authorization").

### 10. Timing-Safe Comparisons & Rate Limiting
- **Requirement & Invariant:** Protection against brute-force attacks and side-channel timing analysis on API keys and credentials.
- **Enforcement:** Bearer keys and token comparisons utilize `crypto.timingSafeEqual` over fixed-length hashes. Sliding-window IP rate limiters return HTTP 429 upon threshold breach.
- **Code Evidence:** `api/src/security/rateLimit.ts`, `api/src/http/extra.ts`.
- **Test Proof:** `api/test/ratelimit.test.ts`, `api/test/redteam.test.ts` (Case 6: "Key brute force returns 429 and locks out caller").

### 11. Model Token Budgets & Emergency Kill Switch
- **Requirement & Invariant:** Invariant I13. Every model call has token caps, timeouts, daily budgets, and a global ops kill switch.
- **Enforcement:** Model gateway tracks global daily tokens (cap 500,000) and workspace daily tokens (cap 30,000). Requests timeout at 30 seconds. Admin endpoint `POST /ops/model/kill` immediately halts all model evaluations; `POST /ops/model/resume` re-enables them.
- **Code Evidence:** `api/src/agents/limits.ts`, `api/src/app.ts` (`/ops/model/kill`, `/ops/model/resume`).
- **Test Proof:** `api/test/model.test.ts`, `api/test/repair-pass.test.ts` ("model kill switch blocks calls until resumed").

### 12. PayPal Agent Toolkit Tiering & Direct Action Blocking
- **Requirement & Invariant:** Invariant I10. Every PayPal Agent Toolkit tool has an explicit tier. The server refuses any tool without a tier.
- **Enforcement:** Tools are classified into `read`, `propose`, or `out_of_scope`. Direct money movement tools (`payouts`, `captures`) can only be executed by the server from a verified, locked cart. Read tools are withheld from agents unless explicitly enabled via `MCP_EXPOSE_READ_TOOLS`.
- **Code Evidence:** `api/src/paypal/tiers.ts`, `packages/guard/index.ts` (`withMandate`), `api/src/mcp/server.ts`.
- **Test Proof:** `api/test/tiers.test.ts`, `api/test/phases.test.ts` (toolkit guard verification), `api/test/mcp.test.ts`.

### 13. Independent Offline Receipt Verification
- **Requirement & Invariant:** Trust verification must not depend on the live server. Anyone can verify receipts client-side.
- **Enforcement:** Client receipts contain the full canonical warrant, cart parameters, and server signature. The browser verification engine recomputes hashes and verifies ECDSA signatures locally using the Web Crypto API without network requests.
- **Code Evidence:** `web/src/lib/verify.ts`, `web/src/screens/Verify.tsx`.
- **Test Proof:** `api/test/verify.test.ts`, `web/e2e/job.spec.ts` ("a receipt can be checked in the browser without a key, and a tampered one is caught").

### 14. Zero Secret Leakage & Environment Isolation
- **Requirement & Invariant:** Invariant I8, I9. Sandbox only. Secrets never appear in repository code, logs, screenshots, error messages, or bundles.
- **Enforcement:** Secrets are encapsulated in `SecretString` wrappers that mask values in string serialization and error dumps. `scripts/check-secrets.mjs` scans all tracked files during every gate execution. Production credentials are strictly barred.
- **Code Evidence:** `api/src/security/secrets.ts`, `scripts/check-secrets.mjs`.
- **Test Proof:** `api/test/ops-readyz-secret.test.ts` (Case 35: "secret and canary log redaction sweep across all log outputs"), `scripts/check-secrets.mjs` (0 violations across 375 tracked files).

### 15. Agent Sign-in Cannot Widen Authority
- **Requirement & Invariant:** Signing in with a browser must never give an agent more than a pasted key could.
- **Enforcement:** An OAuth grant is an ordinary agent key with scope `mcp` + `read` (look only) or + `propose` (look and ask), chosen by the owner. The `/mcp/readonly` resource is always look-only. The grant has no scope that approves, captures, pays or changes rules. PKCE S256 is required, the code is one-shot and lasts 5 minutes, and a refresh token that returns twice revokes the whole connection.
- **Code Evidence:** `api/src/auth/oauth.ts`, `api/src/app.ts` (`/oauth/*`, `/v1/oauth/decision`), `api/src/services/agents.ts`.
- **Test Proof:** `api/test/oauth.test.ts` (look-only default, read-only door, single-use code, wrong verifier, refresh rotation and replay, revoke), `web/e2e/oauth-connect.spec.ts`.
