# Sunset Portal Slice 1 — Seed Runner Implementation Plan

**Status:** DRAFT — awaiting Captain sign-off before any staging DB writes  
**Date:** 2026-06-19  
**Branch:** `feat/sunset-multitenant-luna`  
**Parent docs:** `SUNSET-PORTAL-SLICE-1-STAGING-DEPLOY-PLAN.md`, `SUNSET-PORTAL-SLICE-1-SEED-INPUTS.md`, `SUNSET-PORTAL-SLICE-1-IMPLEMENTATION-PLAN.md`  
**Reference pattern:** Wolfhouse `STAGE-8.5-DEMO-DATA-SEED-PLAN.md` (`stage8_demo` tag)

---

## Approval gate — do not write to staging DB until Captain approves

**No seed execution, no cleanup execution, and no staging DB writes until Captain explicitly signs off on:**

1. This seed runner plan.
2. The pinned branch/commit deployed to staging Staff API.
3. A one-time seed run authorization (separate from code deploy).

Default script mode is **dry-run**. Live writes require **both** `ALLOW_SUNSET_DEMO_SEED=1` and `--execute`.

Deckhand/Cursor **must not** run seeds during planning or implementation review.

---

## 1. Inputs

### Primary machine input

| File | Role |
|------|------|
| `fixtures/sunset-portal-slice1/seed-manifest.json` | Authoritative row specs: 2 conversations, 3 `booking_service_records`, 1 `accommodation_partner_queue` entry |
| `config/clients/sunset.baseline.json` | Tenant scope + **config-only** `portal_demo.lesson_slots` (not written by seed script) |

**Manifest schema:** `sunset-portal-slice1-seed-manifest-v1`  
**Validated offline by:** `npm run verify:sunset-portal-slice1-seed` (116 assertions)

### Config input (read-only for seed runner)

`portal_demo.lesson_slots` in `sunset.baseline.json` powers Day Schedule **demo tiles** in the portal UI. The seed runner **does not insert lesson slot rows** — Captain decision: no `lesson_slots` DB table in Slice 1.

Seed runner **may** insert `booking_service_records` that align with demo slot dates (`2026-07-10` / `2026-07-11` / `2026-07-12`) so Day Schedule query tables populate when a staff user picks those dates.

### Manifest → DB mapping notes (implementation must handle)

Manifest uses Sunset catalog names; Staff API queries use Wolfhouse-era DB enums:

| Manifest `service_type` | Target DB `service_type` | Query surface |
|-------------------------|--------------------------|---------------|
| `group_lesson_adult` | `surf_lesson` | `services.lessons_today` |
| `board_rental` | `surfboard` | `services.gear_today` |
| `board_and_suit_rental` | `surfboard` + `wetsuit` (2 rows) or `surfboard` with combo metadata | `services.gear_today` |

Store manifest identifiers in `metadata`:

```json
{
  "source": "sunset_demo_slice1",
  "manifest_record_id": "demo-sunset-bk-001",
  "manifest_service_type": "board_rental",
  "pricing_status": "unverified_seed",
  "note": "Sunset portal Slice 1 staging demo — safe to delete"
}
```

`accommodation_partner_queue` is **manifest-only for Slice 1** — no dedicated DB table. Defer to Slice 2 or store as a tagged `booking_service_records` row with `service_type` TBD only if Captain approves schema extension. **Default: skip accommodation insert in v1 seed script.**

---

## 2. Proposed scripts

### `scripts/fixtures/sunset-portal-slice1-seed.js`

**Purpose:** Idempotent insert of Sunset demo rows into staging Postgres.

**CLI interface (proposed):**

```
node scripts/fixtures/sunset-portal-slice1-seed.js                 # dry-run (default)
node scripts/fixtures/sunset-portal-slice1-seed.js --execute       # writes (requires env flag)
node scripts/fixtures/sunset-portal-slice1-seed.js --execute --force-refresh  # update timestamps only
```

**Responsibilities:**

1. Load and validate manifest JSON (reuse checks from `verify-sunset-portal-slice1-seed.js logic or require verifier PASS first).
2. Resolve `clients.id` for `slug = 'sunset'`; **fail** if missing (optional `--create-client` deferred — Captain must confirm `clients` row exists on staging).
3. Insert demo rows in FK-safe order (see §3).
4. Print planned vs actual row counts per table.
5. Exit non-zero on safety guard failure or tenant isolation violation.

### `scripts/fixtures/sunset-portal-slice1-cleanup.js`

**Purpose:** Delete **only** Sunset Slice 1 demo rows tagged `sunset_demo_slice1`.

**CLI interface (proposed):**

```
node scripts/fixtures/sunset-portal-slice1-cleanup.js              # dry-run
node scripts/fixtures/sunset-portal-slice1-cleanup.js --execute  # deletes (requires env flag)
```

**Responsibilities:**

1. Same safety guards as seed script.
2. Delete in reverse FK order (see §4).
3. Print deleted counts per table.
4. Assert zero rows remain with `metadata->>'source' = 'sunset_demo_slice1'` and `client_slug = 'sunset'`.

### `package.json` scripts (add when implemented)

```json
"sunset:portal-slice1-seed": "node scripts/fixtures/sunset-portal-slice1-seed.js",
"sunset:portal-slice1-cleanup": "node scripts/fixtures/sunset-portal-slice1-cleanup.js"
```

---

## 3. Tables likely involved

Mirror Wolfhouse Stage 8.5 inbox pattern (`conversations` + `messages`). Sunset Slice 1 does **not** seed beds, packages, or Wolfhouse booking blocks.

| Table | Seed? | Rows (expected) | Notes |
|-------|-------|-----------------|-------|
| `clients` | verify only | 0 insert | Must exist: `slug = 'sunset'` |
| `bookings` | **yes** | 3 | Lightweight demo bookings linked to service records; **no** `booking_beds` |
| `conversations` | **yes** | 2 | Alex + Maria threads; phones `+34611000101`, `+34611000102` |
| `messages` | **yes** | 8 | From manifest `turns` (inbound/outbound); no WhatsApp send |
| `staff_handoffs` | **optional** | 0–1 | Maria / kids-lesson scenario if `demo_state.handoff_needed` |
| `booking_service_records` | **yes** | 3–4 | Mapped types; `service_date` from manifest `date` |
| `payments` | **no** | 0 | Manifest: `payment_link: null`, `payment_status: unpaid` |
| `booking_beds` | **no** | 0 | Sunset has no bed calendar |
| `guest_message_events` | **no** | 0 | Inbox uses `conversations`/`messages`, not webhook events |

### Inbox tables (current Staff API)

Staff portal inbox loads via `GET /staff/conversations` and related routes on `conversations` + `messages` (same tables Wolfhouse Stage 8.5 seeds). Do **not** seed `guest_message_events` unless Captain later wants webhook-parity — not required for Slice 1 read-only demo.

### Day Schedule query tables

`loadDaySchedule()` calls:

- `GET /staff/query?intent=services.lessons_today` → `booking_service_records` where `service_type = 'surf_lesson'` joined to `bookings`
- `GET /staff/query?intent=services.gear_today` → `booking_service_records` where `service_type IN ('surfboard','wetsuit')` joined to `bookings`

**Therefore:** seed must create parent `bookings` rows with `client_slug = sunset` and child `booking_service_records` with non-cancelled status and valid `booking_id` FK.

### Payment / demo status fields

Use existing enums only:

| Field | Demo value |
|-------|------------|
| `booking_service_records.payment_status` | `not_requested` or `pending` (never `paid` without Stripe truth) |
| `booking_service_records.status` | `requested` or `confirmed` |
| `booking_service_records.source` | `demo_fixture_stage888` if CHECK allows, else `staff_manual` with `metadata.source = sunset_demo_slice1` |
| `bookings.status` | `confirmed` or `payment_pending` (avoid `hold` expiry noise) |
| `payments` | **no rows** |

Never insert `stripe.com` URLs or `sk_live_*` / `sk_test_*` secrets.

---

## 4. Idempotency

### Tag standard (canonical)

**Use `sunset_demo_slice1`** in every `metadata` JSONB column. Do **not** reuse Wolfhouse `stage8_demo`.

```json
{
  "source": "sunset_demo_slice1",
  "manifest_id": "demo-conv-sunset-001",
  "tenant_id": "sunset",
  "client_slug": "sunset",
  "note": "Sunset portal Slice 1 staging demo — safe to delete"
}
```

Manifest field `"source": "demo_seed"` is documentation only; DB writes use `sunset_demo_slice1`.

### Stable idempotency keys

| Entity | Unique key for skip-if-exists |
|--------|------------------------------|
| Conversation | `(client_id, phone)` — normalize phone to E.164; manifest `conversation_id` in metadata |
| Message | `(conversation_id, metadata.manifest_turn_id)` or deterministic `wa_message_id` prefix `sunset_demo_slice1_*` |
| Booking | `(client_slug, booking_code)` — use `SUNSET-DEMO-001` … `SUNSET-DEMO-003` |
| Service record | `(client_slug, metadata.manifest_record_id)` |
| Handoff | `(conversation_id, metadata.manifest_id)` |

### Safe re-run behavior

1. **Default:** skip insert when idempotency key exists; log `SKIP` with reason.
2. **`--force-refresh`:** update `updated_at`, `last_message_preview`, `service_date` only — no duplicate rows.
3. Never delete Wolfhouse rows on re-run.
4. Print summary: `{ inserted, skipped, refreshed, errors }` per table.

### Safe cleanup behavior

**Deletion order (FK-safe):**

```
1. DELETE staff_handoffs      WHERE metadata->>'source' = 'sunset_demo_slice1'
2. DELETE messages            WHERE metadata->>'source' = 'sunset_demo_slice1'
3. UPDATE conversations       SET current_hold_booking_id = NULL
                                WHERE metadata->>'source' = 'sunset_demo_slice1'
4. DELETE booking_service_records
     WHERE client_slug = 'sunset' AND metadata->>'source' = 'sunset_demo_slice1'
5. DELETE conversations       WHERE metadata->>'source' = 'sunset_demo_slice1'
6. DELETE payments            WHERE metadata->>'source' = 'sunset_demo_slice1'  -- expect 0
7. DELETE bookings            WHERE metadata->>'source' = 'sunset_demo_slice1'
```

Cleanup **must not** touch `stage8_demo` or any `client_slug = 'wolfhouse-somo'` row.

---

## 5. Tenant isolation

Every inserted row must satisfy:

- `client_slug = 'sunset'` (on tables that have the column), or
- `client_id` resolved from `clients.slug = 'sunset'`, or
- `metadata.tenant_id = 'sunset'` and `metadata.client_slug = 'sunset'`

**Hard fails (abort before any write):**

- Manifest row with `tenant_id` or `client_slug` ≠ `sunset`
- Manifest JSON contains `"wolfhouse"` or `"wolfhouse-somo"`
- Target DB URL appears to be production (see §6)
- Any pre-check SELECT finds `metadata->>'source' = 'sunset_demo_slice1'` on `client_slug = 'wolfhouse-somo'`

**Phone block:** use `+34 611 000 1xx` range from manifest — distinct from Wolfhouse `+34 999 000 0xx` demo block.

---

## 6. Safety guards

Implement shared module `scripts/fixtures/sunset-portal-slice1-guards.js` (or inline in both scripts):

| Guard | Behavior |
|-------|----------|
| `assertNotProduction()` | Refuse if `NODE_ENV=production`, hostname matches production Staff API, or `WOLFHOUSE_DATABASE_URL` / `DATABASE_URL` host not in staging allowlist |
| `assertAllowSeedEnv()` | Require `process.env.ALLOW_SUNSET_DEMO_SEED === '1'` for `--execute` |
| `assertClientSlugSunset()` | Manifest + CLI `--client` must be `sunset` only |
| `assertManifestValid()` | Run structural checks (or shell out to `verify:sunset-portal-slice1-seed`) |
| **Dry-run default** | Without `--execute`, print SQL/row plan and counts only |
| **Row count preview** | Before writes: `PLAN: conversations=2 messages=8 bookings=3 service_records=3 handoffs=0-1` |

### Staging allowlist (configure at implementation time)

- DB host: `wh-staging-pg-app` / Azure staging Postgres endpoint
- Optional: `STAFF_API_BASE_URL=https://staff-staging.lunafrontdesk.com`

### Explicit env for execute mode

```bash
ALLOW_SUNSET_DEMO_SEED=1 \
WOLFHOUSE_DATABASE_URL='postgres://...' \
node scripts/fixtures/sunset-portal-slice1-seed.js --execute
```

---

## 7. Verification

### A. Pre-seed (offline — no DB)

```bash
npm run verify:sunset-portal-slice1-seed
npm run verify:sunset-all
```

### B. Dry-run (staging credentials, no writes)

```bash
node scripts/fixtures/sunset-portal-slice1-seed.js
# Expect: PLAN row counts, 0 INSERT, exit 0
```

### C. Post-seed SQL checks (staging DB)

```sql
-- Sunset demo rows present
SELECT 'conversations' AS t, COUNT(*) FROM conversations c
  JOIN clients cl ON cl.id = c.client_id
  WHERE cl.slug = 'sunset' AND c.metadata->>'source' = 'sunset_demo_slice1';

SELECT 'messages' AS t, COUNT(*) FROM messages m
  WHERE m.metadata->>'source' = 'sunset_demo_slice1';

SELECT 'booking_service_records' AS t, COUNT(*) FROM booking_service_records
  WHERE client_slug = 'sunset' AND metadata->>'source' = 'sunset_demo_slice1';

-- Zero Wolfhouse leakage
SELECT COUNT(*) AS wolfhouse_leak FROM booking_service_records
  WHERE client_slug = 'wolfhouse-somo' AND metadata->>'source' = 'sunset_demo_slice1';
-- must be 0

SELECT COUNT(*) AS wolfhouse_stage8_touch FROM conversations c
  JOIN clients cl ON cl.id = c.client_id
  WHERE cl.slug = 'wolfhouse-somo' AND c.metadata->>'source' = 'sunset_demo_slice1';
-- must be 0
```

### D. Portal manual smoke (after seed + Staff API deploy)

From `SUNSET-PORTAL-SLICE-1-STAGING-DEPLOY-PLAN.md` §7, plus seeded paths:

- [ ] Sunset inbox shows Alex + Maria conversations
- [ ] Day Schedule date `2026-07-10` shows lessons + gear rows
- [ ] Wolfhouse inbox unchanged (no Sunset phones)
- [ ] Wolfhouse bed calendar unchanged

### E. Post-cleanup verification

```bash
node scripts/fixtures/sunset-portal-slice1-cleanup.js --execute
```

Re-run SQL in §7C — all counts must be **0** for `sunset_demo_slice1`. Wolfhouse `stage8_demo` counts unchanged.

### F. Known non-blockers

- `verify:luna-golden` — excluded on Lunabox (no local Postgres). See `VERIFY-LUNA-GOLDEN-DB-NOTE.md`.

---

## 8. Execution sequence (after Captain approval)

| Step | Action | Owner |
|------|--------|-------|
| 1 | Captain signs off this plan | Captain |
| 2 | Implement seed + cleanup scripts | Cursor |
| 3 | `npm run verify:sunset-all` at pinned SHA | Deckhand |
| 4 | Deploy Staff API to staging (separate deploy approval) | Captain/Ops |
| 5 | Confirm `clients.slug = 'sunset'` exists on staging DB | Deckhand |
| 6 | Dry-run seed against staging DB | Deckhand |
| 7 | Captain approves **execute** seed | Captain |
| 8 | `ALLOW_SUNSET_DEMO_SEED=1 ... --execute` | Deckhand |
| 9 | Run §7C SQL + portal smoke §7D | Deckhand |
| 10 | Captain demo sign-off or cleanup per §4 | Captain |

---

## 9. What demo works without vs with seed

| Demo surface | Without DB seed | With DB seed |
|--------------|-----------------|--------------|
| Tab gating / default WhatsApp tab | yes | yes |
| Day Schedule config slot tiles | yes (`portal_demo`) | yes |
| WhatsApp inbox threads | empty | 2 demo conversations |
| Day Schedule lessons table | empty | rows on `2026-07-10`–`12` |
| Day Schedule gear/rentals table | empty | board + bundle rows |
| Accommodation partner queue | n/a (deferred) | deferred |

---

## 10. Summary

Slice 1 seed runner is **not yet implemented**. Inputs are ready (`seed-manifest.json`, `sunset.baseline.json`). Implementation should follow Wolfhouse `stage8_demo` patterns but with **`sunset_demo_slice1` tagging**, **`sunset` tenant isolation**, **dry-run default**, and **`ALLOW_SUNSET_DEMO_SEED=1` gate**. Primary tables: `bookings`, `conversations`, `messages`, `booking_service_records`, optional `staff_handoffs`. **Captain must approve before any staging DB write.**

---

*Document version: 1.0 — 2026-06-19*

## Implementation note (2026-06-19)

- `scripts/fixtures/sunset-portal-slice1-guards.js` — shared fail-closed guards.
- `--execute` accepts **localhost/test DB hosts only** until Captain widens the allowlist for staging.
- Verified offline by `verify:sunset-portal-slice1-seed-runner` (no DB, no live execute).

