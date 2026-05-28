# Wolfhouse Architecture North Star

## Purpose

Long-term direction for the **Wolfhouse Booking Assistant** — an AI booking assistant for surf-house / hospitality operations (guest WhatsApp, availability, holds, payments, confirmations, bed assignment, manual entries, operator room release, cancellations).

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

**Before Stage 4:** complete Stage **3x** (bot knowledge + safety guardrails as **specs/fixtures**, not n8n sprawl).

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

Multi-client: `client_id`, per-client config, monitoring, backups, onboarding checklist. See [`azure-n8n-hosting-plan.md`](azure-n8n-hosting-plan.md) when approved.

---

## Related docs

| Doc | Use |
|-----|-----|
| [ROADMAP.md](ROADMAP.md) | Stages 3–7 + 3x detail |
| [PROJECT-STATE.md](PROJECT-STATE.md) | What is done, in progress, next |
| [CURSOR.md](../CURSOR.md) | Agent rules and safe commands |
| [PROJECT-ROADMAP.md](PROJECT-ROADMAP.md) | Owner-friendly summary |
| [PHASE-3c-PROPOSAL.md](PHASE-3c-PROPOSAL.md) | Main integration proposal |
| [PHASE-3d-STRIPE-ISOLATED-PLAN.md](PHASE-3d-STRIPE-ISOLATED-PLAN.md) | Stripe isolated test gates |
| [PHASE-3b-FREEZE.md](PHASE-3b-FREEZE.md) | Bed-ops / manual / ORR sign-off |
