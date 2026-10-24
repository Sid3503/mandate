# S8 A settled short payment is a settlement

Status: built and green. 23 hygiene checks, typecheck clean, 64 files, 735 tests, secret check 416 tracked files, 20 of 20 guarantees, `npm run build` clean.

## Why this pass exists

S1 recorded what PayPal says arrived, but nothing read it. A charge paid for less than the lock stayed `invoice_sent`, so:

- the chip on screen said "Invoice sent · waiting for the client" while the client had already paid;
- `GET /v1/jobs/{job}` read `totals.inCents` as 0, because the totals counted `captured_amount_cents` on rows whose phase was `captured`;
- the money that arrived could fund nothing and refund nothing, because both flows key on `capture_id` and only `markCaptured` ever set it.

That is a receipt with a number on it that no field explains. S8 is the pass that turns the stored delta into a phase and makes every reader agree with it.

## Why it could not be smaller

`amounts.match` (`audit.ts:171`) is on screen as "Settled to the cent". It fails when `captured_amount_cents !== amount_cents` on a `captured` or `refunded` row. So a short settlement cannot be `captured` without breaking that guarantee, and it cannot stay `invoice_sent` without the product lying. It needs its own phase, and a fourth phase value in about forty hand-written comparisons is exactly how a product like this ends up with one screen that disagrees with the ledger. So the pass does two things together: it adds the phase, and it routes every question about it through named predicates.

## The four decisions, and why

**1. The phase is called `settled_short`, not `part_paid`.**

The plan's working name was "short-settled". `settled_short` keeps the product's central word and pairs with the field that already carries the fact (`settled_cents`) and with the predicate that reads it. `part_paid` reads well alone but collides with `amounts.match`'s promise, because it invites the question "part-paid by whom, and is the rest coming?" that only the invoice status answers. The phase says what PayPal has done; `invoice_status` says whether more can still arrive.

**2. A gap nothing arrived for is never a settlement.**

`settlementReason` (`mandate.ts:139-142`) returns `unexplained` exactly when `settledCents` is 0. An invoice PayPal calls `PAID` but reports no money for has no payment id, so there is nothing to store as the capture id, nothing to refund against, and nothing to fund from. Those rows keep their old behaviour: the delta is recorded, the phase stays `invoice_sent`, and the row keeps refusing to settle. Only a real payment moves the phase.

**3. The new phase is not terminal.**

A short settlement leaves the invoice open at PayPal. `openInvoices` (`repo.ts`) now watches `settled_short` and `refreshInvoice` (`mandate.ts`) accepts it, so the once-a-minute sweep still sees a later payment that completes the lock. `POST /v1/proposals/{id}/capture` on a `settled_short` row re-reads PayPal instead of short-circuiting, and leaves the phase alone, which is what stops a read that learns nothing new from appending an event (S4's property, preserved). Once money has arrived the row also leaves the chaser: `invoicesOut` and `liveInvoice` (`remind`, `cancel`) stay `invoice_sent` only, because reminding a client who has already paid part of an invoice is a collections decision for the owner, and cancelling would erase the settlement.

**4. The auto-payout still waits for the lock in full.**

`afterMoney` already returned unless the charge was `captured` with a capture id (`mandate.ts:967`). That is now written down as `fullPhase(charge.phase)` and kept. A part payment leaves the contractor's share for the owner to ask for: the gate admits it (a `settled_short` charge is fundable, capped by what arrived) but the standing rule does not fire by itself, because paying a share out of money that has not all arrived is a decision, not a standing rule. The same reasoning covers refunds: a `settled_short` charge can be refunded, capped by what arrived rather than by the lock.

## The shared vocabulary

`api/src/domain/phases.ts` is new and holds the phase lists and the three predicates, plus `arrivedCents(row)`, the one accessor for "what did PayPal actually put in":

- `fullPhase(phase)`: the lock was paid in full. `captured` alone.
- `fundedPhase(phase)`: money arrived and is still with the studio, so a payout may cite it and a refund may reverse it. `captured`, `settled_short`.
- `paidPhase(phase)`: money moved for this request. `captured`, `settled_short`, `refunded`.
- `arrivedCents(row)`: `settled_cents ?? captured_amount_cents ?? 0`. Both settlement paths write `settled_cents`; a payout records its paid amount in `captured_amount_cents` and never settles through an invoice.

`RESERVED_PHASES`, `OPEN_PHASES` and `DEAD_PHASES` moved there from `repo.ts`, which re-exports the first two.

## Deviation from the plan: `RESERVED_PHASES` is unchanged

The plan listed `RESERVED_PHASES` (`repo.ts:165`) as a site to route. It is the set of phases in which a *payout's* money is spoken for, and it is only ever applied to `kind = 'payment'` rows (`repo.ts` reservations, `heldPayoutCents`, and the standing check in `audit.ts`). No payout produced by this code becomes `settled_short`, so adding it would be vocabulary with no producer. It is left as it is, and `settled_short` is deliberately absent from it.

## Files

Change:
- `api/src/db/repo.ts`: `settleShort`, `openInvoices` and `settledProposals` read the shared lists.
- `api/src/services/mandate.ts`: produce the phase, restore the re-read path, `arrivedCents` in the job totals, `fundingState`, the packet, funding candidates and the "why can't I fund this" copy.
- `api/src/services/audit.ts`: `jobs`, `history.complete`, `MOVED`, funding admission and the fundable ceiling.
- `api/src/domain/gate.ts`: refund parenting and funding admission.
- `api/src/mcp/server.ts`, `api/src/services/shares.ts`, `api/src/services/today.ts`, `api/src/agents/guard.ts`, `api/src/agents/service.ts`.
- `web/src/lib/words.ts` (label and the three predicates), `jobTrack.ts`, `control-room/rows.ts`, `Receipt.tsx`, `Ledger.tsx`, `Jobs.tsx`, `NewRequest.tsx`, `Today.tsx`.

Add:
- `api/src/domain/phases.ts`, `api/test/settlement-delta.test.ts`.

## Test, as built

`api/test/settlement-delta.test.ts`, 6 tests:

1. A short settlement moves the row to `settled_short`, keeps the invoice payment's id as the capture id, and the job totals count the 5,000 that arrived with `fundableCents` 3,000 (60% of what arrived, not of the lock).
2. The packet does not claim the cents matched (`match: false`) while the view carries the delta.
3. A payout citing it is admitted up to 3,000 and refused `funding.exceeds` at 3,001.
4. A refund citing it is admitted up to 5,000 and refused `refund.exceeds` at 5,001.
5. The audit is green: `payouts.funded`, `jobs.in_covers_out`, `history.complete` and `amounts.match` all pass with a short-settled charge and a payout against it.
6. No raw `'captured'` comparison exists outside `domain/phases.ts` without a `phase-compare-ok` reason on or above the line.

Two existing assertions changed to the new truth (`settlement.test.ts`, `invoices.test.ts`): the phase is `settled_short` and `totals.inCents` is 5,000 rather than 0. The S4 churn test (`invoices.test.ts`, one `invoice.partial` however many times the sweep runs) still passes unchanged, which is the strongest signal that the re-read path preserved its property.

## What it cost

- The completeness test bans a literal, so the two places that genuinely need one (`amounts.match`, and the client share link's "paid" state) carry a written reason. Both are deliberate.
- The share links stay strict on purpose: a client's own invoice reads "due" for a part payment (which is what they still owe) and a contractor's "has the client's money arrived" line only reports a full settlement. `ShareView` has no state for "partly", and saying "received" would overstate. The shortfall is shown where there is room to explain it: the receipt, the job screen and the ledger.

## Risks

1. A `settled_short` row can no longer be reminded or cancelled from the UI. That is the intended boundary (above), but it is a behaviour a user could notice. It is visible: the panel says the invoice is part paid and offers only "Check PayPal".
2. `settleShort` writes `capture_id` with `COALESCE`, so a later sweep cannot overwrite a real capture id with a null. The uniqueness index on `capture_id` is satisfied because the id comes from PayPal and is unique per payment.
3. The short path is still narrow in production: `invoices.ts` sends `allow_partial_payment: false`, so the server's own invoice cannot be paid short. The phase is reachable through PayPal quirks and manual mark-as-paid, and it becomes the common case only once partial payment or discounts are enabled, which is S2, S3 and S6.

## Rollback

Revert the commit. `settled_short` is a string in an untyped column and `phase` is a free string in the OpenAPI schema, so no migration is involved; rows already written as `settled_short` would need one `UPDATE` back to `invoice_sent` or they would render with the phase name as their label.
