# Try Mandate

This guide gives the exact environment variables, commands to launch Mandate with multi-tenancy, hosted demos, and WebAuthn passkeys enabled, followed by an end-to-end 10-step click path that any first-time visitor can follow in a standard browser.

---

## 1. Prerequisites and Setup

Ensure Node.js 24+ is installed. Clone the repository and install all dependencies:

```bash
# Install root and workspace dependencies
npm ci
npm --prefix api ci
npm --prefix web ci

# Build frontend production bundle
npm run build
```

---

## 2. Launch Commands and Environment

To run the full stack with tenancy, demo creation, and passkeys enabled on `localhost:8777`:

```bash
# Launch the dev passkey server with tenancy and demo enabled
PORT=8777 \
FLAG_TENANCY=1 \
DEMO_ENABLED=1 \
FLAG_PASSKEYS=1 \
FLAG_INVITES=1 \
FLAG_PAYEE_BOOK=1 \
WEBAUTHN_RP_ID=localhost \
WEBAUTHN_ORIGINS=http://localhost:8777 \
COOKIE_SECURE=0 \
TRUST_PROXY=0 \
node api/node_modules/tsx/dist/cli.mjs api/src/dev/passkey-server.ts
```

The server listens on `http://localhost:8777`.

---

## 3. Ten-Step Walkthrough

Follow these 10 steps in Google Chrome, Microsoft Edge, or Apple Safari:

1. **Visit Welcome Door**: Open `http://localhost:8777/app/welcome`. You will see the headline "Agents can ask. Only you can pay." and the trust strip confirming sandbox operation and zero AI money movement.
2. **Launch Demo Workspace**: Click the primary door button labeled **"Try the demo"**. The system generates a sandboxed, ephemeral workspace with pre-seeded Line Studio proposals and rules.
3. **Inspect the Demo Banner**: Observe the yellow status banner at the top of the Today screen: "Simulated PayPal. No real money. Your demo ends in 24 hours." Notice the live role switcher pills on the right.
4. **Inspect Waiting Approval**: On the **Today** screen (`/app/`), examine the waiting payment card citing contractor Priya for $90.00. Review the cart hash, clause, and evidence URL.
5. **Approve via Demo Tap**: Click the button labeled **"Demo tap"**. This exercises the approval flow without touching real money.
6. **Verify Signed Receipt**: Observe the green toast notification ("Signed and sent") and note that the proposal status updates to "Approved · locked" with an amber demo proof mark.
7. **Switch to Proposer Role**: In the top demo banner, click the **"proposer"** role button. Notice that your authority immediately steps down: you are automatically routed to **Ask Mandate** (`/app/clerk`), where agents can ask questions but cannot approve payouts.
8. **Switch to Viewer Role**: In the demo banner, click the **"viewer"** role button. Notice that you are routed to the **Proof** screen (`/app/proof`) in read-only audit mode.
9. **Inspect Guarantees and Replay**: On the Proof screen, inspect the list of 20 verified Mandate Guarantees. Click **"Verify receipt offline"** to inspect the offline ES256 cryptographic signature without pinging the server.
10. **Reset the Demo Workspace**: Switch the role back to **"owner"**, click **"Reset demo"** in the demo banner, type `reset the demo` into the confirmation modal, and submit. The ledger and rules cleanly reset back to the pristine template state.
