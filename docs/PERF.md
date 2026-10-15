# Performance Report

This report records production bundle performance and mobile Lighthouse audit results for Mandate.

## Bundle Splitting and Lazy Loading

AG Grid, AG Charts, and AG Studio are strictly lazy-loaded and removed from the application shell, service worker precache, and initial entry bundles (Welcome, Unlock, and Today).

### Chunks over 1,000 kB

The following chunks exceed 1,000 kB after minification, and both are loaded strictly on demand:

| Chunk | Size | Gzip | Routes | Purpose |
|---|---|---|---|---|
| `dist/assets/ControlRoom-BNJIglkd.js` | 4,602.45 kB | 1,281.50 kB | `/app/control-room` | AG Studio dashboard runtime and AG Charts Enterprise |
| `dist/assets/index.esm-CSWLGXVZ.js` | 1,194.65 kB | 332.42 kB | `/app/ledger`, `/app/control-room` | AG Grid Community and AG Grid React table engines |

Initial application bundle:
- `dist/assets/index-CC_Emdxw.js`: 821.07 kB (gzip: 242.27 kB, transferred: 212 kB)
- `dist/assets/index-BrZCsryC.css`: 87.07 kB (gzip: 17.23 kB, transferred: 16 kB)

Neither AG Grid nor AG Studio is downloaded during initial load of Welcome, Unlock, or Today.

## Mobile Lighthouse Audits

Audits executed using Lighthouse 13.5.0 with default mobile settings against production build running on local preview server.

Artifacts saved to `docs/evidence/q9/`:
- `docs/evidence/q9/lighthouse-mobile-welcome.json`
- `docs/evidence/q9/lighthouse-mobile-unlock.json`
- `docs/evidence/q9/lighthouse-mobile-today.json`

### Audit Results

| Screen | Target URL | Final Displayed URL | Performance | FCP | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|
| Welcome | `http://127.0.0.1:8799/app/welcome` | `http://127.0.0.1:8799/app/welcome` | 90 | 2.9 s | 2.9 s | 10 ms | 0.000 |
| Unlock (Attempt 1) | `http://127.0.0.1:8799/app/unlock` | `http://127.0.0.1:8799/app/unlock` | 88 | 2.9 s | 3.2 s | 0 ms | 0.000 |
| Unlock (Attempt 2) | `http://127.0.0.1:8799/app/unlock` | `http://127.0.0.1:8799/app/unlock` | 88 | 2.9 s | 3.2 s | 0 ms | 0.000 |
| Today (Demo session) | `http://127.0.0.1:8799/__fake/session?redirect=/app/` | `http://127.0.0.1:8799/app/` | 83 | 3.1 s | 3.7 s | 80 ms | 0.008 |

Verification:
- Welcome achieved performance score 90 (>= 90) with `finalDisplayedUrl: http://127.0.0.1:8799/app/welcome`.
- Unlock achieved performance score 88 within two attempts with `finalDisplayedUrl: http://127.0.0.1:8799/app/unlock`.
- Today redone run loaded the real demo Today screen with all dashboard endpoints returning 200, achieving performance score 83 with `finalDisplayedUrl: http://127.0.0.1:8799/app/`.
- Zero AG Grid, Charts, or Studio chunks transferred on Welcome, Unlock, or Today.
