# Mandate — knowledge transfer

Handoff for the warrant server and the sandbox runs behind it. The product story is in [README.md](README.md). How to call the API is in [api/README.md](api/README.md).

## What this repo is

A company writes a warrant once. People and tools may propose a contractor payment. The server decides `DENY`, `AUTO`, or `NEEDS_APPROVAL`. Capture is a server route. It sends PayPal only the locked cart. The model, when it exists, gets two tools: `propose_payment` and `list_ledger`. It never gets the PayPal secret, and capture is not a tool.

The first customer shape is Line Studio, Bengaluru. The owner holds the PayPal account. A producer can ask. Priya Shah is the only seeded payee. Dollars land in the studio's US business. Priya is recorded on the warrant, not sent to PayPal as the receiver.

There is no UI and no model client in the repo yet. `api/` is the product core.

## Repo map

| Path | What it is |
| --- | --- |
| `api/src/domain/schemas.ts` | Warrant, proposal, and the seeded Line Studio warrant. |
| `api/src/domain/gate.ts` | `decide()`. Pure. No PayPal, no database. |
| `api/src/domain/hash.ts` | Cart hash and the stable PayPal request id. |
| `api/src/domain/money.ts` | Integer cents in, PayPal decimal strings out. |
| `api/src/domain/period.ts` | Month window in the warrant timezone (`Asia/Kolkata`). |
| `api/src/services/mandate.ts` | Propose, approve, reject, capture, refund, packet. |
| `api/src/paypal/client.ts` | Orders v2 and the refund call. OAuth client-credentials. |
| `api/src/db/` | SQLite schema, seed, and the single-writer transaction. |
| `api/src/app.ts` | HTTP routes, auth, idempotency. |
| `api/test/` | Gate cases and API cases against an in-memory database and a fake PayPal. |
| `api/postman/` | Collection and local environment. No PayPal secrets in those files. |
| `.env` | Gitignored. PayPal sandbox credentials. Never print it and never commit it. |

`npm run dev` does **not** load `.env`. Start the live server from `api/` with:

```bash
node --env-file=../.env ./node_modules/tsx/dist/cli.mjs src/main.ts
```

Listens on `127.0.0.1:8787`. Development API key, when `API_KEY` is unset: `dev-mandate-key-change-me`. Production refuses that key and any key shorter than 16 characters. `GET /ready` stays up when PayPal credentials are missing. The PayPal check is a warning. Readiness fails only when SQLite cannot be read.

The live database file is `api/data/mandate.sqlite` (gitignored). Tests use `:memory:`.

## Seeded warrant

`wnt_line_studio`, version 1, timezone `Asia/Kolkata`, currency USD.

| Rule | Value |
| --- | --- |
| Auto-settle | Strictly under 2000 cents ($20). |
| Monthly cap | 6000 cents ($60). Payments only. |
| Per-payment ceiling | 50000 cents. This may be higher than the monthly cap. It is a typo guard. |
| Evidence | Required. `https` URL. No user or password in the URL. |
| Payee | `payee_priya`, display name Priya Shah, email `priya.shah@example.com`, aliases `Priya` and `priya`. |
| Categories | `design`, `production`. |

`PUT /v1/warrant` writes the next version. Proposals keep `warrantVersion` from the moment they were decided.

## Gate order

`decide()` in `api/src/domain/gate.ts` checks, in this order: positive integer cents, payee on the warrant, category, currency, refund parent (same payee, captured, remaining cents), https evidence, per-payment ceiling, monthly cap, then `AUTO` or `NEEDS_APPROVAL`.

A denial is HTTP 201 with `gate: "DENY"` and `orderId: null`. The row is the proof that the agent is not the authorization layer.

Reservations that count toward the monthly cap are payment proposals in phase `locked`, `order_created`, `capture_inflight`, or `captured`, using `reserved_at` inside the Kolkata month. Refunded cents are subtracted. `denied`, `rejected`, `pending_approval`, and `capture_refused` do not reserve. `AUTO` locks and reserves immediately. `NEEDS_APPROVAL` reserves on approve. Approve re-checks the cap. If the cap was consumed in between, the approval is stored as blocked and the response is 409. The event still commits.

## Capture

1. The proposal must be `locked`, or already `order_created` so a buyer-pending retry can continue.
2. A body field `claimedAmountCents` that differs from the lock returns 409 `cart.immutable` and does not call PayPal. The phase stays `locked`.
3. If there is no order yet, the server creates an Orders v2 order with `intent: CAPTURE`, `custom_id` and `invoice_id` set to the proposal id, and the locked cents. `PayPal-Request-Id` is a stable UUID derived from `proposalId:create` (capture and refund have their own). A retry does not open a second order.
4. The server reads the live order. Amount, currency, or `custom_id` mismatch sets `capture_refused` and does not capture.
5. Buyer status other than approved returns 409 `paypal.buyer_pending` with `approveUrl`. Phase goes back to `order_created`.
6. Capture uses `proposalId:capture` as the request id. Success stores `captureId` and `capturedAmountCents`.
7. A PayPal error during the in-flight window returns 502 `paypal.upstream`. `detail` is PayPal's error **name** (`UNPROCESSABLE_ENTITY`), plus `debugId`. The issue string (`INSTRUMENT_DECLINED` and similar) is not copied into the response. Phase returns to the resume phase so a later capture can try again. The in-flight lock is 30 seconds.

Refunds do not create an order. They `POST /v2/payments/captures/{id}/refund` for the locked cents, after the same gate.

The clerk is not built. Today a human sends `POST /v1/proposals` with an `Idempotency-Key`. Same key and same body replay the first response. Same key and a different body is 422. A key still in flight is 409.

## PayPal sandbox

Accounts on the developer dashboard used for these runs. Passwords live in the dashboard and in `.env`. They are not written here.

| Account | Role |
| --- | --- |
| `sb-hvfur53113943@business.example.com` | US business. Owns the app credentials in `.env`. PayPal sets this as the receiver when the order has no payee email. |
| `sb-jxwz553178202@personal.example.com` | India personal. John Doe, Mumbai. This is the buyer in the product story. |
| `sb-rgmi053183971@personal.example.com` | US personal. San Jose. Used once while the India checkout was blocked. |
| `sb-n478nl53174057@business.example.com` | India business, marked default in the dashboard. Not the receiver of these orders. |

The India wallet's stock Visa ends in 1883. PayPal's checkout will say it is not enabled for international payments when the **receiver** is wrong. Generated test cards were also rejected by that link-card form. Do not keep pasting card numbers into it.

### Receiver rule

`priya.shah@example.com` is not a PayPal account. Create still accepted an order with that address as `purchase_units[0].payee.email_address`. Checkout then demanded an international-enabled card, and capture returned `INSTRUMENT_DECLINED` while the order stayed `APPROVED`. Retrying capture cannot fix a declined instrument. The buyer has to fund a **new** order.

`mandate.ts` now passes `payeeEmail: null` on create. The contractor stays on the warrant and on the packet. PayPal pays the app's merchant. `order.created` records `payeeAttached: false`. The client still retries once without a payee if PayPal returns 422 and the error text mentions payee. That retry did not save the bad order, because create had already succeeded with the fake email.

Checkout has no return URL, so after a successful approval the browser can remain on **Pay with**. The order is still approved. Capture from the API is what moves the money.

## Live rows in `api/data/mandate.sqlite`

These exist only in that local file.

| Proposal | Phase | What happened |
| --- | --- | --- |
| `94869f50-2b2f-4650-aab8-46e5aba74912` | `denied` | A $25 denial. No order. Does not reserve cap. |
| `f4bd8fdf-343d-41c9-83a1-f21748bab980` | `capture_refused` | Priya $25. Approve locked the cart. A $40 `claimedAmountCents` returned 409 and left the lock at 2500. Order `93C08793GB3750533` was created **with** Priya's email as payee. India buyer approved. Capture returned 502. The phase was set to `capture_refused` by hand so the dead order stopped holding $25 of the monthly cap. The API's own 502 path had left it `order_created`. |
| `076328a6-f7f8-447a-bf04-f3f2eb74ef57` | `captured` | Order `4XJ37793MB337931H`, capture `8SC68460EW2924617`, 2500 cents. US personal buyer. Receiver is the US business. |
| `e2430dc6-2ef1-4eda-9729-ca7dc02f9080` | `captured` | Order `6C811134271727847`, capture `64R136545B749934W`, 2500 cents. India buyer `sb-jxwz553178202@personal.example.com`. Receiver is the US business. This is the payment that matches the product story. Packet `amounts.match` is true. |

October in `Asia/Kolkata` already has two captured $25 payments. The cap is $60, so another $25 this month is denied with `cap.monthly` unless one of those reservations is refunded or the month rolls.

## Errors worth recognizing

| Response | Meaning |
| --- | --- |
| 201 `gate: DENY` | The warrant refused. The row is the result. |
| 409 `cart.immutable` | Client amount or live PayPal order does not match the lock. |
| 409 `paypal.buyer_pending` | Order exists. The buyer has not finished approval. Open `approveUrl`, then capture again. |
| 409 `cap.monthly` | This proposal would pass the month. The detail cites reserved cents and prior capture ids. |
| 502 `paypal.upstream` | PayPal rejected the call. `detail` is only the PayPal error name. Use `debugId` in the PayPal dashboard. |
| 401 | Bearer key missing or wrong. A 502 means the key was accepted. |

## Decisions that stay

- The warrant is Zod data. The gate is a pure function. A prompt is not the policy.
- Capture is a route. It is not a model tool.
- One process, one SQLite file, `BEGIN IMMEDIATE`. Postgres later is a driver change, not a new design.
- Money is integer cents.
- Two consents: the owner's tap, and the PayPal buyer's approval. `AUTO` skips the in-app tap. It still needs the PayPal payer window.
- The contractor on the warrant and the PayPal receiver are different. The receiver is the business that owns the app until a payee has a real PayPal account.

## Still to build

The product that is not in the repo yet:

1. The clerk. One model, `propose_payment` and `list_ledger`. Tool result is the clause. Warrant, month reserved cents, and any open cart are loaded into the turn from SQLite. The message id is the idempotency key.
2. Owner surfaces: edit the warrant, tap a card that shows the five locked fields and the hash, open the packet, read a denial as a normal outcome.
3. PayPal lifecycle still open on this server: return and cancel URLs, a webhook so a capture is recorded when the browser never returns, the seller breakdown stored on the packet, and one real refund through the gated refund proposal.
4. A person can file the same `POST /v1/proposals` the clerk files.

The six acceptance cases are already the gate's tests: lunch denied with no order, Priya at $25 tapped and captured at the locked cents, a $40 retry refused, an unknown payee denied under $20, a third invoice denied by the monthly cap, and a refund gated again.
