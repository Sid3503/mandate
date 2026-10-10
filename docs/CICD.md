# CI/CD: how a change gets from your laptop to the hosted demo

The goal is fast and safe: you merge small changes often, nothing untested reaches the hosted copy, and if something does go wrong you know within minutes and can go back in one click.

```
 your branch ──► pull request ──► CI: 7 jobs, in parallel where they can, about 5 minutes ──► merge to main
                                                                                  │
                                   CI passes on main ─────────────────────────────┤
                                          │                                       │
                                          ▼                                       ▼
                       Render deploys that exact commit          "Verify deploy" waits until /ready reports
                       (autoDeployTrigger: checksPass)           that commit, then smoke-tests the live service
```

## The workflows

| Workflow | Runs | What it does |
| --- | --- | --- |
| **CI** (`ci.yml`) | every pull request, every push to `main` | The gate. Seven jobs; the single check **CI OK** is what to require. |
| **Verify deploy** (`verify-deploy.yml`) | after CI passes on `main` | Waits for the live service to report the new commit, then smoke-tests it. Needs the variable `PRODUCTION_URL`. |
| **Deploy a commit** (`deploy.yml`) | by hand | Deploys one exact commit through Render's deploy hook: to promote when auto-deploys are off, or to **roll back**. |
| **Security** (`security.yml`) | pushes, pull requests, and weekly | CodeQL code scanning, and a weekly audit of production dependencies. |
| **Dependabot** (`dependabot.yml`) | weekly | Grouped pull requests for npm and for the pinned actions. Each one runs CI. |

### What the CI jobs catch

| Job | Catches |
| --- | --- |
| **Repo rules** (`scripts/ci/hygiene.mjs`) | A different Node version in `.nvmrc` and `render.yaml`; an action not pinned to a commit SHA; a workflow with no `permissions:`; `pull_request_target`; a secret written into `render.yaml`; a tracked `.env`, `.pem` or database; a Render config that would deploy every push (it must be `checksPass` or `off`). |
| **Secret scan** (gitleaks, `.gitleaks.toml`) | A key committed to a **public** repository. Only the fixed test keys are allowed, by exact string. |
| **API typecheck and tests** | Everything in `api/test`: the gate, the red team, signed locks, the MCP door, the pipeline's own guards. All against a fake PayPal, so no credentials. |
| **Console build** | A type error in the console, a broken build, and **an API change whose console types were not regenerated** (`npm --prefix web run gen:types`). |
| **Browser tests** (desktop, phone) | The whole product through a real Chrome, with an accessibility scan. No retries: the tests share a server and build on each other's ledger, so a retry would run against changed state and hide the real failure. |
| **CI OK** | Fails if any job above failed or was cancelled. |

## Why it is safe

- **Only green commits deploy.** `render.yaml` sets `autoDeployTrigger: checksPass`, so Render waits for the CI checks on the commit. A red commit never reaches the hosted demo.
- **A deploy that did not happen is a red run.** "Verify deploy" polls `/ready`, which now reports `releaseId` (the running commit), and fails if the live service does not report the commit within 25 minutes. It then checks the console, the security headers, the public links, the signing keys, the auth wall, and the MCP door.
- **The smoke test is safe on a live demo.** It only reads. With the optional `SMOKE_OWNER_KEY` it makes one read-only agent key, connects over MCP, confirms a read-only key cannot see `propose`, and revokes the key. It never asks for money to move.
- **Docs-only pushes do not deploy.** `render.yaml` lists `buildFilter.ignoredPaths` (docs, tests, workflows, scripts). A redeploy restarts the free instance and wipes its ledger, so a README edit should not. The post-deploy check reads the same list, so the two always agree.
- **Pinned and least-privilege.** Every action is pinned to a commit SHA (a moved tag cannot change what runs). Workflows default to `contents: read`, checkouts do not keep a token, and nothing uses `pull_request_target`, so a fork's pull request never runs with your secrets.
- **Secrets stay secret.** CI needs none to run. The deploy hook lives in the `production` environment, and logs print status codes only.

## One-time setup (these are settings only you can change)

1. **Push.** Actions runs on a public repository with no setup. Open the Actions tab and watch the first run.
2. **Require the gate.** Settings → Rules → Rulesets → New branch ruleset → target the default branch → *Require status checks to pass* → add **CI OK** → *Block force pushes*. With "Require a pull request" on, `main` is only changed by merged, green pull requests. Leave yourself as a bypass actor for emergencies.
3. **Let Render use it.** Push `render.yaml`, then sync the blueprint (Render → Blueprints → Sync), or set the service's *Auto-Deploy* to **After CI checks pass**. Until then Render keeps deploying every commit.
4. **Turn on the post-deploy check.** Settings → Secrets and variables → Actions → *Variables* → `PRODUCTION_URL` = `https://mandate-80ng.onrender.com`. Optional *secret* `SMOKE_OWNER_KEY` = the service's `API_KEY`, for the MCP check.
5. **Enable the manual deploy.** Settings → Environments → New → `production`. Add the secret `RENDER_DEPLOY_HOOK_URL` (Render → the service → Settings → Deploy Hook). Optionally add *Required reviewers* so a person approves every manual deploy.
6. **Switch on GitHub's own protections** (free on a public repository): Settings → Code security (also called Advanced Security) → Secret scanning and **Push protection**, and Dependabot alerts.
7. **Locally**, once: `npm run hooks:install`. A pre-push hook then runs `npm run check` (about 20 seconds).

## Day to day

```
npm run check      # repo rules, both type-checks, the API tests: what the pre-push hook runs
npm run ci         # everything CI runs, including the browser tests (about 8 minutes)
npm run smoke -- https://your-host [--commit <sha>]     # the same smoke test CI runs
MANDATE_AGENT_KEY=<key> npm --prefix api run check:mcp -- https://your-host --attack    # connect an agent and watch the rules refuse it
```

A pull request that touches money (the gate, PayPal calls, locks, standing rules, autopilot) should add or change a test; the template asks.

## Roll back

Actions → **Deploy a commit** → Run workflow → give the earlier commit's SHA. It checks the commit is on `main` and had a passing **CI OK**, asks Render to deploy exactly that commit, and runs the smoke test against it. To roll back past the start of CI, tick *skip_ci_check*. Then fix forward: the next green push to `main` deploys as usual, unless you freeze first.

## The judging window (1 to 15 December)

A deploy restarts the free instance and wipes its ledger, so nothing should deploy under a judge by accident.

1. In `render.yaml` set `autoDeployTrigger: off` and push, or turn Auto-Deploy off in Render.
2. Set the repository variable `DEPLOY_FREEZE` to `true`, so "Verify deploy" stops waiting for deploys that will not come.
3. Deploy only by hand with **Deploy a commit**, and only for a real fix.
4. Better still, move the service to a paid plan with a persistent disk (`DATABASE_PATH` on the disk) so a deploy keeps the ledger.

## Not covered, on purpose

- **No staging environment.** One free Render service is the demo. A second one is a copy of `render.yaml` with another name; add it if you want to see a build before it is live.
- **No automatic rollback.** A failed smoke test turns the run red and emails you; going back is one click (above). Automatic rollback on a free instance with an ephemeral ledger would hide the failure.
- **The real PayPal sandbox is not in CI.** CI uses the fake PayPal. Live checks (a real invoice, a payout, the webhook) stay manual: `npm run webhook:register`, the steps in `docs/JUDGES.md`.
- **Lighthouse and the AI model evaluations** are not run per commit (`npm run eval:agents` needs a model key and costs money).

## The live chain a merge does not prove

CI uses the fake PayPal. What remains unproven is one unbroken live chain on the sandbox. A live run depends on the owner publishing real sandbox emails on Rules before the first capture. This repo does not contain those emails. Merging does not produce a PayPal id.

Walk the frozen job in Today's next-step order:

1. Keep the price sheets.
2. Agree the deal.
3. Bill milestone 0.
4. Approve and send, unless the invoice is already out.
5. Pay as the sandbox buyer.
6. Ask to pay the contractor share.

Publishing `billSignedDeals`, `payOnSettle`, and one standing rule before that capture is a separate no-tap choice, not Today's next step. `UNCLAIMED` is not paid.
