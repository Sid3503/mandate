# For judges: try Mandate in five minutes

Mandate is a spend-authority layer in front of PayPal. People and AI agents can *ask* to move money. Fixed rules decide. The owner says yes once to a rule, and taps for the exceptions. PayPal then moves exactly the locked cents. **PayPal sandbox only. No real money exists here.**

The one idea: escrow protects the client's money. Mandate decides what leaves yours, and only from client money that already settled.

## Get in
Open the hosted URL (or run it, see the [README](../README.md#run-it-real-paypal-sandbox-real-ai-model)) and unlock with the owner key from the Devpost testing instructions. The key can approve and settle in the sandbox, so it is not in this repository.

## The five-minute path
1. **Today → Try to break it.** Press the three buttons. Each runs a bad request through the real rules as a dry run: refused, with a rule code, and *PayPal was never called*.
2. **Deals → Let the agents negotiate.** Two companies' agents trade offers. $450 and $200 are refused; $300 in two milestones is agreed and signed.
3. **Jobs → open the job.** The track shows where it is and the one next step. Bill a milestone, approve it, and pay the invoice as the sandbox buyer. The page updates by itself when PayPal says it was paid.
4. **Pay the contractor.** $90 goes out through PayPal Payouts, only from the settled $150. Try the same payout *before* the client paid, and it is refused (`funding.missing`).
5. **System → Connect any agent.** Make an agent key with the MCP door scope and point your own MCP agent at it. Tell it to ignore its rules. It can only ask.
6. **Activity → Proof**, then open any receipt and press **Verify**. The check runs in your browser against public keys.
7. **Jobs → Share this job.** Create a status link for Priya, open it in a private window with no key, and see that she sees only her own payouts. Withdraw it and the same address stops working.

If the page looks stale or another judge has been here first, an owner can use **System → Start the demo over** (typed confirmation, sandbox only, keys stay valid).

## Where PayPal is used
Invoicing (Agent Toolkit: create, send, get, remind, cancel), Orders v2 (checkout fallback), Payouts v1 (pay the contractor, status read back, unclaimed cancel), Payments v2 refunds, transaction search, disputes (read), webhook signature verification, idempotent requests. The Agent Toolkit has no Payouts tool, so Payouts uses the REST API directly. Details: [docs/REFERENCE.md](REFERENCE.md#paypal-integration).

## Where AI is used, and what it cannot do
A clerk, two negotiators, a rules drafter with an auditor, and a client-side acceptance agent, on Ollama Cloud. The model reads rules and writes requests. Authority lives in code: the agent door has six tools and none can approve, pay or change rules. Fifty-six red-team cases assume a fully compromised model and check that PayPal is never asked.

## Honest limits
Sandbox only. A single-process SQLite database, so share a hosted copy sparingly. Refunds, signed webhook deliveries and an open-dispute hold are fake-tested, not yet proven on the live sandbox. See [PRODUCT.md](../PRODUCT.md#11-honest-limits).
