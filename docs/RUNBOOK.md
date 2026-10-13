# Mandate run book (resume file)

Read this file and `docs/PROGRESS.md` first. Then run the queue until a checkpoint, a STOP, or RESUME.
The contract in `.agents/rules/00-mandate-contract.md` still applies: invariants I1 to I15, tests first, flags OFF by default, proof before ticks, no weakened tests. Do not push, merge, or deploy.

## 1. Run rules

1. Do not end your turn between tasks or between queue items. Do not send chat reports.
2. Write all reports to `docs/PROGRESS.md`. Keep these headings: Done (task ids, commits), Test counts, Open items, False assumptions, Decisions, Next (one action).
3. End your turn only in one of these cases:
   - CHECKPOINT: you finished C1, C2, or C3. Write the checkpoint report in `docs/PROGRESS.md`. Print a summary of at most 15 lines. End the turn. Wait for the word "go".
   - STOP: a stop condition in Section 3 happened. Print the STOP report. End the turn.
   - RESUME: context use passed 60 percent. Commit your work. Update `docs/PROGRESS.md`. End the turn with one line: `RESUME`.
4. After each task run `gates:fast`. After each queue item run `npm run gates` (with Playwright and axe) and the Section 5.2 checklist from `docs/MASTER_PLAN.md`.
5. If the gates are green: tick boxes only when a test or file proves the whole task. Update `docs/PROGRESS.md`. Commit. Start the next task at once.
6. One branch per queue item, cut from the previous one: `q1-identity`, `q2-onboarding`, and so on. One commit per task: `Q<n>.<k>` plus the MASTER_PLAN task id. Never squash. Never rewrite history.
7. Write tests first for security, money, and tenancy code. Test every new route with a role case, an abuse case, and a rate-limit case. Update OpenAPI and Postman.
8. Use the browser agent for each new screen. Save screenshots in `docs/evidence/q<n>/`. Hide secrets first.
9. Use only the task ids in `docs/MASTER_PLAN.md`. If a phase plan uses other numbers, map them in `docs/PROGRESS.md`.

## 2. Work queue

Q0 is done (see `docs/PROGRESS.md`). Continue from the first queue item that is not done.

Q1 Identity (P3.T7 to T10, P5.T3, P6.T1, P6.T2). Second passkey. Recovery codes (issue with "I saved these", use, regenerate with step-up). Add and remove passkey routes and screen (never remove the last one). Members routes and screen (list, role change, revoke; last owner protected; revoke ends sessions and keys and lists open requests). Sessions screen (list, revoke, revoke others, login history). Invites: step-up to create, a revoke route, inviter and role on the join page, race test. Studio wizard: name, passkey, second passkey or codes (required), PayPal card (simulated, honest text), rules in words (can skip), progress saved. `npm run admin:reset-owner` with an `admin_audit` event. Role matrix tests. Chromium virtual authenticator tests for every passkey flow.

Q2 Onboarding (P5.T1 to T9). Welcome headline and three doors. Demo: role switcher, Reset, banner, and a Live proof page that reads `docs/live-proof/*.json` (if empty, show "not added yet" and tell the human). Role landings. PWA: "Unlock with Face ID" on an expired session. At most 3 coach marks. Loading, empty, and error states. Desktop and phone browser tests. axe on every new screen. Write `docs/PHONE_CHECKLIST.md` for the human.
CHECKPOINT C1.

Q3 Ops and tenancy gaps (P1 and P2). `SecretString` on boot secrets. Tests for each rate-limit class. A real `/readyz`. SSE caps. Backup before every migration, and a test on a copy of an older database. Backup and restore tests. `npm run seed:template` with a test for the frozen numbers. Tests for demo reset, switch, and simulate. Model cap for each demo workspace. Cleanup job every 15 minutes (demo and expired only; never default, studio, or live). Webhook routing through `external_refs`. Per-workspace public key route. MCP under `/w`. One scheduler, no timer for each tenant. Property test: random work in workspace A never changes the table contents of workspace B. Suite-wide log sweep for secrets (case 35).

Q4 Safety (P7). Auto-trip with the plan defaults, as a plain gate input; `system.paused`. The owner edits the settings with step-up. Resume with step-up. A proposer cannot pause or resume. "Stopped" on Today. Payee screen with history and "Why can I not pay this account?". Payee change with step-up. Tests for cases 30 to 32.

Q5 Rule tools (P8). Test case generator in code. Try-it box (verify it). Tap to rule with a passkey publish and a "taps this month" number. Paste your policy: flag, 20,000 character cap, at most 3 passes, segment table, fenced untrusted text. Eval of 30 wordings with the scripted model in CI, and `npm run eval:drafter` for the real model with a token cap. Name the model beside each number. Skip the second reader.

Q6 Proof and guarantees (P10). fast-check sequences for every invariant in the plan. History replay as a Proof control. Proof lines for members, assertions, signed rules, safety events, and key fingerprint. `docs/guarantees.json`, `npm run guarantees`, and the page that reads it. Put every Appendix B case in the red team file. Show a table of cases 1 to 35 with test names. List any case with no test.
CHECKPOINT C2.

Q7 Toolkit wrapper (P11). Propose calls `POST /v1/proposals` through an injected client. The read tier passes through. An unknown tool throws. `MCP_EXPOSE_READ_TOOLS` is wired behind its flag. Proof and System text changes when it is on. Tests.

Q8 Hardening (P12). Security checklist with evidence for each of the 14 items. Chaos tests: PayPal timeout, model timeout, database locked, disk full (inject the error). Each gives a clear message and leaves no wrong money state. Model provider usage refusal: the clerk goes quiet with a clear message and quick asks work. Performance: a p95 read test; split the ControlRoom chunk so no chunk is over 1,000 kB (lazy-load AG Grid); run Lighthouse on mobile and record the numbers (target 95). Keyboard walk of the passkey flows. Trim logs at 14 days and auth events at 90 days, and update `docs/DATA.md`. Docs: ONBOARDING, SECURITY (known limits), REFERENCE, README, CHANGELOG, OpenAPI, Postman. Deploy readiness only: `render.yaml` disk path, env list, health check, `npm run preflight`. Do not deploy.
Skip P9 and the second reader unless the human writes "go tier C".
CHECKPOINT C3 and the final report.

## 3. STOP conditions

Write a STOP report: what happened, why, evidence, one question.

- A gate is still red after 2 fix attempts.
- A change would break an invariant, or touches a money path the plan did not list.
- You need a new dependency, secret, paid service, or network domain.
- The plan and the code disagree about how something works and you cannot settle it from the code.

## 4. Final report (at C3)

A table of every MASTER_PLAN task id: status, proof, commit. Test counts before and after. Appendix B cases 1 to 35 with test names. Gate summaries. Flags and env added. Open risks (up to 5). A list of what the human must do: set `TRUST_PROXY=1` and a real domain for the passkey RP ID, a usage limit on the model account, a real phone passkey test, deploy, one unbroken live PayPal run, a real refund, the video, the deck, and the Devpost text.
