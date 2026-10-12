# Phase 4 plan: passkey-signed approvals

Status: WAITING FOR APPROVAL. Branch: `phase/4-stepup`, cut from `repair/hardening` at `86441c0`. Nothing in this file is built yet. Do not push. Do not merge.

Goal: the tap is a signature a third party can check. `REQUIRE_PASSKEY_FOR_MONEY` stays off except inside tests. Rollback is that flag at 0, which returns the old tap.

## Assumptions

Checked against the code on this branch.

- The lock is `canonicalCart` and `cartHash` in `api/src/domain/hash.ts`. The signed message is `lockMessage` in `api/src/domain/signing.ts`. Phase 4 will bind the step-up challenge to that cart hash. It will not invent a second hash.
- Approvals are not a table. An approval is an `events` row of type `proposal.approved`. The payload today is `{ actor: 'owner', cartHash }`. Rules live in `warrants` (`id`, `version`, `body_json`, `created_at`). There is no `rules_versions` table and no `signature_json` column. The plan adds `signature_json` on `warrants` with the same column-add style already used in `api/src/db/database.ts`. It does not create a second rules table.
- The public check is two files, not one. `web/src/screens/Verify.tsx` is the page. `web/src/lib/verify.ts` recomputes the cart and checks the Ed25519 lock. `web/e2e/job.spec.ts` "a receipt can be checked in the browser without a key, and a tampered one is caught" already runs the cart check. Phase 4 extends those two files. It does not add a second verify page.

One gap found while checking, and the plan fixes it: `finishLogin` in `api/src/auth/passkeys.ts` revokes a credential when the counter moves backwards. `POST /auth/stepup/verify` in `api/src/http/extra.ts` does not. The step-up challenge is bound to the proposal id, not the cart hash, so an assertion for one lock can be presented for another.

## What is already there

- `POST /auth/stepup/options` and `POST /auth/stepup/verify` exist. They return a one-time grant. No test calls them. P4.T1 stays partial until the tests below pass.
- `requireStep` runs only on `POST /v1/proposals/:id/approve` and `PUT /v1/warrant`, and only when the flag is on. A demo workspace may skip it with `x-mandate-demo-tap: 1`. Case 25 already shows that header does not approve on the default studio.
- `approval.over_limit` is thrown in `api/src/app.ts` when `memberRole` is `approver` and the amount is over `approval_limit_cents`. Nothing tests it. `agent.over_limit` is a different code and does not count.
- The approval card on Today already shows the amount and the payee (`web/src/screens/Today.tsx`). It does not show the category, the evidence, the short hash, or the clause before the prompt, and the success toast does not say "Signed and sent".

## Tasks, in order

1. P4.T1. Keep two HTTP calls. The browser has to sit between them for the passkey prompt. Options builds the challenge from `mandate/stepup/v1`, the kind, and `cartHash(canonicalCart(...))` for an approval, or the warrant body hash already used by `requireStep` for a rules publish. Verify still returns a grant. Approve consumes that grant inside the same database transaction that writes the lock and the approval event. A second use of the same assertion is 401.
2. P4.T2. When the flag is on, also require a step-up to issue or revoke a key, create or revoke an invite, remove a member, resume after pause (`POST /v1/safety/resume`), and confirm a payee change. The approver limit check stays where it is and gains the test in case 16. Do not add a members screen.
3. P4.T3. Store the assertion JSON on the `proposal.approved` event and on the receipt packet. Store the rules signature in `warrants.signature_json`. Old rows stay null and read as legacy.
4. P4.T4. `web/src/screens/Receipt.tsx` shows who approved and how, for example "Meera, passkey, 14 Oct 11:20". A standing-rule payout links to the warrant version and says whether that version has a signature.
5. P4.T5. `web/src/lib/verify.ts` checks an ES256 passkey assertion in the browser with WebCrypto. It recomputes the challenge from the receipt fields and checks type, origin, the UV flag, and the signature over `authenticatorData || SHA-256(clientDataJSON)`. Any other algorithm shows "cannot verify here" and never "valid". `Verify.tsx` gains an optional expected-fingerprint field.
6. P4.T6. The Proof check in `api/src/services/audit.ts` turns red when a human approval has no assertion and is not marked `owner-key` or `demo`, and when the active warrant has no signature and is not marked legacy.
7. P4.T7. Demo mode gets a "Demo tap" button that sends `x-mandate-demo-tap: 1` and a `method` of `demo`. The receipt shows that line in amber. An optional "Try with my passkey" enrolls a demo passkey. Demo method stays refused outside a demo workspace. The server check for that already exists.
8. P4.T8. The Today approval card shows amount, payee, category, evidence, a short hash, and the clause before the prompt. After a successful approve the toast says "Signed and sent".

Flags stay off. No new env var. No new dependency. The passkey library is already pinned.

## Appendix B cases 9 to 18

All new API tests go in `api/test/stepup.test.ts` and use the existing soft authenticator (`api/test/soft-authenticator.ts`) so the signatures are real ES256 assertions. The flag is on only inside that file.

| Case | Test |
|---|---|
| 9 Assertion replay fails | `api/test/stepup.test.ts` "a step-up assertion cannot be used twice". The older registration replay in `api/test/phases.test.ts` "registers a passkey and signs in with it" stays. It is not this case. |
| 10 Assertion for lock A fails on lock B | `api/test/stepup.test.ts` "an assertion bound to one cart hash does not approve another" |
| 11 UV flag off fails | `api/test/stepup.test.ts` "a step-up with user verification off is refused" |
| 12 Revoked credential fails | `api/test/stepup.test.ts` "a revoked passkey cannot sign a step-up" |
| 13 Assertion from another member fails | `api/test/stepup.test.ts` "a passkey from another member cannot approve" |
| 14 Wrong origin or RP ID fails | `api/test/stepup.test.ts` "a step-up from the wrong origin or relying party id is refused" |
| 15 Counter rollback revokes the credential | `api/test/stepup.test.ts` "a step-up counter that moves backwards revokes the passkey". Login already revokes. This test is the step-up path, which does not. |
| 16 Approver over the limit is `approval.over_limit` | `api/test/stepup.test.ts` "an approver over their limit gets approval.over_limit". The member is a cookie approver. `agent.over_limit` does not count. |
| 17 Proposer approve is 403 | Keep `api/test/api.test.ts` "lets a proposer key ask and read, but never decide, capture, or change the warrant" for the bearer key. Add `api/test/stepup.test.ts` "a cookie proposer cannot approve". |
| 18 Changed stored approval turns Proof red | `api/test/stepup.test.ts` "a changed stored assertion turns the proof line red". The cart tamper stays `web/e2e/job.spec.ts` "a receipt can be checked in the browser without a key, and a tampered one is caught". `api/test/verify.test.ts` gains "a changed passkey assertion is not valid" for the browser check function. |

Cases 10 to 16 have no test today. This phase is what covers them.

## Files

Change: `api/src/http/extra.ts`, `api/src/app.ts`, `api/src/auth/passkeys.ts`, `api/src/db/database.ts`, `api/src/services/mandate.ts`, `api/src/services/audit.ts`, `api/src/domain/hash.ts` only if the challenge string needs a helper next to `cartHash`, `web/src/lib/verify.ts`, `web/src/screens/Verify.tsx`, `web/src/screens/Receipt.tsx`, `web/src/screens/Today.tsx`, `docs/DATA.md`, `docs/MASTER_PLAN.md` after each task is proven.

Add: `api/test/stepup.test.ts`.

Do not edit `web/e2e/job.spec.ts` except to point an existing assertion at "Signed and sent" if that toast replaces the current one. The 112 job tests must stay green.

## Migration

`ALTER TABLE warrants ADD COLUMN signature_json TEXT` when the column is missing. No new table. Before running it against a file database that already has money, copy that file aside. Tests use `:memory:` and do not need a copy. There is no checksum migration.

## Flags and env

No new flag. No new env var. `REQUIRE_PASSKEY_FOR_MONEY` stays off in `api/.env.example` and on Render. Tests pass the flag in the harness.

## Risks

- Binding the challenge to the cart hash changes the step-up grant. A client that signed the proposal id alone will get 401 once the flag is on. The flag is off, so the current console is unchanged until someone turns it on.
- WebCrypto verification of an ES256 assertion is easy to get wrong and then show "valid". The rule is the opposite: if the algorithm or the signature format is not checked, the page says it cannot verify.
- Storing the assertion on the receipt puts a public key and a signature in a file the owner can download. That is the point of the check. The file must not gain the PayPal token, the owner key, or the master key.

## Rollback

Leave `phase/4-stepup` unmerged. `REQUIRE_PASSKEY_FOR_MONEY=0` skips `requireStep`. Dropping the branch drops the column add, because nothing is pushed. Old warrants keep working with a null `signature_json`, read as legacy.

## Out of this phase

Members screen, recovery-code screen, a second passkey in the studio wizard, turning the flag on for a public URL, Lighthouse, and the Ollama free-plan quiet-clerk test. That last one belongs in P12: if the provider refuses for usage, the clerk goes quiet with a clear message and quick asks still work.
