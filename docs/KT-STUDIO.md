# Knowledge transfer: the "Create your studio" door

This is the handover for the flow that opens a **studio** — a second company inside one server, with its own ledger, its own rules, its own signing key and its own people. It is not [KT.md](../KT.md) (the history of an early Orders design) and not [docs/TRY_IT.md](TRY_IT.md) (the hosted demo). This one is the door a real owner walks through, and everything that went wrong on the way.

Date of this note: 22 October 2026. Branch: `final/submission`.

---

## The story

A studio is not a demo and not a copy of one. It is a company: its own requests, its own money, its own rules, its own key. The owner opens it in four steps — a name, a passkey, a way back in, and the rules in their own words — and from then on the console says **their** name, not *Line Studio*.

Before this pass, a studio was a byte copy of the demo's template: *Line Studio*'s warrant, *Northwind*'s price sheet, *Priya Shah*'s address, a seeded standing rule, and a **fake PayPal** no matter what the server had. The console then called every studio *Line Studio* in the top bar, on the story rail and on Deals. That was a prototype wearing a product's clothes. It is gone.

## What a studio owns

| Thing | Where it lives | Note |
|---|---|---|
| The ledger | `api/data/ws/<workspaceId>.sqlite` | Its own file. Created empty: no rules, no people, no example numbers. |
| The signing key | `workspaces.signing_key_sealed` in `api/data/control.sqlite` | An Ed25519 key per studio, sealed with `MASTER_KEY`. The studio publishes it at `/.well-known/mandate-keys.json`; it differs from the default studio's. |
| The rules | `warrants` in the studio's own file | The owner writes version 1. Nothing exists until then. |
| The people | `members`, `credentials`, `sessions` in the control store | The owner, their passkeys, their sessions. |
| The words | `rule_words` in the studio's file | The rules in the owner's own words, until they become rules. |
| Its PayPal | `workspaces.paypal_mode` | `sandbox` = the server's own PayPal account. `fake` = a stand-in (the hosted demo only). |

## The doors, and what opens them

`POST /workspaces` is behind two flags and four secrets. An unset flag reads as **off** (`api/src/flags.ts`), and `openProduct` refuses to boot without the master key, the pepper and the passkey site (`api/src/boot.ts`).

```bash
# .env (gitignored, local only)
FLAG_TENANCY=1          # workspaces exist
FLAG_PASSKEYS=1         # the owner signs in with a passkey
DEMO_ENABLED=1          # the hosted demo (fake PayPal, 24h)
FLAG_INVITES=1          # staff can be invited into a studio
MASTER_KEY=…            # ≥16 chars. Seals every studio's signing key. KEEP IT.
KEY_PEPPER=…            # ≥16 chars. Hashes sessions, invites, recovery codes. KEEP IT.
WEBAUTHN_RP_ID=localhost
WEBAUTHN_ORIGINS=http://localhost:8787,http://127.0.0.1:8787
COOKIE_SECURE=0
TRUST_PROXY=0
```

```bash
cd api && node --env-file=../.env ./node_modules/tsx/dist/cli.mjs src/main.ts
```

## The four steps, and what the server does at each

| Step | The screen | The server |
|---|---|---|
| 1. A name | `/app/studio` → **Studio name** | `POST /workspaces`. Creates the workspace row, an empty ledger, its own signing key, and the owner's member row. Returns the WebAuthn registration options and `paypal: "sandbox"`. |
| 2. A passkey | **Create and save a passkey** | `POST /auth/register/verify` stores the credential against the owner. `POST /auth/login/options` + `/auth/login/verify` sets the session cookie. The browser now holds `mandate.workspace` (sessionStorage) and `mandate.mode`. |
| 3. A way back in | **Add a second passkey** or **Create recovery codes** | A second credential, or eight codes stored as hashes. The last passkey can never be removed. |
| 4. The rules in words | **Rules in words** | `POST /v1/rules/words` keeps the words in the studio's own ledger. The Rules screen starts from them. Publishing the rules clears them. |

Then **Open Today**. The studio is its own place: `/w/<workspaceId>/v1/…`.

## The guarantees that hold for a studio

- **A passkey signs the money.** `workspaces.passkey_for_money` is on for every studio, so approving a request needs a signature over the cart hash. Change the cart, and the signature does not count (`cart.changed`).
- **One studio never sees another.** A cookie, key or id from studio A used on studio B is 404 (red-team case 22). The cross-studio answer was tried and reverted: it broke this case.
- **An address may only come from the owner's words.** The drafter refuses an address the owner did not write (`rules.draft_unwritten_address`), so the first-run page asks **who is on your studio**.
- **A payee nobody has paid waits.** A payee the owner has just written is *cooling* for 24 hours (`NEW_PAYEE_WAIT_HOURS`) until the owner attests it with a passkey. The seeded demo payees are `owner_attested` and are not caught by this.
- **Nothing may be asked for money before the rules exist.** `POST /v1/proposals` answers 404 `warrant.missing` until version 1 is published.
- **The first version can be drafted.** The drafter used to need a live version to diff against, so a studio with no rules could not write any. It now drafts version 1 on a blank sheet, and the read-back says *this is the first version of the rules: everything in it is new*.

## The money

`paypal_mode` was a dead column: every tenant got `new FakePayPal()` whatever the server had. It is honoured now.

| `paypal_mode` | What the studio does | What the console says |
|---|---|---|
| `sandbox` | The server's own PayPal account. Real PayPal, test money. | *"PayPal here is this server's PayPal sandbox account. It is real PayPal, running on test money: it never reaches live PayPal, and no card is charged."* |
| `fake` | A stand-in. The hosted demo only. | *"PayPal here is simulated. No charge reaches PayPal. No real money moves."* |
| `none` | No PayPal at all. | *"PayPal here is not connected yet, so nothing can be charged."* |

The screen never guesses: it asks the server (`GET /v1/session` → `paypalMode`) every time it needs the truth.

## The traps (this is the part worth keeping)

**1. `localhost`, not `127.0.0.1`.** Chrome refuses an IP address as a WebAuthn relying party id. On `http://127.0.0.1:8787` the browser answers *127.0.0.1 is an invalid domain* and the passkey cannot be made. Open the console on `http://localhost:8787`.

**2. The service worker holds the old bundle.** A tab opened before a rebuild keeps the old JavaScript in memory, and the precache keeps serving the old shell. The symptom is old copy on a new server. **Cmd+Shift+R**. If it survives: DevTools → Application → Service Workers → *Unregister* → reload. To see which bundle is running, read the `assets/index-<hash>.js` in the served `/app/` shell.

**3. `sessionStorage` is per tab.** The studio id lives there, so a tab opened later does not know which studio it is in. The wizard asks `GET /auth/me` — which reports only the caller's **own** studio — and uses that to scope its questions. The wizard's progress in `localStorage` also keeps the studio id now, but `/auth/me` is what rescues a tab whose progress was written by an older build.

**4. `EADDRINUSE`.** Another server holds 8787: `lsof -iTCP:8787 -sTCP:LISTEN -P -n`.

**5. A new studio is empty, and that surprises people.** No rules, no payees, no requests. Today says *"Your studio starts here"*, the Rules screen says *"Your studio has no rules yet"*, and the first thing to do is write the rules. Ask for money first and the server refuses with `warrant.missing` — that is the design, not a bug.

**6. The drafter needs the addresses.** Write *"Priya is paid 60% of what Northwind pays"* and the model has no address to use. Fill in **who is on your studio** (name and email) on the Rules page: those words travel with the request, so the model may use them.

**7. A failed agent run was recorded twice**, which turned the real error into `UNIQUE constraint failed: agent_runs.id` and a 500. Fixed: a run is written once.

**8. `migrate()` on a brand-new ledger copies the file aside** as a "backup before a migration". A fresh studio has nothing to protect, so `migrate(db, { backup: false })` is used there. Without it every studio creation left a copy in `api/data/ws/backups/`.

## How to test it

Two tools, both against any server, with no device:

```bash
npm run studio:e2e -- http://localhost:8787      # 34 checks over the API
npm run studio:browser -- http://localhost:8787  # 13 checks on the real screen in Chrome
```

`api/scripts/studio-e2e.ts` walks: create → passkey → sign in → the studio's own name, rules, ledger and signing key → the words kept → the first version of the rules signed → a request that waits for a signature → the signature → the money moving on the server's PayPal → the default studio seeing none of it.

`web/scripts/studio-browser.mjs` walks the screen: name → passkey → backup → rules → Today → the Rules screen starting from the words.

The suites: `api/test/studio-lifecycle.test.ts` (5 tests), the browser specs in `web/e2e/` (the `passkey` project runs the studio wizard; `web/e2e/studio.ts` writes a studio's first rules through the real passkey path for the specs that need a populated studio).

## Where the code is

| Path | What it is |
|---|---|
| `api/src/http/extra.ts` | `POST /workspaces`. Creates the studio, empty. `paypal_mode` from the server. |
| `api/src/boot.ts` | Opens the control store, the tenant registry and each studio's app. Honours `paypal_mode`; a studio on a server with credentials gets the server's PayPal. |
| `api/src/tenancy/registry.ts` | At most 50 studios open at once; one that is idle is closed. |
| `api/src/control/store.ts` | Workspaces, members, credentials, sessions, invites, challenges. |
| `api/src/db/database.ts` | `migrate()`, the schema, and `rule_words`. |
| `api/src/agents/drafter.ts` | Drafts a first version as well as a change; the address rule. |
| `api/src/services/today.ts` | The studio's own next step; nothing about Northwind when there is no Northwind. |
| `web/src/screens/Studio.tsx` | The wizard. Keeps progress, asks the server for the PayPal truth, keeps the words. |
| `web/src/screens/Rules.tsx` | No rules yet: what they decide, one job, the owner's words, who is on the studio, the drafter, the dry run. |
| `web/src/components/StoryRail.tsx` | The studio's own name; the first-run rail. |

## If a studio has to be reset

A studio's ledger is one file. Deleting the file and running `migrate()` gives an empty studio again (no rules, no people, no requests). The owner's member, passkeys and sessions live in the control store and survive. Changing `paypal_mode` in `workspaces` moves the studio between the server's PayPal and the stand-in. There is no product screen for either: they are operator actions, and the row is the record.

A studio created before this pass is a **copy of the demo template** and should be reset, or the console will keep showing *Line Studio*'s rules and Northwind's price sheet inside it.

## Open items

- Each studio shares the server's PayPal account. Two studios on one server move money in the same sandbox account. A studio with its own PayPal account needs its own credentials, which the workspace table cannot hold yet.
- There is no way to delete a studio from the console or the API. `deleteDemo` in the control store clears a **demo** only; a studio's row is removed by an operator, by hand.
- The demo banner, the role switcher and *Play Northwind for this demo* now follow the server's word for the workspace. The landing page's story is still the demo's, on purpose: it is the pitch.
