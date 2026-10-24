# phase-run

Run one phase of the Mandate plan. The human gives a phase number. Example: `/phase-run 3`.

1. Open `docs/MASTER_PLAN.md`. Read Section 2, Section 5, and the phase the human named. Do not read other phases.
2. Read the phase checklist. Skip tasks that are already ticked.
3. Check every item under "Assumptions to verify". Use the real code. If an assumption is false, stop. Report what you found and what you propose.
4. Write an implementation plan artifact. Include: files to change, files to add, migrations, flags, env vars, tests, risks, rollback. Mark it WAITING FOR APPROVAL. Stop.
5. After approval, create the branch `phase/<n>-<slug>`. If the phase has a migration, back up the database first.
6. Do the tasks in order. After each task: run the task gates, commit as `P<n>.T<k>: <text>`, tick the checkbox in the plan, and write a short task report.
7. At the end of the phase, run all phase gates from Section 5. Paste the real output summaries.
8. Write the phase report in the format from the contract. Stop. Do not start the next phase.

If the human gives no number, run `phase-run 0`.
