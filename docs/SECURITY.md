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

- A pasted key is not a passkey. A login session is not a payment approval. Passkey step-up is not built yet.
- There is one studio database. Workspace isolation is not built yet.
- A passkey prompt, when it exists, will not show the payment. The screen must show the amount, payee, category, evidence, and a short hash before the prompt.
- A stolen server can still lie. A receipt that a person can check reduces that risk. It does not remove it.

## Planned controls

Workspaces, passkeys, cookie sessions, step-up on money, invites, and an emergency brake are in `docs/MASTER_PLAN.md`. Their flags default to off.
