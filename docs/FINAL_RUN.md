FINAL RUN. One pass. Finish today. Push one branch and open a PR at the end.

STEP 0
Save this whole message, word for word, to docs/FINAL_RUN.md. Commit it. After any context reset, read docs/FINAL_RUN.md and docs/PROGRESS.md and continue from the first step that is not marked done in the "Final run" table in docs/PROGRESS.md. Create that table now. Columns: step, status, proof, commit.
Create the branch final/submission from release/candidate.

RULES (they override .agents/rules/00-mandate-contract.md and docs/RUNBOOK.md where they conflict)
1. Never write STOP, RESUME, or CONTINUE. Never ask a question. Never end your turn before step F9.
2. If a task fails twice: undo it with git revert, write it under Blocked in docs/PROGRESS.md, and go to the next task.
3. Keep invariants I1 to I15. Do not weaken or delete a test. Keep every flag OFF by default.
4. Tests never call a real model or the real PayPal sandbox. Two exceptions only: step F3 (one real-model eval) and step F5 (the live sandbox script). Sandbox only. Never live PayPal.
5. Push only in step F9. Push only the branch final/submission. Never push main. Never use force.
6. Never print or commit a secret, a cookie, an email address, or a personal file path.
7. After each step run gates:fast. Commit each task. Never squash. Never rewrite history.
8. Write plain English. No em dashes in any file or commit message.

F1 Security and privacy cleanup
a. Production web code must never read a key or a mode from the URL. Remove ?key= and ?mode= handling from web/src/lib/session.ts and api/src/dev/e2e-server.ts. A dev server may set a cookie instead. Add a test: the production build ignores ?key=.
b. Scan the working tree and the full git history. Use git log --all -p -G'<regex>' --oneline for each pattern: mnd_, AKIA, -----BEGIN, ghp_, sk-, Bearer , the shapes of Ollama and PayPal keys, email addresses, /Users/, C:\Users\. Write docs/SECRET_SCAN.md: pattern, hit count, files, and class. Class is "fixture" only if the value is in a test file or the allow list and works for no real service. When unsure, class it "real".
c. Replace local paths in tracked files with relative paths. Open every file in docs/evidence. Delete any image or JSON that shows a key, token, cookie, email, or personal path, then redo it clean. Make sure backups/, worktree folders, and .vitest are not tracked. Fix .gitignore.
d. Set HISTORY_CLEAN=true only if no "real" hit is in history. If one is: HISTORY_CLEAN=false, list the key names to rotate in docs/HUMAN_TODO.md, and do not push in F9. Do not rewrite history.

F2 Performance
a. Lazy-load AG Grid, AG Charts, and AG Studio so they load only on the Ledger and Control Room routes. Remove them from the precache and from the Welcome, Unlock, and Today bundles.
b. Build for production. Run Lighthouse with default mobile settings on Welcome, Unlock, and Today inside a demo (use a cookie or the demo start route, never a key in the URL). Print finalDisplayedUrl for each run. Check that the Today run is not the Unlock page. Save the runs in docs/evidence/q9/.
c. Target: Performance 90 or higher on Welcome and Unlock. Two attempts at most. Record the real scores, LCP, TBT, and every chunk over 1,000 kB in docs/PERF.md.

F3 Drafter eval
a. Find the failed prompt-injection case. Write down the wording, what the drafter returned, and what the code flagged. Add a scripted-model test for it. If the code lets it through, fix the code.
b. Make the token cap stop before the call that would pass the cap.
c. Run npm run eval:drafter once on the real model with EVAL_TOKEN_CAP=60000. Write the model name and every number in docs/EVAL.md. If there is no key, write "not run".

F4 Machine keys (P6.T3)
Finish it. New keys: mnd_ag_<workspace_id>_<secret> and mnd_cl_<workspace_id>_<secret>. Store HMAC-SHA256 with KEY_PEPPER. If KEY_PEPPER is unset, use a safe fallback and log one warning, and add the name to .env.example and preflight. Add expiry, daily limits, last used, and prefix display. Old keys keep working. Write tests first. The browser suite must stay green. If you cannot finish in two attempts, leave it partial and say so in one line in MASTER_PLAN, FINAL_REPORT, and PROGRESS.

F5 Live sandbox proof
Only if sandbox credentials are in the local env. Otherwise add the missing items to docs/HUMAN_TODO.md and go on.
a. Find how earlier live runs were done (scripts/, docs/KT.md, docs/REFERENCE.md). Add npm run live:proof. Never add it to the gates. It runs the frozen job against the real sandbox and saves redacted receipts in docs/live-proof/ (no tokens, no secrets, no emails). Skip any step that needs a human buyer login. Say which.
b. Try one real refund through the gated route on a captured payment. If none exists, write "not proven".
c. Update the Live proof page and the PayPal table in docs/REFERENCE.md with exactly what ran live. Claim nothing more.

F6 Submission documents (use only facts from the repo and the real test numbers)
- docs/DEVPOST.md: Inspiration, What it does, How we built it, Challenges, Accomplishments, What we learned, What is next, Built with, Try it. Include honest limits.
- docs/VIDEO_SCRIPT.md: under 3 minutes. A table of timed shots with the exact click path from docs/TRY_IT.md, voice-over lines of 20 words or fewer, and on-screen text. Show: the problem, the rule in words with flags, the standing-rule payout, a refusal, the emergency brake, passkey approval, and the receipt checked in the browser.
- docs/DECK.md: 8 slides. Title, 3 bullets at most, and one speaker note for each. Update pitch/ if it exists.
- docs/HUMAN_TODO.md: only what needs a person, with exact steps and minutes: model account limit, Render deploy and env list, TRUST_PROXY and the passkey RP ID domain, phone passkey test, record the video, submit on Devpost, key rotation if listed, merge the PR.

F7 Public repo readiness
Add a LICENSE (MIT) if none exists, and say so in the PR body. Add a 10-line Quick start to README.md that links to docs/TRY_IT.md. In SECURITY.md, say to report issues by opening a private security advisory on GitHub. Do not invent an email address. Make the numbers in README, PRODUCT.md, FINAL_REPORT, MASTER_PLAN, and DECISIONS match the final gate run.

F8 Final gates
In a fresh worktree from final/submission run npm ci and then npm run gates. Write the summaries in docs/PROGRESS.md and docs/FINAL_REPORT.md. If red after two fix attempts, revert the cause and run once more. Remove the worktree.

F9 Ship
a. Preconditions: HISTORY_CLEAN is true, git status is clean, no tracked file is over 5 MB, and git remote -v shows an origin.
b. Write docs/PR_BODY.md: Summary; What changed by area (identity and passkeys, demo workspaces, approvals and receipts, safety, rule tools, proof, ops, performance); How to try it (link docs/TRY_IT.md); Real test numbers; Flags (all off); Known limits; Human todo; Checklist.
c. If the preconditions hold: git push -u origin final/submission. Then gh pr create --base main --head final/submission --title "Mandate: final submission" --body-file docs/PR_BODY.md. Add --draft if the final gates were red. If gh is missing, print the compare URL built from the remote URL.
d. If a precondition fails: do not push. Write why in docs/HUMAN_TODO.md.
e. Print one last line: DONE <PR url, or compare url, or "not pushed: reason">. Then a summary of at most 15 lines: gate numbers, Lighthouse scores, eval numbers, what ran live, blocked items, and the human list.
