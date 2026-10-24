# S2, S3, S5, S6, S7 An unattributed shortfall is a number nobody can check

Status: built and green. 23 hygiene checks, typecheck clean, 65 files, 758 tests, secret check 422 tracked files, 21 of 21 guarantees, `npm run build` clean.

## Why this pass exists

S1 recorded what PayPal says arrived. S8 made a short settlement a real phase, so the money that arrived can fund a payout and be refunded. Neither pass answered the question the receipt now asks: **why is it short?**

Before this pass there were two codes, `partial` and `unexplained`, and `partial` was the only one a short settlement could carry. A row that settled for $142.50 of $150 said "short by $7.50" and nothing else. That is the product's own thesis failing on its own screen: **no unattributed number on a receipt**. A number with no field behind it is a number a person has to take on trust, and this product exists to remove exactly that.

S8's own plan doc records the gap honestly (`docs/plans/s8-settled-short.md`, risks 3): the short path was reachable in production only through PayPal quirks and manual mark-as-paid. This pass is what makes the explained path reachable, and it is also what makes the unexplained part of it visible.

## The two questions, kept apart

`api/src/domain/settlement.ts` is new, pure, and has no imports. It answers two questions that look alike and must never be merged:

- **`explainDelta(lockedCents, money)` (`:89`)** - *why did what arrived fall short?* This decides what is **recorded** on the row (`deltaReason` and `deltaSource`). It runs after PayPal has already told us money arrived.
- **`explainTotal(lockedCents, money)` (`:104`)** - *is an invoice whose total is not the lock still ours?* This decides whether to **refuse**. It runs before anything is recorded.

Merging them is the bug the split avoids. A total that is $7.50 below the lock with a $7.50 discount behind it is our invoice and should settle; a total that is $7.50 below the lock with nothing behind it is a different bill and must be refused. The same field, the same amount, opposite decisions.

## The reason set is closed, and every code has a field

`DeltaReason` (`:16`) is `full | early_discount | credit_note | paypal_fee | partial | unexplained`, and `SOURCE_OF` (`:55`) names the PayPal field behind each. `ATTRIBUTED_REASONS` (`:52`) is the four a settled row may carry.

| Reason | The PayPal field | When |
| --- | --- | --- |
| `early_discount` | `early_payment_discount` | PayPal reports the discount as **applied** (`is_applied`), and its amount equals the gap |
| `credit_note` | `amount.breakdown.discount` | The invoice carries a discount amount that equals the gap |
| `paypal_fee` | `payments.transactions[].fee` | PayPal reports a fee that equals the gap |
| `partial` | `payments.paid_amount` | Money arrived, and no adjustment above accounts for the difference |
| `full` | none | The lock was met or exceeded |
| `unexplained` | none | Nothing arrived at all |

Three rules make the codes mean something:

1. **Exactness.** A field only explains a gap when its amount equals the gap to the cent. A $5.00 discount does not explain a $7.50 shortfall; it is reported as `partial`. This is the rule that stops the product inventing the missing $2.50.
2. **Precedence.** `early_payment_discount`, then `amount.breakdown.discount`, then `payments.transactions[].fee`. The first exact match wins, and the more specific field is checked first.
3. **A percentage is not a number of cents.** A discount PayPal reports with a percentage and no amount is ignored. `is_applied` is read before the amount is used, because an offer the payer did not take is not a fact about the payment.

## S2: a total below the lock is now ours when a discount explains it

`refuseLive` was called for any total that was not the lock (`mandate.ts:928`). It is now called unless `explainTotal` accepts the difference. This **narrows** the refusal, it does not weaken it:

- a total above the lock always refuses, because `explainTotal` only ever accepts a *lower* total explained by a discount;
- a total below the lock with nothing behind it still refuses;
- a total below the lock with an exact discount behind it settles short for what was actually paid, with the reason recorded.

The lock is still the authority. A discount the studio applied is not an edit to the lock, and the row still says the lock was $150.00 and the settlement was $142.50.

## S3: overpayment, and the inconsistency S8 left

S8 computed the reason from `settledCents` alone, so a payer who sent **more** than the lock produced `settled_short` with reason `full` - a phase that says "short" and a reason that says "full", disagreeing on the same row.

`explainDelta` now reads `paidCents >= lockedCents` as `full` and keeps the extra cents in `settledCents`. `markCaptured` (`repo.ts`) stores `captured_amount_cents = the lock` and `settled_cents = what arrived`, so `amounts.match` keeps its exact meaning - what was captured is the lock to the cent - while the tip is a fact on the row instead of a mismatch. The checkout capture path passes the same value twice, because a checkout capture is the lock by construction.

## S3: a short phase only ever carries an attributed reason

`amounts.explained` asserts that every row in a short phase has a reason a PayPal field stands behind. For that
assertion to be worth anything, the producer has to guarantee it, so `applyLiveInvoice` settles short only when the
reason is one of `ATTRIBUTED_REASONS` (`mandate.ts`). Two cases fall outside and are recorded without moving the
phase, because neither is a settlement PayPal confirmed:

- `unexplained`: nothing arrived, so there is no payment id to store as the capture id.
- `full` while PayPal has not marked the invoice `PAID`: the money is there but the state is not confirmed, so the
  row keeps waiting and settles in full on the sweep that sees `PAID`.

The second case is a hole this pass closed. The pre-pass code computed the reason from the cents alone and settled
short on any non-`unexplained` reason, so money that arrived in full against an invoice PayPal had not called
`PAID` produced a `settled_short` row with reason `full` - a phase that says short and a reason that says full,
disagreeing on one row, and a row the new check would have failed. It is now impossible by construction rather than
merely unlikely.

## S5: no gate change was needed

The gate already funds a payout from `arrivedCents`, not from the lock (`gate.ts:116`, `fundableCents`), so 60% of a $142.50 settlement was already $85.50. Only the **refusal detail** was incomplete: it did not say what the share was taken from. `fundingArithmetic` (`gate.ts:126`) is new and names every number - "settled 14250 cents ... at a 60% contractor share that is 8550 cents ... 9000 cents was asked". The string still contains "N more cents", which `api/test/api.test.ts:309` asserts.

## S6: what the server asks PayPal for is signed data, not a constant

`createDraft` (`paypal/invoices.ts`) hardcoded `allow_partial_payment: false` and sent no discount. Both now come from something the owner signed:

- `allowPartialPayment` is a **warrant** field (`schemas.ts`), `.default(false)`, so rules v1 and every existing behaviour are byte-identical, and the Rules screen can turn it on.
- `earlyPaymentDiscount: { percentBps, days }` is **deal terms** (`deal.ts`), optional, so no existing deal changes. It is rendered to `{ percent, due_date }` with the due date from the server clock.

Only `early_payment_discount` is ever sent. `amount.breakdown.discount` is read-only, because it is a discount on an invoice edited in PayPal rather than one this server asked for.

**The default is safe.** A warrant body is bound to a step-up grant by `sha256(JSON.stringify(raw request body))` (`app.ts:877`), and the audit's `rulesSigned` only re-parses the stored body. Nothing re-serialises a stored warrant against its signature, so a `.default()` field cannot break an old signature.

**The drafter model is deliberately not given the field.** `RulesPatchSchema` (`agents/drafter.ts:35`) is the vocabulary a pasted policy is turned into, and `allowPartialPayment` is not in it. It is an owner setting, not something a policy paragraph should guess at. The owner sets it in the Rules editor, and `compareRules` reports the change as a **note** rather than a loosening, because part payment is the client's side of the invoice: it moves no money and widens nothing, and a client who pays less can only reduce what contractors are funded from.

## S7: the audit proves the field is there

`amounts.explained` (`audit.ts:187`) is new and sits immediately after `amounts.match`. It looks only at rows in a short phase and fails when the stored reason is not in `ATTRIBUTED_REASONS`, or when the stored `delta_source` is not `SOURCE_OF[reason]`. `amounts.match` is untouched beside it: a full settlement still has to equal the lock to the cent, and `api/test/audit.test.ts`'s strict `toEqual(['amounts.match'])` on a tampered `captured` row still passes, because a `captured` row is not a short phase and `amounts.explained` does not look at it.

A new guarantee is published for it (`guarantees.ts`, `docs/guarantees.json`): *"A settlement short of the lock carries the PayPal field its reason was read from, and one whose reason no field stands behind fails the audit."* The wording is deliberate: a `partial` settlement does have a field behind it (`payments.paid_amount`, the field that reported how much arrived), so the promise is about **the reason having a source**, not about every shortfall having an explanation for why it is short. That distinction is the whole point of the pass and it would be dishonest to blur it in the promise.

## Deviation from the plan: `unexplained` is still reachable only by hand

`unexplained` means nothing arrived, and a row in that state never settles, so a `settled_short` row with reason `unexplained` cannot be produced by the running code. `api/test/audit.test.ts` therefore produces it by editing the database by hand - the same way the other audit tests prove a check can fail - and the check catches it. The check is a detector for an impossible state, which is what a stranger's checklist is for.

## Files

Change:
- `api/src/services/mandate.ts`: `applyLiveInvoice` (the explained-total admission, the reason and the source), `settleInvoice` (the warrant flag and the deal discount), `fundingBlock`, `toView`, `markCaptured`.
- `api/src/services/audit.ts`: `explained` and the check list.
- `api/src/domain/gate.ts`: `fundingArithmetic`.
- `api/src/domain/phases.ts`: `SHORT_PHASES` and `shortPhase`.
- `api/src/domain/schemas.ts`, `api/src/domain/deal.ts`: `allowPartialPayment` and `earlyPaymentDiscount`.
- `api/src/paypal/invoices.ts`, `api/src/paypal/fake.ts`: the request fields, the parsed fields, `payPartial`, `lastCreate`.
- `api/src/db/repo.ts`, `api/src/db/database.ts`: `delta_source`, `markCaptured`, `recordSettlement`, `settleShort`.
- `api/src/openapi.ts`, `api/src/agents/policy.ts`, `api/src/agents/drafter.ts`, `api/src/domain/guarantees.ts`.
- `web/src/lib/words.ts`, `web/src/screens/Receipt.tsx`, `web/src/screens/Jobs.tsx`, `web/src/screens/NewRequest.tsx`, `web/src/screens/Rules.tsx`, `web/src/lib/openapi.d.ts`.

Add:
- `api/src/domain/settlement.ts`, `api/test/settlement-explain.test.ts`.

## Test, as built

`api/test/settlement-explain.test.ts`, 21 tests:

1. `explainDelta` returns `full` for the lock and for more than the lock, keeping the extra cents.
2. It returns `partial` for money that arrived short with nothing beside it, naming `payments.paid_amount`.
3. It reads `early_discount`, `credit_note` and `paypal_fee` from their own fields.
4. A field that only partly covers the gap does not get the credit for it.
5. An early-payment offer PayPal did not apply is not used.
6. The more specific field wins when two could explain the same gap.
7. Nothing arrived is `unexplained`, and it settles nothing.
8. `explainTotal` accepts a discounted invoice and refuses an unexplained one and a higher one.
9. End to end, each of the four reasons is written on the row with its source, `amounts.match` still refuses to call it a match, and the audit's `amounts.explained` is green with the row counted.
10. End to end, a field that only partly covers the gap leaves the reason as `partial`.
11. End to end, a total below the lock with a discount settles short, a total below the lock with nothing behind it is refused `cart.immutable`, and a total above the lock is refused.
12. End to end, an overpayment settles `captured` for the lock with the extra on the record, and both amount checks are green.
13. End to end, money that arrived in full while PayPal has not marked the invoice `PAID` is recorded but not settled, and the row settles in full once PayPal says `PAID`.
14. The create body carries `allow_partial_payment: true` only when the rules say so, and `early_payment_discount` with the deal's percentage and the server-clock due date.

`api/test/settlement-delta.test.ts` gains one test: the refusal on a short-settled charge names every number in the arithmetic (60% of 14,250 is 8,550, so 9,000 is refused), and both amount checks are green.

`api/test/audit.test.ts` gains one test: a hand-edited short settlement with reason `unexplained`, and then with a reason and no field, both fail `amounts.explained` while the row is green as PayPal left it.

## What it cost

- The audit's `amounts.explained` cannot see a reason that was written and then explained away by a later sweep, because it checks the row as stored. That is the right scope: the sweep re-derives the reason every time, so the stored row is the current truth.
- `explainTotal` accepts only a *lower* total. A total above the lock is always refused, so an invoice PayPal somehow raises is still caught.
- The rules editor gained a checkbox and the field defaults off, so the short path stays narrow in production for a seller in India, Brazil or Israel, where PayPal does not offer part payment to sellers at all. The demo studio's timezone is `Asia/Kolkata`, so the **discount** path - not part payment - is the demo-relevant one, and it is the one that needs no country support.

## Risks

1. `delta_source` is a plain string in an untyped column. A row written by an older version has no source, and `amounts.explained` would fail it. The column is added by `ensureColumn`, so an existing database gets it as null: any pre-existing `settled_short` row needs one `UPDATE` to carry its source, or the audit will report it. No such row exists in the seeded or template databases.
2. The Rules screen now writes `allowPartialPayment`, so a published rules version can differ from v1 by that field alone. `compareRules` reports it as a note, which is the honest direction: it is not a loosening.
3. `earlyPaymentDiscount` is read from the deal at invoice time, so editing a deal's terms after a charge is locked changes what a *later* charge on that deal sends, not what an already-sent invoice asked for. The lock covers the cents, not the discount.

## Rollback

Revert the commit. `delta_source` is a string in an untyped column, `phase` is a free string in the OpenAPI schema, and both new warrant and deal fields are optional with defaults, so no migration is involved. Rows already carrying an attributed reason would keep their values and their phase, and the audit check would simply no longer run.
