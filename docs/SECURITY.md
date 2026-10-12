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
- Step-up runs when that workspace's `passkey_for_money` row is on, or when `REQUIRE_PASSKEY_FOR_MONEY` is on. A new studio starts on. The default studio and a demo start off. The env flag stays off. Turning the row on needs an enrolled passkey and a step-up. Today the check is on approve and on publishing rules.
- A passkey prompt does not show the payment. The screen shows the amount, payee, category, and evidence before the prompt. The prompt itself does not.
- Demo and studio workspaces use a fake PayPal. The banner says so. They are not a live sandbox payment.
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
- Demo data is a file under the database directory with an expiry on the workspace row (24 hours unless `DEMO_TTL_HOURS` says otherwise). Logs are the process logs. Auth events sit in the control database until that file is removed. Nothing here is a long-term archive.

## What the flags add

Workspaces, passkeys, cookie sessions, step-up on money, invites, the payee book, and the model kill switch are in the server. `POST /ops/model/resume` clears the kill with the admin key. It is 404 until `ADMIN_KEY` is set and 401 when the key is wrong. Their flags default to off, except the model, which stays on, and the legacy owner key, which stays on for the default studio.
