# Changelog

## Unreleased

- Members: `POST /v1/members/{id}/role` and `POST /v1/members/{id}/revoke`. The last owner stays. Revoke ends sessions and passkeys and lists open requests. `npm run admin:reset-owner` writes an `admin_audit` event. The screen is `/app/members`.
- Invites: `POST /v1/invites/revoke`. The join page names the inviter and the role. Creating an invite needs a passkey when the studio rule is on.
- Unlock has "Sign in with a passkey" for a studio that already enrolled one.
- Passkeys on the account: `GET /auth/credentials` and `POST /auth/credentials/revoke`. The last passkey stays. Another member's id is not found. The screen is `/app/sessions`.
- Recovery codes: `POST /auth/recovery/issue`, `POST /auth/recovery/ack` ("I saved these"), and `POST /auth/recovery/regenerate` with a passkey step-up. Codes are hashed. A used code fails the second time.
- Sessions: `GET /auth/sessions`, `POST /auth/sessions/revoke`, `POST /auth/sessions/revoke-others`, and owner `GET /auth/events`. The list does not return the session token. The screen is `/app/sessions`.
- `POST /ops/model/resume` clears the model kill with the admin key. The day's token counters stay.
- Phase 0. `npm run gates` and `npm run gates:fast`. A secret check over tracked files. `GET /v1/flags` for the owner. Switches on the System screen. `backups/` is gitignored. Planned flag names are listed in `api/.env.example` as placeholders.
- Phases 1 to 12, flags off. Per-workspace apps, demo start, passkeys, invites, a payee book, rule simulate, model budget and kill switch, classed limits when `TRUST_PROXY=1`, backup and restore scripts, and three welcome doors. Studio and demo PayPal is fake. Log in with PayPal was not built. Browser tests and Lighthouse were not re-run.
