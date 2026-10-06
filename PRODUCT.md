# Mandate: the product

> **AI can act on your money without owning your money.**

Mandate is a spend-authority layer that sits in front of PayPal. Staff and AI agents can *ask* to move a company's money. A pure function of rules decides. The owner says yes once to a rule, and taps for the exceptions. Once the rules are signed, the whole job can run by itself, and every step of it can be re-verified on demand. PayPal then moves exactly the cents that were locked, and nothing else. Nobody who asks, human or agent, ever holds the PayPal token.

Built for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/). PayPal sandbox only; nothing here moves real money.

This file is the product story: what it is, why it exists, what we built, how it works and how much of it is proven. For commands and the API see [README.md](README.md), [docs/REFERENCE.md](docs/REFERENCE.md) and [api/README.md](api/README.md).

---

## 1. The problem

Agents can already talk, quote, negotiate and fill in forms. What nobody has made safe is the moment money moves.

Today a business has two bad options when it lets software (or a junior person) act on its PayPal account:

1. **Hand over the keys.** The agent holds the token and can do anything the account can do. One prompt injection, one typo, one hallucinated vendor, and the money is gone. There is no record of why.
2. **Keep a human in every step.** Safe, but it defeats the point of having an agent: the owner becomes an approval button.

Underneath both is the same gap: *the rule that decides whether money may move lives in a prompt or in someone's head, not in code the owner controls.*

## 2. What Mandate is

An agent gets **a wallet of authority, not a wallet of money.**

- The owner writes **rules** once. They are versioned data, not a paragraph in a prompt.
- Anyone (a producer, a bookkeeping agent, a client's negotiating agent) can **propose** a charge (money in), a payout (money out) or a refund.
- A **pure function** answers every proposal: `DENY`, `AUTO` (under the owner's line, or covered by a standing rule, so it goes ahead), or `NEEDS_APPROVAL` (the owner must tap).
- **Say yes to the rule once, not to each payment.** The owner can sign a **standing rule**: "Priya is paid from settled Northwind payments on a signed deal, up to her 60% share and inside the monthly cap." A payout that matches it needs no tap. Everything else still does.
- When a payment is approved (by the tap, or by a standing rule), the exact payment is **locked** into one SHA-256 hash and **signed** with an Ed25519 key. PayPal may move that and nothing else.
- A contractor is paid only from **client money that already settled** on the same job.
- Every dollar that moved, and every dollar that was refused, has a **receipt**.

The design rule behind everything: **AI may only add friction.** A model can make something need a tap. It can never remove a refusal, approve, or pay.

## 3. Who it is for

**Line Studio** is a small design studio in Bengaluru. Meera (the owner) holds the PayPal account. Arun (the producer) and software agents do the day-to-day asking. Priya Shah is a freelance designer who gets a share of each client job. Northwind is a client, with its own agent and its own private spending limits.

The same engine works for anyone whose money is moved by someone else, or by someone else's agent: a parent and a teen's shopping agent, friends splitting a dinner, a community pool, a nonprofit board. The rules are data, so these are templates, not separate products.

## 4. The job everything is built on

One frozen scenario drives every test, screenshot and demo. Nothing in the repo uses different numbers.

> Northwind and Line Studio agree **$300** in two **$150** milestones. Priya's share is **60% = $90**. Anything under **$20** is automatic. The monthly contractor cap is **$180**.

| Moment | What Mandate does |
| --- | --- |
| Agents negotiate | Studio asks $450, client offers $200. Each is refused by a check against *both* companies' rules. $300 is agreed and **signed**. |
| Studio bills milestone 1 | A $150 charge bound to that milestone. The owner taps. A real PayPal invoice goes to Northwind. |
| Client pays | Settled **only** when PayPal reports the invoice `PAID` for exactly the locked cents. |
| Pay Priya | $90 is proposed and cites the settled $150. Without a standing rule the owner taps; with one, Mandate sends it itself. PayPal Payouts sends exactly $90 to Priya's own account. It is called *paid* only when PayPal says `SUCCESS`. |
| Refusals | $18 team lunch (`category.missing`). Fake vendor "P. Shah" $480 (`payee.unknown`). Payout before the client paid (`funding.missing`). A $250 retry after the tap (`cart.immutable`). A third $90 past the cap (`cap.monthly`). |
| The job | **$150 in, $90 out, $60 kept.** |

## 5. What we built

**The short version.** Meera signs the rules once. A producer (or the clerk) says "milestone 1 is delivered" with a link; Mandate invoices Northwind through PayPal; Northwind pays; Mandate pays Priya her share; Meera's Today page shows it under *Done for you* with how each step was approved; and a *Proof* page re-verifies the whole ledger on demand. What needs Meera is a short list of exceptions.


### The core (rules and money)
- **Rules** (called a *warrant* in the code): versioned, Zod-validated data. A new version never rewrites an open request.
- **The gate**: a pure function, no PayPal and no database. It checks the amount shape, payee, category, currency, refund parent, job, deal, funding, proof link, per-payment ceiling and monthly cap, then decides automatic vs needs-a-tap. A refusal is stored as a row with its rule code and the server's sentence, and PayPal is never called.
- **The lock**: SHA-256 over payee, cents, currency, category, proof, kind, job and funding capture, **signed with Ed25519**. Recomputed and verified at settle. Edit the database afterwards, even with a matching hash, and PayPal is not called (`lock.signature_invalid`). Anyone can verify with the public key at `/.well-known/mandate-keys.json`. Keys rotate without breaking old receipts.
- **Money in**: client charges settled through a PayPal **invoice** (Agent Toolkit) or, where the app lacks the permission, PayPal **Orders** checkout.
- **Money out**: contractor **Payouts** (never Orders, which would charge a buyer). The batch id derives from the lock hash so a retry can never pay twice. Pending, unclaimed and failed payouts are shown as such and never counted as paid.
- **Funding**: a payout must cite a captured client payment on the same job and stays within the 60% share. Checked at propose, approve and capture.
- **Standing rules**: part of a published rules version (so versioned, diffed and owner-only). A matching payout is `AUTO` with the code `standing.matched`, is sent by the server through the same settle path the Send button uses, and is held if PayPal cannot be reached or a dispute is open. It skips only the tap: proof, funding, share, cap and dispute checks all still run. A payout that cannot be sent waits and retries; one that is broken is refused for good. The server also re-reads PayPal once a minute for payouts still processing and invoices still out, so they settle with nobody pressing anything.
- **Refunds**: a new proposal against a capture id, through the same gate and the same settle route.
- **Receipts**: one per payment (`/packet`) and one per job, with request, rule, approval, lock, PayPal ids and whether the cents match.

### Deals and agents
- **Deal check**: a pure function that tests an offer against *both* companies' rules. Each side keeps **private limits** that the other never sees, and refusals reveal only the side that was breached.
- **Signed deals**: an agreed deal is Ed25519-signed, and a charge on that job must bill one of its milestones, once, for exactly the agreed cents (`deal.*` rules).
- **MCP agent door** (`/mcp` and stdio): six tools (rules, jobs, propose, ledger, offer a deal, explain). **None can approve, pay or change rules.** The owner key is downgraded on this door.
- **The clerk and two negotiators**: run on `gpt-oss:20b`, with guards (the payee must appear in the request text, a model error is retried once, every run is traced). Evaluated against the real model: 8 cases.
- **Live negotiation**: streamed to the console turn by turn, with a Stop button.

### Autopilot (the whole job, under signed rules)
- **Bill on delivery.** A milestone of a signed deal is billed, and its PayPal invoice sent, as soon as proof is attached (`standing.billing`). Amount, client, milestone and once-only come from the signed deal.
- **Pay on settle.** When PayPal confirms a client payment, the server asks to pay each contractor whose standing rule covers it, for their share. Per-contractor shares are supported, and rules that promise more than the contractor share cannot be published.
- **Chase unpaid invoices.** PayPal's own reminder after N days, up to a maximum.
- **It finishes by itself.** Once a minute the server re-reads PayPal for invoices out and payouts processing, so they settle with nobody pressing anything. Checkout fallback waits for the client and settles when they approve.
- **It stops loudly.** A payout autopilot asked for and the rules refused, a payout on hold, an overdue invoice, a client dispute: all appear under *Waiting for you* with the reason and the button to act.

### Today, Ask and Proof
- **Today** is the landing page: the month in money PayPal confirmed, how much ran without a tap, a setup checklist, *Waiting for you*, *Ready to bill* (paste the proof link), *In flight*, *Done for you* (and how), and *Stopped by the rules*, with the buttons on each row.
- **Ask Mandate** (Cmd or Ctrl + K, on any screen) is the clerk in a dialog: "the concepts are delivered, bill Northwind", "what is waiting for me?".
- **Proof** re-verifies the ledger from scratch in the server: every lock intact and signed, every payment had a tap or a signed rule, amounts to the cent, contractors paid from money that arrived, the cap held, no job paid out more than came in, deals followed, and (optionally) PayPal's own history agrees. The tests tamper with the database eight ways and check the right line turns red.

### The rules drafter
Say "let Priya be paid automatically from Northwind" and a model drafts the change. It cannot publish. The server validates the draft against the same schema as a hand edit, and **code, not the model, lists what the draft loosens**, so a draft that calls itself "nothing risky" is still shown with its five loosenings. The owner reads the before-and-after and publishes it.

### The owner console (`web/`)
An installable React app served at `/app/`.
- **Waiting for you** (inbox), **Jobs**, **Deals**, **Clerk**, **New request**, **Ledger** (AG Grid; requests, events and the PayPal activity tab), **Rules**, **System**.
- Receipts with a timeline, a lock **Verify** button and a downloadable receipt.
- A landing page, a guided tour and a per-screen **Guide**.
- Works read-only offline and never caches or queues a money call.
- A strict CSP, the key kept only in `sessionStorage`, and an axe WCAG 2.1 AA scan on every screen.

### PayPal depth (the latest round)
- **Feature readiness**: the System screen reads the permissions on the app's access token and shows each PayPal feature as On or Off, what is lost while it is off, and the dashboard steps to turn it on.
- **Cancel an unclaimed payout**: PayPal holds a payout to an email with no account. One button cancels it, PayPal returns the money, and the reservation is freed.
- **Return URL**: PayPal sends the checkout buyer back to the receipt, which settles by itself.
- **Invoice reminder and cancel**: nudge a client, or void a wrong invoice so the milestone can be billed again.
- **Dispute hold**: a client payment with an open PayPal dispute cannot fund a payout (`funding.disputed`). The server checks every minute and again just before any payout. If PayPal cannot answer, the payout waits.
- **Transaction reconciliation**: the Ledger lists the last 30 days of PayPal activity, matches it to the ledger, and flags anything Mandate did not create as **Not in Mandate**. Read-only.
- **Balance advice**: the account balance PayPal reports, with its age, shown on System and beside a payout about to be sent, with a "may be short" warning. Advice only, because PayPal's report lags.
- **Tool tiers**: all 47 tools in PayPal's Agent Toolkit are put in a tier (read, propose only, out of scope). The server runs only nine, refuses any other, and an agent can call none of them. A test fails when PayPal adds a tool that has no tier.
- **Webhooks**: payout, invoice and dispute events only *nudge* a re-read. With `PAYPAL_WEBHOOK_ID` set, each delivery must carry a signature PayPal confirms. Repeated events are ignored.

## 6. How it works

```
 people and agents ──propose──▶ rules gate ──▶ owner's tap ──▶ signed lock ──▶ PayPal
 (proposer key)                 pure function   (owner key)     payee·cents·     Invoices / Orders in
                                DENY/AUTO/NEEDS                  proof·job·       Payouts out
                                                                 funding
```

1. **Ask.** A person, the console, the clerk or an agent over MCP files a proposal. Each has its own key. The ask carries an idempotency key, so a retry replays the first answer.
2. **Decide.** The gate returns a rule code and a plain-words reason. A denial is stored and is the end of it.
3. **Tap, or a standing rule.** For anything at or above the automatic line, only the owner key can approve, unless the owner's standing rule covers that exact kind of payout. Either way the lock is signed.
4. **Settle.** Only the server talks to PayPal, and only from the locked cart. It re-reads the live PayPal object (order, invoice or payout) and refuses if the amount, currency or reference differ. A different amount sent by a client is only ever a *claim*, never the amount sent. A payout under a standing rule is sent by the server and takes this same path.
5. **Receipt.** Every step is an event in an append-only ledger.

**Three keys:** the owner key approves and settles. The studio key (staff and agents) can only ask and read. A client's agent key can only make offers for its own client.

**Stack:** TypeScript end to end: a Hono and SQLite rules server, a React console, PayPal's REST APIs plus its Agent Toolkit, and an open-weights model behind an MCP door. The details are in the next section.

## 7. Tech stack

### At a glance

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js 22+ (24 recommended), TypeScript 5.9 | One language across server, console and tests. `node:sqlite` is built in, so no native database driver to install. |
| Server | Hono 4 on `@hono/node-server` | Small, fast, standard `Request`/`Response`, so the whole app is testable with `app.request()` and no network. |
| Validation and contract | Zod 4, `@asteasolutions/zod-to-openapi` | One schema is the runtime check *and* the OpenAPI 3.1 contract at `/openapi.json`. Errors are RFC 9457 `application/problem+json`. |
| Database | SQLite through `node:sqlite`, WAL mode, foreign keys on | One owner, one writer. Money steps run inside `BEGIN IMMEDIATE`. The ledger is append-only events. Moving to Postgres would be a driver change. |
| Money | Integer cents everywhere; PayPal decimal strings only at the edge | No floating point near money. |
| Crypto | `node:crypto`: SHA-256 for the lock hash, Ed25519 for signatures | No third-party crypto. Public keys are served at `/.well-known/mandate-keys.json`; rotation keeps old receipts verifiable. |
| Agents | Vercel AI SDK 7 (`ai`), `ai-sdk-ollama`, `@ai-sdk/mcp`, `@modelcontextprotocol/sdk` | See the AI section below. |
| Console | React 19, Vite 8, React Router 7, TanStack Query 5, AG Grid Community 36, framer-motion, lucide-react | A fast installable app. AG Grid gives the ledger filtering and search without hand-rolled tables. |
| PWA | `vite-plugin-pwa` / Workbox | Installable, with an app shell that works offline read-only. Money calls are never cached or queued. |
| API types | `openapi-typescript` | The console's types come from the server's own contract. |
| Tests | Vitest 5 (API), Playwright 1.63 with `@axe-core/playwright` (console) | 247 API tests (56 of them a red team) and 46 browser tests on desktop and phone, with an accessibility scan on every screen. |
| Hosting | Render blueprint (`render.yaml`) | One web service serves the API and the console at `/app/`. |
| Docs and tooling | Postman collection with assertions, OpenAPI 3.1 | Postman walks the frozen job. |

Repository layout: `api/` (server, PayPal adapters, agents, tests), `web/` (console, end-to-end tests), `pitch/` (deck and script), `docs/`.

### Architecture choices that matter

- **Pure core, impure edges.** The gate (`domain/gate.ts`), the deal check, the lock hash and the reconciliation matcher are pure functions. They never touch PayPal or the database, so they are tested exhaustively and cannot be talked around.
- **Ports and adapters.** Each outside system sits behind a small interface: `PayPalPort` (Orders, refunds, Payouts, webhook verification, token scopes), `InvoicePort` (Invoicing) and `WatchPort` (transactions and disputes). Each has a real implementation and a `Fake*` used by the test suite, so every money path is exercised without touching PayPal.
- **Three read-only services on the same container.** `TodayService` (the landing page from the ledger), `AuditService` (the stranger's checklist) and the autopilot inside `MandateService` all start from the one `buildServices()`, so none has a private shortcut past the gate.
- **One container.** `buildServices()` wires the services once. The HTTP app, the MCP server and the agents all start from it, so an agent gets exactly the powers of an outside caller and no private shortcut.
- **Principals, not roles sprinkled in code.** A key maps to a principal (owner, studio, or a client's agent). Owner-only routes are declared in one list and a proposer gets 403 on every one.

### PayPal: how it is integrated

| Piece | Detail |
| --- | --- |
| Auth | OAuth2 client-credentials against the sandbox. The token is cached until expiry. The scopes returned with it are read, so the System screen can say which features are on. |
| REST client | A small hand-written client over `fetch` with a 20 second timeout. No PayPal SDK is needed for Orders, Payments or Payouts. |
| Orders v2 | Create (with `custom_id` and `invoice_id` set to the proposal id, and a return and cancel URL), get, capture. The live order is re-read and compared with the lock before capture. |
| Payments v2 | Capture refund, through the same gated route. |
| Payouts v1 | One item per batch. `sender_batch_id` is derived from the lock hash, so a retry can never pay twice. Status is read back from the batch. Unclaimed items can be cancelled with the payout-item cancel call. |
| Webhook verification | `POST /v1/notifications/verify-webhook-signature` when `PAYPAL_WEBHOOK_ID` is set. Events are de-duplicated by event id, and the body is never trusted: it only names something to re-read. |
| Idempotency | Stable `PayPal-Request-Id` values per operation (create, capture, refund, payout), so a network retry never duplicates money. |
| Agent Toolkit | `@paypal/agent-toolkit` 1.11 runs **server-side only**. Its `ai-sdk` export is configured with just the actions Mandate needs (least privilege), and the tools are called directly rather than handed to a model. Nine of its 47 tools are used: `create_invoice`, `send_invoice`, `get_invoice`, `list_invoices`, `send_invoice_reminder`, `cancel_sent_invoice`, `list_transactions`, `list_disputes`, `get_dispute`. |
| What the toolkit lacks | It has no Payouts tool, so Payouts uses the REST API directly. |
| Degrading gracefully | If the app lacks a permission (401/403), invoices fall back to checkout, disputes are skipped, and transaction search shows the steps to enable it. The dispute check *fails closed*: if PayPal has the permission but cannot answer, the payout waits. |

### AI: how it is integrated

| Piece | Detail |
| --- | --- |
| Model | `gpt-oss:20b`, an open-weights model, on Ollama Cloud, called through the Vercel AI SDK. Changing the model is one environment variable (`AGENT_MODEL`). With no `OLLAMA_API_KEY` the agents are simply off and everything else works. |
| Four agents | The **clerk** (a chat for the producer, and the Ask Mandate dialog: "pay Priya her share…"), two **negotiators**, one per company, that trade offers until a deal is agreed or refused, and the **rules drafter**, which turns "let Priya be paid automatically" into a reviewable draft. |
| The drafter is different on purpose | It gets one tool that takes a small patch in dollars, percent and names, not the rules. The server merges and validates it against the same schema as a hand edit, retries with the validation message, and lists what the draft **loosens** in code, so the model's reassurance is never the thing you read. It runs on `gemma4:31b` (`DRAFTER_MODEL`), which measured best and fastest on compound requests. |
| The only door is MCP | The model never sees HTTP routes or PayPal. It reaches Mandate through an MCP server (`/mcp` for outside agents, stdio with `npm run mcp`, and an in-process connection for Mandate's own agents). An agent of ours has exactly the powers an outside agent would. |
| Six tools, none can pay | `get_rules`, `get_jobs`, `propose`, `list_ledger`, `offer_deal`, `explain`. There is no approve, capture, refund or rule-change tool. The owner key is deliberately downgraded on this door. |
| Bounded runs | Temperature 0 so a message gets a repeatable answer. Capped by steps (8 for the clerk, 3 for a negotiator), by the number of asks (4 and 1), and by wall-clock (60 s and 45 s). A model error is retried once. A negotiator's run stops as soon as it calls `offer_deal`. |
| Grounding | The payee in a request must appear in the person's own words (`payee.not_in_request`). This defeats an injected or hallucinated vendor. `get_jobs` ranks jobs that can be funded first and says when payouts become possible. |
| Facts, not prose | The reply shown to a person is built from the rules' own answers. If the model writes a sentence claiming money moved, an output guard replaces it, because an agent that can only ask can never know that. |
| Traced | Every run stores its input, its reply, each tool call and each tool result. A receipt from an agent has a "Show every step the agent took" view. |
| Evaluated | `npm run eval:agents` runs 14 cases against the real model, including ones built to fool it: the fake-vendor email, "the owner already agreed", a lookalike payee, an instruction hidden in a pasted invoice, "split it into five $18 payments", and a request to approve. Compared on four models: no miss moved money. See the table in `docs/REFERENCE.md`. |
| Red team | 56 deterministic cases assume a *fully compromised* model and check one invariant: PayPal is never asked and nothing reads as paid. |
| Streaming | A negotiation streams to the console turn by turn over server-sent events, with a Stop button that cancels the model call. |

The principle across all of it: the model is a *reader of rules and a writer of requests*. Authority lives in code the owner controls.

### Why this stack

- **Prove safety with code, not promises.** Pure functions and ports let the tests show that no path moves money without a tap and a signed lock.
- **Few moving parts.** One process, one file database and one deploy target make the whole system easy to run, inspect and demo.
- **Use PayPal's own agent surface where it fits.** The Agent Toolkit for invoices, reminders, reconciliation and disputes; REST for the money movements the toolkit does not cover.
- **Open weights, swappable.** The model is replaceable, and nothing depends on it for safety.

## 8. Where PayPal is used

| PayPal capability | Used for | Proven on the real sandbox? |
| --- | --- | --- |
| **Invoicing** (Agent Toolkit: create, send, get, remind, cancel) | Bill a client, nudge, void | **Yes.** A real invoice was created, sent, paid as the sandbox buyer, and settled. Reminder and cancel also run live. |
| **Orders v2** | Checkout fallback for money in; return URL | **Yes** for create, approve and capture (earlier runs). The return URL order creates live; a buyer landing back on the receipt is tested with the fake. |
| **Payouts v1** | Pay the contractor | **Yes.** `PENDING` then `SUCCESS` to a real sandbox account, fee recorded. |
| **Payout item cancel** | Return an unclaimed payout | **Yes.** `RETURNED`, three times. The real run showed PayPal refuses the cancel until the whole batch is processed, so the console now says to wait. |
| **Payouts sent by a standing rule** | A payout approved by the owner's rule, sent with no tap | **Yes.** The server sent a real payout under the rule (`AUTO`, `standing.matched`); the account was unregistered so it was `UNCLAIMED`, then returned. The client payment in that run was simulated. |
| **Payments v2 refunds** | Refund a settled payment | Fake-tested through the gated route. |
| **Transaction Search** (Agent Toolkit) | Reconciliation | **Yes** for the read, with paging. Matching depends on PayPal's report refresh, which lags by hours. |
| **Reporting balances** | Balance advice | **Yes** for the read ($5,341.24 reported). It is advice because the report lags. |
| **Disputes** (Agent Toolkit) | Dispute hold | The read is live (200, none open), and the hold is tested with PayPal's documented shapes and every open status. A real open dispute could not be produced in the sandbox: PayPal refused the buyer-side create call, and a Resolution Center case opened by the buyer on a real payment never appeared in the Disputes API (it is a message thread, not yet a claim). Mandate holds a payout for disputes the API lists, and says so. Details in `docs/REFERENCE.md`. |
| **Webhooks** | Nudge a re-read, signature check | Code and tests are done. Needs a public URL (deploy) to prove end to end. |

Of the Agent Toolkit's 47 tools, Mandate uses nine, all server-side and never exposed to a model: `create_invoice`, `send_invoice`, `get_invoice`, `list_invoices`, `send_invoice_reminder`, `cancel_sent_invoice`, `list_transactions`, `list_disputes`, `get_dispute`. The toolkit has no payouts tool, so Payouts uses the REST API directly.

## 9. What it solved

| Problem | How Mandate answers it |
| --- | --- |
| An agent that holds the token can do anything | Nobody who asks holds it. Only the server does, and only for a locked cart. |
| A prompt is not a policy | The rules are versioned data and a pure function. A model cannot talk its way past them. |
| "Why did that money move?" | Every request, refusal, tap and PayPal id is in an append-only ledger, with a receipt per payment and per job. |
| A changed amount after approval | The lock is hashed and signed. Any difference is refused and PayPal is not asked. |
| Paying a contractor from money you do not have yet | A payout must cite settled client money on the same job, within the share. |
| Software called "paid" too early | Pending, unclaimed and failed states are real and never counted as paid. Settlement is confirmed by re-reading PayPal. |
| A fooled agent | Six MCP tools, none can pay. A fake vendor or an injected instruction gets a rule code. 42 red-team cases assume the model is fully compromised and check that PayPal is never asked. |
| The owner becomes an approval button | A standing rule: say yes to a kind of payout once. Matching payouts need no tap, and everything else still does. |
| Giving an agent PayPal's tools | All 47 Agent Toolkit tools are tiered. An agent reaches none; the server runs nine, and refuses the rest. |
| Two companies agreeing on a price through agents | A deal check against both sides' private limits, and a signed agreement that billing must follow. |
| Money moving outside the system | Transaction reconciliation flags PayPal activity that Mandate did not create. |
| A payout funded by money that can be taken back | An open client dispute holds it. |
| "It is safe, but I still have to do everything" | Autopilot runs the chain under signed rules, and Today shows only the exceptions. |
| "How do I know nothing slipped through?" | Proof: the server re-verifies every lock, every yes, every amount, on demand. |
| Writing rules is hard to do safely | Say it in words: a model drafts it, code lists what it loosens, you publish. |

## 10. Proof

- **247 API tests** (Vitest; 56 are the red team) and **46 end-to-end tests** (Playwright, desktop and phone, with an axe WCAG 2.1 AA scan). Lighthouse 99 / 100 / 100 on mobile.
- The agents are evaluated against the real model (`npm run eval:agents`, 14 cases plus a negotiation) and compared on four models. No miss on any model moved money.
- **The whole frozen job has run on the real PayPal sandbox:** agents negotiated and signed $300; Northwind paid a real $150 invoice; the lock verified; a real $90 payout reached Priya's sandbox account (`SUCCESS`, $0.25 fee); the job reads $150 in, $90 out, $60 kept; and cancelling an unclaimed payout returned the money.

## 11. Honest limits

- **Sandbox only.** No real money.
- **Not deployed yet.** There is no public URL, so the webhook is not registered and the checkout return URL is only proven locally.
- **Fake-tested, not live:** refunds, a dispute that PayPal's API lists as open (a first-stage Resolution Center case is not listed, so Mandate cannot see it), and signed webhook deliveries.
- **Standing rules were run live only in part:** the real Payouts call and the dispute read ran against PayPal, with a simulated client payment. A full run (real invoice paid, then a standing-rule payout to a real account) has not been done yet.
- **PayPal's transaction report lags** by a few hours, so the newest payments can show as unmatched for a while.
- **Model dependence:** the agents use a hosted `gpt-oss:20b`. Two larger models could not be measured because Ollama's free plan does not include them. Everything except the agents works without a model.
- **Single-process SQLite.** Right for one owner; a hosted multi-tenant version would move to Postgres (a driver change, not a redesign).

## 12. What is next

1. Deploy to Render (public HTTPS), register the webhook and set `PAYPAL_WEBHOOK_ID`.
2. Prove a real refund on the sandbox, and run the full standing-rule payout to Priya's real account. A formal dispute can only be seen once PayPal escalates a case to a claim.
3. A public Postman workspace, and a read-only AG Grid agent query ("show me what the rules refused").
4. The pitch: demo video, a short deck, and the Devpost write-up.
5. One complete live run of autopilot. The billing and reminder steps and the auto payout have each run on the real sandbox, and the full chain runs in the browser and in tests against the fake PayPal, but a real auto-billed invoice paid by the sandbox buyer and then followed by the auto payout has not yet been done in one go.

Deliberately cut: passkeys, a multi-round human negotiation UI, a 90-day backtest.

## 13. Where to look

| You want | Open |
| --- | --- |
| To run it | [README.md](README.md) |
| Every screen, rule, route and rule code | [docs/REFERENCE.md](docs/REFERENCE.md) |
| To call the API | [api/README.md](api/README.md), `api/postman/` |
| The console | [web/README.md](web/README.md) |
| The pitch | `pitch/` |
| How Mandate relates to Google's AP2 | [docs/REFERENCE.md](docs/REFERENCE.md#how-mandate-relates-to-ap2) |
| The history of the early sandbox runs | [KT.md](KT.md) (early-build history; this file is current) |

> **AI can act on your money without owning your money.**
