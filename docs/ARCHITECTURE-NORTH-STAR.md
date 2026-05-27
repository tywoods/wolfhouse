# Wolfhouse Architecture North Star

## Purpose

Long-term direction for the **Wolfhouse Booking Assistant** — an AI booking assistant for surf-house / hospitality operations (guest WhatsApp, availability, holds, payments, confirmations, bed assignment, manual entries, operator room release, cancellations).

Evolution order (do not skip):

1. **Correct and safe** ← current
2. **Reliable**
3. **Clean**
4. **Beautiful**
5. **Scalable**

Do not jump to Azure deployment, product UI, or “make it pretty” before the **Main guest booking path** is Postgres-safe.

---

## Current stage: Correct and safe

**Active work:** [Phase 3c](PHASE-3c-PROPOSAL.md) — Main booking flow / Postgres integration (local Stripe fork only).

Goals:

- Postgres is write authority for guest booking state being migrated.
- No double bookings; no silent partial success.
- No accidental `payments` / `payment_events` writes from Main or bed-ops workflows.
- No production Airtable / hosted n8n targets from local testing.
- Stripe Webhook Handler owns payment truth; Send Confirmation follows Phase 2 contract.
- Local workflows stay **inactive** until explicitly approved for a test.
- PG failure must block Airtable mirror writes (when mirrors exist).

**Current snapshot:** [PROJECT-STATE.md](PROJECT-STATE.md)

---

## Target end-state architecture

```text
AI guest assistant
  → clean API / backend (deterministic booking functions)
  → Postgres booking engine (source of truth)
  → operator / admin UI (staff — not Airtable long-term)
  → n8n as integration glue (WhatsApp, Stripe, notifications)
```

**n8n should not remain the booking brain.** Core logic moves into Postgres-backed, testable functions:

| Capability | Owner (target) |
|------------|----------------|
| Check availability | Postgres / shared SQL |
| Create hold | Postgres |
| Promote hold for payment | Postgres |
| Create payment session | Phase 2 HTTP service (unchanged contract) |
| Confirm booking | Postgres + Send Confirmation workflow |
| Cancel booking | Postgres + Cancel workflow |
| Assign / reassign beds | Postgres + 3b forks |
| Operator room release | Postgres + 3b.5 fork |
| Send confirmation | Phase 2d fork (reads PG, sends WhatsApp) |

---

## Airtable policy

**Temporary scaffolding only.** Do not deepen dependency.

| Allowed (short term) | Not allowed (long term) |
|----------------------|-------------------------|
| Reference for old hosted workflow behavior | Source of truth |
| Short-term staff mirror after PG success | Long-term operator UI |
| Migration bridge during dual-write | Required for core booking logic |

When Postgres (or a proper UI) safely replaces a function, **remove Airtable from that path**.

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

## Next stage: Reliable

After **3c Main/Postgres MVP** (through 3c.g sign-off):

- Repeatable regression suites and fixtures per workflow family.
- Idempotency for duplicate guest messages, webhooks, payment-detail messages, confirmations.
- Rollback/cleanup SQL for every fixture family.
- Runbooks; no “green execution, wrong business outcome.”

---

## Next stage: Clean

- Remove dead Main nodes; collapse duplicate branches.
- Move large Code-node logic into repo modules.
- Replace duplicate Airtable availability with shared PG SQL.
- Standardize statuses, booking codes, error shapes.
- Keep payments and manual/operator paths isolated.

**No random Main refactors** before tests prove behavior.

---

## Next stage: Beautiful

- Operator/admin UI: calendar, booking detail, manual form, room release, payment view, conversation view, needs-review queue.
- Guest booking API surface.
- Airtable not required for normal staff work.

---

## Final stage: Scalable (includes Azure)

**Azure / staging / production deployment belongs here** — after:

1. Phase **3c** Main Postgres MVP + local E2E sign-off  
2. Reliability / stabilization  
3. Cleanup / refactor where needed  
4. UI / Airtable-removal planning  

Do not deploy the mess just because it can be deployed. See [`azure-n8n-hosting-plan.md`](azure-n8n-hosting-plan.md) when that stage is approved.

Multi-client: `client_id`, per-client rooms/rules/WhatsApp/Stripe, monitoring, backups, staging/prod runbooks.

---

## Related docs

| Doc | Use |
|-----|-----|
| [PROJECT-STATE.md](PROJECT-STATE.md) | What is done, in progress, next |
| [CURSOR.md](../CURSOR.md) | Agent rules and safe commands |
| [PROJECT-ROADMAP.md](PROJECT-ROADMAP.md) | Owner-friendly phase ladder |
| [PHASE-3c-PROPOSAL.md](PHASE-3c-PROPOSAL.md) | Main integration proposal |
| [PHASE-3b-FREEZE.md](PHASE-3b-FREEZE.md) | Bed-ops / manual / ORR sign-off |
