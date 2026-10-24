# Mandate: Presentation Deck

---

## Slide 1: Mandate: The Deterministic Spend Boundary for AI

- AI agents are drafting invoices and ordering contractor services
- Direct payment authority leads to prompt injection and accidental loss
- Mandate ensures agents can ask, but only you can pay

**Speaker note**: Welcome to Mandate, the deterministic financial spend boundary for human teams and AI agents.

---

## Slide 2: The Problem: Probabilistic AI, Real Money

- Language models hallucinate and cannot be trusted with wallet keys
- Prompt injections can easily manipulate model spending decisions
- Traditional escrow protects buyers, but does not protect your business from your own agents

**Speaker note**: Giving an autonomous LLM a credit card or PayPal API key creates an existential risk for any company.

---

## Slide 3: The Mandate Architecture

- Mathematical policy gate evaluates every request without model calls
- Money in releases money out: contractor payouts require settled client funding
- Locked cart hashes cryptographically bind payment terms to prevent changes

**Speaker note**: We decoupled generation from authorization. AI models only propose; pure code decides what moves.

---

## Slide 4: WebAuthn Passkeys and Hardware Signatures

- Biometric authentication (Face ID, Touch ID, security keys) replaces shared passwords
- Cryptographic signatures bind approvals to exact cart terms and challenge nonces
- Session expiration requires biometric unlock with zero key exposure

**Speaker note**: Passkeys ensure only authorized owners can approve high-value transactions using hardware-backed biometrics.

---

## Slide 5: Circuit Breakers and Emergency Safety

- Automatic tripping on suspicious refusal spikes, unknown payees, or request floods
- Instant pause button freezes outgoing money while keeping read-only auditing active
- Resumption requires owner step-up authentication to prevent unauthorized restart

**Speaker note**: If an agent goes rogue or spam bursts occur, circuit breakers trip automatically to safeguard funds.

---

## Slide 6: Proven in Real PayPal Sandbox

- Real Orders v2 client charge creation with buyer approval workflows
- Real Payouts v1 dispatches contractor money with zero manual re-entry
- Real Payments v2 executes gated partial refunds with automated ledger updates

**Speaker note**: Mandate is fully integrated with PayPal sandbox, tested on live Orders, Payouts, and Payments APIs.

---

## Slide 7: Performance, Reliability, and Isolation

- 715 Vitest tests and 135 Playwright end-to-end tests passing clean
- 20 verified cryptographic guarantees validated on every commit
- Mobile Lighthouse scores of 90 on Welcome, 88 on Unlock, and sub-50ms p95 read latency

**Speaker note**: Our code is hardened with property-based testing, chaos simulations, and strict multi-tenant isolation.

---

## Slide 8: The Vision: Safe Autonomous Commerce

- Model Context Protocol (MCP) connects any AI agent safely in minutes
- Scoped machine keys with daily spending limits and expiration dates
- The standard financial operating system for the agentic economy

**Speaker note**: With Mandate, enterprises and studios can unleash autonomous AI agents without risking their bank accounts.
