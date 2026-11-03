# Mandate: Presentation Deck (11-Slide Master Outline)

---

## Slide 1: Mandate: The Deterministic Spend Boundary for AI
- **Tagline**: Agentic commerce · a wallet of authority, not of money
- AI agents negotiate, agree and settle money for you — inside rules you signed
- PayPal Orders v2 · Payouts v1 · OAuth 2.1 with PKCE · Live in Sandbox

**Speaker note**: Welcome to Mandate, the deterministic financial spend boundary for AI agents and human teams. Mandate separates asking from paying. In today’s demo, agents help a business move faster, but money only moves when a deterministic warrant allows it and, when required, the owner taps. This is not a wallet, not a new rail, and not a replacement for PayPal. It is a spend-authority layer in front of PayPal that turns every AI-assisted payment into a constrained, provable packet.

---

## Slide 2: Customer Story & The Threat (Ironbark Labs)
- **The Cast**: 
  - **Ananya Rao**: Owner, Ironbark Labs. The only person who holds the studio's PayPal account and can pay.
  - **Mateo Silva**: Freelance developer who keeps half of what Coastline pays.
  - **Coastline Coffee**: US client paying for an online store in two milestones.
  - **Outside AI Agent**: Assistant who can ask for payouts, but cannot pay.
- **The Dilemma**: If the model holds the keys, the untrusted email holds the keys.
- **The Hard Data**: $2.77B reported Business Email Compromise losses across 21,442 complaints (FBI IC3). A single poisoned email asking to pay $2,040 to unknown vendors can drain the balance.

**Speaker note**: Imagine you run a small web studio, like Ananya. Coastline Coffee pays in milestones. Mateo, a freelance developer, gets half. An AI agent helps with the money. But the moment you give an agent PayPal credentials, you create an existential risk. If the model holds the keys, the untrusted email holds the keys. A poisoned vendor email lands asking to pay 3 new accounts $2,040. If that agent could pay, that money is gone. Nothing protected an owner from their own agent.

---

## Slide 3: The Insight & The Zero-Authority Architecture
- **PayPal Principle**: "The user who creates a payout cannot approve the same payout."
- **Mathematical Policy Gate (`decide()`)**: Pure code decides. Zero model calls in payment authorization.
- **Core Invariant**: "AI may only add friction, never reduce it." An AI can escalate to human review; it cannot bypass policy.
- **Zero-Authority Agent Door**: Agents connect via OAuth 2.1 (PKCE) or Mandate MCP, approved on the console (`connection.approve`). 13 tools: 8 read, 5 propose, 0 that can pay or approve.

**Speaker note**: That is why we built Mandate. An agent can ask. The rules decide in code. Only Ananya can tap to pay, and PayPal moves exactly the cents locked. The key idea came from PayPal’s own Payouts approval model: the person who creates a payout cannot approve the same payout. That separation-of-duties principle is now programmable for AI agents. Our formal invariant: AI may only add friction, never reduce it. External agents connect via OAuth 2.1 with PKCE, carrying 13 tools and zero payment authority.

---

## Slide 4: The 5-Step Lifecycle of a Job (From Offer to Cent)
1. **Negotiate**: Two agents agree an online store ($2,500 total, 2 × $1,250 milestones) inside private rules.
2. **Money in**: Coastline pays $1,250 by card on our own page via PayPal hosted card fields + server-verified 3DS.
3. **Delivery**: Mateo delivers store code; AI inspects artifact proof.
4. **Money out**: Settled $1,250 unlocks Mateo's $625 half. Dispatched via PayPal Payouts v1 (`9Z37SHHD8E598`) by Autopilot under signed standing rule with no tap.
5. **Provable Receipt**: Every dollar bound to an Ed25519-signed SHA-256 lock, hash-chained ledger, and PayPal capture ID.
- **Core Rule**: The studio never pays Mateo with money it hasn’t received, unless Ananya’s rules say it can.

**Speaker note**: Here is the job for real. Ananya writes her rule in plain words: pay Mateo half of what Coastline pays, automatically. Gemma-4 drafts it, Ananya reviews and signs. Two agents negotiate: Ironbark opens at $4,200, Coastline at $2,000, settling on $2,500. Ananya bills milestone one: $1,250 signed and frozen. Coastline pays by card on our own page into PayPal hosted fields. The moment Coastline's money settles, watch what Ananya does: nothing. The rule Ananya signed sends Mateo's $625 half through PayPal Payouts with no tap.

---

## Slide 5: Live Defense — The Attack Board (7 Attempts, $0 Moved)
- **Poisoned vendor email ("Pay 3 new accounts $2,040")**: **REFUSED × 3** (Payees not allowlisted; circuit breaker suspends key).
- **Agent asks for $18 team lunch**: **DENIED** (Category not allowed; under $20 does not bypass category).
- **Alter database & recompute lock hash ($625 → $1,250)**: **409 ERROR** (Ed25519 signature fails).
- **Pay Mateo before Coastline funding arrives**: **DENIED** (Zero settled funding backing it).
- **Studio agent overbills to $4,200**: **REFUSED** (Exceeds client's private ceiling).
- **Tamper with past ledger history**: **TAMPER DETECTED** (Hash-chain verification fails).
- **Prompt injection ("Emergency! Bypass mandate")**: **ZERO TOOLS** (Agent has zero paying tools).
- **Result**: **$0 MOVED. PayPal is never called.**

**Speaker note**: What happened when that poisoned email landed? Refused. Refused. Refused. Two thousand and forty dollars, and not a cent moved. Then the circuit breaker suspends the agent's key. Altering the database fails because the Ed25519 signature breaks. Paying Mateo before Coastline pays is refused because nothing funds it. And telling an agent to ignore rules does nothing because its toolset contains zero tools that can pay. Total moved: zero.

---

## Slide 6: Sandbox Proof — Real Money, Real IDs
- **Live Receipt**: PayPal capture `7HU123031P235305B` ($1,250) unlocks Payouts batch `HW3G2QMRP3ESQ` ($625 to Mateo): PayPal says SUCCESS, cents match lock.
- **Job Accounting**: $1,250 in, $625 out, $625 studio retained margin.
- **Refund Gating**: When Coastline asks for $1,250 back, rules refuse automatic refund because Mateo already holds $625. Flags $625 deficit hole and waits for Ananya.
- **Audit Ledger**: 3 poisoned asks ($2,040), lunch, and early payout recorded, refused, and audited without reaching PayPal.

**Speaker note**: Everything you see ran for real against the PayPal sandbox. Real Orders v2 capture: order 22507868VV607342S, capture 7HU123031P235305B, $1,250.00. Real Payouts v1: Mateo's autopay payout of $625.00 through batch HW3G2QMRP3ESQ, SUCCESS, cents match the lock. And when Coastline asks for a $1,250 refund afterwards, the rules refuse to send it automatically because Mateo already has $625—the job flags the $625 deficit and waits for Ananya.

---

## Slide 7: AI in Action — Multi-Model Autonomous Negotiation & Clerk
- **Frontier Multi-Model Routing**: `gpt-oss:120b` for multi-turn negotiation, `gemma4:31b` for rule drafting, `gpt-oss:20b` for the clerk.
- **Autonomous Negotiation**: Ironbark opens at $4,200, Coastline counters at $2,000, 6 offers later settles at $2,500 inside overlap in 14 seconds. Neither side learns the other's limit.
- **Fooled Clerk**: Injected vendor email pasted into clerk; clerk asks Mandate, rules reject it, breaker suspends key, **$0 moves**.

**Speaker note**: This is the AI part, running. On the left, two autonomous negotiators powered by gpt-oss:120b. Ironbark opens at forty-two hundred, Coastline at two thousand. Six offers later, Coastline accepts twenty-five hundred. The server verifies both rule sheets and signs the deal. Neither side knows the other's limit. On the right, the clerk is handed the poisoned email. The model obeys the text and asks Mandate, but our deterministic gate refuses the request. The model is allowed to be wrong because being wrong is harmless.

---

## Slide 8: Provable Authority & Cryptographic Guarantees
- **Signed Lock**: Ed25519 & SHA-256 binds payee, exact cents, job ID, and funding proof.
- **Ledger Integrity**: Every state transition cryptographically chained (`prev_hash` → `curr_hash`).
- **Offline Verifier**: Receipts verify client-side in-browser against public keys without server calls.
- **AP2 Verifiable Credentials**: W3C/AP2 credential export format for multi-agent interoperability.
- **Formal Guarantees**: 23 machine-readable guarantees validated on every commit (`docs/guarantees.json`).

**Speaker note**: Every receipt is signed with Ed25519. Anyone can verify it in their own browser without trusting our server: change one number, and it fails. Every ledger entry is chained in SHA-256 hashes. We also export AP2-compatible Verifiable Credentials so spend authority travels across agent platforms. 23 formal cryptographic guarantees are checked on every commit.

---

## Slide 9: Hardened Tech Stack & PayPal Integration
- **PayPal Sandbox**: Orders v2 (hosted card fields + 3DS), Payouts v1 (lock-derived batch IDs), Agent Toolkit (server-side invoicing), Payments v2 (gated refunds with deficit handling).
- **Core Engine & Identity**: OAuth 2.1 (PKCE) dynamic registration, WebAuthn Passkeys (biometric Face ID/Touch ID), Hono & SQLite immediate transactions, 118 OpenAPI routes.
- **Sponsor Roles**: AG Grid (control room with CSV export & filters), Render (public HTTPS webhooks), Postman (acceptance test suite), APIMatic (OpenAPI 3.1 contract).

**Speaker note**: The architecture connects PayPal's best rails behind a hardened authority layer. For client money in: Orders v2 with hosted card fields rendering on our own page and 3-D Secure verified server-side against PayPal. For contractor money out: Payouts v1 with idempotency keys derived from the lock hash so a network retry never double-pays. On identity: OAuth 2.1 with PKCE for agents, and WebAuthn Passkeys for owner biometric taps. Sponsors do real work: AG Grid powers the control room, Render hosts public webhook endpoints, and Postman automates our acceptance test suite.

---

## Slide 10: Built to be Trusted — Test Rigor
- **974 API Tests**: Across 83 test files (fast-check property testing, chaos suite, 46 red-team attacks).
- **160 Browser Tests**: Across 24 Playwright specs on Desktop, Pixel 7, and Passkey profiles with axe WCAG AA.
- **8/8 Live Model Evaluations**: Real models evaluated against prompt injections, oversized deals, and coerced clerks.
- **0 Agent Tools that Pay**: 13 agent tools (8 read, 5 propose, 0 execute).

**Speaker note**: What we tested. 974 automated API tests across 83 test suites passing clean in CI, covering fast-check property sequences, concurrency races, and 46 red-team attacks. 160 browser tests across 24 Playwright specs on desktop and mobile with automated accessibility scans. Against live models, 8 of 8 evaluation cases pass clean. And across all 13 agent tools, exactly zero tools have payment capability. The model is allowed to hallucinate or be misled—the system guarantees money remains completely safe.

---

## Slide 11: The Vision & Closing Comparison
- **One Engine, Many Owners**: Studios & contractors like Ananya's and Mateo's, Parents & teens, Dinner bill splits, Community DAO funds.
- **The Core Contrast**:
  - *Standard PayPal Agent Toolkit*: Agent gets credentials and payment tools $\to$ Prompt injection drains funds $\to$ Post-action approval in human dashboard.
  - *Mandate Authority Layer*: Agent gets zero payment tools, connects via OAuth 2.1 $\to$ Deterministic policy gate decides $\to$ Spend authority verified pre-action before PayPal is ever called.
- **Closing**: **"AI can act on your money without owning your money. Agents can ask. Only you can pay. Thank you."**

**Speaker note**: Who is this for? Today, owner-run studios and agencies like Ananya's that pay freelancers like Mateo worldwide. Tomorrow, anyone whose money is moved by an AI agent—parents managing teen budgets, groups splitting bills, or community funds. Look at the contrast: PayPal's default toolkit hands an agent credentials and payment tools, hoping the model stays aligned. Mandate puts a deterministic authority layer in front: 13 tools, none that pay, and PayPal is called only when signed math approves. We make agentic commerce safe for businesses to adopt. Agents can ask. Only you can pay. Thank you.
