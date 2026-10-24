# Mobile and Phone PWA Verification Checklist

This document is the manual verification runbook for testing Mandate on real mobile hardware (iPhone with Face ID and Android with biometrics). Real phone WebAuthn cannot be automated in CI and requires human sign-off.

---

## 1. Prerequisites Before Real Device Testing

1. **Domain and HTTPS**:
   - WebAuthn on real devices refuses bare IP addresses and insecure HTTP.
   - The server must be deployed on a real hostname with valid TLS (e.g., `https://mandate.yourdomain.com`).
2. **Environment Configuration**:
   - `TRUST_PROXY=1` set on the host.
   - `WEBAUTHN_RP_ID` set to the domain hostname (e.g., `mandate.yourdomain.com`).
   - `WEBAUTHN_ORIGINS` set to the full HTTPS origin.
   - `COOKIE_SECURE=1` enabled on production HTTPS.

---

## 2. iPhone (iOS Safari & PWA) Verification Checklist

Perform these steps on a real iPhone running iOS 16 or newer:

- [ ] **Step 1: Welcome and Doors**
  - Open `https://<domain>/app/welcome` in Safari.
  - Verify layout fits portrait screen without horizontal scrolling.
  - Verify headline: "Agents can ask. Only you can pay."
  - Verify three door cards: Demo, New studio, API key.
  - Verify trust strip with link to `/verify`.

- [ ] **Step 2: Install as Standalone PWA**
  - Tap Safari Share sheet -> "Add to Home Screen".
  - Verify app icon (192x192 / maskable icon) and title "Mandate".
  - Tap "Add".
  - Launch Mandate from iPhone Home Screen.
  - Verify Safari URL bar and navigation controls are absent (standalone display mode).

- [ ] **Step 3: Studio Creation with Face ID**
  - In PWA, tap "Create a studio" door (`/app/studio`).
  - Enter studio name (e.g., "Line Studio Mobile").
  - Tap "Create and save a passkey".
  - Verify iOS system Face ID prompt appears ("Create a passkey for mandate...").
  - Authenticate with Face ID.
  - Verify "Studio ready" appears with key fingerprint.
  - Verify simulated PayPal banner displays ("PayPal here is simulated. No charge reaches PayPal.").

- [ ] **Step 4: Backup Requirement**
  - Verify Today cannot be opened yet.
  - Tap "Create recovery codes".
  - Verify 8 recovery codes are shown.
  - Tap "I saved these".
  - Skip or save rules in plain words.
  - Tap "Open Today".

- [ ] **Step 5: Mobile Navigation and Shell**
  - Verify bottom tab bar shows: Today, Jobs, Rules, Activity.
  - Verify touch targets are at least 44 by 44 points and comfortable to tap.
  - Verify topbar shows status chips (Live, PayPal sandbox/simulated).
  - Tap "Ask" in topbar: verify Ask sheet opens smoothly.

- [ ] **Step 6: Session Expiration & Face ID Unlock**
  - Lock console from System or allow session to expire.
  - Open `/app/unlock`.
  - Verify "Session expired" banner and "Biometric unlock" chip appear.
  - Verify primary button reads "Unlock with Face ID".
  - Tap "Unlock with Face ID": verify iOS Face ID prompt triggers.
  - Complete Face ID: verify immediate return to Today dashboard.

- [ ] **Step 7: Airplane Mode / Offline Behavior**
  - Enable Airplane mode on iPhone.
  - Observe top of screen: verify offline banner displays.
  - Verify message: "Offline. Reading what was already loaded. Nothing that moves money can be sent until you are back online."
  - Disable Airplane mode: verify Live reconnects.

---

## 3. Android (Chrome & PWA) Verification Checklist

Perform these steps on a modern Android device running Android 11 or newer:

- [ ] **Step 1: Installation**
  - Open `https://<domain>/app/welcome` in Chrome.
  - Tap Chrome menu (three dots) -> "Install app".
  - Confirm installation. Launch Mandate from App Drawer.
  - Verify standalone window with theme color `#050505`.

- [ ] **Step 2: Biometric Passkey Registration**
  - Select "Create a studio".
  - Enter studio name.
  - Tap "Create and save a passkey".
  - Verify Google Credential Manager prompt appears (Fingerprint / Screen Lock).
  - Authenticate with fingerprint or screen pattern.
  - Verify fingerprint generated and recovery codes issued.

- [ ] **Step 3: Mobile Interactions & Touch Targets**
  - Test role switcher in demo mode if enabled.
  - Tap tabs: Today, Jobs, Rules, Activity.
  - Test scrolling through long ledger entries.
  - Verify no overlapping text or obscured buttons.

- [ ] **Step 4: Expired Unlock**
  - Trigger lock or session expiration.
  - Verify "Unlock with Face ID" / biometric unlock button is visible and active.
  - Authenticate via device fingerprint and verify return to Today.

---

## 4. Unsupported Browser Fallback Test

- [ ] Open console in an embedded webview or legacy browser where WebAuthn is unavailable.
- [ ] Verify notice appears: "This browser does not support WebAuthn passkeys. Unlock using an API key below, or try in a modern browser."
- [ ] Verify API key entry remains functional as alternative access.

---

## 5. Sign-off Record

| Device | OS Version | Passkey Method | Tester | Date | Result |
|---|---|---|---|---|---|
| iPhone (e.g. 15 Pro) | iOS 17.x | Face ID | Human reviewer | | Pending |
| Android (e.g. Pixel 8) | Android 14 | Fingerprint | Human reviewer | | Pending |
