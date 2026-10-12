# How long data stays

- A demo workspace expires after `DEMO_TTL_HOURS` (24 by default). Cleanup may remove a row only when its mode is `demo`. It does not remove the default studio or a studio workspace.
- The default studio ledger is the file at `DATABASE_PATH`. On the free host that file is ephemeral and a restart reseeds it.
- `model_budget` and `model_budget_kill` sit on that same ledger. They keep the day's token counts and an ops kill across a process restart. `MODEL_ENABLED=0` pauses the current process only and does not write the kill row. `POST /ops/model/resume` with the admin key clears that kill row and lets the clerk run again in this process. A boot with the model flag off calls `pause()` again, so resume does not outlive that flag.
- Auth events live in `control.sqlite` next to that file. This server does not trim them on a timer. `workspaces.passkey_for_money` is 0 on the default studio and on a demo, and 1 on a new studio. An older control file gains the column as 0. Turning it on needs a passkey on the account and a step-up.
- `warrants.signature_json` is added by checksum step `0002_warrant_signature`. A file database is copied aside before that step. Old rows stay null. An old `proposal.approved` payload of `{ actor, cartHash }` still reads. A new approval also stores `method` (`passkey`, `owner-key`, or `demo`) and, for a passkey, `fingerprint` (the first 16 hex characters of the key hash), the ES256 public key, the RP ID, the origin, and the challenge. Rows without `method` stay legacy.
- Process logs are whatever the host keeps. The app redacts known secrets before it writes a line. It does not set a 14-day log life.
- Sandbox PayPal is the only live money path, and only for the default studio. Demos and new studios use a fake.
