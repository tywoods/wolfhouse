# Wolfhouse Architecture North Star

## Current operating contract (2026-11-05)

This section supersedes the historical stage/n8n architecture below. The preserved
archive is design history, not the current deployment map or authorization policy.
See [AGENTS.md](../AGENTS.md) for the repository map and
[LUNA-GUEST-BEHAVIOR-SPEC.md](LUNA-GUEST-BEHAVIOR-SPEC.md) for current guest behavior.

```text
Guest WhatsApp → classic Luna / Hermes → Staff API → Postgres / payment services
Staff website                         → Staff API
```

Existing OVH France staging is the operating lane. `hermes-luna` is classic Luna;
`hermes-luna-clone` is the separate v3 candidate. Running candidate containers do
not establish approved guest routing. Azure and Lunabox instructions are historical
references, not release defaults. Inventory actual callers before retiring legacy
JS/n8n surfaces: source reachability is not evidence of live guest traffic, nor is
an old filename proof of dead code.

### Ownership and remaining consolidation

| Responsibility | Authoritative contract / existing source owner | Remaining boundary to simplify |
|---|---|---|
| Intent, acceptance, clarification and guest wording | Classic conversational model through `docker/hermes-staging/plugins/wolfhouse_staff_api/`; canonical behavior spec | Remove competing mandatory interpretation and coded guest-copy authorities incrementally, with outcome tests. |
| Shown offer, draft revision, trusted session and operation identity | `docker/hermes-staging/wolfhouse/accepted_quote.py` | Preserve revisions/person-to-bed scope; optional diagnostics must ultimately be read-only. Existing mutating revision callers must migrate before that is claimed complete. |
| Availability, pricing and durable booking | Staff API, shared `luna-front-desk-accommodation-booking-create-service.js`, pricing/deposit owners | Keep fresh transaction-time checks, locks, tenant admission and stable replay identity. |
| Invoice/deposit facts | `wolfhouse-stay-deposit.js` and `booking-invoice-totals.js` | Browser invoice policy still overlaps these owners; migrate it to a server projection, preserving historical contracts. |
| Booking follow-ups | Existing Staff payment/transfer services, reached through `staff-bot-v2-routes.js` and classic plugin | Replace internal fake HTTP/result inference; consolidate execution without losing partial-success receipts. |
| Payment truth | Existing Staff payment ledger/reconciliation/webhook services | A payment link is not payment; never infer success from guest prose. |
| Delivery | Existing configured Hermes transport and send/admission controls | One approved ingress per guest. No routing change implied by source cleanup. |
| Sunset business semantics | Existing Sunset vertical/domain services | Do not flatten its lesson/rental catalog into Wolfhouse accommodation pricing. |

Paths abbreviated to module basenames in this table are under `scripts/lib/`.
These are contract boundaries, not a claim that every transitional duplication has
already been removed. The classic direct-create path and shared Staff executor
already exist; consolidate around them instead of building another engine.

### Preserve business outcomes

- A displayed deposit/full choice can accept the displayed offer; no second save question.
- Fresh commercial validation remains mandatory. Changed/unseen terms do not inherit consent.
- Every successful save is confirmed from its receipt, even if a later link/transfer fails.
- Unknown write outcome is reconciled under the same operation identity; it is not a fresh create.
- Historical prices, per-person deposit caps, names and tenant/person associations survive cleanup.
- The model authors guest language and recovery. Code remains responsible for trusted facts,
  identity, security and authorized effects—not multilingual keyword-based consent decisions.

### Delivery and proof

Use [GITHUB-CONTAINER-BUILDS.md](GITHUB-CONTAINER-BUILDS.md): source checks,
pinned-image checks and approved existing-staging acceptance are different evidence.
An offline test, receipt validator or healthy container alone does not prove a
booking conversation. Pin source SHA, image digest and mounted-source hashes;
back up the existing staging service and preserve compatible rollback images.
Deployments, restarts, business mutations and guest sends remain separately approved.
No new environment, v3 cutover or production release is part of consolidation.

---

## Historical archive — superseded stage/n8n design

Everything below is retained historical context. In particular, “current stage,”
“today,” the n8n ownership table, proposed `src/booking-assistant/` layout and
Azure references below do **not** describe the current operating lane. Their safety
lessons remain useful, but current contracts and reviewed executable owners above
take precedence; this archive does not authorize any deployment or payment write.

## Purpose

Long-term direction for the **Wolfhouse Booking Assistant** — **client #1** of a category-wide engine: **AI booking operations for WhatsApp-first experience businesses** (AI front desk for WhatsApp-heavy operators). Beachhead implementation: surf-house operations (guest WhatsApp, availability, holds, payments, confirmations, bed assignment, manual entries, operator room release, cancellations). Market positioning: [`ROADMAP.md` § Client category](ROADMAP.md#client-category--market-positioning).

**Product roadmap (stages):** [`ROADMAP.md`](ROADMAP.md) · **Current execution:** [`PROJECT-STATE.md`](PROJECT-STATE.md)

---

## Evolution order (do not skip)

```text
1. Correct and safe     ← Stage 3 (current)
2. Reliable             ← Stage 4
3. Clean                ← Stage 5
4. Beautiful            ← Stage 6
5. Scalable             ← Stage 7
```

Do not jump to staff UI, Azure production, or “make it pretty” before dangerous guest paths are proven safe.

---

## Client category / market positioning

| | |
|--|--|
| **Category** | AI booking operations for WhatsApp-first experience businesses |
| **Plain language** | AI front desk for WhatsApp-heavy experience operators |
| **Beachhead** | Wolfhouse — surf houses / surf camps |
| **Not** | A generic chatbot; a configurable booking-operations layer |

**Core guest journey (all verticals):** WhatsApp question → explain options/packages → availability → collect details → payment/deposit link → payment truth → confirmation → staff handoff for exceptions.

**Wolfhouse complexity:** accommodation + packages + rooming + payments + confirmations in one property — a hard first client that stress-tests the engine.

**Expansion:** surf schools, surf/kite/dive shops, retreats, hostels with activities, tour operators, lesson/rental inventory businesses — typically simpler rooming, more slot/rental semantics; same spine via `client_config`.

**Competitive angle:** Hotel/hospitality WhatsApp tools exist; gap is small experience operators with messy packages/rentals/lessons, not hotel PMS-only flows.

Full detail: [`ROADMAP.md`](ROADMAP.md#client-category--market-positioning).

---

## Orchestration principle

**Do not keep expanding n8n with more and more business logic forever.**

| Layer | Responsibility |
|-------|----------------|
| **n8n** | **Orchestrates** — inbound webhooks, WhatsApp send, Stripe callbacks, schedule polls, simple HTTP calls |
| **Backend / code** | **Decides** — route, required fields, package choice, safety guards, handoff, duplicate checks |
| **Postgres** | **Remembers** — bookings, payments, conversations, beds, events |
| **Client config** | **Controls** — per-property packages, pricing, policies (Wolfhouse = client #1) |
| **Staff UI** | **Manages** — operations surface (Stage 6+) |

**Today (Stage 3):** n8n-heavy forks are **acceptable** to prove behavior locally with strict activation boundaries and frozen payment/confirmation contracts.

**Tomorrow (Stage 5+):** decision logic lives in testable modules; n8n calls them and performs I/O only.

**Target code layout:**

```text
src/booking-assistant/
  routeMessage.ts
  extractBookingDetails.ts
  requiredFields.ts
  packageDecision.ts
  safetyGuards.ts
  handoffRules.ts
  duplicateProtection.ts
  bookingContext.ts
  clientConfig.ts
  customerMemory.ts
```

---

## Current stage: Correct and safe (Stage 3)

**Active work:** Prove core paths without dangerous mistakes — see [`ROADMAP.md` § Stage 3](ROADMAP.md#stage-3--correct-and-safe).

Engineering milestones (legacy numbering): Phase **3c** Main+Postgres, Phase **3d** isolated real Stripe gates — [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md).

Goals:

- Postgres is write authority for guest booking state being migrated.
- No double bookings; no silent partial success.
- No accidental `payments` / `payment_events` writes from Main or bed-ops workflows.
- No production Airtable / hosted n8n targets from local testing.
- Stripe Webhook Handler owns payment truth; Send Confirmation follows Phase 2 contract.
- Local workflows stay **inactive** until explicitly approved for a test.
- PG failure must block Airtable mirror writes (when mirrors exist).

**Before Stage 4:** complete Stage **3x** planning ([`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md) — required fields, packages, WhatsApp mining, **customer memory**, gates, client config, exit criteria). Specs/fixtures only — not n8n sprawl.

**Current snapshot:** [`PROJECT-STATE.md`](PROJECT-STATE.md)

---

## Target end-state architecture

```text
Guest WhatsApp
  → n8n (orchestration)
  → booking-assistant decision engine (code)
  → Postgres (source of truth)
  → staff UI (Stage 6)
  → integrations (Stripe, notifications)
```

| Capability | Owner (target) |
|------------|----------------|
| Route message / intent | `routeMessage` + client config |
| Check availability | Postgres / shared SQL |
| Create hold | Postgres |
| Promote hold for payment | Postgres + Ensure contract |
| Create payment session | CPS workflow / service (Stripe API) |
| Payment truth | Stripe Webhook Handler → Postgres |
| Confirm booking | Send Confirmation (after payment truth) |
| Cancel / assign / reassign / ORR | Postgres + bed-ops forks → later unified services |
| Package explain / quote | `packageDecision` + config |

**n8n should not remain the booking brain.**

---

## Airtable policy

**Temporary scaffolding only.** Do not deepen dependency.

| Allowed (short term) | Not allowed (long term) |
|----------------------|-------------------------|
| Reference for old hosted workflow behavior | Source of truth |
| Short-term staff mirror after PG success | Long-term operator UI |
| Migration bridge during dual-write | Required for core booking logic |

When Postgres (or staff UI) safely replaces a function, **remove Airtable from that path**.

---

## Payment policy

`payments` and `payment_events` are **protected**.

| Rule | Detail |
|------|--------|
| Payment truth | **Stripe Webhook Handler** only |
| Send Confirmation | Consumes PG booking/payment state per Phase 2 contract |
| Forbidden writers | Main, Manual Entries, Operator Room Release, Assign, Reassign, Cancel |
| Changes | Any touch to payments, webhook handler, or Send Confirmation needs **explicit scope** + extra verification |

---

## Stage 4 — Reliable

After Stage 3 sign-off and Stage 3x specs:

- Repeatable regression suites and golden messages.
- Idempotency for duplicate guest messages, webhooks, payment-detail messages, confirmations.
- Rollback/cleanup SQL for every fixture family.
- Monitoring, stuck-booking detection, runbooks.
- No “green execution, wrong business outcome.”

---

## Stage 5 — Clean

- Move logic from Code nodes into `src/booking-assistant/`.
- Collapse duplicate branches; standardize error shapes.
- Replace duplicate Airtable availability with shared PG SQL.
- **Client config** drives Wolfhouse-specific rules; same engine for future clients.

**No random Main refactors** before tests prove behavior.

---

## Stage 6 — Beautiful

- Operator/admin UI: calendar, booking detail, manual form, room release, payment view, conversation view, needs-review queue.
- Guest-facing polish where product requires it.
- Airtable not required for normal staff work.

---

## Stage 7 — Scalable

**Azure / staging / production deployment belongs here** — after Stages 3–5 are in good shape.

Multi-client: `client_id`, per-client config, monitoring, backups, onboarding checklist — **same engine, many experience-business verticals**, not surf-house-only. See [`azure-n8n-hosting-plan.md`](azure-n8n-hosting-plan.md) when approved.

---

## Related docs

| Doc | Use |
|-----|-----|
| [ROADMAP.md](ROADMAP.md) | Stages 3–7 + 3x detail |
| [STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md) | Bot knowledge, customer memory, guardrails |
| [PROJECT-STATE.md](PROJECT-STATE.md) | What is done, in progress, next |
| [CURSOR.md](../CURSOR.md) | Agent rules and safe commands |
| [PROJECT-ROADMAP.md](PROJECT-ROADMAP.md) | Owner-friendly summary |
| [PHASE-3c-PROPOSAL.md](PHASE-3c-PROPOSAL.md) | Main integration proposal |
| [PHASE-3d-STRIPE-ISOLATED-PLAN.md](PHASE-3d-STRIPE-ISOLATED-PLAN.md) | Stripe isolated test gates |
| [PHASE-3b-FREEZE.md](PHASE-3b-FREEZE.md) | Bed-ops / manual / ORR sign-off |
