# The one-pass upgrade: mandates as credentials, friction that only adds, and the refusal corpus

Recorded 26 October 2026. Everything below landed in one pass, layer by layer (domain → gate → services → MCP →
web → tests), with the full suite green at each layer. Nothing here is pushed or deployed. The suite went in at
891 API tests and came out at 919 across 77 files; the browser checker gained a mandate mode and the end-to-end
suite a beat that proves the browser and the server agree on it.

## 1. What this pass was for

Three moves, chosen against the judging criteria and against what competitors have actually shipped:

1. **The AP2 projection (A).** Mandate already had the structure the Agent Payments Protocol describes — signed
   locks, standing rules with budgets and payees, Ed25519 keys. This pass makes that structure *legible as AP2*:
   every locked payment and every standing rule is now also a verifiable credential, minted as a compact JWS over
   EdDSA with a `vct` claim naming its schema. A judge who knows AP2 reads `mandate.payment.closed.1` and sees the
   payment mandate; reads `mandate.payment.open.1` and sees the open payment mandate where pre-authorized spend
   limits live. We did not retrofit anything: we exposed what was already there in the industry's shape.
2. **Adaptive friction (D), deterministic and demo-safe.** The one place AI-adjacent judgment may add friction.
   The design rule the pass held onto: **a signal can only raise friction, never lower it** — AUTO →
   NEEDS_APPROVAL, never the reverse, never touching a refusal, never de-escalating a tap. And the signals are
   deterministic: the lookalike check fires on the words of the ask itself, zero ledger dependence, exactly on cue
   in a demo. Velocity and new-host signals read the ledger, so they default **off**; a live demo can never trip
   them at random.
3. **The refusal corpus (E), artifact-only.** Every refusal in the ledger, with the rule that said it and the
   server's own sentence, exported as one signed artifact. No API, no subscription — the artifact is the product.
   A bank, a client, or another agent can check the Ed25519 signature without trusting this server.

Along the way, the agent door gained two read-only tools (`verify_mandate`, `get_metrics`), and the Verify page
gained a mandate mode so anyone can check a token an agent handed them, in the browser, with no key.

## 2. What landed, layer by layer

- **Domain.** `api/src/domain/risk.ts`: the pure risk evaluator (`assessRisk`, `impersonatesKnownParty`,
  `isLookalike`, `riskEnabled`). No clock, no database, no PayPal — the service gathers the ledger slice.
  `api/src/domain/mandate-vc.ts`: minting and verifying for closed and open mandates, reusing the server's
  existing `Signer`, so one public key verifies locks, deals, and mandates alike.
- **Rules.** The warrant gained a `risk` block (v3 data, defaulted, backward compatible): `enabled`,
  `velocityMaxPerHour`, `velocityWindowMinutes`, `escalateNewEvidenceHost`, `patternMatchPayees`. The policy
  facts list covers every new field, so "the rules have no place for this" stays a checkable claim.
- **Gate.** Escalation in `decide()`: an AUTO decision plus a signal becomes NEEDS_APPROVAL with the signal's
  clause. Refusals are untouched. The one deliberate exception that is not an escalation: with the feature on, a
  lookalike payee is refused as `risk.payee_impersonation` instead of the generic `payee.unknown` — refused is
  refused, PayPal is never called either way, but the refusal now names the attempt instead of shrugging.
- **Services.** `judge()` gathers the ledger slice and passes the signal in. A new `ProjectionService`
  (`services/projections.ts`) mints closed mandates, open mandates, verifies tokens, and signs the refusal export.
- **HTTP.** `GET /v1/proposals/:id/mandate`, `GET /v1/standing/:ruleId/mandate`, `POST /v1/mandates/verify`,
  `GET /v1/refusals/export`. All read-only projections; nothing here writes, nothing here calls PayPal.
- **MCP.** `verify_mandate` (any side, read scope, `readOnlyHint`, no budget spend — an agent can verify as often
  as it likes before trusting anything) and `get_metrics` (studio, read scope). Tool-count assertions updated to
  eleven studio / nine client; a deals-only key does not get `verify_mandate`, because it asks for `read`.
- **Web.** The Today month strip now shows the money behind the no-tap count (`automaticCents`) and what PayPal
  confirmed actually moved (`autoPaidCents`) — the strongest demo number on the page. `words.ts` carries the three
  risk clauses in plain words. The Verify page verifies a mandate token with WebCrypto Ed25519 and shows the
  claims it authorizes.
- **Tests.** `api/test/risk.test.ts` (15: the config default, the lookalike check, both escalate signals, the
  invariants on `decide()`, and three end-to-end beats — lookalike refused by name, a burst escalating on cue,
  a never-seen host waiting for a tap). `api/test/mandate-vc.test.ts` (12: mint→verify roundtrips, tamper,
  wrong key, `alg: none`, service-level mandates from the ledger, the signed refusal export checked with node
  crypto). `api/test/verify.test.ts` gained the cross-check: a server-minted mandate verified by the *browser*
  checker, plus a flipped-character refusal. Playwright: the verify spec now drives the mandate panel end to end,
  and job.spec gained the friction beat — flip the risk switches on Rules, publish, and the same lookalike ask
  flips from `payee.unknown` to `risk.payee_impersonation` while staying DENY (off means exactly as before).

## 3. The design fight worth writing down

The impersonation signal was first built as an escalation. Writing the tests exposed that it was dead code: payee
resolution is exact-match, so a lookalike name never resolves, so the gate refuses it as `payee.unknown` *before*
any signal is consulted — the escalation could never fire. The honest fix was not to force the signal through but
to move the check to where the decision actually happens: the gate's identity check. The refusal class never
changes; only the named reason gets sharper. The invariant "signals only escalate" now has no exceptions, and the
lookalike beat in the demo is a refusal that says *why* — which is stronger than a tap anyway.

## 4. What was cut, and why

- **Subscriptions (Direction C).** Recurring payouts against a PayPal billing agreement would be real PayPal
  surface, but it adds demo area without sharpening the argument. The open mandate already expresses the
  recurrence shape AP2 cares about (payee, funding clients, share, monthly cap). Documented as what's next, not
  built. If picked up later: `POST /v1/standing/:id/mandate` mints the credential a billing agreement would
  reference, so the projection work is the groundwork either way.
- **The refusal corpus API.** One signed export exists; a subscription feed over it does not. The artifact lets a
  judge think "platform" without the maintenance surface of a productized API.

## 5. Deliberately deferred to v2

**The `cnf` claim.** AP2's closed mandates can bind the authorized agent's own public key into the credential.
Agent keys here are opaque bearer tokens with no registered public key, so there is nothing honest to pin —
writing a fake binding would be worse than omitting it. The mandate header carries the server's `kid`; the
payload carries `askedBy` from the ledger. When agent keys gain a registered pubkey, the closed mandate gains
`cnf` and AP2's autonomous mode is fully expressed. This is documented in `mandate-vc.ts` itself, next to the code
that will grow it.

## 6. The kill list, as executed

1. No new paying tool on the agent door — both new tools are `readOnlyHint`, and the red-team assertions still
   check that no tool can approve, pay, send, refund or change the rules.
2. No new state. Mandates are projections of rows that already exist; verifying is pure.
3. No probabilistic behavior in the demo path. Impersonation reads the ask's own words; the ledger-dependent
   signals default off.
4. No second copy of the crypto. Mandates sign and verify with the same `Signer` and the same public keys as
   locks; the browser checker reuses the same Ed25519 helper it uses for receipts.
5. No deployment, no push. The working tree holds the whole pass; `npm test` is the gate.

One trap the new e2e beat flushed out, now closed: the browser tests serve `web/dist`, and locally nothing
rebuilt it, so a fresh screen could be missing from the page the tests drive. Root `npm test` now builds the
console before Playwright runs. CI was never exposed (its e2e job downloads the dist the `web` job just built).

## 7. How to see it in three minutes

1. `GET /v1/proposals/:id/mandate` on any locked payment → a three-part token; paste it at `/app/verify` →
   "This mandate is genuine," with the claims underneath.
2. Turn the risk engine on in the rules (`risk.enabled`, `patternMatchPayees`), ask for "P. Shah" → refused,
   and the refusal says lookalike. Turn it off → the same ask is refused as unknown, exactly as before.
3. `GET /v1/refusals/export` → the corpus, signed; the signature checks with one `crypto.verify` call.
