# Mandate: The Deterministic Spend Boundary for AI Agents

Agents can ask. Only you can pay.

---

## Inspiration

Autonomous AI agents are increasingly drafting invoices, hiring contractors, negotiating rates, and ordering services. But giving an AI agent direct access to a corporate credit card or PayPal credentials creates an unacceptable financial attack surface. LLMs suffer from prompt injection, hallucinated fees, social engineering, and goal drift.

Escrow protects the buyer from the seller. But until now, nothing protected the studio or business owner from their own AI agents. We built Mandate to solve this exact problem: a deterministic spend boundary where any agent can ask to spend money, but plain code and owner-signed rules determine what leaves your account, funded only by client money that has already settled.

---

## What It Does

Mandate is a self-hosted spend authority and policy firewall for human teams and AI agents.

1. **Deterministic Spending Gate**: Every payment, invoice, and contractor payout passes through a pure evaluation gate (`decide()`). It enforces positive integer cents, authorized payees, approved service categories, monthly spending caps, and funding coverage.
2. **Money In Releases Money Out**: Contractors are never paid from thin air. A contractor payout is only approved if an associated client payment has cleared and settled. If a client disputes or refunds a payment, contractor payouts are automatically locked.
3. **Model-Free Enforcement**: AI models only draft proposals or suggest wording. The actual authorization decision is made by pure mathematical functions without model calls.
4. **Passkey Approvals with WebAuthn**: High-stakes approvals require a biometric tap (Face ID, Touch ID, or security key) with WebAuthn level 2 authentication and replay-proof challenge signing.
5. **Circuit Breakers and Emergency Pause**: If unusual patterns occur (3 suspicious refusals in 2 minutes, unknown payees, or agent request spam), system breakers trip automatically and pause outgoing money.
6. **Machine Keys for MCP Agents**: Agents connect over Model Context Protocol (MCP) using revocable tokens (`mnd_ag_...`) with scoped permissions, expiry dates, and daily spend limits.
7. **Offline Receipt Verification**: Every approved transaction produces an Ed25519 or P-256 cryptographic receipt that anyone can verify offline in any browser against public keys.

---

## How We Built It

- **Backend Core**: Built in TypeScript on Node.js 24 using the Hono lightweight web framework and standard `node:sqlite` (`DatabaseSync`) for ACID transactional persistence with zero external database dependencies.
- **PayPal Integration**: Direct integration with PayPal Orders v2 for client payments, Payments v2 for gated refunds, Payouts v1 for contractor disbursements, and Invoicing via `@paypal/agent-toolkit`.
- **Identity and Security**: Cryptographic signatures using WebAuthn Level 2 (`@simplewebauthn/server`), Ed25519 signing keys, and HMAC-SHA256 machine keys with environment peppers.
- **Frontend Console**: Responsive, mobile-first single page application built with React, Vite, TanStack Query, and clean Vanilla CSS without heavy UI frameworks.
- **AI Agent Bridge**: Model Context Protocol (MCP) server exposing tools for agents to propose payments, query balances, and review deliverables without ever seeing money-movement credentials.
- **Verification Engine**: Automated test suite powered by Vitest, Fast-check property-based testing, and Playwright browser tests.

---

## Challenges We Overcame

1. **State Machine Idempotency and Race Conditions**: Handling concurrent webhook events and duplicate API submissions while ensuring money moves exactly once. We solved this with stable request hashing and SQLite immediate transactions.
2. **Deterministic Settlement Matching**: Guaranteeing that PayPal live order amounts and captured cents match the locked cart to the exact penny before finalizing records.
3. **Prompt Injection Defense**: Preventing malicious prompts from manipulating policy drafting. We enforced untrusted boundaries where raw input is fenced and sanitized, fixing untrusted segment preservation during policy audit passes and verifying all 4 prompt-injection cases with the scripted-model test suite in CI.
4. **Zero-Secret Architecture**: Ensuring credentials, tokens, cookies, and personal paths are never committed, logged, or exposed over the wire.

---

## Accomplishments That We Are Proud Of

- **715 Automated Vitest Tests** across 61 test files passing completely clean in CI.
- **135 Playwright Browser Tests** verifying desktop and mobile user journeys and role-based access.
- **20 Verified Cryptographic Guarantees** documented in machine-readable JSON and verified on every build.
- **Real PayPal Sandbox Proof**: Validated live Orders v2 order creation (order `51H50117X4794793P`), real Payouts v1 disbursements (batch `D9RZNWUWD2F3A` to Priya), and real Payments v2 refunds (refund `12C310409G863064M` via gated route) against actual PayPal sandbox infrastructure.
- **Mobile Lighthouse Performance**: Scored 90 on Welcome, 88 on Unlock, and 80 on Today with lazy-loaded data grids and an optimized bundle.
- **Sub-50ms Read Latency**: Achieved p95 read performance under 50ms across core ledger endpoints.

---

## What We Learned

- Financial software must treat AI as a proposer, never as the decider. Isolating LLMs to text drafting while using deterministic code for ledger mutation eliminates entire classes of AI failure modes.
- WebAuthn passkeys provide vastly superior security and user experience compared to passwords and SMS codes, especially when paired with local session encryption.
- Property-based testing with fast-check caught edge cases in month-window boundaries and currency rounding that traditional unit tests missed.

---

## What Is Next

- Multi-currency conversion rates with locked exchange windows.
- Native integration with additional payment rails including Stripe and automated clearing house (ACH) transfers.
- Mobile native application wrappers for iOS and Android with hardware enclave credential storage.
- Multi-party approval workflows requiring quorum signatures for transfers exceeding high thresholds.

---

## Built With

- TypeScript
- Node.js 24
- Hono
- SQLite (node:sqlite)
- React
- Vite
- Playwright
- Vitest
- Fast-check
- WebAuthn / SimpleWebAuthn
- PayPal Orders v2, Payments v2, Payouts v1
- Model Context Protocol (MCP)
- Vanilla CSS

---

## Try It

See `docs/TRY_IT.md` for full instructions.

Quick start commands:
```bash
npm run setup
npm run build
PORT=8777 DEMO_ENABLED=1 FLAG_PASSKEYS=1 node api/node_modules/tsx/dist/cli.mjs api/src/dev/passkey-server.ts
```
Open `http://localhost:8777/app/welcome` and click **"Try the demo"**.

---

## Honest Limits

- **PayPal Sandbox Capture**: Full end-to-end checkout capture requires interactive human buyer authentication at the PayPal approval URL; machine scripts cannot log in on behalf of a buyer.
- **Single Currency per Warrant**: A single warrant version currently operates in one specified currency (e.g. USD).
- **SQLite Single-Writer**: Database writes use SQLite single-writer semantics, optimized for small-to-medium businesses and design studios rather than high-frequency payment gateways.
