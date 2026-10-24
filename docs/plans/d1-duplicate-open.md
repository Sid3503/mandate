# D1 to D3 Duplicate open asks

Status: built and green. 23 hygiene checks, typecheck clean, 63 files, 729 tests, secret check 414 tracked files, 20/20 guarantees.

## Why this and not S8

S8 (the short-settled phase) is the item that makes the settlement delta visible, and it is the largest
by blast radius. Recon for it found two facts that change the order of work:

1. `invoices.ts:69` sends `allow_partial_payment: false`, and `settleInvoice` sends no discount. So the
   server's own invoice can never be paid short. A short settlement is today only reachable when PayPal
   reports something the server did not ask for.
2. `amounts.match` (`audit.ts:164-172`) fails when `captured_amount_cents !== amount_cents` on a
   `captured` or `refunded` row. So a short settlement cannot be stored as `captured` without breaking
   the "Settled to the cent" guarantee on screen. It needs its own phase, and that phase needs every one
   of about forty "did this settle?" call sites routed through one predicate.

That makes the settlement feature an all or nothing slice rooted at S8, not a series of small wins. D1 to D3
is a separate, complete, visible improvement that touches none of it: the product stops you asking for the
same money twice while the first ask is still live. It is the double-pay guard, which is the most expensive
mistake a spend-authority product can make.

## What this pass changes

A second ask for the same money, on the same job, in the same currency, while the first is still open, is
refused with `duplicate.open` and the detail names both proposal ids. A DENY, not a tap, because the product
already refuses the native version of this: `deal.milestone_billed` is a DENY (`gate.ts:192`).

## Recon, already checked

- `proposeNew` at `mandate.ts:1244-1308`. It calls `this.judge(...)` (`:1248`) and then `insertProposal` (`:1270`).
- Every propose runs inside one transaction: `runIdempotent` at `idempotency.ts:11-27` wraps `fn` in `repo.transaction`.
  `proposeNew` is its `fn` (`mandate.ts:281`). So a lookup inside `judge` is inside the same transaction as the
  insert, which is what D3 asks for, by construction rather than by an extra lock.
- The gate is pure and takes plain data (`I2`). The precedent for a state fact is `DealContext` (`gate.ts:73-82`):
  `milestoneBilled`, `jobHasDeal` and `accepted` are booleans the service resolves from the database and hands in.
  A duplicate is the same shape of fact.
- `openProposals` at `repo.ts:645-652` already defines what "open" means for this product: `pending_approval`,
  `locked`, `order_created`, `capture_inflight`, `invoice_draft`, `invoice_sent`, `payout_sent`, `payout_unclaimed`.
- Dead phases are `denied`, `rejected`, `capture_refused`, `invoice_cancelled` (`repo.ts:167`). None of them is in the
  open list, so a refused or cancelled ask never blocks a fresh one.
- `clause` is a free string in the OpenAPI `Proposal` schema, so a new clause needs no schema change. The clause
  tables are `docs/REFERENCE.md:905-932` and the UI labels are `web/src/lib/words.ts`.
- No test asserts a clause list, so adding one cannot weaken a test.

## The two deviations from the doc, and why

**1. The key is scoped tighter than `jobId + payeeId + amountCents + currency`.**

The doc's key would refuse a legitimate second ask. Milestone 0 and milestone 1 of the same deal are both
150,000 cents to the same client on the same job; if milestone 1 is billed while milestone 0 is still an open
invoice, the doc's key collides and the client can never be billed for milestone 1. Two 90,000 cent instalments
to Priya from two different client payments collide the same way.

So the key is the same **ask**, not the same amount: `kind`, `payeeId`, `amountCents`, `currency`, `jobId`,
`fundingCaptureId`, `dealId`, `milestone`, `parentCaptureId`, all null safe. That catches a double tap, an agent
retrying with a fresh idempotency key, and a repeated ask with a different description, and it does not catch two
different instalments or two milestones. For a charge with a deal, the deal's own `deal.milestone_billed` is the
more specific refusal and it still wins, because it is evaluated first (`gate.ts:192`).

**2. "Open" includes `capture_inflight` and `payout_unclaimed`, which the doc's list left out.**

Both are money in flight: a capture mid-flight and a payout PayPal has sent but nobody has claimed. A second
identical ask against either is the double-pay this check exists to stop. This is the same list the product
already uses to mean "not finished" (`openProposals`), so it is one definition, not a second one.

## Where the check sits in the gate

After the identity and validity checks and after the deal block (`gate.ts:196`), and before the payment funding
rule (`gate.ts:197`). The order matters: an open ask has already reserved the share (`funding.exceeds`) and the
month (`cap.monthly`), so a duplicate placed later would surface as a confusing arithmetic refusal instead of
"you already asked for this".

## Files

Change:
- `api/src/db/repo.ts`: export `OPEN_PHASES` and reuse it in `openProposals`; add `openDuplicate`.
- `api/src/domain/gate.ts`: `Clause.duplicateOpen`, `openDuplicate` on `GateProposal`, one deny branch.
- `api/src/services/mandate.ts`: resolve the lookup in `judge` and pass it.
- `web/src/lib/words.ts`: a clause label.
- `docs/REFERENCE.md`, `docs/CHANGELOG.md`, `docs/ZORD_PASS.md`.

Add:
- `api/test/duplicate-open.test.ts`.

## Test, as built

`api/test/duplicate-open.test.ts`, 7 tests:

1. Two identical asks while the first is open: the second is `DENY duplicate.open`, the detail names both ids, PayPal is
   not called, and exactly one of the two was let through.
2. The same ask with the note reworded is still a duplicate, and the first has been approved (`locked`) first, so the
   share is held and only the duplicate rule can explain it.
3. A repeat of a charge whose invoice is still out is refused, and no second invoice is created.
4. A dead ask does not block: a first ask refused for `category.missing` is `denied`, so an identical second ask is
   judged on its own merits.
5. Two different milestones of one deal are not duplicates (the first deviation above).
6. A different amount is not the same ask.
7. The same amount from a different client payment is not the same ask (the funding part of the key).

## What it cost

The guard refused seven existing fixtures. Every one of them was genuinely the same ask twice, and every one used that
as a fixture for a property that has nothing to do with duplicates. Each was rewritten to use a distinct ask so its real
property is still proven, not weakened:

| File | Fixture was proving | Now |
| --- | --- | --- |
| `api.test.ts` "refuses a second $90" | the funding share is used up | a repeat asserts `duplicate.open`; a *different* amount asserts `funding.exceeds` and "0 more cents" |
| `api.test.ts` "re-checks funding when Meera taps" | approve re-checks funding and returns 409 | the second ask is 5,000 cents instead of 9,000 |
| `mcp.test.ts` "ranks their job first" | a refused attempt does not mislead the ranking | the refused attempt is 1,000 cents |
| `safety.test.ts` pause and resume | a pause stops what would go without a tap | the four asks are four different amounts, all under the automatic line |
| `standing.test.ts` "insist the money came through a signed deal" | a rule republished without `requireDeal` covers the payout | the covered payout is 8,000 cents instead of 9,000 |
| `stepup.test.ts` "bound to one cart hash" | a step-up assertion for lock A does not approve B | the second charge is 14,000 cents |
| `redteam.test.ts` Case 10 | the same, as a red-team case | the second charge is 14,000 cents |

The two security tests are the ones worth being careful about. Their property is that a step-up assertion is bound to a
specific cart, and `CartFields` includes `proposalId` (`mandate.ts:1252`), so the two carts differ in hash whatever the
amounts are. Changing the amount does not weaken what they prove.

## Risks

1. A false refusal blocks a legitimate second ask. Mitigated by scoping the key to the same ask, and by the milestone,
   funding, deal and parent-capture fields. A DENY is terminal, so a wrong refusal is visible and needs a code change,
   not a retry. The owner is not stuck: a `pending_approval` or `locked` ask can be rejected (`POST
   /v1/proposals/{id}/reject`, which puts it in `rejected`, a dead phase), and the copy says so. Noted as the main cost
   of this design, and it is a real cost: seven fixtures in this repo reached for "ask the same thing twice" naturally.
2. `payee_id` is null for a request whose payee is not on the warrant. Two such asks share the null key, but those rows
   are `denied` and dead, so they never block.
3. The lookup adds one read per propose. The key columns are not indexed, so it is a small scan over open rows. Fine at
   this size; a real deployment would want an index on the open phases.
4. The refusal is a DENY, and `decide` (`gate.ts:289`) only lets the pause override a result that is not already a
   DENY. So a duplicate refused while Mandate is paused reports `duplicate.open`, not `system.paused`. That is the
   existing design for every hard rule, not a new exception.

## Rollback

Revert the commit. The check is one query, one field and one deny branch, and no row changes shape.
