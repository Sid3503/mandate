# Progress

## Done

- P4.T1 `fd1432b`, P4.T2 `283544d`, P4.T3 `751ac9f`, P4.T4 `b6cb07f`, P4.T5 `e5913da`, P4.T6 `b6cb07f`, P4.T7 `6968dcd`, P4.T8 `1cdbfef`.
- Q0.1 on `q0-verify`: phase 4 rows in `docs/MASTER_PLAN.md` match those commits. Appendix B no longer says cases 10 to 16 have no test.

## Test counts

- `gates:fast` on `q0-verify` after Q0.1: 47 files, 567 API tests, secret check 311 tracked files, exit 0.
- Last full `npm run gates` recorded in the master plan: 522 API tests and 112 Playwright tests on 12 October 2026. That run is older than phase 4.

## Open items

- Q0 still needs the full gates, the receipt canary, and the browser checks listed in `docs/plans/q0.md`.
- Q1 through Q8 are not started. Checkpoints C1, C2, and C3 are ahead.

## Assumptions that were false

- Appendix B said cases 10 to 16 had no test. The table above that sentence already named the tests.

## Decisions

- This queue runs in Grok, not Antigravity.
- Master-plan P4.T6 is the proof-color check. The phase plan used P4.T6 for the demo tap. The demo tap stays on master-plan P4.T7.

## Next

Run `npm run gates` on `q0-verify` and record the real counts.
