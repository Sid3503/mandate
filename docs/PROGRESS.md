# Progress

## Done

- P4.T1 `fd1432b`, P4.T2 `283544d`, P4.T3 `751ac9f`, P4.T4 `b6cb07f`, P4.T5 `e5913da`, P4.T6 `b6cb07f`, P4.T7 `6968dcd`, P4.T8 `1cdbfef`.
- Q0.1 `8624506` on `q0-verify`. Q0.2 `bf2e482`. Q0 is complete.
- Q1.1 P3.T7 `52fde09`: session list, revoke, revoke others, owner sign-in history, screen `/app/sessions`.
- Q1.2 P3.T8 `5f7d0c5`: recovery codes issued, confirmed with "I saved these", used once, and replaced only with a passkey step-up. Proof: `api/test/identity.test.ts` and `web/e2e/passkey-repair-recovery.spec.ts`.
- Q1.3 P3.T9 `2904707`: add a passkey and refuse to remove the last one. Another member's id is 404. A call without the web client header is 403. Proof: `api/test/identity.test.ts` and `web/e2e/passkey-repair-passkeys.spec.ts`. Screenshot `docs/evidence/q1/passkeys.png` shows a fingerprint and no codes.
- Q1.4 P3.T10 `a9df7ed`: Chromium virtual authenticator on register (`passkey-repair.spec.ts`), sign in again (`passkey-repair-login.spec.ts`), step-up approve (`passkey-repair-receipt.spec.ts`), a second passkey (`passkey-repair-passkeys.spec.ts`), and recovery replace (`passkey-repair-recovery.spec.ts`). Unlock has "Sign in with a passkey". Screenshot `docs/evidence/q1/passkey-login.png` shows one active session, one ended session, and no codes.
- Run book v2 `31d78b3`. No checkpoints. A blocked task is logged and the queue continues.
- Q1.5 P6.T1 `6105e8d`: invite create needs a passkey when the rule is on. Revoke is owner-only, a proposer is 403, an unknown token is 404. The join page names the inviter and the role. Race: `api/test/repair-pass.test.ts` "lets one of two joins win". Screenshot `docs/evidence/q1/invite.png` shows no token.
- Q1.6 P6.T2 `f37e3e6`: members list, role change, and revoke. The last owner stays. Revoke ends sessions and passkeys and lists open requests. `npm run admin:reset-owner` writes `admin_audit`. Proof: `api/test/identity.test.ts` and `web/e2e/passkey-repair-members.spec.ts`. Screenshot `docs/evidence/q1/members.png` shows the refusal and no codes.
- Q1.7 P5.T3 `0a41958`: studio wizard. A second passkey or recovery codes are required before Today. PayPal text says the charge is simulated. Rules in words can be skipped. Progress is in local storage. Proof: `web/e2e/passkey-repair-wizard.spec.ts`. Screenshot `docs/evidence/q1/wizard.png` shows no codes.
- Q1.8 P6.T3: an owner can replace an `mnd_ag_` or `mnd_cl_` secret and keep the same agent or client. A legacy hash of the bare secret is rewritten on first use. Proof: `api/test/agent-keys.test.ts` and `api/test/client-keys.test.ts`.
- Q1.9 P6.T4: connect an agent screen with templates, preview, expiry, and key testing. Screen `/app/connect`. Proof: `api/test/agent-keys.test.ts` and `web/e2e/passkey-repair-agent-connect.spec.ts`. Screenshot `docs/evidence/q1/connect-agent.png` shows no secret.
- Q1.10 P6.T5: agent scorecard feeding the safety breaker. Proof: `api/test/agent-keys.test.ts` and `web/e2e/passkey-repair-agent-scorecard.spec.ts`. Screenshot `docs/evidence/q1/scorecard.png` shows no secret.
- Q1.11 P6.T4 `cded03b`: button label alignment with e2e job suite. Full `npm run gates` complete for Q1.
- Q2.1 P5.T1 `fda497e`: welcome headline, line of proof, three doors, trust strip with verify link. Proof: `web/e2e/onboarding-doors.spec.ts`. Screenshot `docs/evidence/q2/doors.png`.
- Q2.2 P5.T2 `fdd1ca4`: demo banner, role switcher (owner, approver, proposer, viewer, payee), reset, and live proof page. Proof: `api/test/demo-onboarding.test.ts` and `web/e2e/passkey-repair-demo.spec.ts`. Screenshot `docs/evidence/q2/demo-banner.png`.
- Q2.3 P5.T5 `8dbab75`: role landings for owner/approver on Today, proposer on Ask Mandate, viewer on Proof, payee on Payments, client on Deals. Proof: `web/e2e/passkey-repair-role-landings.spec.ts` with axe. Screenshot `docs/evidence/q2/payee-landing.png`.
- Q2.4 P5.T6: PWA unlock with Face ID on expired session, workbox denylist for authenticated paths. Proof: `web/e2e/passkey-repair-pwa-unlock.spec.ts` with axe. Screenshot `docs/evidence/q2/unlock-faceid.png`.

## Test counts

- Baseline before Phase 4: 46 files, 543 API tests, 114 Playwright, axe pass. The 522 and 112 numbers are the earlier audit.
- Full `npm run gates` on 12 October 2026, `q0-verify`: 47 files, 568 API tests, 7.71s, secret check 313, Playwright 116, axe included.
- Full `npm run gates` after Q1 on 13 October 2026: 48 files, 594 API tests, 10.00s, secret check 345 tracked files, Playwright 125 passed (8.1m), axe included, exit 0.
- `gates:fast` after Q2.4: 49 files, 596 API tests, 9.33s, secret check 354 tracked files, exit 0.

## Open items

- Appendix B cases still partial: 22, 27, 28, 30, and 35.

## Human todo

- Two real sandbox receipts in `docs/live-proof/`.

## False assumptions

- Appendix B said cases 10 to 16 had no test. The table already named the tests.
- The 522 and 112 counts were treated as the Phase 4 baseline. The repair pass is 543 and 114.

## Decisions

- This queue runs in Grok. Reports go in this file. Do not push.
- Master-plan P4.T6 is the proof-color check. The demo tap stays on P4.T7.
- `DEMO_ENABLED` is on only inside `api/src/dev/passkey-server.ts`.
- A session's public id is a random id, not the token hash. Revoke of another member's id is 404.
- `FLAG_INVITES` is on only inside `api/src/dev/passkey-server.ts`, same as `DEMO_ENABLED`. A bearer key cannot revoke an invite.
- Member role and revoke are `POST /v1/members/:id/role` and `POST /v1/members/:id/revoke`. `POST /v1/members` stays absent. Open requests are proposals in `pending_approval`, because the ledger has no member column. Revoke clears every passkey, including the last one. Role change ends sessions and keeps passkeys.
- The studio wizard stores progress in `mandate.studio.progress`. It does not store recovery codes. Rules in words are not published. Today stays closed until a second passkey or saved codes.
- Machine key upgrade keeps the same id. New secrets still use `mnd_ag_` and `mnd_cl_`, because the browser suite matches those prefixes. A hash of the bare secret is accepted once and then stored as the hash of the whole key.
- Demo role switch and demo reset are allowed for viewer, payee, and approver in demo workspace mode.
- Live proof reads `docs/live-proof/*.json`. If empty, the page displays "not added yet".
- Role landings: owner and approver land on Today, proposer on Ask Mandate (/app/clerk), viewer on Proof (/app/proof), payee on Payments (/app/payments), client on Deals (/app/deals). Direct navigation to /app/ redirects non-owner roles to their role landing. useToday query only runs for owner/approver.
- PWA unlock with Face ID: on expired session (401 or ?reason=expired or mandate.session.expired), /app/unlock presents an immediate biometric unlock button "Unlock with Face ID" alongside manual key unlock. Workbox denylists /v1/, /auth/, /w/, and /mcp/ paths from navigation fallback.

## Next

Q2.5 P5.T7: first-run coach marks (at most 3) and screen states (loading, empty, error).
