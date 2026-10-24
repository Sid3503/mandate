# Mandate Onboarding Guide

Mandate is a spend-authority layer placed in front of PayPal. It guarantees that AI models and team members can ask to spend, but only deterministic, versioned rules can authorize money to move. PayPal executes only the exact integer cents approved by the owner.

---

## 1. Core Architecture and Philosophy

- **AI Only Adds Friction:** No AI model can approve, pay, send, refund, modify rules, or override a refusal. Models are limited to proposing structured requests or summarizing data.
- **Pure Deterministic Decisions:** Spending evaluations are pure, synchronous functions that execute with zero network I/O.
- **Cart Immutability:** Once a payment proposal is approved, payee, amount in cents, proof link, job reference, and funding locks are cryptographically sealed into a hash. Any subsequent tampering produces an immediate 409 error.
- **Settled Funding Before Payouts:** Subcontractors are paid only from client money that has already settled on the exact same job.
- **Cryptographic Receipts:** Every payment and decision generates an independently verifiable receipt that can be validated offline without trusting the server.

---

## 2. The Three Entry Doors

When you open Mandate, you are presented with three distinct paths tailored to different operational needs:

1. **Explore the Demo:**
   - Launch an instant, isolated in-memory workspace.
   - Operates with simulated PayPal and pre-loaded sample milestones.
   - Includes a guided walkthrough of negotiating deals and executing contractor splits.
   - Automatically expires after 24 hours (or the configured `DEMO_TTL_HOURS`).

2. **Create a Studio:**
   - Designed for production-style usage with device passkeys (WebAuthn / Face ID).
   - Starts with simulated PayPal so you can safely test policies without risking real accounts.
   - Requires generating and backing up one-time recovery codes.
   - Workspaces and ledgers are preserved permanently on persistent storage mounted at `/var/data` (`DATABASE_PATH=/var/data/mandate.sqlite`).

3. **Unlock Console (Default Studio):**
   - Direct access using an Owner API Key.
   - Connected to the live PayPal developer sandbox.
   - Full access to live sandbox orders, invoicing, payouts, and dispute resolution.

---

## 3. Roles and Authority Matrix

Mandate enforces least-privilege role boundaries across both human operators and automated agents:

| Role | Description | Allowed Actions | Restricted Actions |
| --- | --- | --- | --- |
| **Owner** | Primary human operator holding spend authority | Authorize payments, publish rules, invite members, issue agent keys, step-up biometric auth | Cannot alter settled immutable receipts |
| **Proposer** | Team members or AI agents | Submit proposals, bill milestones, ask clerk questions, read public status | Cannot approve proposals, pay, refund, or edit rules |
| **Viewer** | External auditor or client representative | Inspect job ledger, verify cryptographic proof, read receipt hashes | Cannot submit requests or modify state |
| **Payee** | Contractor or vendor recipient | View invoice status, check payout delivery status, download receipts | Cannot propose or approve charges |

---

## 4. Setting Up Passkeys and Device Security

Mandate supports WebAuthn FIDO2 passkeys for passwordless authentication and step-up authorization:

1. **Enrolling a Passkey:**
   - On the studio registration screen, enter your studio name and select **Create and save a passkey**.
   - Your browser prompts for biometric confirmation (Face ID, Touch ID, or hardware security key).
   - Upon completion, the screen displays a 16-character hexadecimal fingerprint (e.g. `a1b2c3d4e5f60718`). Save this fingerprint for receipt verification.
2. **Backing Up Recovery Codes:**
   - Generate eight emergency recovery codes.
   - Store them securely in a password manager.
   - Confirm by selecting **I saved these**.
3. **Step-Up Authentication for Sensitive Actions:**
   - By default on new studios, sensitive operations require a fresh biometric assertion:
     - Approving payments
     - Publishing new spending rules
     - Creating member invites
     - Resetting agent keys or client secrets
   - Step-up grants are cryptographically bound to the active member, request hash, and an expiry window of 120 seconds.

---

## 5. Connecting AI Agents via the Model Context Protocol (MCP)

Mandate exposes a standard Model Context Protocol (MCP) endpoint at `/mcp` for Claude, OpenAI, and custom AI agents:

1. **Obtaining an Agent Key:**
   - Navigate to **System -> Connect an agent** in the console.
   - Select the required capabilities (e.g. `agent:ask`, `agent:propose`).
   - Copy the generated `mnd_ag_...` key.
2. **Configuring Your MCP Client:**
   ```json
   {
     "mcpServers": {
       "mandate": {
         "url": "http://127.0.0.1:8787/mcp",
         "headers": {
           "Authorization": "Bearer mnd_ag_your_key_here"
         }
       }
     }
   }
   ```
3. **Strict MCP Tool Boundaries:**
   - Agents can access read tools (`mandate_status`, `mandate_read_warrant`, `mandate_proposals`).
   - Agents can submit proposals (`mandate_propose_payment`).
   - Agents CANNOT approve or move money. Any model attempting to settle a payment receives a deterministic refusal.

---

## 6. End-to-End Walkthrough: Milestone 1 Billing to Payout

Here is the standard workflow executed by Line Studio:

1. **Deal Agreement:** Two agents negotiate terms for a $300 job across two $150 milestones. Both companies' rule sets are checked. The deal is signed.
2. **Milestone Billing:** Milestone 1 ($150) is billed. The proposal checks the warrant:
   - $150 <= milestone cap ($200) -> Gate evaluates to **NEEDS_APPROVAL**.
3. **Owner Approval:** The owner verifies the milestone proof link and taps **Approve**. The request is locked into a canonical SHA-256 cart hash.
4. **Client Settle:** The client pays the $150 PayPal invoice. When PayPal confirms settlement, the job balance registers $150 in settled funds.
5. **Contractor Payout:** The system proposes Priya's 60% share ($90). Because $150 in client funds has settled on this exact job, the gate allows the payout. The owner approves, and PayPal Payouts delivers $90 directly to Priya.
6. **Receipt Download:** Download the completed receipt JSON and paste it into `/app/verify` to verify the cryptographic signatures offline.
