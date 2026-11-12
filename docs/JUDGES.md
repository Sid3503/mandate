# For judges: try Mandate in five minutes

Mandate is a spend-authority layer in front of PayPal. People and AI agents can *ask* to move money. Fixed rules decide. The owner says yes once to a rule, and taps for the exceptions. PayPal then moves exactly the locked cents. **PayPal sandbox only. No real money exists here.**

The one idea: escrow protects the client's money. Mandate decides what leaves yours, and only from client money that already settled. For project work it also covers the money coming in: the client pays each stage into a PayPal hold and releases it when they approve the work.

## Get in
Open the hosted URL and press **Try the demo**: no key, your own workspace for a day, on a **simulated PayPal** that the header labels as such. For the real PayPal sandbox, press **Create your studio** on the same page (one passkey), unlock with the owner key from the Devpost testing instructions, or run it yourself (see the [README](../README.md#run-it-real-paypal-sandbox-real-ai-model)). The owner key can approve and settle in the sandbox, so it is not in this repository.

## The five-minute path
1. **Today → Try to break it.** Press the three buttons. Each runs a bad request through the real rules as a dry run: refused, with a rule code, and *PayPal was never called*. On the same page, **Blast radius** shows the most that could ever leave with no tap, and **Attack my rules** throws a hostile proposer at the live rules and suggests the fix.
2. **Deals → Let the negotiators negotiate.** Two companies' negotiators trade offers, move by move, each deciding on its own judgement inside its own company's private limits. It ends when one accepts the other's exact offer (then the deal is signed), a side walks away, or the deadline passes. Each side is then told how the price compares with its own walk-away and target, and its negotiator writes it a debrief. How it works: [docs/NEGOTIATION.md](NEGOTIATION.md).
3. **Jobs → open the job.** The track shows where it is and the one next step. Bill a milestone and approve it, then choose how the client pays: **an invoice** (settles only when PayPal says `PAID`) or **a card on our own page** (PayPal's card fields inside the bill; the server re-reads the order and refuses to capture on any mismatch). Either way the page updates by itself when PayPal says it was paid.
4. **Pay the contractor.** $90 goes out through PayPal Payouts, only from the settled $150. Try the same payout *before* the client paid, and it is refused (`funding.missing`).
5. **System → Connect an agent.** Name it, keep *Read and ask*, press **Create the key**, then **Check the connection from here**. Paste the Claude Code command (the key is already in it) into your own MCP agent and tell it to ignore its rules. It can only ask.
6. **Activity → Proof**, then open any receipt and press **Verify**. The check runs in your browser against public keys.
7. **Projects → New project → Use an example → Plan the payments.** A model drafts paid stages and code checks them against the brief. Create and send it, then **Open the client's view**: approve the plan as the client. Back as the studio, add an image to a stage, **Check against the plan**, and **Send for review, sealed**. As the client: blurred previews, then pay the stage into a hold, review the watermarked copy, and **Approve and release**; the files unlock. Paying by card needs the real sandbox, so do this step in a studio you created or with the owner key: the *Try the demo* workspace's simulated PayPal cannot take a card. How it works: [docs/PROJECTS.md](PROJECTS.md).
8. **Jobs → Share this job.** Create a status link for Priya, open it in a private window with no key, and see that she sees only her own payouts. Withdraw it and the same address stops working.

If the page looks stale or another judge has been here first, an owner can use **System → Start the demo over** (typed confirmation, sandbox only, keys stay valid).

## Where PayPal is used
Invoicing (Agent Toolkit: create, send, get, remind, cancel), Orders v2 (checkout, card fields on our own page, and `AUTHORIZE` holds that only the client's approval captures, with void and reauthorize), Payouts v1 (pay the contractor, status read back, unclaimed cancel), Payments v2 refunds, transaction search, disputes (read), webhook signature verification, idempotent requests. The Agent Toolkit has no Payouts tool, so Payouts uses the REST API directly. Details: [docs/REFERENCE.md](REFERENCE.md#paypal-integration).

## Where AI is used, and what it cannot do
A clerk, two negotiators, a rules drafter with an auditor, a client-side acceptance agent, a project planner, and a look at delivered images that can only add doubt, on Ollama Cloud. The model reads rules and writes requests. Authority lives in code: the agent door has thirteen tools and none can approve, pay or change rules. Forty-six red-team cases assume a fully compromised model and check that PayPal is never asked.

## Honest limits
Sandbox only. A single-process SQLite database, so share a hosted copy sparingly. Refunds ran live (`12C310409G863064M`); signed webhook deliveries and an open-dispute hold are fake-tested, not yet proven on the live sandbox. A free hosted instance is ephemeral: it sleeps and wipes its ledger on restart. See [PRODUCT.md](../PRODUCT.md#11-honest-limits).
