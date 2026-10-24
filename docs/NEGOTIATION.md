# How two companies negotiate in Mandate

A studio and its client agree a price for a job before any money exists. Either side can negotiate itself, let Mandate's
negotiator do it, or bring its own agent over MCP. This page explains how a negotiation runs, how it ends, how a deal
is called, how each side learns whether the result was good for it, and what the AI does and does not decide.

## The short version

- **A deal is made only when one side accepts the other's exact offer.** Offers stand until they are answered. The
  server never "notices" that two numbers overlap and calls it a deal.
- **On its turn a side does one of three things:** make an offer (or counter), accept the standing offer, or walk away.
- **It ends** when one side accepts, one side walks away, the deadline both sides know passes (2 to 8 offers each), or
  neither side moves its price for three rounds.
- **Each company's limits stay its own.** The server checks every offer and every acceptance against the mover's own
  rules. A client that set its own numbers with its own key is sealed from the studio: the studio cannot read them,
  change them or answer offers for it.
- **Each side is told how good the result was, in its own terms**: the margin over its walk-away and how far it got
  towards its target (worked out by code), and its negotiator's own debrief (the model's judgement).

## The protocol

Mandate uses the alternating-offers protocol of the bargaining literature (Rubinstein 1982) in the form automated
negotiation research uses (the Stacked Alternating Offers Protocol of the ANAC competition; Aydoğan et al. 2017).

| On its turn, a side may | What the server checks |
| --- | --- |
| **Offer** (`offer_deal`, `POST /v1/deals/offers`) | The terms are consistent (milestones add up, the currency, proof); the offer is inside the offerer's **own** rules (its walk-away, its kinds of work, its milestone limits); it is not worse for the other side than the offerer's previous offer (a concession is never taken back); the offerer has offers left. The other side's limits are **not** consulted: whether they can live with it is theirs to say. |
| **Accept** (`accept_offer`, `POST /v1/deals/:id/accept`) | It is the other side's latest, still-open offer, exactly as it stands (the "mirror image" rule of contract law). **Both** companies' current rules are checked again at this moment, because a sheet may have changed since the offer. Only then is the deal signed with Ed25519 and given its job. |
| **Walk away** (`walk_away`, `POST /v1/negotiations/:id/walk-away`) | Always allowed. The standing offer is withdrawn. |

A counter-offer answers the offer it was made against, which then no longer stands. A side marks an offer **final**
to say it will make no more. A negotiation nobody touches for a week ends by itself.

### How it ends

| Ending | When |
| --- | --- |
| `agreed` | One side accepted the other's standing offer. |
| `walked_away` | A side walked away. |
| `expired` | The side to move has no offers left and cannot accept the standing offer (the deadline), or nobody answered in time. |
| `stalled` | Neither side changed its price for three rounds. |

A model failure is not an ending: the negotiation stays open and either side can carry on, by hand or with its agent.

## Who sits in each chair

| Chair | Who may act |
| --- | --- |
| Studio | The owner, the studio's own keys and agents, and Mandate's negotiator for the studio. |
| Client, before it sets its own numbers | The owner may answer for it (a demo, or a client not on Mandate yet: the screen says so), and Mandate's negotiator may speak for it. |
| Client, after it sets its own numbers with its own key | Only the client: in its own console, with its own agent over MCP, or with Mandate's negotiator **if it delegated** (`delegate: true` on its sheet, with its own private brief). The studio's owner sees that a limit is set and nothing else. |

## What each side tells its negotiator

Each company's price sheet (`PUT /v1/party-rules/mine`) holds:

- its **walk-away** (the studio's floor, the client's ceiling): a hard limit;
- its **target**: what it hopes for (if left out, 25% better than the walk-away stands in, and is labelled as such);
- its **style**: `firm` (concedes late), `balanced`, or `flexible` (concedes early);
- its **brief**: standing instructions in its own words ("a quick start matters more than the last dollar");
- for a client, whether Mandate's negotiator may speak for it.

All of it is private to that company.

## The AI: what the model decides, and what code holds

The model makes every decision: whether to counter, accept or walk away, and at what price. It reads the other side's
moves and messages, its own mandate and the deadline, and writes what it says to the other side and a private note for
its own company. Code holds only what is authority, arithmetic or privacy:

| Code | Why it is code |
| --- | --- |
| The walk-away, the turn order, the deadline, no taking back a concession | Authority. A model that is fooled, or wrong, is simply refused, and told why in its own numbers. |
| Writing the terms and splitting the milestones | Arithmetic. Language models get sums wrong; the model sends a price and the server writes the terms. |
| Removing the private numbers from anything said to the other side | Privacy. A price already on the table is public and is left alone. |
| The facts in the prompt (each side's openings, concessions, the gap, offers left) | So the model reasons from correct numbers. |
| A reference move from a standard concession curve (Faratin, Sierra & Jennings 1998) and acceptance rule (Baarslag et al. 2014), labelled "a guide, not an order" | Research on LLM negotiators finds they anchor on the other side's first offer, concede without reciprocity and accept too fast. The reference counters that without taking the decision away. |

Each move is one run of the model with three tools only (least privilege), a forced tool call, reasoning effort
"medium" on gpt-oss, and the model card's own sampling settings. A move the server refuses comes back to the model as the
tool's answer, and it may correct itself in the same turn. A model that answers in words instead of moving is told so
and asked again, at most twice, with the exact calls it can make. If it still makes no valid move, the move fails and is
reported: **code never moves on the model's behalf.** Walking away cannot be undone, so when Mandate's negotiator walks
away while the other side's standing offer is inside its own walk-away and it still has offers left, the tool answers
once with those facts and asks it to confirm (`confirm: true`): the usual guard on an irreversible action. The model
still decides.

After the end, each debrief is given the moves worked out by code (each side's opening against its walk-away, every
concession on both sides, the offers left), and is sent back if it names an amount that is not a fact or advises
opening closer to the walk-away. A debrief that still fails its checks is not shown: no debrief beats a wrong one.

The prompts are versioned (`negotiator@v3`, `debrief@v2`) with snapshot tests, and fence the other company's words as
untrusted data. The prompt's negotiation guidance is drawn from the research listed below: anchor with your first offer
and counter-anchor from your own target, concede in proportion to the other side's movement, mind the known deadline,
accept when the offer is at least as good as what you could still get, walk away only when the other side's best
plausible offer is past your walk-away, and be warm and specific.

## Is each side satisfied?

After a negotiation ends, each side Mandate's negotiator spoke for writes its own company a **debrief** through one
checked tool: satisfied, acceptable or dissatisfied; ratings from 1 to 5 for the outcome, the process, the relationship
and itself (the four parts of the Subjective Value Inventory, Curhan, Elfenbein & Xu 2006); whether it would sign the
same again; a short summary; and one lesson. Code works out the facts it is given (the price, the margin over the
walk-away, the progress towards the target, every move), and every amount in its words must be one of those facts or
it is sent back.

Beside it, code shows each side its **outcome**: for example "$300 is $50 above the least you take ($250), 33% of the way
to your target of $400". It names both the walk-away and the target on purpose: measuring against the target gets
better deals, measuring against the walk-away leaves people satisfied (Galinsky, Mussweiler & Medvec 2002).

Only where one person can see both chairs (a demo) does the screen also show the overlap of the two limits and where
the price fell in it, against the Nash bargaining point (Nash 1950), which for one issue is the middle of the overlap.

## What a live run looks like

Run on `gpt-oss:20b` with the sample sheets (studio floor $250, target $400; client ceiling $400, target $200), four
offers each:

| Move | Who | What |
| --- | --- | --- |
| 1 | Studio | Offers $400 ("…a design that captures your brand's essence.") |
| 2 | Client | Counters $200 |
| 3 | Studio | Counters $350 |
| 4 | Client | Counters $265 |
| 5 | Studio | Counters $300 |
| 6 | Client | Accepts $300 |

The client's debrief, rated "acceptable": "We anchored too low at the start and accepted $300 before exploring a
higher offer." Runs differ: a live model decides, and earlier runs ended at $350 with a buyer who opened at $300
(the anchoring failure the prompt now counters).

## The API at a glance

| Call | Who |
| --- | --- |
| `POST /v1/negotiations` and `/stream` | The owner: Mandate's negotiators play the table move by move, stopping at a client that speaks for itself. Body: `buyer`, `task`, `milestones`, `offersPerSide`, `sellerBrief`, `threadId` (to carry one on). |
| `GET /v1/negotiations`, `GET /v1/negotiations/:id` | Either side: the moves, whose turn it is, the standing offer, the deadline, how it ended, and the caller's own seat. |
| `POST /v1/deals/offers` | Either side: an offer. Full terms to open a negotiation, or `threadId` and `totalCents` to counter in one. |
| `POST /v1/deals/:id/accept` | The side the offer was made to. |
| `POST /v1/negotiations/:id/walk-away` | Either side. |
| `POST /v1/negotiations/:id/agent-move` | One move by Mandate's negotiator for the caller's seat (a client only if it delegated). |
| MCP: `offer_deal`, `accept_offer`, `walk_away`, `get_negotiation` | Outside agents, with a key that has the `deals` scope. |

## Sources

- Rubinstein, "Perfect Equilibrium in a Bargaining Model", *Econometrica* 50(1), 1982.
- Aydoğan, Festen, Hindriks & Jonker, "Alternating Offers Protocols for Multilateral Negotiation", Springer, 2017.
- Faratin, Sierra & Jennings, "Negotiation decision functions for autonomous agents", *Robotics and Autonomous Systems* 24, 1998.
- Baarslag, Hindriks & Jonker, "Effective acceptance conditions in real-time automated negotiation", *Decision Support Systems* 60, 2014.
- Galinsky & Mussweiler, "First Offers as Anchors", *JPSP* 81(4), 2001.
- Galinsky, Mussweiler & Medvec, "Disconnecting Negotiated Outcomes and Evaluations", *JPSP* 83(5), 2002.
- Curhan, Elfenbein & Xu, "What Do People Value When They Negotiate?" (the Subjective Value Inventory), *JPSP*, 2006.
- Nash, "The Bargaining Problem", *Econometrica* 18(2), 1950.
- Bianchi et al., "How Well Can LLMs Negotiate? NegotiationArena", ICML 2024 (anchoring, arithmetic errors, weak buyers).
- Xia et al., OG-Narrator, ACL Findings 2024 (a deterministic offer generator with an LLM narrator raised buyer deal rates).
- Vaccaro et al., the MIT AI negotiation competition, 2025 (warmth reaches more deals; prompt injection extracts positions).
- Microsoft Research, Magentic Marketplace, 2025 (first-proposal bias, prompt injection across agents).
- Van Hoek et al., "How Walmart Automated Supplier Negotiations", *Harvard Business Review*, 2022 (Pactum: deals with 64% of suppliers in the pilot).
