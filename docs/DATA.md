# How long data stays

- A demo workspace expires after `DEMO_TTL_HOURS` (24 by default). Cleanup may remove a row only when its mode is `demo`. It does not remove the default studio or a studio workspace.
- The default studio ledger is the file at `DATABASE_PATH`. On the free host that file is ephemeral and a restart reseeds it.
- `model_budget` and `model_budget_kill` sit on that same ledger. They keep the day's token counts and an ops kill across a process restart. `MODEL_ENABLED=0` pauses the current process only and does not write the kill row.
- Auth events live in `control.sqlite` next to that file. This server does not trim them on a timer.
- Process logs are whatever the host keeps. The app redacts known secrets before it writes a line. It does not set a 14-day log life.
- Sandbox PayPal is the only live money path, and only for the default studio. Demos and new studios use a fake.
