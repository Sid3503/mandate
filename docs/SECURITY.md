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
- Step-up runs only when `REQUIRE_PASSKEY_FOR_MONEY` is on, and only on approve and on publishing rules. Other owner actions stay on the key.
- A passkey prompt does not show the payment. The screen shows the amount, payee, category, and evidence before the prompt. The prompt itself does not.
- Demo and studio workspaces use a fake PayPal. The banner says so. They are not a live sandbox payment.
- A stolen server can still lie. A receipt that a person can check reduces that risk. It does not remove it.
- The admin key compare is a hash compare. Ops routes stay 404 until `ADMIN_KEY` is set.
- Demo data is a file under the database directory with an expiry on the workspace row (24 hours unless `DEMO_TTL_HOURS` says otherwise). Logs are the process logs. Auth events sit in the control database until that file is removed. Nothing here is a long-term archive.

## What the flags add

Workspaces, passkeys, cookie sessions, step-up on money, invites, the payee book, and the model kill switch are in the server. Their flags default to off, except the model, which stays on, and the legacy owner key, which stays on for the default studio.
