# Human Todo Runbook

This document lists tasks that require human execution for production deployment and competition submission, complete with estimated durations and exact steps.

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

## 2. Deploy Web Service and Database to Render
- **Estimated time**: 15 minutes
- **Tool**: Render Dashboard (`https://dashboard.render.com`)
- **Steps**:
  1. Click **New +** and select **Blueprint**.
  2. Connect your GitHub repository (`paypal-ai-hack`).
  3. Select branch `final/submission` (or `main` after merging).
  4. Render reads `render.yaml` and initializes the web service with attached persistent disk storage at `/data`.
  5. Configure the following required environment variables under Service Settings:
     - `PAYPAL_CLIENT_ID`: Your PayPal developer sandbox client ID.
     - `PAYPAL_CLIENT_SECRET`: Your PayPal developer sandbox client secret.
     - `PAYPAL_API`: `https://api-m.sandbox.paypal.com`
     - `KEY_PEPPER`: A 64-character random hex string for HMAC-SHA256 machine key hashing (e.g. generated via `openssl rand -hex 32`).
     - `DEMO_ENABLED`: `true`
     - `FLAG_TENANCY`: `true`
     - `FLAG_PASSKEYS`: `true`
     - `COOKIE_SECURE`: `true`
     - `PORT`: `10000`

---

## 3. Configure TRUST_PROXY and Passkey RP ID Domain
- **Estimated time**: 5 minutes
- **Tool**: Render Environment Settings
- **Steps**:
  1. Once Render assigns your service URL (for example `https://mandate-api.onrender.com`), configure:
     - `PUBLIC_URL`: `https://mandate-api.onrender.com`
     - `WEBAUTHN_RP_ID`: `mandate-api.onrender.com` (or your custom apex domain)
     - `WEBAUTHN_ORIGINS`: `https://mandate-api.onrender.com`
     - `TRUST_PROXY`: `true`
     - `TRUSTED_PROXY_HOPS`: `1`
  2. Save changes and trigger a manual redeploy.
  3. Check `GET /ready` to confirm the service answers with HTTP 200 and healthy SQLite status.

---

## 4. Mobile Phone Passkey Verification Test
- **Estimated time**: 10 minutes
- **Tool**: iPhone (Safari / Face ID) or Android (Chrome / Fingerprint)
- **Steps**:
  1. Open your mobile browser and navigate to `https://mandate-api.onrender.com/app/welcome`.
  2. Follow the test runbook in `docs/PHONE_CHECKLIST.md`.
  3. Register a new passkey using device biometrics (Face ID or fingerprint sensor).
  4. Close the browser tab to expire the in-memory session.
  5. Open `/app/unlock` and click **"Unlock with Face ID / Touch ID"**.
  6. Confirm that the biometric prompt succeeds and takes you directly to the Today dashboard.

---

## 5. Record and Upload Demo Video
- **Estimated time**: 30 minutes
- **Tool**: OBS Studio / QuickTime Screen Recording, YouTube
- **Steps**:
  1. Open `docs/VIDEO_SCRIPT.md` and read through the timed storyboard.
  2. Warm up the hosted demo environment by visiting `/demo/start`.
  3. Record the screen at 1920x1080 resolution following the exact 12 storyboard shots.
  4. Ensure audio voice-over matches the scripted lines (all <= 20 words per shot).
  5. Verify total video duration is under 3 minutes (target: 2:45).
  6. Upload the video to YouTube as Unlisted or Public.

---

## 6. Submit Devpost Entry
- **Estimated time**: 15 minutes
- **Tool**: Devpost Hackathon Submission Form
- **Steps**:
  1. Open your Devpost submission draft for the PayPal AI Hackathon.
  2. Copy markdown sections directly from `docs/DEVPOST.md`.
  3. Paste the public GitHub repository URL.
  4. Paste the YouTube video link.
  5. Paste the hosted demo URL (`https://mandate-api.onrender.com/app/welcome`).
  6. Review all questions and submit before the hackathon deadline.

---

## 7. Key Rotation Status
- **Estimated time**: 2 minutes
- **Status**: **Zero keys require rotation**.
- **Proof**: Full git history scan confirmed `HISTORY_CLEAN=true` in `docs/SECRET_SCAN.md`. No real tokens, API secrets, cookies, or personal paths exist in git history.

---

## 8. Merge Pull Request
- **Estimated time**: 3 minutes
- **Tool**: GitHub Pull Requests
- **Steps**:
  1. Review the pull request opened from `final/submission` to `main`.
  2. Verify all status checks and gates are green.
  3. Perform a fast-forward merge or merge commit without squashing history.
