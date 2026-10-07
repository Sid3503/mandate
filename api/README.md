# Mandate API

The spending warrant in front of PayPal. An agent may propose a contractor payment. Capture is a server route, and it sends PayPal only the locked cart.

Money is integer cents. A denied proposal is still stored: HTTP 201, `gate: "DENY"`, `orderId: null`.

## Run

```bash
cd api
npm install
npm test
npm run dev
```

The dev server listens on `127.0.0.1:8787`. There are two keys:

| Key | Development default | Can |
| --- | --- | --- |
| Owner (`API_KEY`) | `dev-mandate-key-change-me` | Everything: propose, read, approve, reject, capture, publish the warrant. |
| Proposer (`PROPOSER_KEY`) | `dev-proposer-key-change-me` | Propose and read only. Approve, reject, capture and `PUT /v1/warrant` return 403 `auth.forbidden`. This is the key an agent gets. |

Production refuses to boot when `API_KEY` is unset or is the development key. It also refuses when `PROPOSER_KEY` is the development key or equals `API_KEY`. In production `PROPOSER_KEY` is optional; without it, only the owner key works.

The owner console (`web/`) is served at `/app/` when `web/dist` exists, or from `WEB_DIST`.

PayPal is optional for the gate. Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and optionally `PAYPAL_API` (default `https://api-m.sandbox.paypal.com`). Node can load the repo `.env` without printing it:

```bash
node --env-file=../.env ./node_modules/tsx/dist/cli.mjs src/main.ts
```

`GET /ready` stays up when those credentials are missing. The PayPal check is `warn`. It fails only when SQLite cannot be read.

## Postman

Import both files:

- `postman/Mandate.postman_collection.json`
- `postman/Mandate.local.postman_environment.json`

Or import `GET /openapi.json` (OpenAPI 3.1). The collection runs the $18 lunch denial, the fake-vendor denial, Priya's $90 approval, and the $250 refusal. Capture then returns the PayPal approve URL until the sandbox buyer approves, or `paypal.unconfigured` when no credentials are set.

## Contract

| Request | Auth | What it does |
| --- | --- | --- |
| `GET /health` | public | Liveness. `application/health+json`. No dependency checks. |
| `GET /ready` | public | Readiness. 503 when SQLite cannot be read. |
| `GET /openapi.json` | public | OpenAPI 3.1 |
| `GET /app/*` | public | The owner console. Strict CSP. Hashed assets are immutable; compressed with br or gzip. |
| `GET /v1/session` | bearer | Which key this is: `owner` or `proposer`. |
| `GET /v1/warrant` | bearer | Current warrant |
| `GET /v1/warrant/versions` | bearer | Every warrant version, newest first. |
| `PUT /v1/warrant` | owner | Next version. Open proposals keep the version they were decided against. |
| `POST /v1/proposals` | bearer | Run the gate. Requires `Idempotency-Key`. Does not capture. |
| `POST /v1/proposals/:id/approve` | owner | Lock the cart. Empty body. |
| `POST /v1/proposals/:id/reject` | owner | Drop a pending proposal. |
| `POST /v1/proposals/:id/capture` | owner | Create, check, and capture the PayPal order from the lock. |
| `GET /v1/proposals/:id/packet` | bearer | Prompt, clause, approval, hash, order id, capture id. |
| `GET /v1/jobs/:jobId` | bearer | Job receipt: money in, money out, what each capture can still fund. |
| `GET /v1/ledger` | bearer | Append-only events, cursor page. Each `proposal.created` event records `actor` as `owner` or `proposer`. |

Errors use `application/problem+json` (RFC 9457). The `code` field is the clause or the HTTP problem (`cart.immutable`, `cap.monthly`, `idempotency.mismatch`, `paypal.buyer_pending`).

`POST /v1/proposals` follows the Idempotency-Key rules: the same key and body replay the first response; the same key and a different body is 422; a key still in flight is 409.

Capture ignores any amount in the client body. `claimedAmountCents` is recorded and, when it differs from the lock, the route returns 409 and does not call PayPal. Before capture, the server also reads the live order and refuses when the PayPal amount, currency, or `custom_id` disagrees with the cart.

`PayPal-Request-Id` is a stable id derived from the proposal id and the operation, so a retry does not create a second order.

## Seeded warrant

Line Studio, `Asia/Kolkata`, USD. Priya Shah (`Priya`) is the only payee. Categories are `design` and `production`. Auto-settle is strictly under $20. $20 and above needs a tap. The monthly cap is $180 (two $90 milestone payouts). Evidence must be an `https` URL.

A refund is another proposal (`kind: "refund"`, `parentCaptureId`) and goes through the same gate and the same capture route. The route calls `POST /v2/payments/captures/{id}/refund` with the locked cents.

## Money in releases money out

Northwind (`client_northwind`) is a client on the warrant. The warrant sets `fundingRequired: true` and `contractorShareBps: 6000`.

- **Money in** is `kind: "charge"`. The payee is a client, and `jobId` is required (`job.missing` otherwise). It goes through the same gate and the same capture route: Orders v2, where the client is the buyer. Charges do not count against the contractor monthly cap.
- **Money out** is `kind: "payment"`. It must set `fundingCaptureId` to a **captured** charge. If `jobId` is left out, it is taken from that charge.
  - `funding.missing`: no capture is cited, or the cited charge has not been captured yet.
  - `funding.job_mismatch`: the charge belongs to another job.
  - `funding.exceeds`: the payout is more than 60% of the captured cents, minus refunds held on that charge and payouts already locked against it. For a $150 capture that is $90.
- **Rechecks.** Funding is checked again when Meera taps. It is checked a third time at capture: if the client payment was refunded in between, the payout is refused and PayPal is not called.
- **Lock.** The job and the funding capture are part of the lock (cart v2).
- **Job receipt.** `GET /v1/jobs/{jobId}` returns the charges, the payouts, the refunds, what each capture can still fund, and `totals` (`inCents`, `outCents`, `heldCents`, `keptCents`).

Contractor payouts are **never** settled through Orders. `POST /v1/proposals/:id/capture` on a locked payout sends one PayPal Payouts item with exactly the locked cents (`sender_batch_id` is derived from the lock hash), reads the batch back from PayPal, and checks the amount, currency and `sender_item_id` against the lock. It says `captured` (paid) only when PayPal reports `SUCCESS`. `PENDING` or `ONHOLD` stays `payout_sent`; `UNCLAIMED` (no PayPal account for the receiver) stays `payout_unclaimed` and is not counted as paid; `FAILED`, `BLOCKED`, `RETURNED`, `DENIED`, `REFUNDED` or `REVERSED` becomes `payout_failed` and frees the reservation. Capturing again re-reads the status. The proposal view and the packet carry `payoutBatchId`, `payoutItemId`, `payoutStatus`, `payoutTransactionId` and `payoutFeeCents`. A locked payout can be cancelled with `POST …/reject` until a batch is sent. `POST /v1/webhooks/paypal` (no credential) only names a batch; the server re-reads it from PayPal, so a forged call cannot change a status.

## Scale

One process, one SQLite file, one writer per proposal. The gate is a pure function. PayPal is the only network call, and only the capture route can make it. A later multi-studio deployment swaps SQLite for Postgres and keeps this schema: integer cents, append-only `events`, reservations counted inside the decision transaction.

## Deals, signatures, MCP, agents and invoices

The full description is in [docs/REFERENCE.md](../docs/REFERENCE.md#deals-signed-locks-the-agent-door-and-invoices). The short version for someone calling the API:

- `POST /v1/deals/offers` with `{ buyer, terms, as?, threadId?, prompt? }` and an `Idempotency-Key`. Agreed only if the terms fit both companies' rules. A client agent key (`BUYER_AGENT_KEY`) can call this and the read routes for its own client, nothing else.
- `GET /v1/proposals/:id/verify` and `GET /v1/deals/:id/verify` re-check a signature. `GET /.well-known/mandate-keys.json` publishes the public keys.
- A charge on a job with an agreed deal must send `dealId` and `milestone`, for exactly the agreed cents (`POST /v1/deals/:id/milestones/:n/bill` fills that in).
- `POST /mcp` is the agent door; `npm run mcp` serves it over stdio. Tools: `get_rules`, `get_jobs`, `propose`, `list_ledger`, `offer_deal`, `explain`. No tool can approve or pay.
- `POST /v1/clerk/messages` and `POST /v1/negotiations` need `BEDROCK_API_KEY` (or `OLLAMA_API_KEY`). `npm run eval:agents` tests them against the real model.
- Billing a client by invoice needs **Invoicing** enabled on the PayPal app; without it charges fall back to checkout and record `invoice.unavailable`.
- Copy `.env.example` for the variables.

New problem codes: `lock.signature_invalid`, `deal.wrong_side`, `deal.thread_closed`, `agents.unconfigured`, `agent.model_error`, `agent.timeout`, `budget.exceeded` (inside MCP tool results).
