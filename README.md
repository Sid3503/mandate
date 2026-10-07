# Mandate

**Agents and staff can ask to spend. Rules decide. The owner says yes to a rule once, and taps for the exceptions. PayPal moves exactly the locked cents.**

Mandate is a spend-authority layer in front of PayPal, built for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/). Nobody who asks for a payment, human or AI, ever holds the PayPal token. PayPal sandbox only; nothing here moves real money.

- The owner writes **rules** once. They are versioned data, not a prompt.
- A pure function answers each request: **refused**, **automatic**, or **needs the owner**.
- Say a change in words and a model **drafts** the rules; code lists what it loosens; you publish.
- The owner can sign a **standing rule** ("Priya is paid from settled Northwind payments, up to her 60% share"). A payout that matches needs no tap; everything else still does.
- When the owner taps, the exact payment is locked into one **hash**. PayPal may then move that and nothing else.
- A contractor is paid only from **client money that already settled** on the same job.
- Every dollar that moved, and every one that was refused, has a **receipt**.

## The job everything is built on

Line Studio (Bengaluru) bills Northwind $300 in two $150 milestones. Priya Shah, the freelance designer, gets 60% of each: **$90**.

| Step | What happens | Status |
| --- | --- | --- |
| Money in | The studio bills $150. Meera (owner) taps. Northwind pays through PayPal Orders. | built, live in sandbox |
| Money out | The captured $150 funds Priya's $90. Meera taps. PayPal Payouts sends exactly $90 to Priya's own account, and it is called *paid* only when PayPal says so. | built, live in sandbox |
| Refusals | $18 team lunch (`category.missing`). Fake vendor "P. Shah" $480 (`payee.unknown`). Payout before the client paid (`funding.missing`). Retry at $250 after the tap (`cart.immutable`). A third $90 past the $180 monthly cap (`cap.monthly`). | built |
| Receipt | One record per payment and per job: request, rule, approval, lock, PayPal ids, cents match. | built |
| Deal | The two companies' agents agree $300 in two milestones. $450 and $200 are refused by a pure function that checks **both** companies' rules. The agreed deal is signed. | built |
| Agents | A clerk Arun can talk to, and two negotiators, on `gpt-oss:20b` through an MCP server whose six tools cannot pay. A fooled agent is refused by the same rules. | built, evaluated against the real model |
| Autopilot | With the owner's rules signed, the job runs itself: proof attached → PayPal invoice sent; client pays → the contractor's share is asked for and paid; unpaid invoices get PayPal's reminder. The server re-reads PayPal every minute, so it finishes without anyone pressing anything. | built, tested in the browser and in pieces live |
| Client acceptance | Optionally, the studio's delivery waits for the client's own agent to accept it (signed over the exact proof link) before the invoice goes out. | built, tested |
| Verify a receipt | A public page checks a downloaded receipt's lock and signatures in the browser, against the public keys, without asking the server. | built, tested |
| Today, Ask, Proof | A landing page of what waits for the owner, what is in flight and what was done for them (and how); a clerk on Cmd/Ctrl + K; and a Proof page that re-verifies every lock, every yes and every amount from the ledger. | built |
| Standing rules | The owner signs one rule for Priya's share. The $90 is then sent with no tap, after the same checks: funding, share, cap, proof, dispute hold, signed lock. Anything that does not match still waits. | built, red-teamed, real Payouts call verified |
| Invoices | A client charge is billed as a PayPal invoice through the Agent Toolkit, and settled only when PayPal says it was paid. Falls back to checkout where the app lacks the permission. | built, live in sandbox |

Job totals for the live sandbox run: **$150 in, $90 out, $60 kept.**

## Run it (real PayPal sandbox, real AI model)

Needs Node.js 22+ (24 recommended) and Chrome. Put your PayPal sandbox app credentials and an Ollama Cloud key in a repo-root `.env` (see [`api/.env.example`](api/.env.example)). It is gitignored; never commit it.

```bash
npm run setup && npm run build
cd api && node --env-file=../.env ./node_modules/tsx/dist/cli.mjs src/main.ts
```

Open **http://127.0.0.1:8787/** (it opens the landing page, which explains the product; press **Unlock**) and unlock with `dev-mandate-key-change-me`. A guided tour opens on first visit, and every screen has a **Guide** button.

The route: **Deals → Let the agents negotiate** ($450 and $200 refused, $300 agreed and signed) → bill milestone 1 → approve → **Settle**, then approve the order in PayPal as the sandbox buyer and press **Check PayPal and settle** → **Clerk**: "pay Priya her share…" → approve → **Send $90.00** → **Jobs**: $150 in, $90 out, $60 kept. Then paste the fake vendor email into **Clerk** and watch the rules refuse it.

Full walk-through with what you should see at each step: [docs/REFERENCE.md](docs/REFERENCE.md#running-against-the-paypal-sandbox).

> **About `npm run demo`.** It starts a *test server* on :8799 with a fake PayPal and a scripted stand-in for the AI, so the 30 browser tests are deterministic and free. It is for development, not for showing the product. The real thing is above.

## How it works

```
 people and agents  ──propose──▶  rules gate  ──▶  owner's tap  ──▶  lock (hash)  ──▶  PayPal
 (proposer key)                   pure function     (owner key)       payee·cents·     Orders in
                                  DENY/AUTO/NEEDS                     proof·job·       Payouts out
                                                                      funding
```

- **Server:** `api/` is TypeScript, Hono, Zod and SQLite, with an OpenAPI contract, idempotency keys, and integer cents.
- **Console:** `web/` is an installable React app at `/app/` with an AG Grid ledger. It works read-only offline and never caches money calls. A first-time visitor gets a guided tour, and every screen has a **Guide** button that walks through exactly what is on it.
- **Three keys:** the owner key approves and settles. The studio key (staff and agents) can only ask and read. A client's agent key can only offer deals for its own client.
- **The lock is signed.** When the owner taps, the server signs the exact payee, cents, proof and funding with Ed25519. Edit the database after that, even with a matching hash, and PayPal is never called. The receipt has a **Verify** button.
- **The agent door is `/mcp`.** Six tools, none of which can approve, pay or change rules. An agent that is tricked can only ask, and the rules say no.
- **Money out is Payouts, never Orders.** Checkout collects money for the studio, so it cannot pay a contractor. Pending, unclaimed and failed payouts are shown as such, never as paid.

## Repository

| Path | What is there |
| --- | --- |
| `api/` | Rules server, PayPal client and fake, tests, Postman collection |
| `web/` | Owner console and Playwright end-to-end tests |
| `pitch/` | Deck and demo video script |
| `PRODUCT.md` | The product story: the problem, what Mandate is, what is built, how it works, what is proven and what is not |
| `docs/REFERENCE.md` | Everything else: architecture, every screen, rules, the lock, HTTP API, rule codes, tests, security, Render deploy, troubleshooting |
| `KT.md` | Handover notes and the sandbox accounts |

Commands: `npm run setup`, `npm run build`, `npm start`, `npm test` (API tests then Playwright), `npm run demo`.

## Quality

265 API tests (including a 56-case red team), 50 end-to-end tests on desktop and phone (including an axe WCAG 2.1 AA scan), Lighthouse 99 / 100 / 100 on mobile.

## Where to read next

- **Judges:** [docs/REFERENCE.md](docs/REFERENCE.md) for the demo walkthrough, and the [PayPal integration](docs/REFERENCE.md#paypal-integration) section with the live sandbox history.
- **Developers:** [api/README.md](api/README.md), [web/README.md](web/README.md), and the [HTTP API reference](docs/REFERENCE.md#http-api-reference).
- **Roadmap and what is left:** [docs/REFERENCE.md#roadmap-what-is-left](docs/REFERENCE.md#roadmap-what-is-left).

## License

[MIT](LICENSE). Copyright (c) 2026 Siddharth Mishra.

> **AI can act on your money without owning your money.**
