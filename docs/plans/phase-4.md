# Phase 4 plan: passkey-signed approvals

Status: APPROVED WITH 5 CHANGES. Branch: `phase/4-stepup`, cut from `repair/hardening` at `86441c0`. Do not push. Do not merge. Stop after the phase report.

Goal: the tap is a signature a third party can check. `REQUIRE_PASSKEY_FOR_MONEY` stays off in `api/.env.example` and on Render. Tests may turn a workspace setting on, or the flag on, only inside that test. Rollback is the setting off, the flag at 0, or leaving this branch unmerged.

## What stayed from the review

- Step-up today binds the proposal id, so one assertion can approve another lock. The grant binds to the cart hash instead.
- Step-up does not revoke on a counter rollback. Login does. Both paths reject a rollback. A revoke happens only when the member has another passkey.
- The signature is stored on `warrants`. There is no second rules table.
- Verify says "cannot verify here" for an unknown algorithm and never "valid".

## The 5 changes

1. The passkey rule is a per-workspace setting, not only the env flag. Default on for a new studio or live workspace, off for `ws_default` and for demos. Turning it on needs an enrolled passkey and a step-up. Test all three defaults and the turn-on path.
2. A grant binds to the member, the kind, the payload hash, and a 120 second expiry. One use. Approve recomputes the cart from stored data. If it differs from the grant, return 409 "changed since you looked". Two parallel approves with one grant: one wins. Step-up routes are in the auth rate-limit class. A counter rollback always rejects the assertion. Revoke the credential only if the member has another passkey. If it is the last one, mark it suspect, write an event, and keep it. Test both. This applies to login and to step-up.
3. Verify uses test vectors from the Chromium virtual authenticator, not only the soft authenticator. Convert the DER signature to raw r and s for WebCrypto. Check rpIdHash, the UP and UV flags, type, and the challenge. Negative vectors flip one bit in the signature, authData, clientDataJSON, the challenge, and the rpId. The result shows the key fingerprint, the RP ID, and the origin. The wording is "valid signature by this key", never "approved by Meera" unless the fingerprint matches the one the user typed. One Playwright test in the passkey project: sign in, approve, download the receipt, verify it, tamper with it, see it fail.
4. Enrollment shows the fingerprint with "Save this". The receipt line shows a short fingerprint. Proof: a missing assertion where the method says passkey is red. `owner-key` and `demo` are amber. Old rows are grey, marked legacy.
5. Add `warrants.signature_json` through the migration runner. Back up a file database before the new step. Test the migration on a copy of an older database file. The old `proposal.approved` payload shape must still read. Apply step-up only to routes that exist. Do not add the missing ones.

## Assumptions

Checked against the code on this branch. None were false.

- The lock is `canonicalCart` and `cartHash` in `api/src/domain/hash.ts`. The signed message is `lockMessage` in `api/src/domain/signing.ts`. Phase 4 reuses that cart hash.
- An approval is an `events` row of type `proposal.approved`. The payload today is `{ actor: 'owner', cartHash }`. That shape must still read.
- Rules live in `warrants` (`id`, `version`, `body_json`, `created_at`). There is no `rules_versions` table.
- The public check is `web/src/screens/Verify.tsx` and `web/src/lib/verify.ts`. There is no second verify page.
- `POST /auth/stepup/options` and `POST /auth/stepup/verify` exist. `rateClass` already treats a path starting with `/auth/` as `auth`. A test still locks that in.
- `applySqlSteps` records a checksum and does not take a backup. The caller must copy a file database before the first new step.

## Routes

Step-up, when the workspace rule or the env flag is on, applies only to routes that already exist:

- `POST /v1/proposals/:id/approve`
- `PUT /v1/warrant` (this is how a payee change is published)
- `POST /v1/invites`
- `POST /v1/safety/resume`
- `POST /v1/agents` and `POST /v1/agents/:id/revoke`
- `POST /v1/client-keys`, `POST /v1/client-keys/:id/revoke`, and `POST /v1/client-keys/:id/rotate`

These routes do not exist. Do not add them:

- `POST /v1/keys` and `POST /v1/keys/:id/revoke`
- `POST /v1/invites/revoke`
- `POST /v1/members` and `DELETE /v1/members/:id`
- `POST /v1/payees` and `PATCH /v1/payees/:id`

`GET /v1/payees` and `GET /v1/members` stay as reads. `POST /v1/agents/:id/resume` is an agent pause, not the safety resume, and does not gain a step-up.

## Tasks, in order

- [x] P4.T1. `workspaces.passkey_for_money`. New studio and live rows are 1. The default workspace and demos are 0. An old control file gains the column as 0. `requireStep` reads the row, and the env flag still forces the check when it is on. `POST /v1/workspace/passkey-rule` turns the row on only with a live passkey and a one-time grant of kind `passkey-rule`. Tests cover the three defaults and the turn-on path.
- [x] P4.T2. Grant columns gain the member check, the payload hash, and `expires_at` of 120 seconds. One use, inside the same database transaction as the action. Approve recomputes the cart. A mismatch is 409 "changed since you looked". Two parallel approves with one grant: one wins. Auth rate class covers `/auth/stepup/options` and `/auth/stepup/verify`. Counter rollback rejects on login and on step-up. Revoke only when another live passkey exists. Otherwise mark suspect, insert an auth event, and keep the credential. Appendix B cases 9 to 17, with case 15 split into the two rollback outcomes.
- [x] P4.T3. Store the assertion JSON on `proposal.approved` and on the receipt. Add `warrants.signature_json` as a new checksum step. Do not edit `0001_ops`. Back up a file database first. Migrate a copy of an older database and still read `{ actor, cartHash }`. Wire step-up to the existing routes listed above. Do not add the missing routes.
- [x] P4.T4. Enrollment shows the fingerprint and "Save this". The receipt line is who, how, when, and a short fingerprint. A standing-rule payout names the warrant version and whether that version has a signature. Proof colors: missing passkey assertion is red, `owner-key` and `demo` are amber, legacy rows are grey.
- [x] P4.T5. Browser verify checks ES256. DER becomes raw r and s. Check rpIdHash, UP, UV, type, and the challenge. Commit Chromium virtual-authenticator vectors and the five negative bit flips. Wording is "valid signature by this key". An unknown algorithm says "cannot verify here". One new passkey-project Playwright test signs in, approves, downloads the receipt, verifies it, tampers, and sees the failure. `gates:fast` does not run Playwright, so that project is run on its own.
- [ ] P4.T6. Demo mode gets a "Demo tap" button that sends `x-mandate-demo-tap: 1` and method `demo`. The receipt shows that line in amber. An optional "Try with my passkey" enrolls a demo passkey. The server still refuses a demo tap outside a demo workspace.
- [ ] P4.T7. The Today approval card shows amount, payee, category, evidence, a short hash, and the clause before the prompt. After success the toast says "Signed and sent".

No new dependency. The passkey library stays on the pinned versions. Do not edit `web/e2e/job.spec.ts` except the toast string if "Signed and sent" replaces the current one.

## Appendix B cases 9 to 18

New API tests live in `api/test/stepup.test.ts`. Server assertions use `api/test/soft-authenticator.ts`. Browser vectors for P4.T5 come from Chromium, not from that class.

| Case | Test |
|---|---|
| 9 Assertion replay fails | "a step-up assertion cannot be used twice" |
| 10 Assertion for lock A fails on lock B | "an assertion bound to one cart hash does not approve another" |
| 11 UV flag off fails | "a step-up with user verification off is refused" |
| 12 Revoked credential fails | "a revoked passkey cannot sign a step-up" |
| 13 Assertion from another member fails | "a passkey from another member cannot approve" |
| 14 Wrong origin or RP ID fails | "a step-up from the wrong origin or relying party id is refused" |
| 15 Rollback with another passkey revokes | "a step-up counter that moves backwards revokes the passkey when another one exists" |
| 15b Rollback of the last passkey keeps it | "a step-up counter that moves backwards marks the last passkey suspect and keeps it" |
| 16 Approver over the limit | "an approver over their limit gets approval.over_limit" |
| 17 Proposer approve is 403 | Keep the bearer test in `api/test/api.test.ts`. Add "a cookie proposer cannot approve". |
| 18 Changed stored approval turns Proof red | "a changed stored assertion turns the proof line red", plus the existing cart tamper, plus "a changed passkey assertion is not valid", plus the passkey Playwright flow. |

## Files

Change as each task needs them: `api/src/control/store.ts`, `api/src/http/extra.ts`, `api/src/app.ts`, `api/src/auth/passkeys.ts`, `api/src/db/database.ts`, `api/src/db/sql-migrations.ts`, `api/src/services/mandate.ts`, `api/src/services/audit.ts`, `web/src/lib/verify.ts`, `web/src/screens/Verify.tsx`, `web/src/screens/Receipt.tsx`, `web/src/screens/Today.tsx`, `docs/DATA.md`, `docs/SECURITY.md`, `docs/MASTER_PLAN.md` after a task is proven.

Add: `api/test/stepup.test.ts`. Add one spec under the passkey Playwright project for P4.T5. Do not edit `api/src/dev/e2e-server.ts`.

## Migration

New step id `0002_warrant_signature` adds `warrants.signature_json TEXT`. `0001_ops` stays byte for byte. `migrate()` copies a file database aside before `applySqlSteps` runs a new step. `:memory:` tests do not copy. A test builds an older file, migrates a copy, and reads an old approval payload.

## Risks

- A client that signed the proposal id alone gets 401 once the rule is on. The default workspace stays off, so the current console is unchanged until the owner turns the rule on.
- WebCrypto verification is easy to get wrong and then show "valid". If the algorithm or the signature is not checked, the page says it cannot verify.
- The receipt carries a public key and a signature. It must not gain the PayPal token, the owner key, or the master key.
- Revoking the only passkey on a rollback would lock the owner out. The last key stays, marked suspect.

## Out of this phase

Members screen, recovery-code screen, a second passkey in the studio wizard, turning the flag on for a public URL, Lighthouse, and the Ollama free-plan quiet-clerk test. That last one belongs in P12.
