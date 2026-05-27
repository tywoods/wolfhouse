# Phase 3c.d — Conversation / message / current-hold state

**Status:** **3c.d.4** conversation upsert CLI implemented. **3c.e** not started.

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
| **3c.d.3** | Fixture-backed positive verification | Done |
| **3c.d.4** | `db:main-conversation-upsert:postgres` | Done |
| **3c.d.5** | Sign-off + **3c.e** planning | Next |

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

## 3c.d.3 — Fixture-backed verification (positive path)

Scoped booking fixture only (no `conversations` row). Proves hold resolution before **3c.e**.

```powershell
Get-Content scripts/fixtures/main-hold-3cc-active-hold-up.sql | docker compose -f infra/docker-compose.local.yml exec -T wolfhouse-postgres psql -U wolfhouse -d wolfhouse

npm run db:report:main-conversation-state -- --phone=+353300000001 --booking-code=WH-3C-ACTIVE-HOLD-GUARD-001
```

**Expected (2026-05-27):**

- `pg_booking_by_code` resolves `WH-3C-ACTIVE-HOLD-GUARD-001` with UUID `booking_id`
- `pg_active_hold_candidates.count` = 1 for phone
- `current_hold_resolution_preview.pick_source` = `booking_code_argument`
- `expected_airtable_mapping`: AT **Current Hold ID** = `booking_code`; PG **`current_hold_booking_id`** = UUID
- Exit **2** with `missing_conversation_row` only (no PG conversation row yet — expected until 3c.e upsert)
- No `payments` / `payment_events` rows for fixture booking

```powershell
Get-Content scripts/fixtures/main-hold-3cc-active-hold-down.sql | docker compose -f infra/docker-compose.local.yml exec -T wolfhouse-postgres psql -U wolfhouse -d wolfhouse
```

---

## 3c.d.4 — Conversation upsert CLI

Links a PG `conversations` row to an existing hold/payment_pending booking.

```powershell
npm run db:main-conversation-upsert:postgres -- --help

# After main-hold-3cc-active-hold-up.sql (or db:main-hold:postgres --execute)
npm run db:main-conversation-upsert:postgres -- --phone=+353300000001 --booking-code=WH-3C-ACTIVE-HOLD-GUARD-001

npm run db:main-conversation-upsert:postgres -- --phone=+353300000001 --booking-code=WH-3C-ACTIVE-HOLD-GUARD-001 --execute

npm run db:report:main-conversation-state -- --phone=+353300000001 --booking-code=WH-3C-ACTIVE-HOLD-GUARD-001
```

| Rule | Detail |
|------|--------|
| **UUID column** | `current_hold_booking_id` = `bookings.id` |
| **booking_code** | Stored in `session_state` hints only; AT mirror uses code in **3c.e** |
| **Default dry-run** | `--execute` required |
| **No messages** | Does not insert `messages` |
| **No payments** | Does not touch `payments` / `payment_events` |

**Cleanup:**

```powershell
Get-Content scripts/fixtures/main-conversation-3cd4-cleanup-down.sql | docker compose -f infra/docker-compose.local.yml exec -T wolfhouse-postgres psql -U wolfhouse -d wolfhouse
Get-Content scripts/fixtures/main-hold-3cc-active-hold-down.sql | docker compose -f infra/docker-compose.local.yml exec -T wolfhouse-postgres psql -U wolfhouse -d wolfhouse
```

| File | Role |
|------|------|
| [`scripts/lib/main-conversation-pg-sql.js`](../scripts/lib/main-conversation-pg-sql.js) | Upsert SQL + plan |
| [`scripts/main-conversation-upsert-postgres.js`](../scripts/main-conversation-upsert-postgres.js) | CLI |

---

## Next step

**3c.e** — plan then inject hold + Ensure + conversation upsert into `build-main-local-stripe.js` (workflow still inactive until approved).

---

## Out of scope

- `build-main-local-stripe.js` / Main JSON changes (**3c.e**)
- `messages` table writes (this CLI)
- `payments` / `payment_events`
