# Mandate: The Deterministic Spend Boundary for AI Agents

Agents can ask. Only you can pay.

---

## Inspiration

Autonomous agents already draft invoices, hire contractors, negotiate rates and fill in forms. The moment money moves, a business has two bad choices: hand the agent the PayPal token and hope, or keep a human in every step and become an approval button.

Escrow protects the buyer from the seller. Nothing protected a business owner from **their own agent**. Underneath both bad choices is the same gap: the rule that decides whether money may move lives in a prompt or in someone's head, not in code the owner controls.

Mandate is the third option. An agent gets a wallet of authority, not a wallet of money.

---

## What It Does

Mandate is a spend-authority layer that sits in front of PayPal. Staff and AI agents *ask*; a pure function of the owner's signed rules decides; PayPal moves exactly the cents that were locked.

1. **Anyone can ask, nobody can pay.** Agents connect over MCP with keys that carry eleven tools and none that approve, pay or change a rule. A proposer key can file a request and watch it; it cannot move a cent.
2. **A pure function decides.** Every charge, payout and refund gets `DENY`, `AUTO` or `NEEDS_APPROVAL` from `decide()` — no model call in the decision. It checks payees, categories, monthly caps, milestone limits, funding coverage and duplicate asks.
3. **Say yes to the rule, not the payment.** A signed standing rule ("Priya is paid from settled Northwind money, up to her 60% share") makes matching payouts go with no tap. Everything else still waits for one.
4. **Autopilot runs the job.** With the rules signed, a delivered milestone is accepted, billed, paid by the client and paid out to the contractor without anyone tapping. Today shows only the exceptions.
5. **Two companies negotiate for real.** An offer stands until the other side accepts *that exact offer*, counters it, or walks away. Each side has a private walk-away, target, style and brief. A deal is signed only after both sides' **current** rules are re-checked. Once a client writes its own numbers with its own key, the studio's owner cannot read them, overwrite them or answer offers for it.
6. **Money in releases money out.** A contractor is paid only from client money PayPal confirmed settled on the same job, never above their share, never twice, never past the monthly cap.
7. **The client pays on our own page.** PayPal's card fields render *inside* Mandate; card data never reaches our server. The order is created from the lock; the server re-reads it and refuses to capture if the amount, currency or reference differ. The buyer still approves the order in PayPal — Mandate cannot do it for them. 3-D Secure is verified against PayPal, not trusted from the browser.
8. **Every dollar has a receipt.** A SHA-256 lock signed with Ed25519, PayPal's ids, the fee and a cents match. The Proof page re-verifies the whole ledger on demand, and any receipt can be checked in a browser without trusting the server.

*Note on the demo cast: the recorded video uses Ironbark Labs (Ananya, Coastline Coffee, Mateo Silva); the seeded console opens with Line Studio (Meera, Northwind, Priya Shah). Same engine, same rules, same gate — only the story cast differs.*

---

## How We Built It

- **Server**: TypeScript on Node.js 24, Hono, Zod, and `node:sqlite` in immediate transactions. Integer cents everywhere, idempotency keys on every write, OpenAPI for all 118 routes.
- **PayPal**: Orders v2 (checkout and card fields on our own page), Payouts v1, Payments v2 refunds, Invoicing through the Agent Toolkit, disputes and transaction search, and webhook signature verification. The Agent Toolkit has no Payouts tool, so Payouts calls REST directly.
- **Authority**: a pure gate (`decide()`), a signed lock over payee, cents, proof, job and funding, WebAuthn passkeys for taps, and Ed25519 for locks, deals and receipts. Machine keys are HMAC-SHA256 with an environment pepper.
- **AI**: Ollama Cloud open-weights models — `gpt-oss:120b` for the two negotiators, `gemma4:31b` for the rules drafter, `gpt-oss:20b` for the clerk and the outside agent. Prompts are versioned, fenced against injected text, snapshot-tested, and every sentence that claims money moved is taken back.
- **Console**: React, Vite, TanStack Query and vanilla CSS; an AG Grid ledger with CSV export; the control room built on AG Studio; live updates over SSE; installable PWA.
- **Proof**: Vitest, fast-check property tests, Playwright on desktop, a Pixel 7 and a passkey profile, and axe WCAG 2.1 AA on every signed-in screen.

---

## Challenges We Overcame

1. **Exactly once, under concurrency.** Duplicate asks, webhook replays and the sweep all racing on the same row. Solved with a stable ask-hash, `duplicate.open`, and one transaction per state change.
2. **Settling to the cent, and explaining when it isn't.** A short payment has to say *which PayPal field* explains the gap — an early discount, a credit note, a fee, a partial — and only when that field's amount equals the gap. A reason no field stands behind fails the audit.
3. **The client's number is not the studio's to see.** Hiding it in React was a costume; the API still returned it. Sealing it meant redacting the server, refusing the owner's write, and refusing to let the owner answer the client's offers.
4. **The browser can lie about 3-D Secure.** The result the SDK reports is a hint. The server reads the issuer's answer from PayPal and follows PayPal's recommended-action table before it captures.
5. **The card form that reset itself.** The client page refreshed every 15 seconds and re-keyed each bill on its last change — and opening the form changed it, wiping what the buyer typed. It is keyed by bill id now.

---

## Accomplishments That We Are Proud Of

- **891 API tests across 75 files** passing clean in CI, including fast-check property sequences, 46 red-team cases and the chaos suite.
- **150 browser tests in 23 specs** on desktop, a Pixel 7 and a passkey profile, with an axe WCAG 2.1 AA scan on every signed-in screen.
- **23 verified cryptographic guarantees** in machine-readable JSON, checked on every build — including *no payout is larger than the contractor's share*, *nothing is paid from money that has not arrived*, *no AI can reach PayPal*, and *a buyer cannot change what is paid*.
- **Real PayPal sandbox proof, end to end**: a bill paid **by card on our own page** (captures `16863006RF678602F`, `79204140TH113652R`), an invoice paid by the sandbox buyer and settled only when PayPal said `PAID` (`INV2-76H8-5LLT-E4P4-C2HD`), contractor payouts through Payouts v1 (`SJ5B3GGM7UBAU`, `DKPZEQ87HG8MU`), and a second payout sent by **autopilot under a signed standing rule, with no tap** (`9Z37SHHD8E598`, `SUCCESS`). A partial refund (`12C310409G863064M`) ran through the gated route.
- **A refusal that tells you what would pass** — only variants re-run through the real gate, never a model's guess.
- **Offline verification**: a tampered receipt fails in your browser, against public keys, with no call to our server.
- **Mobile Lighthouse**: 90 on Welcome, 88 on Unlock, 80 on Today.

---

## What We Learned

- **AI may only add friction.** A model can make something need a tap; it can never remove a refusal, approve, or pay. Every design decision fell out of that one line.
- **A rule in a prompt is not a rule.** Versioned, signed data that a pure function reads is the only version a finance person can audit.
- **Refusals are the product.** The first thing owners asked was never "how do I pay?" — it was "why did it say no?" So the code names the rule, the field and the number.

---

## What Is Next

- Postgres and real multi-tenancy (a driver change, not a redesign).
- Prove a real open dispute and a real refund end to end on the sandbox.
- Adopt AP2's credential format so a Mandate lock can travel with an agent payment.
- More rails behind the same gate — ACH, cards, local wallets — and quorum approval above a threshold.

---

## Built With

- TypeScript, Node.js 24, Hono, Zod
- SQLite (`node:sqlite`)
- React, Vite, TanStack Query, vanilla CSS
- PayPal Orders v2, Payouts v1, Payments v2, Invoicing, Agent Toolkit
- WebAuthn / SimpleWebAuthn, Ed25519, HMAC-SHA256
- Model Context Protocol (MCP)
- Ollama Cloud (`gpt-oss:120b`, `gemma4:31b`, `gpt-oss:20b`)
- AG Grid, AG Studio
- Vitest, fast-check, Playwright, axe
- Render, Postman

**Sponsor prize:** Best Use of AG Grid. The ledger is an AG Grid with CSV export and a refusal filter; the control room is built on AG Studio and is lazy-loaded, read-only, and has no path to PayPal.

---

## Try It

Sandbox only. Nothing here moves real money.

**Fastest, when the hosted console is up:** open the link on the Devpost page and click **Try the demo** — no key needed. Then try *Today → Try to break it* and *Deals → Let the negotiators negotiate*. If it is asleep, use the path below.

**The real owner console, on your machine:**

```bash
npm run setup
npm run build
# put sandbox PayPal credentials and OLLAMA_API_KEY in .env
cd api && node --env-file=../.env ./node_modules/tsx/dist/cli.mjs src/main.ts
```

Open `http://localhost:8787` and unlock with the owner key from the Devpost testing instructions. Use **localhost**, not `127.0.0.1`, or passkeys will refuse the origin.

Full instructions: `docs/TRY_IT.md`. The five-minute judge path: `docs/JUDGES.md`.

The recorded demo uses the **Ironbark Labs** cast (`E2E_SCENARIO=ironbark` in `api/src/dev/scenarios.json`); the seeded console opens with **Line Studio**. Both are demo data; the product is the same.

---

## Honest Limits

- **PayPal sandbox only.** No real money moves here.
- **Single-process SQLite.** Right for one studio, not a payment gateway.
- **The hosted demo is ephemeral.** A free Render instance sleeps and wipes its disk on restart, so a hosted copy shows a fresh ledger. The repo path above always works.
- **An open PayPal dispute cannot be demonstrated.** The sandbox does not list a first-stage case, so the hold is fake-tested only.
- **The agents need a model.** The rules, the gate, the lock and PayPal do not.
- **One currency per studio.** A studio picks its currency and time zone; there is no conversion.
