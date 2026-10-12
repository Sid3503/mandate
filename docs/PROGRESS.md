# Progress

## Done

- P4.T1 `fd1432b`, P4.T2 `283544d`, P4.T3 `751ac9f`, P4.T4 `b6cb07f`, P4.T5 `e5913da`, P4.T6 `b6cb07f`, P4.T7 `6968dcd`, P4.T8 `1cdbfef`.
- Q0.1 `8624506` on `q0-verify`: phase 4 rows in `docs/MASTER_PLAN.md` match those commits. Appendix B no longer says cases 10 to 16 have no test.
- Q0 verify is complete on `q0-verify`. Full gates are green. The receipt canary and the Q0 browser check are in the tree with this progress update.

## Test counts

- Baseline before Phase 4, the repair pass: 46 files, 543 API tests, 114 Playwright tests, axe pass. The 522 API tests and 112 Playwright tests are the earlier audit on the same day.
- `gates:fast` after Q0.1: 47 files, 567 API tests, secret check 311 tracked files.
- Full `npm run gates` on 12 October 2026, branch `q0-verify`: exit 0. Hygiene 23. Typecheck clean. 47 files, 568 API tests, 7.71s. Secret check 313 tracked files. `ControlRoom` 4,602.45 kB. Playwright 116 passed (7.5m), axe included.

## Open items

- Q1 through Q8 are not started. Checkpoints C1, C2, and C3 are ahead.
- Appendix B cases still partial, with no full test: 22, 27, 28, 30, and 35. The receipt canary does not close case 35. That case still needs a log sweep of the suite.

## Assumptions that were false

- Appendix B said cases 10 to 16 had no test. The table above that sentence already named the tests.
- The 522 and 112 counts were treated as the Phase 4 baseline. They are the earlier audit. The repair pass is 543 and 114.

## Decisions

- This queue runs in Grok, not Antigravity. The contract file was read in this session. Antigravity does not load `.agents/rules` here.
- Master-plan P4.T6 is the proof-color check. The phase plan used P4.T6 for the demo tap. The demo tap stays on master-plan P4.T7.
- `DEMO_ENABLED` is on only inside `api/src/dev/passkey-server.ts`, so the Q0 browser check can start a demo. It is not in `.env.example` or `render.yaml`.

## Next

Cut `q1-identity` from `q0-verify` and start P3.T7.
