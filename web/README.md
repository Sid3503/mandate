# Mandate owner console

An installable web app (PWA) for the owner, built only on the API in `../api`. It has no AI and no PayPal secret. Every decision it shows comes from the server, word for word.

| Screen | Path | API |
| --- | --- | --- |
| Unlock | `/app/unlock` | `GET /ready`, `GET /v1/session` |
| Waiting for you | `/app/` | `GET /v1/proposals`, `POST …/approve`, `POST …/reject` |
| Receipt | `/app/p/:id` | `GET …/packet`, `POST …/capture` (client charges and refunds; the claimed-amount integrity check). Contractor payouts show a **Send the payout** panel instead of Settle (ready, sent, paid, unclaimed, failed; cancel until sent). |
| Jobs | `/app/jobs`, `/app/jobs/:jobId` | `GET /v1/jobs/:jobId` |
| New request | `/app/new` | `GET /v1/warrant`, `POST /v1/proposals` with an `Idempotency-Key` |
| Ledger | `/app/ledger` | `GET /v1/proposals`, `GET /v1/ledger` (AG Grid Community) |
| Rules | `/app/rules` | `GET /v1/warrant/versions`, `PUT /v1/warrant` with a reviewed diff |
| System | `/app/system` | `GET /health`, `GET /ready` |

## Run

From the repo root:

```bash
npm run setup          # installs api/ and web/
npm run demo           # builds the console, starts an in-memory server with a fake PayPal on :8799
```

Open http://127.0.0.1:8799/app/. Owner key `owner-e2e-key-0123456789`, proposer key `proposer-e2e-key-0123456789`. Nothing in demo mode touches PayPal.

Against the real sandbox server (`api/`, port 8787), from `web/`:

```bash
npm run build           # api serves web/dist at /app/
# or, for live reload against :8787
npm run dev             # http://localhost:5173/app/
```

## New screens

- **Deals** (`/app/deals`): "Let the agents negotiate" shows the negotiation turn by turn with the rule behind every refusal, a picture of where both companies' rules overlap (owner only), each agreed deal with a signature **Verify** button, and billing of the next milestone. You can also make an offer yourself.
- **Clerk** (`/app/clerk`): chat with the studio clerk. Try the fake vendor email in the examples.
- **Receipt**: the lock shows the Ed25519 signature with **Verify**; a request an agent asked for shows the chat behind it and, for the owner, every step the agent took; a charge billed by invoice shows the invoice.

## Guided tour

The console teaches itself, because it is complex at first.

- **First visit:** after unlocking, a 9-step welcome tour explains the one flow (ask, check, tap, pay, receipt) and points at the sidebar, the key and the Guide button. Leaving it with Esc or Skip is remembered in this browser (`localStorage`), so it never nags.
- **Guide button (top right, with a lime dot until seen):** a walkthrough of the screen you are on: Waiting for you, New request, Jobs, a job, Ledger, Rules, a receipt, System. The sidebar **Full tour** link and System's **Take the full tour** replay the welcome tour.
- **Keys:** → or Enter next, ← back, Esc leave. Focus stays inside the card and returns to where it was. Reduced motion is respected.
- **Where it lives:** `src/components/ui/product-tour.tsx` is the generic component (spotlight, card, `useTour`). `src/components/GuidedTour.tsx` is the provider and the Guide button. `src/lib/tours.tsx` holds every script. A step points at an element with a `data-tour="…"` attribute. A step whose target is not on screen (an empty inbox has no approval card) is left out, so a guide never points at nothing.
- **Adding a step:** put `data-tour="my-thing"` on the element, then add `{ target: '[data-tour="my-thing"]', title, content, placement }` to the right list in `tours.tsx`.

## Rules this app follows

- **The API key lives in `sessionStorage`.** It is never bundled and never written to disk. Closing the tab locks the console.
- **Offline is read-only.** The service worker caches only the app shell and fonts. Calls to `/v1/*` are never cached and never queued, and buttons that move money are disabled while offline. An end-to-end test checks the caches.
- **No guessing.** The New request screen never predicts the rule decision. It sends the request and shows the server's clause and detail beside a plain-language sentence.
- **Double taps do nothing extra.** Each distinct request body gets its own `Idempotency-Key`, and a retry of the same body reuses it. Approve and capture are idempotent on the server.
- **Integer cents.** Dollars are parsed as strings into cents, with no floating point.
- **A buyer who has not approved** gets a visible "Still waiting" answer with the check time, and a three-step how-to, instead of a silent retry.
- **Proposer keys** see every screen, but approve, settle and rule changes are disabled, with the reason shown.

## Checks

```bash
npm run typecheck
npm run e2e             # Playwright with the local Chrome; desktop and a Pixel 7 viewport (test servers on :8779 and :8778)
```

The end-to-end suite covers:

- **The frozen job:**
  - the $18 lunch is refused
  - a payout before the client has paid is refused
  - Northwind's $150 is billed, approved and settled
  - Priya's $90 is funded by that payment and approved
  - the receipt offers **Send $90.00 to Priya Shah** (Payouts, no Open PayPal control), and only says Paid after PayPal confirms
  - a $250 claim is refused
  - the job shows $150 in, $90 out, $60 kept
  - a payout PayPal is still processing is not called paid, a receiver with no PayPal account is unclaimed, a failed payout is released, and a locked payout can be cancelled
  - the ledger shows the refusals
  - rules v2 is published through a reviewed diff
- **The proposer key** cannot approve.
- **Offline** is read-only.
- **Installability:** manifest, icons, and a service worker scoped to `/app/`, with no API responses in any cache.
- **Accessibility:** an axe WCAG 2.1 AA scan of every signed-in screen. The scan excludes the third-party grid internals.

Lighthouse (mobile, unlock screen): Performance 99, Accessibility 100, Best Practices 100.

`npm run gen:types` regenerates `src/lib/openapi.d.ts` from the server's OpenAPI document. `npm run icons` redraws the PNG icons with the local Chrome.
