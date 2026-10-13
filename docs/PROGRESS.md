# Progress

## Done

- P4.T1 `fd1432b`, P4.T2 `283544d`, P4.T3 `751ac9f`, P4.T4 `b6cb07f`, P4.T5 `e5913da`, P4.T6 `b6cb07f`, P4.T7 `6968dcd`, P4.T8 `1cdbfef`.
- Q0.1 `8624506` on `q0-verify`. Q0.2 `bf2e482`. Q0 is complete.
- Q1.1 P3.T7 `52fde09`: session list, revoke, revoke others, owner sign-in history, screen `/app/sessions`.
- Q1.2 P3.T8 `5f7d0c5`: recovery codes issued, confirmed with "I saved these", used once, and replaced only with a passkey step-up. Proof: `api/test/identity.test.ts` and `web/e2e/passkey-repair-recovery.spec.ts`.
- Q1.3 P3.T9: add a passkey and refuse to remove the last one. Another member's id is 404. A call without the web client header is 403. Proof: `api/test/identity.test.ts` and `web/e2e/passkey-repair-passkeys.spec.ts`. Screenshot `docs/evidence/q1/passkeys.png` shows a fingerprint and no codes.

## Test counts

- Baseline before Phase 4: 46 files, 543 API tests, 114 Playwright, axe pass. The 522 and 112 numbers are the earlier audit.
- Full `npm run gates` on 12 October 2026, `q0-verify`: 47 files, 568 API tests, 7.71s, secret check 313, Playwright 116, axe included.
- `gates:fast` after Q1.2: 48 files, 575 API tests, secret check 326 tracked files, exit 0. The recovery browser test passed alone. Full `npm run gates` for Q1 has not run yet.
- `gates:fast` after Q1.3: 48 files, 577 API tests, 11.06s, secret check 327 tracked files, exit 0. The passkey browser test passed alone.

## Open items

- Q1 still open: P3.T10, P5.T3, P6.T1, P6.T2. Then Q2 through Q8. Checkpoints C1, C2, and C3 are ahead.
- Appendix B cases still partial: 22, 27, 28, 30, and 35.

## False assumptions

- Appendix B said cases 10 to 16 had no test. The table already named the tests.
- The 522 and 112 counts were treated as the Phase 4 baseline. The repair pass is 543 and 114.

## Decisions

- This queue runs in Grok. Reports go in this file. Do not push.
- Master-plan P4.T6 is the proof-color check. The demo tap stays on P4.T7.
- `DEMO_ENABLED` is on only inside `api/src/dev/passkey-server.ts`.
- A session's public id is a random id, not the token hash. Revoke of another member's id is 404.

## Next

Q1.4 P3.T10: Chromium virtual authenticator on every passkey flow that does not already have one.
