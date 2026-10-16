# F The fee PayPal took, and the amount on the other side

Status: built and green. 23 hygiene checks, typecheck clean (api and web), 67 files, 780 tests, secret check 422
tracked files, 21 of 21 guarantees, `npm run build` clean.

Date: 16 October 2026.

## Why this pass exists

Two numbers the product already holds in one hand and drops with the other.

**The reconcile check answers half the question.** `reconcile` (`api/src/domain/reconcile.ts:22`) lines PayPal's
own transaction report up against the ledger and answers one question: does this transaction belong to a Mandate
request? It answers by id alone. A row that matches is accepted on trust; its amount and its currency are never
compared with what the ledger recorded. That is the last place in the product where a number is taken without
being checked, and it is exactly the class of silent wrong answer the rest of the audit exists to remove. On the
Ledger tab it reads "Matched", which a reader takes to mean "and the money agrees". Today it does not mean that.
A PayPal row matched by id whose cents are wrong, or whose currency is wrong, is silently accepted.

**A checkout capture's fee is read nowhere.** `firstCapture` (`api/src/paypal/client.ts:310`) reads a completed
order capture and returns its id, status, amount and currency. It throws away `seller_receivable_breakdown`, the
object PayPal puts on a capture that states the gross, the `paypal_fee` it took, and the `net_amount` that
reached the studio. The outbound fee is read (`client.ts:241`) and stored (`payout_fee_cents`), and the invoice
path reads the inbound fee to explain a shortfall (`invoices.ts:181`), but a checkout capture's fee is read
nowhere and stored nowhere. The studio's receipt shows a fee when it paid a contractor and shows nothing when it
was paid. That is the same asymmetry the provenance line was drawn to remove: a number PayPal stated that no
field on the row carries.

Neither number is a demo number. The frozen job settles through an invoice, not a checkout capture, and the
Ledger tab is not a beat in the 2:50 script. Both are product truth: the receipt should not be able to show a
fee for money out and hide a fee for money in, and a "Matched" chip should not be a promise the check does not
keep.

## F2, the reconcile check

**The expected money comes from the ledger, keyed by the same ids that already match.** `knownPayPalIds`
(`repo.ts:805`) already maps every PayPal id the ledger holds, and every proposal id, to its proposal. It is
widened to carry, alongside the proposal id, the money the ledger says that request is: signed cents and a
currency (`LedgerMoney` in `domain/reconcile.ts`). One lookup now answers both "whose is this?" and "what should
it be?", so a row can never be matched without the amount being available to check. The sign follows PayPal's own
transaction report: money in is positive, money out is negative, so a client charge is positive and a payout or a
refund is negative.

**What the ledger says the amount should be is `settled_cents ?? captured_amount_cents ?? amount_cents`,
signed by kind.** What actually arrived wins over the lock. A short settlement is therefore compared against the
money that really moved, not against a lock it never met, so a known, attributed shortfall is not re-flagged here
as a new disagreement; its delta and its reason are already on the row. `amount_cents` is the fallback for a
request whose money is still in flight. This is `expectedSignedCents` in `domain/phases.ts`, next to
`arrivedCents`, because it is the same question ("what money moved, and which way") the rest of that file already
answers.

**A request paid in several transactions is compared as a total.** An invoice can be paid in parts: two
transactions, one proposal. Comparing each part against the full lock would flag both, which is a false
accusation. So the check groups the matched rows by proposal and compares their sum, and the currency of each,
against what the ledger holds. A row's own `deltaCents` is only meaningful when it is the only transaction for
that request; when the request is split, the row's delta is null and the group carries the answer in `balanced`.
This is written down rather than assumed because the settled-short path exists precisely so a second payment can
complete a lock that a first payment only partly met.

**A row that matched but does not agree is surfaced, not accepted.** `ActivityRow` gains `expectedCents`,
`expectedCurrency`, `deltaCents` and `balanced`; `Activity` gains `mismatched` (requests whose transactions do
not add up to the ledger) and `mismatchedNetCents` (PayPal's side minus the ledger's side, across those
requests). `balanced` is null when nothing was compared, true when the money agreed, false when it did not. The
Ledger tab renders it as a second chip next to "Matched", a differing row is tinted, and the summary line names
the count. The promise the tab makes is narrowed to what the check enforces, exactly as the `amounts.explained`
guarantee was worded last pass: "Matched" means the ids agree, and the money chip means the money does.

**A currency disagreement is not a cents disagreement.** If the cents are equal but the currency differs, the
net-cents difference is zero while the request is still wrong. So `mismatched` counts it and
`mismatchedNetCents` does not pretend to. The two counters are separate on purpose.

## F1, the capture fee

**`seller_receivable_breakdown` is read in `firstCapture` and carried out of `captureOrder`.** `CapturedPayment`
(`port.ts:17`) gains `feeCents` and `netCents`, read from `seller_receivable_breakdown.paypal_fee` and
`seller_receivable_breakdown.net_amount`. The reader is the same shape as the invoice path's `moneyCents`
(`invoices.ts:172`): a bare money object or a `{ amount: money }` wrapper, and an absent field is null.

**Absent means null, never zero.** PayPal does not state a fee on a capture that is not complete, and it may not
state one at all. A zero would claim the studio paid nothing, which is a fact PayPal did not state. This is the
same rule the settlement pass enforced for a missing PayPal field, applied to the same object.

**The two numbers are stored on the row, beside the amount.** `proposals` gains `capture_fee_cents` and
`capture_net_cents`, nullable, added by the same `ensureColumn` migration every other column uses.
`markCaptured` (`repo.ts:1023`) takes them and writes them with `COALESCE`, so a re-read that does not repeat a
fee cannot erase a fee PayPal already stated, the same way `applyPayout` protects `payout_fee_cents`. They are
exposed on the proposal view as `captureFeeCents` and `captureNetCents` and shown in the receipt's PayPal panel,
so the store is not a dead end.

**Only the capture path is stored, deliberately.** The invoice path already reads its fee (`invoices.ts:181`)
and uses it to explain a shortfall, so that fee is attributed to the delta it explains and is visible through
`delta_source`. Storing it again as a receipt number is a different change with a different question ("was this
fee taken, or only used to explain a gap?"), and it is left out so this pass stays small. The plan's F1 names
`firstCapture` and nothing else.

## Files

Change:
- `api/src/domain/phases.ts`: `expectedSignedCents`.
- `api/src/domain/reconcile.ts`: `LedgerMoney`, the widened `known` map, the per-request money check, the two
  new `Activity` counters, and the four new row fields.
- `api/src/db/repo.ts`: `knownPayPalIds` returns `LedgerMoney`; `capture_fee_cents` and `capture_net_cents`
  columns, in `ProposalRow`, in `PROPOSAL_COLUMNS`, and in `markCaptured`.
- `api/src/db/database.ts`: the two columns and their migration.
- `api/src/paypal/port.ts`, `api/src/paypal/client.ts`, `api/src/paypal/fake.ts`: read and carry the fee and net.
- `api/src/domain/money.ts`, `api/src/paypal/invoices.ts`: `moneyCents` moves to `money.ts` so the capture reader and
  the invoice reader share one reader for "a money amount PayPal states", instead of two copies.
- `api/src/services/mandate.ts`: `toView`, `ProposalView`, and the capture caller passing the two numbers.
- `api/src/openapi.ts`: `captureFeeCents`, `captureNetCents`.
- `web/src/lib/types.ts`, `web/src/screens/Ledger.tsx`, `web/src/screens/Receipt.tsx`.
- `web/src/lib/openapi.d.ts`: regenerated.

New:
- `api/test/reconcile.test.ts`: the F2 proof, pure.
- `api/test/capture-fee.test.ts`: the F1 proof, end to end through the capture route.

Docs: `docs/REFERENCE.md`, `CHANGELOG.md`.

## Proof

- `api/test/reconcile.test.ts`: a matched row whose cents are wrong is `balanced: false` with a signed
  `deltaCents` and is counted in `mismatched`; a matched row whose currency is wrong is `balanced: false` and
  counted, with a zero net-cents difference; a request split across two transactions is compared as a total and
  neither row is falsely flagged; an unmatched row carries no expected money and is not counted as mismatched;
  a row matched by invoice reference is checked too.
- `api/test/capture-fee.test.ts`: a completed capture carries PayPal's fee and net onto the row and out through
  the proposal view; a capture that states no breakdown leaves both null, never zero.
- The existing `api/test/paypal-watch.test.ts` still passes with the widened map, and its activity test now also
  asserts the money agrees on the matched row.
