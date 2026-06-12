# Luna Open World Roadmap

**Goal:** Stop whack-a-mole. Luna should feel like an open-world game — guests wander (FAQ, services, surf, changes) without breaking booking state or getting railroaded through a form.

**North star:** One grounded conversation brain with staff-portal tools. Facts from DB/config only. Voice from Cami. Writes only when truth is ready.

---

## Where we are (Stage 54)

| Layer | Status |
|-------|--------|
| Deterministic chain | Router → availability → quote → payment → composer still owns field requirements |
| Agent Brain | Payment mismatch, paid changes, package repair — endorses composer elsewhere |
| Cami author | GPT 5.5 warmth on intake/quotes; composer owns payment URLs and confirmation truth |
| Context chain | `luna_guest_context` now carries `payment_link_sent`, `booking_code`, `payment_truth`, `confirmation_sent` |
| Confirmations | `LUNA_AUTO_SEND_ENABLED` — all phones, no allowlist; wired on Stripe webhook + open-demo inbound |
| Regression | July 1–5 fixture + `verify-stage54-open-world-confirmations.js` |

**Still form-like because:** Intent is split across brain classifier, router lanes, composer states, and GPT planners. Each layer can disagree; fixes are often local patches.

---

## Phase 1 — Stop the bleeding (now → 2 weeks)

**Principle:** Fixture every real transcript before deploy. No screenshot-only QA.

1. **Transcript fixtures as law** — Every production bug becomes a multi-turn JSON in `fixtures/luna-conversation-state-machine/cami-realism/`. CI runs hammer + realism batch on staging profile.
2. **Context is memory** — Persist live outcomes (hold, link, payment truth, confirmation) on every Meta inbound turn. Never re-ask payment choice after link sent.
3. **Confirmations automatic** — Payment truth → confirmation WhatsApp. No allowlist, no manual send for happy path.
4. **Post-booking = different game** — Holds/bookings route service attach (`add_service_request`), not FAQ loops.
5. **Composer owns fewer states** — Move warmth to Cami; composer keeps URLs, amounts, confirmation text only.

**Exit criteria:** July flow green in verifier; staging walkthrough without deposit re-ask, team handoff on "already paid", or wetsuit FAQ loop.

---

## Phase 2 — Unified intent (2–4 weeks)

**Principle:** One planner decides *what we're doing*; tools supply facts.

1. **Conversation brain v2** — Single GPT pass: intent + tool plan + missing fields. Router becomes executor, not classifier-of-classifiers.
2. **Lane collapse** — `new_booking_inquiry`, `add_service_request`, `payment_question`, `general_question` → `guest_turn` with `active_thread` enum: `intake | quoted | awaiting_payment | booked | post_booking`.
3. **Side questions without derail** — FAQ/surf/package explainer returns with *resume tail* from policy (`buildMidFlowKnowledgeReturnTail`), not a new intake.
4. **Payment truth loader** — Every turn with `booking_code` hydrates payment status from DB into `guest_context` before reply planning.
5. **Agent brain merge** — Agent brain becomes the v2 planner output formatter, not a parallel author.

**Exit criteria:** 90% of cami-realism fixtures pass with brain-only intent (router lane checks deprecated in tests).

---

## Phase 3 — Open world mechanics (1–2 months)

**Principle:** Guest can do anything; system grounds and gates writes.

1. **Tool surface** — Expose staff-portal capabilities as read tools: booking snapshot, payment status, service catalog, surf report, knowledge KB, availability window.
2. **Write tools gated** — hold, bed, stripe link, service attach, confirmation send — only when planner + eligibility agree.
3. **Cami as voice layer only** — Never plans; rewrites validated structured reply. Variation pools for welcome, quotes, acks.
4. **Multilingual thread stick** — Language set on turn 1; knowledge/router cannot hijack on loanwords (wetsuit, yoga, etc.).
5. **Post-booking playground** — Add services, transfer updates, gate code (after confirmation), surf ask — all without resetting intake.

**Exit criteria:** New features add a tool + a fixture, not a new composer state.

---

## Phase 4 — Production parity (ongoing)

1. **Prod flag profile** — Mirror staging with `LUNA_GUEST_AGENT_BRAIN_ENABLED_PROD`, dry-run off, auto-send on.
2. **Observability** — Per-turn audit: intent, tools called, context snapshot hash, reply source.
3. **Hammer generation** — Failed live threads auto-export to `generated-hammer-failures/`.
4. **Kill composer states** — Deprecate `ask_*` one-by-one as brain asks naturally with Cami rewrite.

---

## Anti-patterns (do not repeat)

- Adding a composer state for every new guest phrase
- Gating confirmations or live sends per phone
- FAQ priority over booking/service when `booking_code` exists
- Dropping `payment_link_sent` between turns
- Screenshot → manual fix without fixture

---

## How to add a feature (open-world style)

1. Add read tool or extend existing (no duplicate pricing/availability logic).
2. Add brain/planner rule: when to call it.
3. Add Cami validator rule if new copy shape.
4. Add multi-turn fixture proving wander + resume.
5. Run `verify-stage54-*` + realism batch.
6. Deploy staging; one real phone walkthrough; commit fixture if new.

---

## Key commands

```bash
node scripts/verify-stage54-open-world-confirmations.js
node scripts/verify-stage53-cami-booking-intelligence.js
# Realism batch (subset):
node -e "require('./scripts/lib/luna-conversation-fixture-set-batch').runFixtureSetBatch('cami-realism')"
```

---

*Last updated: Stage 54 — ungated confirmations, July fixture, context persistence.*
