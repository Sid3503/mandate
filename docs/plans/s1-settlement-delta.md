# S1 Settlement delta: record what arrived, and why

Status: built and green. Proof: `api/test/settlement.test.ts` (6 tests). `npm run gates:fast` exit 0, 62 files, 721 tests, 23 hygiene checks, secret check clean at 411 tracked files.

## The problem, in one line

A client can pay less than the locked amount, and the product has nowhere to put the fact.

## What this pass changes

When PayPal reports a payment that is short, `applyLiveInvoice` writes an `invoice.partial` event and returns (`mandate.ts:901-903`). The row keeps `captured_amount_cents = null`, the phase stays `invoice_sent`, and `jobs/{JOB}.totals.inCents` reads 0 (`invoices.test.ts:69`). Nothing on the row says an amount arrived, or what it was, or why it was short.

1. Add three columns to `proposals`: `settled_cents`, `delta_cents`, `delta_reason`.
2. Write them on every settlement path: full and short.
3. Expose them on the proposal view and in OpenAPI.

No phase changes here. S8 owns the phase. `amounts.match` (`audit.ts:172`) iterates `captured` and `refunded` only, so a `settled_cents` value on a row that is still `invoice_sent` cannot affect it.

## Recon, already checked

- `applyLiveInvoice` at `mandate.ts:873-906`. Full settle at `:880-888` calls `markCaptured` and returns. The short and not-through-PayPal case falls to `:889-904`.
- `markCaptured` at `repo.ts:975` sets `phase`, `capture_id`, `captured_amount_cents`.
- `markCaptured` has two call sites: the order path at `mandate.ts:551` and the invoice path at `mandate.ts:883`.
- `toView` at `mandate.ts:80` and the `ProposalView` type at `mandate.ts:54-78`.
- `ProposalRow` at `repo.ts:15-58`, `PROPOSAL_COLUMNS` at `repo.ts:235`.
- The migration pattern at `database.ts:269-276`: `SCHEMA` first, then `PRAGMA table_info` and `ALTER TABLE` per missing column.
- `LiveInvoice` at `invoices.ts:18-31` already carries `status`, `paidCents`, `totalCents`, `currency`.
- `parseInvoice` at `invoices.ts:116-136` reads `payments.transactions[]` and already returns `paidCents`.
- `openInvoices` at `repo.ts:610` sweeps `phase IN ('invoice_draft','invoice_sent')`, ordered by `updated_at LIMIT 20`. A short invoice stays `invoice_sent`, so it is swept again and the reason is re-derived. That is why S3 can upgrade rows S1 already wrote.
- Existing assertions on the proposal body use `toMatchObject` (35 matches), so three added fields do not break them. The one full-shape fixture is `control-room.test.ts:10`, a partial row builder.
- `web/src/control-room/rows.ts:54` already computes a local `settledCents`. The name matches what this pass stores.

## The reason codes

A closed list. Code reads them, never a model.

| Code | Means | Filled by |
|---|---|---|
| `full` | settled equals the lock, `delta_cents` is 0 | S1 |
| `partial` | PayPal status `PARTIALLY_PAID`, nothing else explains the gap | S1 |
| `unexplained` | paid, short, and no field explains it | S1 |
| `early_discount` | an early-payment discount applied | S3 |
| `credit_note` | a credit note or a line discount | S3 |
| `paypal_fee` | a PayPal fee reduced the net | S3 |

S1 ships the first three. `unexplained` is honest: it means the code that exists today cannot explain the gap. S3 adds the three remaining codes. Because the reason is re-derived on each sweep, rows S1 wrote are upgraded without a data fix.

`unexplained` still refuses to settle, the same way `amounts.match` refuses a mismatch. A number with no attribution is not a fact.

## Files

Change:
- `api/src/db/database.ts`: three columns in `SCHEMA`, three `ALTER TABLE` lines in `migrate`.
- `api/src/db/repo.ts`: three fields on `ProposalRow`, three names in `PROPOSAL_COLUMNS`, a new `recordSettlement`, and `markCaptured` also writing the full case.
- `api/src/services/mandate.ts`: three fields on `ProposalView` and `toView`, plus the call in `applyLiveInvoice`.
- `api/src/openapi.ts`: three fields on the `Proposal` schema.
- `web/openapi.json` and `web/src/lib/openapi.d.ts`: regenerated with `npm --prefix web run gen:types`.
- `docs/CHANGELOG.md`, `docs/REFERENCE.md`, `docs/ZORD_PASS.md`: in the same task.

Add:
- `api/test/settlement.test.ts`.

## Task order

### S1.T1: schema and storage, test first

Test first in `api/test/settlement.test.ts`, using the fake invoice port the way `invoices.test.ts:61` does:

1. Pay 5,000 of a 15,000 invoice. Expect `settledCents: 5000`, `deltaCents: -10000`, `deltaReason: 'partial'`. Expect the phase to stay `invoice_sent` and `capturedAmountCents` to stay null.
2. Pay the full 15,000. Expect `settledCents: 15000`, `deltaCents: 0`, `deltaReason: 'full'`.
3. Abuse: sweep twice. The numbers do not change and `updatedAt` does not move on the second sweep.

Then the migration, the `ProposalRow` fields, `PROPOSAL_COLUMNS`, `recordSettlement`, `markCaptured`, and the `applyLiveInvoice` call.

`recordSettlement` writes only when a value differs, so a repeated sweep is a no-op. That matters because `openInvoices` orders by `updated_at LIMIT 20`; moving a stuck invoice's `updated_at` every sweep would rotate it to the back of that queue.

### S1.T2: exposure and docs

`ProposalView`, `toView`, the OpenAPI schema, `gen:types`, CHANGELOG, REFERENCE, and the S1 box in `docs/ZORD_PASS.md`.

## Gates

`npm run gates:fast` after each task: hygiene, typecheck, the API suite, the secret check.

## Risks

1. `updated_at` churn in the sweep queue. Mitigated by writing only on change.
2. A short invoice that is later paid in full must move to `full`. `applyLiveInvoice` re-derives on each sweep and `recordSettlement` overwrites, so it does.
3. `markCaptured` is also on the order path. Writing `full` there is correct for a checkout capture too, but it is a second call site, so the test must cover it.

## Rollback

Three nullable columns and one method. Revert the task commit. No data to undo: the columns are new and nullable.

## Out of this pass

- The phase change (S8). A short invoice still reads `invoice_sent` after this pass. S1 stores the truth; it does not yet change the chip.
- The repeated `invoice.partial` event (S4).
- Reading the discount and fee fields (S3). S1 ships the code set and the three codes it can compute today.
- The job totals (`jobs/{JOB}.totals.inCents`). That reads events, and S2 owns it.
- The refund and payout paths. They reuse `captured_amount_cents`; leaving them alone is the smallest change.
