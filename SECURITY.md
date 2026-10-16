# Security Policy

## Reporting Security Issues

We take the security of Mandate very seriously. If you discover or suspect a security vulnerability:

- **Do not open a public GitHub issue.**
- **Report issues privately by opening a Private Security Advisory on GitHub:**
  Navigate to the **Security** tab of this repository on GitHub and click **"Report a vulnerability"** (GitHub Private Vulnerability Reporting).

Please provide detailed reproduction steps, relevant request shapes, and an assessment of the impact. We will investigate promptly and coordinate any necessary fixes.

## Threat Model and Architecture

Mandate is designed from the ground up as a deterministic spend boundary for AI agents:
- Pure evaluation gate without model calls.
- Money in releases money out: contractor payouts require settled client funding.
- Biometric WebAuthn passkeys for high-stakes approvals.
- Full details of our 14-item security checklist and verification evidence are documented in [docs/SECURITY.md](docs/SECURITY.md).
