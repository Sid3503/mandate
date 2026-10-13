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

## Test counts

- Baseline before Phase 4: 46 files, 543 API tests, 114 Playwright, axe pass. The 522 and 112 numbers are the earlier audit.
- Full `npm run gates` on 12 October 2026, `q0-verify`: 47 files, 568 API tests, 7.71s, secret check 313, Playwright 116, axe included.
- `gates:fast` after Q1.2: 48 files, 575 API tests, secret check 326 tracked files, exit 0. The recovery browser test passed alone. Full `npm run gates` for Q1 has not run yet.
- `gates:fast` after Q1.3: 48 files, 577 API tests, 11.06s, secret check 327 tracked files, exit 0. The passkey browser test passed alone.
- `gates:fast` after Q1.4: 48 files, 577 API tests, 10.50s, secret check 329 tracked files, exit 0. The re-login browser test passed alone.
- `gates:fast` after Q1.5: 48 files, 580 API tests, 9.66s, secret check 331 tracked files, exit 0. The invite browser test passed alone. Full `npm run gates` for Q1 has not run yet.
- `gates:fast` after Q1.6: 48 files, 584 API tests, 10.17s, secret check 333 tracked files, exit 0. The members browser test passed alone. Full `npm run gates` for Q1 has not run yet.
- `gates:fast` after Q1.7: 48 files, 584 API tests, 8.66s, secret check 337 tracked files, exit 0. The wizard browser test passed alone. Full `npm run gates` for Q1 has not run yet.
- `gates:fast` after Q1.8: 48 files, 589 API tests, 8.56s, secret check 339 tracked files, exit 0. No new screen. Full `npm run gates` for Q1 has not run yet.
- `gates:fast` after Q1.9: 48 files, 591 API tests, 8.89s, secret check 340 tracked files, exit 0. Connect agent browser test passed alone. Full `npm run gates` for Q1 has not run yet.
- `gates:fast` after Q1.10: 48 files, 594 API tests, 9.61s, secret check 343 tracked files, exit 0. Scorecard browser test passed alone. Full `npm run gates` for Q1 has not run yet.

## Open items

- Q1 queue complete. Next: full gates for Q1, cut q2-onboarding, and continue Q2 through Q8. No checkpoints.
- Appendix B cases still partial: 22, 27, 28, 30, and 35.

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

## Next

Full gates for Q1, cut q2-onboarding, and begin Q2 Onboarding.
