# Projects: paid on approval

The work waits sealed. The money waits held. A studio is paid when its client approves the work, and a client pays
only for work they have seen. Projects is how Mandate does that, on the same engine that already decides every payment: the gate, the signed lock, the funding
rule, the contractor share, the audit.

## The flow

| Step | Who | What happens | What makes it safe |
| --- | --- | --- | --- |
| Brief in | Studio | Paste the client's DM, email or call notes, or attach a PDF, Word file or screenshot. A model drafts 2–5 priced, dated stages and up to three questions worth asking. | Code reads the plan back against the brief: over the stated budget (red), past the stated deadline (red), a count the client never wrote ("3 logo concepts" when they said "a logo", amber), dates out of order. Every field stays editable. No model: plain rules split the brief, and say so. |
| Plan out | Studio | Create and send. The client gets a private link: no account, no app. | The studio's Ed25519 signature covers the plan's hash (`mandate:plan:v1`). A new client is added to the rules as a new rules version (owner only). |
| Approve | Client | Approve the plan, or ask for changes. | Their answer is recorded and signed against that exact version (`mandate:plan-decision:v1`). The approved plan becomes a **signed deal** on the project's job, so the gate refuses any bill on the job that is not one of its stages, once, for its exact price. Changing the plan later sends a new version back with a per-stage diff; open stages cannot be paid until it is approved again; stages under way cannot change. |
| Deliver sealed | Studio | Upload the stage's files and send them for review. | Each file's real type is read from its bytes; each is fingerprinted (SHA-256). The files become a **manifest**, and the manifest's hash is the proof on the stage's bill, so the **signed lock covers the exact bytes delivered**. The bill goes through the gate like any other (`deal.*`, ceiling, cap, risk); a bill at or above the automatic line waits for the owner's tap. |
| Check | Both | A check against the plan, shown to both sides before any money moves. | Rules prove file facts (counts, formats, pixel sizes, duplicates, empty files). A vision model (gemma4:31b) looks at the images and **can only add doubt**: it never marks anything as delivered, and its lines are labelled. |
| Pay into a hold | Client | "Pay $400 into hold": PayPal's own buttons or card fields, on the page. | The order is made from the lock with `intent: AUTHORIZE`. The server re-reads it (amount, currency, `custom_id`) and the card's 3-D Secure answer before authorizing. The money is reserved on the client's side: the charge is in phase `authorized`, **which is not funded**: no contractor payout may cite it. Nobody but the release path can capture it: the owner's Settle button gets `409 hold.client_decides`. |
| Review | Client | Sealed thumbnails before paying; while held, a watermarked review copy and full-resolution close-ups. | The original never leaves the server before capture. A review copy is made per viewing session, at most 1200 px, with the client's name, email, the time and a session code across it; close-ups are 300 px squares, 12 per session. Views and close-ups are logged and shown to the studio. |
| Decide | Client | Approve and release, or request changes. | Approval is signed over the latest delivery's manifest (`mandate:release:v1`) **before** PayPal is called, then the hold is captured through the gate's own capture path (lock and signature re-verified). If PayPal fails, the decision stands and the sweep finishes it. Changes keep the money held and give the studio a revision deadline. |
| Windows | Both | Agreed in the plan: review window (default 3 days) and revision window (default 3 days). | Silence past the review window releases the money (signed as `review_window`), so a client cannot stall a studio. A missed revision deadline lets the client cancel: the hold is **voided** and they were never charged. Past PayPal's 3-day honor period the hold is reauthorized once before capture; an authorization past its 29-day life is recorded as expired. |
| Unlock | Client | Files unlock; "Download all"; a receipt with the PayPal capture and hold ids and the released manifest's hash. | Originals are served only when the stage's charge is in a funded phase, and only files of the final round. The client can check each download's SHA-256 against the manifest. |
| Paid out | Studio | The capture settles like any client payment. | With a standing rule and `payOnSettle`, the contractor's share (Priya's 60%) is asked for and paid from the captured money, through the gate, with no tap. |
| Reputation | Client | Only a client who paid can leave a review. | The review is signed together with the PayPal capture ids that prove payment (`mandate:review:v1`). The public profile shows only reviews whose signature and captures verify, and a track record counted from captured payments, never typed numbers. |

The studio side also has: the "You're owed $X. $Y of it is overdue, from Z." headline with banked, held and this month's money; a progress dial per project; an activity feed; AI-written payment reminders that get firmer each time (friendly → firm → final), which the studio reads and sends itself, with every figure checked against the facts given to the model.

## What this proves on the real sandbox

A full run on the PayPal sandbox with the live models (gpt-oss:20b drafting, gemma4:31b looking at images):
plan drafted to the stated $1,400 budget and 3-week deadline; approved on the link; two concepts delivered and
checked; owner tapped the bill; client paid $400 by card into a hold (authorization `2E222329GY086481C`, honor until
three days later, expiry 29 days later); review copy and close-up opened; changes asked; three concepts sent as round
2; client approved; hold captured (`2W857145A5341332A`, PayPal fee $10.85, net $389.15); release signature valid; the
downloaded original's SHA-256 equals the uploaded file's; a 5-star review verified against the capture.

## Where it lives

- `api/src/domain/project.ts`: pure functions: plan terms and hash, manifests, file sniffing, the rule check, brief facts, plan flags, money summary.
- `api/src/services/projects.ts`: the project desk. `api/src/db/projects.ts`: its tables (migration `0008_projects_and_holds`).
- `api/src/services/mandate.ts`: holds: `settleHold`, `captureHold`, `releaseHold`, `voidHold`, `refreshHolds`; phases `authorized` and `voided` in `domain/phases.ts`.
- `api/src/paypal/client.ts`: `intent: AUTHORIZE`, authorize, capture authorization, void, reauthorize.
- `api/src/services/sealed.ts`: sealed thumbnails, watermarked review copies, close-ups (sharp).
- `api/src/agents/projectAgents.ts`: drafting, the image look, reminders. `api/src/services/briefImport.ts`: PDF, Word, text, screenshot.
- Console: `/app/projects`, `/app/projects/new`, `/app/projects/:id`; client page `/app/c/:token`; public profile `/app/u/:handle`.
- Tests: `api/test/projects.test.ts` (whole job, auto-release, void, reauthorize, re-approval, refusals, project deals off the old billing path, pure functions).

## Honest limits

- The client's approval and release are recorded and signed **by the server** when the client acts on their link. A client who wants their own key can use the client-agent door; the link alone cannot prove who held it.
- Watermarks and session codes make a screenshot traceable; nothing on the web stops someone photographing a screen. The guarantee is that the original is never sent before capture.
- Reminders are drafted, not sent: Mandate does not send email. The studio copies or opens it in their mail app.
- The studio is the merchant: the client's money is held on PayPal for the studio's own account, and contractors are paid from captured money by Payouts. Mandate never holds third-party funds.
