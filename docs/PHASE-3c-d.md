# Phase 3c.d — Conversation / message / current-hold state

**Status:** **3c.d.2** PG conversation state report (SELECT-only) implemented. **3c.e** not started.

**Parents:** [`PHASE-3c-d-PROPOSAL.md`](PHASE-3c-d-PROPOSAL.md) · [`PHASE-3c-PROPOSAL.md`](PHASE-3c-PROPOSAL.md) · [`PROJECT-STATE.md`](PROJECT-STATE.md)

---

## Goal

Plan how Main tracks **conversations**, **messages**, and **current hold** so Phase **3c.e** can wire PG hold + Ensure SQL without breaking the Booking State Resolver or duplicating holds.

---

## Substeps

| Substep | Deliverable | Status |
|---------|-------------|--------|
| **3c.d** | Proposal | Done (`54d5446`) |
| **3c.d.1** | `db:report:main-conversation-inventory` | Done |
| **3c.d.2** | `db:report:main-conversation-state` (SELECT-only) | Done |
| **3c.d.3** | PG conversation upsert CLI (optional) | Deferred |
| **3c.d.4** | Sign-off | Not started |

---

## 3c.d.1 — Field inventory (read-only)

Maps every Main **Conversations** and **Messages** Airtable node: operation, route tags, fields written/read, PG mapping draft, resolver dependencies, 3c.e risks.

### Command

```powershell
npm run db:report:main-conversation-inventory -- --help

npm run db:report:main-conversation-inventory

# Optional: hosted export or both
npm run db:report:main-conversation-inventory -- --workflow=both
```

Docker tools profile:

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:report:main-conversation-inventory
```

### Output

| Output | Meaning |
|--------|---------|
| Console | Summary: write nodes, hold/stage flags, message direction, resolver nodes, risks |
| `reports/main-conversation-inventory-<timestamp>.json` | Full structured inventory per workflow |

JSON top-level flags: `read_only: true`, `no_mutations: true`.

### Guarantees

- Parses `n8n/phase2/...Main (local Stripe).json` (default) and/or hosted export only
- **No** Postgres, Airtable API, Sheets, webhooks, workflow JSON writes
- **No** `payments` / `payment_events`

### Implementation

| File | Role |
|------|------|
| [`scripts/lib/main-conversation-inventory.js`](../scripts/lib/main-conversation-inventory.js) | Inventory logic |
| [`scripts/report-main-conversation-inventory.js`](../scripts/report-main-conversation-inventory.js) | CLI |

Reuses route map from [`scripts/lib/main-workflow-inventory.js`](../scripts/lib/main-workflow-inventory.js) (3c.a).

---

## 3c.d.2 — PG conversation state report (SELECT-only)

Answers for a **phone** (and optional **booking_code**): what Postgres has for `conversations`, active holds, and how that compares to Main’s **Pick Active Booking** / **Current Hold ID** expectations. **Does not call Airtable** — `expected_airtable_mapping` is from workflow/inventory docs only.

### Why before 3c.e

Proves UUID vs `booking_code` alignment, detects multiple active holds, missing conversation rows, and status drift **before** injecting PG nodes into Main.

### Command

```powershell
npm run db:report:main-conversation-state -- --help

# Fixture phone (if main-hold-3cc-active-hold-up.sql was applied)
npm run db:report:main-conversation-state -- --phone=+353300000001

# Optional Current Hold ID simulation
npm run db:report:main-conversation-state -- --phone=+353300000001 --booking-code=WH-3C-ACTIVE-HOLD-GUARD-001
```

Docker:

```powershell
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:report:main-conversation-state -- --phone=+353300000001
```

### Output

| Field | Meaning |
|-------|---------|
| `pg_conversation_match` | `conversations` row + join to `current_hold_booking_id` booking |
| `pg_active_hold_candidates` | `hold` / `payment_pending` for phone |
| `pg_resolver_candidates` | Broader statuses (resolver phone search) |
| `current_hold_resolution_preview` | Simulated pick: code → conversation FK → phone |
| `expected_airtable_mapping` | AT mirror rules (not live AT data) |
| `risks` / `actionable` | Blockers for 3c.e; exit **2** if actionable |

Exit **0** = no actionable flags. JSON: `reports/main-conversation-state-<phone>-<timestamp>.json`.

### Guarantees

- **SELECT only** on `clients`, `conversations`, `messages`, `bookings`
- No `payments` / `payment_events`
- No Airtable API, workflow JSON changes, or writes

### Implementation

| File | Role |
|------|------|
| [`scripts/lib/main-conversation-state-pg-sql.js`](../scripts/lib/main-conversation-state-pg-sql.js) | Queries + resolution preview |
| [`scripts/lib/main-conversation-state-plan.js`](../scripts/lib/main-conversation-state-plan.js) | Report builder + fixture hints |
| [`scripts/report-main-conversation-state.js`](../scripts/report-main-conversation-state.js) | CLI |

---

## Next step

**3c.d.3** (optional) PG conversation upsert CLI, or **3c.d.4** sign-off then **3c.e** workflow injection planning.

---

## Out of scope

- `build-main-local-stripe.js` / Main JSON changes (**3c.e**)
- Postgres writes (until approved substep)
- `payments` / `payment_events`
