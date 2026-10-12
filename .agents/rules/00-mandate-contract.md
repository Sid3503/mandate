# Mandate agent contract (always on)

You work on Mandate. Mandate is a spend-authority layer in front of PayPal. It runs on the PayPal sandbox only.
You build the product one phase at a time. The plan is in `docs/MASTER_PLAN.md`.
Open that file only when you run a phase. Do not load it for other work.

## 1. Invariants. Never break them.

I1. AI only adds friction. No model output can approve, pay, send, refund, publish rules, issue keys, or remove a refusal.
I2. The gate is a pure function. It does no input or output. New gate inputs are plain data.
I3. Only the server talks to PayPal. It does so only from a locked cart.
I4. Money is integer cents. Decimal strings exist only at the PayPal edge.
I5. Every money call has an idempotency key. A retry never moves money twice.
I6. The ledger is append-only. Do not update or delete events. Add a new event.
I7. Existing tests stay green after every task: API tests, browser tests, red team. Do not skip, delete, or weaken a test.
I8. Sandbox only. Do not add live PayPal credentials, live endpoints, or any real-money path.
I9. Secrets never appear in the repo, logs, test output, screenshots, artifacts, or error text. Read secrets from the environment only.
I10. Every PayPal Agent Toolkit tool has a tier. The server refuses a tool that has no tier.
I11. Old doors keep working: owner, proposer, client, and agent keys, the MCP stdio server, the Postman collection. A risky new feature sits behind a flag. The flag is OFF by default.
I12. Add a dependency only with a written reason in `docs/DECISIONS.md`, a pinned version, a license check, and a clean `npm audit` (no high or critical result). Prefer Node built-ins. Do not use a package version that is less than 14 days old.
I13. Every model call has a token cap, a timeout, a per-principal rate limit, a daily budget, and a global kill switch. Tests never call a real model.
I14. When passkeys exist, a person approves money with a fresh passkey signature. A login session is never an approval.
I15. Tenant data never crosses workspaces. A request for another workspace returns 404.

## 2. How to work

1. Use Planning mode for every phase.
2. Start each phase with recon. Read the code. Check each item in "Assumptions to verify". If an assumption is false, stop and report.
3. Write an implementation plan artifact before you write code. List files to change, files to add, migrations, flags, tests, risks, and rollback. Wait for approval.
4. Work in small tasks. One task changes about 300 lines or fewer. One branch for each phase: `phase/<n>-<slug>`. One commit for each task: `P<n>.T<k>: <text>`.
5. Write the test first for code that touches security, money, or tenancy.
6. After each task run the task gates (see `docs/MASTER_PLAN.md`, Section 5). Copy the real command output summary into your report. Never write "should pass".
7. Update the docs in the same task: REFERENCE, README, CHANGELOG, OpenAPI, Postman, and the plan checkboxes.
8. Prefer the smallest change that meets the exit criteria. Do not refactor code that the task does not need.

## 3. Stop and ask the human when

- A requirement conflicts with an invariant.
- A change touches a money path in a way the plan did not list.
- A task takes more than twice its estimate.
- The same problem fails three times. Name the assumption that may be wrong. Ask one diagnostic question.
- A migration cannot be proved safe on a copy of the database.
- You need a new secret, a new paid service, or a new network domain.
- The plan and the code disagree about how something works.

## 4. Never do these things

- Never run `git push --force`, `git reset --hard`, or `rm -rf` outside build folders without approval.
- Never delete or overwrite a database file. Back it up first with `VACUUM INTO`. Apply migrations to a copy first.
- Never print, commit, or paste an API key, a pepper, a master key, a cookie, or a recovery code.
- Never put a secret in a screenshot or a browser recording.
- Never call a real model, or the real PayPal sandbox, from automated tests. Use the scripted model and the Fake ports.
- Never add third-party scripts, fonts, or analytics to the web app.
- Never disable the CSP, a rate limit, a flag check, or an authorization check to make a test pass.
- Never use an em dash in code comments, docs, UI text, or commit messages. Use a comma, a colon, or a new sentence.

## 5. Definition of done

A task is done when all of these are true:

1. The code does what the task says.
2. New tests cover the success path, each failure path, and one abuse case.
3. All task gates pass. You have the output.
4. No secret is in the diff. Run the secret check.
5. Docs, OpenAPI, and Postman match the code.
6. The plan checkbox is ticked.

A phase is done when all phase gates pass and the phase report is written. Do not start the next phase.

## 6. Code standards

- TypeScript strict mode. No `any`. No non-null assertion without a comment that explains why it is safe.
- Validate every input and output at the boundary with Zod. Return errors as RFC 9457 `application/problem+json`.
- Compare secrets with `crypto.timingSafeEqual`. Hash tokens before you store them.
- Use `crypto.randomUUID()` or 32 random bytes for ids and tokens. Never use `Math.random()` for security.
- Store time as UTC ISO strings. Inject the clock so tests can control it.
- Keep functions small and pure where you can. A comment explains why, not what.
- Log as JSON with a request id. Redact `authorization`, `cookie`, `set-cookie`, `key`, `token`, `secret`, `password`, `signature`.
- Do not log request bodies for `/auth/*`, `/join`, or key routes.
- Use transactions for every multi-row write. Use `BEGIN IMMEDIATE` for money steps.
- Every new route needs: a Zod schema, an OpenAPI entry, a Postman request, an authorization test, and a rate-limit class.

## 7. Web standards

- Mobile first. Design at 390 px wide. Touch targets are 44 px or larger.
- Every screen has a loading state, an empty state, and an error state.
- axe reports zero serious or critical issues on every new screen.
- Keyboard works for every action. Focus moves to the right place after each step. Status text uses `aria-live`.
- No inline scripts. No third-party origins. Keep the CSP strict. Extend it only when a test proves the need.
- Respect `prefers-reduced-motion`.
- UI text is plain English in short sentences. Keep all strings in one copy file.
- Never cache authenticated API responses. Auth routes return `Cache-Control: no-store`.
- Show what a person approves before the passkey prompt. Show amount, payee, category, evidence, and the short hash.

## 8. Report format (after each task and each phase)

```
Done: <what works now, in concrete terms>
Not done: <what is left or skipped, and why>
Tests: <command> <passed>/<total>, before <n>, after <n>
Flags and env added: <names and defaults>
Risks: <up to 3>
Next: <one action for the human, under two minutes>
```

## 9. Settings the human sets once in Antigravity

- Planning mode on.
- Review policy: request review at plans, migrations, and security tasks.
- Terminal execution policy: request review, or auto with a deny list for destructive commands.
- JavaScript execution policy: request review.
- Use the browser agent to check each new screen. Attach screenshots to the report. Hide secrets first.
