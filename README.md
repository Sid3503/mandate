# Mandate

**Agents and staff can ask to spend. Rules decide. The owner taps. PayPal moves exactly the locked cents.**

Mandate is a spend-authority layer in front of PayPal, built for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/). Nobody who asks for a payment, human or AI, ever holds the PayPal token. PayPal sandbox only; nothing here moves real money.

- The owner writes **rules** once. They are versioned data, not a prompt.
- A pure function answers each request: **refused**, **automatic**, or **needs the owner**.
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
| Invoices | A client charge can be billed as a PayPal invoice through the Agent Toolkit. Falls back to checkout where the app lacks the permission. | built |

Job totals for the live sandbox run: **$150 in, $90 out, $60 kept.**

## Try it in two minutes

Needs Node.js 22+ (24 recommended) and Chrome.

```bash
npm run setup     # install api/ and web/
npm run demo      # build the console, start an in-memory server with a fake PayPal
```

Open **http://127.0.0.1:8799/app/** and unlock with the owner key `owner-e2e-key-0123456789`. (The agent key `proposer-e2e-key-0123456789` can ask and read, never approve.)

Or press **Deals → Let the agents negotiate** to watch two agents reach $300, then **Clerk** and paste the fake vendor email. (`npm run demo` uses a scripted stand-in for the AI so it works offline; set `OLLAMA_API_KEY` for the real model.)

Then follow the job: **New request** → Money in, $150, job `job_northwind_logo` → **Waiting for you** → Approve → Settle → ask for Priya's $90 funded by that payment → Approve → **Send $90.00 to Priya Shah**. Try the refusals from the table above in **New request**.

To run against the real PayPal sandbox, see [Setup](docs/REFERENCE.md#running-against-the-paypal-sandbox).

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
| `docs/REFERENCE.md` | Everything else: architecture, every screen, rules, the lock, HTTP API, rule codes, tests, security, Render deploy, troubleshooting |
| `KT.md` | Handover notes and the sandbox accounts |

Commands: `npm run setup`, `npm run build`, `npm start`, `npm test` (API tests then Playwright), `npm run demo`.

## Quality

99 API tests, 30 end-to-end tests on desktop and phone (including an axe WCAG 2.1 AA scan), Lighthouse 99 / 100 / 100 on mobile.

## Where to read next

- **Judges:** [docs/REFERENCE.md](docs/REFERENCE.md) for the demo walkthrough, and the [PayPal integration](docs/REFERENCE.md#paypal-integration) section with the live sandbox history.
- **Developers:** [api/README.md](api/README.md), [web/README.md](web/README.md), and the [HTTP API reference](docs/REFERENCE.md#http-api-reference).
- **Roadmap and what is left:** [docs/REFERENCE.md#roadmap-what-is-left](docs/REFERENCE.md#roadmap-what-is-left).

## License

[MIT](LICENSE). Copyright (c) 2026 Siddharth Mishra.

> **AI can act on your money without owning your money.**
