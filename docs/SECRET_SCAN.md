# Secret Scan Report

Comprehensive scan of the working tree and full git history across all branches using `git log --all -p -G'<regex>' --oneline` and file system inspection.

## Scan Results

| Pattern | Commits | Tracked Files | Total Matches | Class | Details |
|---|---|---|---|---|---|
| `mnd_` | 31 | 38 | 8378 | fixture | Test machine keys (`mnd_ag_test...`, `mnd_cl_test...`), machine key types in schema, documentation examples. Works for no real service. |
| `AKIA` | 3 | 3 | 10122 | fixture | AWS access key pattern defined in `scripts/check-secrets.mjs` scanner regex (`AKIA[0-9A-Z]{16}`), quoted prompt in `docs/FINAL_RUN.md`, and substring in Lighthouse audit translation dictionary. No live AWS keys exist. |
| `-----BEGIN` | 4 | 3 | 179 | fixture | Private key header pattern in `scripts/check-secrets.mjs`, dummy test certificate in `api/test/ops-readyz-secret.test.ts`, and scanner definitions. No real private keys exist. |
| `ghp_` | 1 | 1 | 59 | fixture | GitHub personal access token regex pattern referenced in `docs/FINAL_RUN.md`. Zero GitHub tokens in history. |
| `sk-` | 9 | 11 | 1551 | fixture | SVG mask IDs (`mask-` containing `sk-`), test redteam mock strings (`sk-proj-test...`), and documentation placeholders. No live OpenAI/Anthropic keys exist. |
| `Bearer ` | 45 | 48 | 11986 | fixture | HTTP Authorization test headers (`Bearer ${OWNER_KEY}`, `Bearer owner-e2e-key-...`, `Bearer test-token`), OpenAPI specifications, and documentation examples. |
| Ollama keys | 9 | 12 | 4503 | fixture | Configuration schemas (`OLLAMA_API_KEY` in `api/.env.example`, `config.ts`, `PRODUCT.md`, test options). Local Ollama instances run keyless by default. No real third-party keys. |
| PayPal keys | 4 | 4 | 1151 | fixture | Sandbox endpoint definitions (`https://api-m.sandbox.paypal.com`), FakePayPal test harness, and SDK client references. No real PayPal live secrets exist. |
| Email addresses | 22 | 32 | 26733 | fixture | Synthetic domain test fixtures (`priya.shah@example.com`, `buyer@example.com`, `accounting@northwind.example.com`). All belong to the reserved `.example.com` domain. |
| `/Users/` | 18 | 18 | 1109 | fixture | Local filesystem paths in earlier e2e screenshot fixtures, replaced with portable relative `fileURLToPath` in current working tree. |
| `C:\Users\` | 0 | 0 | 0 | fixture | Zero occurrences found across git history and working tree. |

## Gitleaks History Scan

Executed `gitleaks detect --source . --log-opts="--all" --redact`:
- Raw commits scanned: 177 commits (9.72 MB)
- Initial raw hits: 3 hits across all history
- Rules triggered: `generic-api-key` (2 hits), `private-key` (1 hit)
- Findings:
  1. `api/test/ops-cleanup-scheduler.test.ts:336` (Rule `generic-api-key`): test fixture idempotency key header string in multi-tenant isolation test.
  2. `api/test/ops-readyz-secret.test.ts:14` (Rule `private-key`): synthetic mock test string with trailing ellipsis in secret redaction unit test.
  3. `web/src/lib/passkey-vector.json:9` (Rule `generic-api-key`): public RFC/W3C WebAuthn sample test vector for offline ES256 verification.
- Classification: 100% test fixtures. Zero real secrets or live service credentials exist in git history.
- CI and repository configuration: added test fixture paths and regexes to `.gitleaks.toml` and fingerprints to `.gitleaksignore`. Subsequent scan with `.gitleaks.toml` reports 0 leaks found across 177 commits.

## History Audit Status

- `HISTORY_CLEAN=true`
- Reason: Every matched item across commit history and the working tree is a synthetic fixture, scanner regex rule, documentation placeholder, SVG artifact, or reserved test fixture. No real secret or credential for any live service has ever been committed. Zero keys to rotate.
