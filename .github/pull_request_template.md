## What changed and why

## How it was checked
- [ ] `npm run check` passes locally (types and API tests). CI runs everything else.
- [ ] If this touches money (the gate, PayPal calls, locks, standing rules, autopilot): a test pins the new behavior, and a refusal still moves $0.
- [ ] If the API shape changed: `npm --prefix web run gen:types` was run.
- [ ] If an env var or setting was added: `api/.env.example`, `render.yaml` and `docs/REFERENCE.md` say so.

## Deploy notes
<!-- Merging to main deploys it after CI passes. Say here if it needs anything first (a new secret on Render, a PayPal setting). -->
