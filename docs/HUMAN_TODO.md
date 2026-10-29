# Human Todo Runbook

This document lists the human tasks required for production deployment and competition submission, complete with exact steps, estimated durations, and environment configurations.

---

## 1. Set AI Model Account Spending Limit
- **Estimated time**: 5 minutes
- **Tool**: Ollama / AI provider dashboard
- **Steps**:
  1. Log into your AI model provider console (or local Ollama host).
  2. Navigate to Billing and Usage Limits.
  3. Set a hard monthly spend ceiling (for example $20.00) to ensure models cannot exceed budgets even if automated requests spike.
  4. Verify that alert notifications are configured for 75% and 90% threshold usage.

---

## 2. Read the Gitleaks Scan Result
- **Estimated time**: 2 minutes
- **Tool**: `docs/SECRET_SCAN.md`
- **Status**: **HISTORY_CLEAN=true**. Zero keys require rotation.
- **Details**:
  - Independent scan executed via `gitleaks detect --source . --log-opts="--all" --redact`.
  - Exactly 3 hits detected across 171 commits (9.08 MB):
    1. `api/test/ops-cleanup-scheduler.test.ts:336` (Rule `generic-api-key`): test fixture idempotency header string.
    2. `api/test/ops-readyz-secret.test.ts:14` (Rule `private-key`): mock test string with trailing ellipsis.
    3. `web/src/lib/passkey-vector.json:9` (Rule `generic-api-key`): public RFC/W3C WebAuthn sample test vector.
  - All 3 hits are synthetic test fixtures. Zero live secrets or production credentials exist in git history.

---

## 3. Merge the Pull Request
- **Estimated time**: 3 minutes
- **Tool**: GitHub Pull Requests (`https://github.com/Sid3503/mandate/pull/13`)
- **Steps**:
  1. Review pull request 13 from `final/submission` into `main`.
  2. Verify all gates and status checks are green.
  3. Perform a merge commit or fast-forward merge without squashing commit history.

---

## 4. Render Deploy and Environment Configuration
- **Estimated time**: 20 minutes
- **Tool**: Render Dashboard (`https://dashboard.render.com`)
- **Instance Plan Notice**:
  - A persistent disk and no-sleep continuous uptime require a paid Render instance plan (such as Starter or Standard). Free plans have ephemeral disks that reset on restart and sleep after 15 minutes of inactivity. Check current Render plans before deploying.
- **Persistent Disk and Database Path**:
  - Persistent disk mount path: `/var/data`
  - Database path environment variable: `DATABASE_PATH=/var/data/mandate.sqlite`
  - Disk name in `render.yaml`: `mandate-data` (1 GB persistent storage).
- **Deployment Steps**:
  1. Click **New +** and select **Blueprint**.
  2. Connect your GitHub repository (`Sid3503/mandate`).
  3. Select branch `main` (or `final/submission` prior to merge).
  4. Render reads `render.yaml` and provisions the web service with persistent disk attached at `/var/data`.

### Render Environment Variables

Configure the following environment variables in the Render dashboard under Service Settings. Names only; never commit values.

#### Feature Flags
- `FLAG_TENANCY`: `1` (enables multi-tenant workspace isolation)
- `DEMO_ENABLED`: `1` (enables ephemeral sandbox demo workspace creation)
- `FLAG_PASSKEYS`: `1` (enables WebAuthn FIDO2 passkeys and cookie sessions)
- `FLAG_INVITES`: `1` (enables member invitation flows)
- `FLAG_PAYEE_BOOK`: `1` (enables payee cooling period and verification checks)
- `FLAG_STEPUP_APPROVE`: `1` (enables biometric passkey step-up on approvals)

#### Storage and Networking
- `NODE_ENV`: `production`
- `PORT`: `10000`
- `HOST`: `0.0.0.0`
- `DATABASE_PATH`: `/var/data/mandate.sqlite` (persists on `/var/data` disk mount)
- `PUBLIC_URL`: `https://<your-service>.onrender.com`
- `WEBAUTHN_RP_ID`: `<your-service>.onrender.com` (hostname only, no protocol or port)
- `WEBAUTHN_ORIGINS`: `https://<your-service>.onrender.com`
- `COOKIE_SECURE`: `1` (enforces HTTPS-only cookies in production)
- `TRUST_PROXY`: `1` (enables reverse proxy header extraction for client IP rate limiting)
- `TRUSTED_PROXY_HOPS`: `1` (number of proxy hops on Render)

#### Cryptographic Keys (Commands to generate random secrets)
- `MASTER_KEY`: 32-byte hex key for encrypting tenant keys at rest.
  Generate with: `openssl rand -hex 32`
- `KEY_PEPPER`: 32-byte hex pepper for HMAC-SHA256 machine key hashing.
  Generate with: `openssl rand -hex 32`
- `ADMIN_KEY`: 32-byte hex key for administrative console resets.
  Generate with: `openssl rand -hex 32`
- `API_KEY`: 32-byte hex key for direct owner unlock.
  Generate with: `openssl rand -hex 32`
- `PROPOSER_KEY`: 32-byte hex key for agent proposals.
  Generate with: `openssl rand -hex 32`
- `BUYER_AGENT_KEY`: 32-byte hex key for client buyer agent negotiations.
  Generate with: `openssl rand -hex 32`
- `SIGNING_KEY`: Ed25519 PKCS8 PEM private key for signing immutable receipts.
  Generate with: `node -e "console.log(require('crypto').generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}))"`

#### AI Model Configuration and Token Caps
- `OLLAMA_API_KEY`: Your Ollama Cloud API key.
- `OLLAMA_BASE_URL`: `https://ollama.com`
- `MODEL_GLOBAL_DAILY_TOKENS`: `500000` (global daily token cap across all workspaces)
- `MODEL_WORKSPACE_DAILY_TOKENS`: `30000` (daily token cap per individual workspace)

#### PayPal Sandbox Credentials
- `PAYPAL_CLIENT_ID`: Your PayPal developer sandbox application client ID.
- `PAYPAL_CLIENT_SECRET`: Your PayPal developer sandbox application client secret.
- `PAYPAL_API`: `https://api-m.sandbox.paypal.com`

#### Validation Script
Verify your environment variables locally before or during deployment:
```bash
npm run render:env
```

---

## 5. Run Smoke Test and Live URL Walkthrough
- **Estimated time**: 15 minutes
- **Tool**: Terminal and Web Browser
- **Automated Smoke Test**:
  Run the automated smoke test script against your live deployment URL:
  ```bash
  npm run smoke -- https://<your-service>.onrender.com
  ```
  The script verifies:
  1. `GET /healthz` returns HTTP 200.
  2. `GET /readyz` returns HTTP 200 with datastore ready.
  3. `GET /app/welcome` loads successfully.
  4. Security headers (`x-content-type-options: nosniff`, `x-frame-options: DENY`) are present.
  5. `POST /demo/start` generates an ephemeral workspace and issues a session cookie (never printing cookie values).
  6. Demo session reads workspace status as owner (`GET /w/:id/v1/status`).

- **Smoke Test on the Live URL (Ten-Step Click Path)**:
  1. **Visit Welcome Door**: Open `https://<your-service>.onrender.com/app/welcome`. Confirm the headline "Agents can ask. Only you can pay." and the trust strip are displayed.
  2. **Launch Demo Workspace**: Click the primary door button labeled **"Try the demo"**. The system creates an isolated ephemeral workspace pre-seeded with Line Studio proposals and rules.
  3. **Inspect the Demo Banner**: Confirm the status banner displays: "Simulated PayPal. No real money. Your demo ends in 24 hours." Note the live role switcher pills on the right.
  4. **Inspect Waiting Approval**: On the **Today** screen (`/app/`), examine the waiting payment card citing contractor Priya for $90.00. Review the cart hash, clause, and evidence URL.
  5. **Approve via Demo Tap**: Click the button labeled **"Demo tap"**. This tests the approval path safely without moving real funds.
  6. **Verify Signed Receipt**: Confirm the green toast notification ("Signed and sent") appears and the status updates to "Approved · locked" with an amber demo proof mark.
  7. **Switch to Proposer Role**: Click **"proposer"** in the top demo banner. Verify that you are redirected to **Ask Mandate** (`/app/clerk`), where agents can ask questions but cannot approve payouts.
  8. **Switch to Viewer Role**: Click **"viewer"** in the banner. Verify that you are routed to the **Proof** screen (`/app/proof`) in read-only audit mode.
  9. **Inspect Guarantees and Replay**: On the Proof screen, inspect the list of 23 verified Mandate Guarantees. Click **"Verify receipt offline"** to inspect offline ES256 verification.
  10. **Reset the Demo Workspace**: Switch the role back to **"owner"**, click **"Reset demo"**, type `reset the demo`, and confirm. Verify that the ledger and rules return cleanly to template state.

---

## 6. Mobile Phone Passkey Verification Test
- **Estimated time**: 15 minutes
- **Tool**: iPhone (Safari / Face ID) or Android (Chrome / Biometrics)
- **Steps**:
  1. Open mobile browser to `https://<your-service>.onrender.com/app/welcome`.
  2. Follow the test runbook in `docs/PHONE_CHECKLIST.md`.
  3. Tap **"Create a studio"** and enroll a new passkey using device biometrics (Face ID or fingerprint).
  4. Confirm that the 16-character credential fingerprint is displayed.
  5. Close browser tab to expire the in-memory session.
  6. Reopen `/app/unlock` and tap **"Unlock with Face ID / Touch ID"**.
  7. Confirm that the biometric challenge succeeds and routes to the Today dashboard.

---

## 7. Register PayPal Webhook and Configure PAYPAL_WEBHOOK_ID
- **Estimated time**: 10 minutes
- **Tool**: PayPal Developer Dashboard (`https://developer.paypal.com/dashboard/applications/sandbox`)
- **Steps**:
  1. Log into PayPal Developer Dashboard and select your sandbox application.
  2. Scroll to **Webhooks** and click **Add Webhook**.
  3. Set Webhook URL to: `https://<your-service>.onrender.com/v1/webhooks/paypal`
  4. Select event notifications:
     - `PAYMENT.CAPTURE.COMPLETED`
     - `PAYMENT.CAPTURE.DENIED`
     - `PAYMENT.CAPTURE.REFUNDED`
     - `PAYMENT.PAYOUTS-ITEM.SUCCESS`
     - `PAYMENT.PAYOUTS-ITEM.FAILED`
     - `PAYMENT.PAYOUTS-ITEM.UNCLAIMED`
     - `INVOICING.INVOICE.PAID`
     - `INVOICING.INVOICE.CANCELLED`
  5. Save the webhook and copy the generated **Webhook ID**.
  6. In Render Dashboard, add the environment variable `PAYPAL_WEBHOOK_ID=<your-webhook-id>`.
  7. Trigger a redeploy to apply the webhook ID.

---

## 8. Run PageSpeed Insights on Live URL
- **Estimated time**: 5 minutes
- **Tool**: Google PageSpeed Insights (`https://pagespeed.web.dev/`)
- **Steps**:
  1. Open PageSpeed Insights.
  2. Analyze `https://<your-service>.onrender.com/app/welcome`.
  3. Analyze `https://<your-service>.onrender.com/app/unlock`.
  4. Verify mobile performance scores align with documented benchmarks (Welcome 90, Unlock 88).

---

## 9. Record and Upload Demo Video
- **Estimated time**: 60 to 90 minutes
- **Tool**: OBS Studio / QuickTime Screen Recording, YouTube
- **Steps**:
  1. Open `docs/VIDEO_SCRIPT.md` and read through the 12 timed storyboard shots.
  2. Warm up the hosted demo environment by visiting `/demo/start`.
  3. Record the screen at 1920x1080 resolution following the exact shots.
  4. Ensure audio voice-over matches the scripted lines (all <= 20 words per shot).
  5. Verify total video duration is under 3 minutes (the current film, `pitch/video/mandate-pitch.mp4`, is 2:57.5).
  6. Upload the video to YouTube as Unlisted or Public.

---

## 9b. Try the browser sign-in with Claude.ai (optional, worth doing before judging)
- **Estimated time**: 15 minutes
- **Why**: The OAuth flow is checked with the official MCP SDK client (`cd api && MANDATE_OWNER_KEY=<owner key> npm run check:oauth -- <https address>`), but not with Claude.ai or ChatGPT themselves. They need a public https address.
- **Steps**:
  1. Serve Mandate on a public https address (the hosted demo, or `ngrok http 8787` with the server started with `E2E_PUBLIC_URL=<that address>` and your own `E2E_OWNER_KEY` for a throwaway demo server).
  2. In Claude.ai, add a custom connector with `<address>/mcp` and leave the key blank.
  3. When it opens the approval page, unlock the console on the same address and approve **Look only**.
  4. Ask Claude "What are my rules?" It should answer, and it should not be able to propose a payment.
  5. Check Connect an agent: the connection shows as "Claude (sign-in)". Revoke it.
- **If it fails**: note the step and the error, and it is a bug to fix before judging. It is not in the demo video, so the video does not depend on it.

---

## 10. Submit Devpost Entry
- **Estimated time**: 30 minutes
- **Tool**: Devpost Hackathon Submission Form
- **Steps**:
  1. Open your Devpost submission draft for the PayPal AI Hackathon.
  2. Copy markdown sections directly from `docs/DEVPOST.md`.
  3. Paste the public GitHub repository URL (`https://github.com/Sid3503/mandate`).
  4. Paste the YouTube video link.
  5. Paste the hosted demo URL (`https://<your-service>.onrender.com/app/welcome`).
  6. Review all questions and submit before the hackathon deadline.
