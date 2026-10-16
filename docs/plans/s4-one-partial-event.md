# S4 One divergence, one event

Status: built. The smallest item in the pass, and it depends on nothing else in it.

## What this pass changes

`applyLiveInvoice` guards the `invoice.status` append with `if (live.status !== row.invoice_status)` (`mandate.ts:906-911`). It does not guard the `invoice.partial` append (`mandate.ts:920-925`). The server re-reads every invoice that is still `invoice_sent` once a minute (`repo.ts:610`), so an invoice that stays part-paid appends one `invoice.partial` per sweep, forever. The ledger is append-only (`I6`), so those rows cannot be removed; the fix is to stop writing them.

One divergence produces one event. A further payment is news, so it produces a second.

## Recon, already checked

- `applyLiveInvoice` at `mandate.ts:889-925`. The `invoice.status` guard is at `:906`; the `invoice.partial` append is at `:920-925`.
- `openInvoices` at `repo.ts:610` selects `phase IN ('invoice_draft','invoice_sent')`. A part-paid invoice stays `invoice_sent` (S1 did not change the phase), so it is swept every minute.
- `recordSettlement` at `repo.ts:994` already carries the exact guard needed: `WHERE ... AND (settled_cents IS NOT ? OR delta_reason IS NOT ?)`, and it writes only on change. Its `changes` count is the answer to "is this news?".
- Only one test reads the event: `invoices.test.ts:68`, `expect(events).toContain('invoice.partial')`, after a single sweep. No test counts events, so guarding the append cannot weaken one.
- `words.ts:69` labels the event for the UI. Guarding it changes how many rows exist, not what a row means.

## Approach

Do not invent a second guard condition. `recordSettlement` already decides whether what arrived is new, so make it say so:

- `recordSettlement` returns `boolean`, true when it changed the row.
- `applyLiveInvoice` appends `invoice.partial` only when that flag is true.

One source of truth for "is this news", in one place, and the event and the stored delta can never disagree.

## Files

Change:
- `api/src/db/repo.ts`: `recordSettlement` returns `boolean`.
- `api/src/services/mandate.ts`: append the event only on a change.
- `docs/CHANGELOG.md`, `docs/ZORD_PASS.md`: same task.

Add:
- a test in `api/test/invoices.test.ts`, the file the plan names as the proof.

## Test, first

In `api/test/invoices.test.ts`, the way `invoices.test.ts:61` already pays a short invoice:

1. Pay 5,000 of the 15,000 invoice, then sweep three times. Exactly one `invoice.partial`.
2. Pay 9,000 more. A second `invoice.partial`, because the cents moved.
3. In `api/test/settlement.test.ts`, at the row level: a change of reason alone writes and reports true, because S3 will make that reachable without the cents moving.

## Risks

1. A sweep that learns nothing also skips nothing else, so the event and the row stay in step. The write and the append are already inside one transaction.
2. The first sweep on a short invoice must still append. `settled_cents` starts null, so `NULL IS NOT 5000` is true and it does.
3. If `invoice.partial` were ever the only record of the money, suppressing it would lose a fact. It is not: S1 stores `settledCents` on the row, which is the durable record. The event is the history of changes.

## Rollback

Revert the commit. The change is a return value and one `if`.

## Out of this pass

- The short-settled phase (S8). The count of events is unrelated to which phase the row shows.
- The reason codes (S3).
