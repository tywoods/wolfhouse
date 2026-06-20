# Sunset Admin — DB-Backed Business Config (Schema / Migration Spec)

**Status:** SPEC ONLY — no migration applied, no write endpoints, no Luna wiring in this slice  
**Date:** 2026-06-20  
**Branch:** `feature/sunset-schedule-page`  
**Prerequisite commits:** `645c644` (session-scope hotfix), `19e3ecc` (Admin config resolver/API), `50b399e` (tenant isolation gate)  
**Current gate:** `verify:portal-tenant-isolation` — 37/37 PASS  
**Current resolver:** `scripts/lib/tenant-business-config.js` — config file only, `read_only: true`, `source: 'config'`

---

## Purpose

Sunset staff will eventually edit business settings in the Admin tab that Luna quotes and operational surfaces consume:

| Domain | Today (read-only) | Future (DB-backed) |
|--------|-------------------|---------------------|
| **Prices** | Flattened from `*.baseline.json` catalog | `tenant_price_rules` |
| **Lesson capacity** | Hard-coded `DEFAULT_DAILY_CAP = 24` | `tenant_lesson_capacity_rules` |
| **Lesson times** | `portal_demo.lesson_slots` or `common_slot_times` | `tenant_lesson_time_rules` |
| **Change history** | Empty array | `tenant_config_audit_log` |

This document defines Postgres tables, constraints, resolver precedence, rollout safety, and verification. **Do not apply migrations until Captain approves a dedicated implementation slice.**

---

## Non-goals (this slice)

- No migration execution
- No deploy
- No seed/backfill execution
- No admin write API (`POST`/`PATCH`/`DELETE`)
- No Luna engine wiring
- No Wolfhouse behavior changes
- No Luna SOUL edits
- No plaintext secrets in repo

---

## Tenant identity columns

Every row carries **both**:

| Column | Type | Rule |
|--------|------|------|
| `tenant_id` | `TEXT NOT NULL` | Engine / deployment scope. Sunset: `sunset`. Wolfhouse: `wolfhouse`. |
| `client_slug` | `TEXT NOT NULL` | Staff portal filter / session scope. Sunset: `sunset`. Wolfhouse: `wolfhouse-somo`. |

For Sunset MVP, `tenant_id = client_slug = 'sunset'`. Columns are duplicated intentionally so Staff API queries always filter on `client_slug` (matches session scoping) while Luna/engine readers can use `tenant_id` consistently with baseline `_meta.tenant_id`.

**Invariant:** `client_slug` must match the authenticated staff session client. Cross-tenant reads or writes are forbidden.

---

## Table 1: `tenant_price_rules`

Authoritative price rows for lessons, rentals, and packages Luna may quote once `pricing_status`-equivalent rules allow it.

### Columns

| Column | Type | Constraints / notes |
|--------|------|---------------------|
| `id` | `UUID` | PK, `DEFAULT gen_random_uuid()` |
| `tenant_id` | `TEXT NOT NULL` | e.g. `sunset` |
| `client_slug` | `TEXT NOT NULL` | e.g. `sunset` |
| `item_type` | `TEXT NOT NULL` | `CHECK (item_type IN ('lesson', 'rental', 'package'))` |
| `item_code` | `TEXT NOT NULL` | Stable catalog key, e.g. `group_lesson_adult`, `board_rental`, `surf_accommodation_package` |
| `display_name` | `TEXT NOT NULL` | Human label for Admin UI |
| `currency` | `CHAR(3) NOT NULL` | Default `EUR` |
| `amount_cents` | `INTEGER NOT NULL` | `CHECK (amount_cents >= 0)` |
| `unit` | `TEXT NOT NULL` | `CHECK (unit IN ('person', 'day', 'session', 'item'))` — maps from baseline `prices_eur` keys (`1_day`, `per_person`, etc.) via import transform |
| `active` | `BOOLEAN NOT NULL` | Default `true` |
| `effective_from` | `DATE` | Nullable = effective immediately when active |
| `effective_to` | `DATE` | Nullable = open-ended; `CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)` |
| `created_at` | `TIMESTAMPTZ NOT NULL` | `DEFAULT NOW()` |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | `DEFAULT NOW()` |
| `updated_by` | `UUID NULL` | FK → `staff_users(id)` ON DELETE SET NULL; null for import/backfill |

Optional future column (not in MVP migration): `pricing_status TEXT CHECK (... IN ('unverified_seed','provisional','confirmed'))` mirroring baseline policy. Until then, imported rows default to `provisional`; Luna live quote gate continues to require owner confirmation workflow.

### Uniqueness

Partial unique index — one active price per item/unit/effective window:

```sql
CREATE UNIQUE INDEX uq_tenant_price_rules_active_window
  ON tenant_price_rules (client_slug, item_type, item_code, unit, COALESCE(effective_from, DATE '1970-01-01'))
  WHERE active = true;
```

Historical (inactive) rows may coexist for audit replay.

### Indexes

```sql
CREATE INDEX idx_tenant_price_rules_client_active
  ON tenant_price_rules (client_slug, active, item_type);

CREATE INDEX idx_tenant_price_rules_tenant_item
  ON tenant_price_rules (tenant_id, item_code);
```

### Validation rules

- `amount_cents` must be > 0 for `active = true` rows used in live quotes (enforced in write API, not DB CHECK — allows zero placeholders during import).
- `item_code` must exist in tenant baseline catalog **or** be explicitly created via Admin (write slice validates against allowed catalog keys).
- `client_slug` and `tenant_id` must be consistent for Sunset (`sunset`/`sunset`). Mismatch rejected at insert.
- Overlapping `effective_from`/`effective_to` windows for the same `(client_slug, item_type, item_code, unit)` where both `active = true` — rejected by application layer before insert.

### Resolver mapping (read model)

Maps to existing API shape:

```js
{
  category: item_type,           // 'lesson' | 'rental' | 'package'
  offering_key: item_code,
  label: display_name,
  currency,
  unit,
  amount: amount_cents / 100,
  active,
  effective_state: 'confirmed'   // when pricing_status column added
}
```

---

## Table 2: `tenant_lesson_capacity_rules`

Daily lesson seat caps with scoped overrides.

### Columns

| Column | Type | Constraints / notes |
|--------|------|---------------------|
| `id` | `UUID` | PK |
| `tenant_id` | `TEXT NOT NULL` | |
| `client_slug` | `TEXT NOT NULL` | |
| `scope` | `TEXT NOT NULL` | `CHECK (scope IN ('default', 'weekday', 'date'))` |
| `weekday` | `SMALLINT NULL` | `0=Sunday … 6=Saturday`; required when `scope='weekday'` |
| `service_date` | `DATE NULL` | Required when `scope='date'` |
| `capacity` | `INTEGER NOT NULL` | `CHECK (capacity >= 0 AND capacity <= 999)` |
| `active` | `BOOLEAN NOT NULL` | Default `true` |
| `effective_from` | `DATE NULL` | Optional season window |
| `effective_to` | `DATE NULL` | |
| `created_at` | `TIMESTAMPTZ NOT NULL` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | |
| `updated_by` | `UUID NULL` | FK → `staff_users(id)` ON DELETE SET NULL |

### Scope column rules

| `scope` | `weekday` | `service_date` |
|---------|-----------|----------------|
| `default` | `NULL` | `NULL` |
| `weekday` | `NOT NULL` | `NULL` |
| `date` | `NULL` | `NOT NULL` |

Enforced via CHECK:

```sql
CHECK (
  (scope = 'default' AND weekday IS NULL AND service_date IS NULL)
  OR (scope = 'weekday' AND weekday BETWEEN 0 AND 6 AND service_date IS NULL)
  OR (scope = 'date' AND service_date IS NOT NULL AND weekday IS NULL)
)
```

### Resolution order

When resolving capacity for `(client_slug, service_date)`:

1. **Date override** — active row with `scope='date'` and `service_date = target_date` (within effective window)
2. **Weekday override** — active row with `scope='weekday'` and `weekday = EXTRACT(DOW FROM target_date)` (within effective window)
3. **Default** — active row with `scope='default'` (within effective window)
4. **Fallback** — `24` (`DEFAULT_DAILY_CAP` in `tenant-business-config.js`)

Tie-break within same scope: most recent `updated_at` wins; implementation slice must log ambiguous duplicates.

### Uniqueness

```sql
CREATE UNIQUE INDEX uq_tenant_lesson_capacity_default
  ON tenant_lesson_capacity_rules (client_slug)
  WHERE scope = 'default' AND active = true;

CREATE UNIQUE INDEX uq_tenant_lesson_capacity_weekday
  ON tenant_lesson_capacity_rules (client_slug, weekday)
  WHERE scope = 'weekday' AND active = true;

CREATE UNIQUE INDEX uq_tenant_lesson_capacity_date
  ON tenant_lesson_capacity_rules (client_slug, service_date)
  WHERE scope = 'date' AND active = true;
```

### Indexes

```sql
CREATE INDEX idx_tenant_lesson_capacity_client_scope
  ON tenant_lesson_capacity_rules (client_slug, scope, active);
```

### Resolver mapping

```js
lesson_capacity: {
  default_daily_cap: <resolved default or 24>,
  overrides: [
    { scope: 'date', date: '2026-07-10', capacity: 20 },
    { scope: 'weekday', weekday: 6, capacity: 30 }
  ]
}
```

---

## Table 3: `tenant_lesson_time_rules`

Recurring and date-specific lesson slot templates (local wall-clock times in tenant timezone).

### Columns

| Column | Type | Constraints / notes |
|--------|------|---------------------|
| `id` | `UUID` | PK |
| `tenant_id` | `TEXT NOT NULL` | |
| `client_slug` | `TEXT NOT NULL` | |
| `time_local` | `TIME NOT NULL` | Start time in tenant timezone (`Europe/Madrid` for Sunset) |
| `time_local_end` | `TIME NULL` | Optional end; nullable for single-point slots |
| `label` | `TEXT NOT NULL` | e.g. `Morning surf lesson` |
| `lesson_type` | `TEXT NOT NULL` | e.g. `group_lesson_adult`, `private_lesson` — maps to catalog lesson offering |
| `weekdays_active` | `SMALLINT[] NOT NULL` | Subset of `0..6`; empty array = none (row inactive for recurrence) |
| `service_date` | `DATE NULL` | When set, row applies only to this date (one-off override); `weekdays_active` ignored |
| `active` | `BOOLEAN NOT NULL` | Default `true` |
| `effective_from` | `DATE NULL` | Season start |
| `effective_to` | `DATE NULL` | Season end |
| `created_at` | `TIMESTAMPTZ NOT NULL` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | |
| `updated_by` | `UUID NULL` | FK → `staff_users(id)` ON DELETE SET NULL |

**Note:** User spec listed `time_local` + `weekdays active` without date column; this spec adds optional `service_date` for parity with capacity date overrides and existing `portal_demo.lesson_slots[].date` demo rows.

### Uniqueness

Recurring slots:

```sql
CREATE UNIQUE INDEX uq_tenant_lesson_time_recurring
  ON tenant_lesson_time_rules (client_slug, lesson_type, time_local)
  WHERE service_date IS NULL AND active = true;
```

Date-specific slots:

```sql
CREATE UNIQUE INDEX uq_tenant_lesson_time_date
  ON tenant_lesson_time_rules (client_slug, service_date, time_local, lesson_type)
  WHERE service_date IS NOT NULL AND active = true;
```

### Indexes

```sql
CREATE INDEX idx_tenant_lesson_time_client_active
  ON tenant_lesson_time_rules (client_slug, active);

CREATE INDEX idx_tenant_lesson_time_client_date
  ON tenant_lesson_time_rules (client_slug, service_date)
  WHERE service_date IS NOT NULL;
```

### Validation rules

- `weekdays_active` elements must each be `BETWEEN 0 AND 6`.
- `time_local_end` if set must be > `time_local` (same-day slots only for MVP).
- `lesson_type` must reference a lesson offering in baseline catalog or Admin-approved catalog extension list.

### Resolver mapping

For a given `service_date`, emit slots where:

- `service_date = target_date`, OR
- `service_date IS NULL` AND `EXTRACT(DOW FROM target_date) = ANY(weekdays_active)`

Maps to existing API:

```js
{
  slot_id: <uuid string>,
  date: service_date || null,
  slot_time: 'HH:MM' or 'HH:MM-HH:MM',
  offering_label: label,
  session_type: lesson_type,
  capacity: null,   // per-slot cap deferred; daily cap from capacity rules
  source: 'db'
}
```

Until migrated, resolver continues reading `portal_demo.lesson_slots` then `catalog.lessons.scheduling.common_slot_times`.

---

## Table 4: `tenant_config_audit_log`

Append-only audit trail for all Admin config mutations (future write slice).

### Columns

| Column | Type | Constraints / notes |
|--------|------|---------------------|
| `id` | `UUID` | PK |
| `tenant_id` | `TEXT NOT NULL` | |
| `client_slug` | `TEXT NOT NULL` | |
| `actor_user_id` | `UUID NULL` | FK → `staff_users(id)` ON DELETE SET NULL |
| `actor_email` | `TEXT NOT NULL` | Denormalized for immutable audit |
| `action` | `TEXT NOT NULL` | `CHECK (action IN ('create', 'update', 'deactivate', 'import', 'rollback'))` |
| `entity_type` | `TEXT NOT NULL` | `CHECK (entity_type IN ('price_rule', 'capacity_rule', 'lesson_time_rule'))` |
| `entity_id` | `UUID NOT NULL` | ID of affected row |
| `before_json` | `JSONB NULL` | Snapshot before change; null on create |
| `after_json` | `JSONB NULL` | Snapshot after change; null on deactivate-only if row purged |
| `created_at` | `TIMESTAMPTZ NOT NULL` | `DEFAULT NOW()` |

No `updated_at` — append-only.

### Indexes

```sql
CREATE INDEX idx_tenant_config_audit_client_created
  ON tenant_config_audit_log (client_slug, created_at DESC);

CREATE INDEX idx_tenant_config_audit_entity
  ON tenant_config_audit_log (entity_type, entity_id);
```

### Validation rules

- Every successful write API call must insert exactly one audit row in the same transaction as the config mutation.
- `actor_email` must match authenticated session user email.
- `client_slug` must match session `active_client`.
- Audit rows are never updated or deleted (retention policy TBD — see open questions).

### Admin UI mapping

`change_history[]` in `GET /staff/admin/config` — last N audit entries (default 50), newest first, redacted of internal UUIDs in UI if desired.

---

## Tenant isolation rules

### Query layer

Every SELECT/INSERT/UPDATE on these tables **must** include:

```sql
WHERE client_slug = $session_client_slug
```

Staff API handlers call `assertStaffClientAccess(user, clientSlug, res)` before any config read/write (already pattern for `GET /staff/admin/config`).

### Wolfhouse / cross-tenant

- Tables are **shared Postgres** (same DB as Wolfhouse staging) but rows are partitioned by `client_slug`.
- Wolfhouse Admin is **not enabled** (`is_surf_vertical` gate + `SUNSET_ADMIN_CLIENT === 'sunset'` in resolver).
- No Wolfhouse rows should exist in these tables until a future Wolfhouse Admin slice explicitly scopes them.
- `verify:portal-tenant-isolation` must continue to assert Wolfhouse excludes Admin nav and Sunset schedule bleed.

### Optional hardening (implementation slice)

Row-level security policies on `client_slug = current_setting('app.client_slug')` — evaluate after MVP queries prove correct filtering.

---

## Resolver read precedence

Extend `resolveTenantBusinessConfig(clientSlug)` in a future slice **without changing current behavior until DB has rows**:

```
1. DB (tenant_* tables)     → source: 'db'
2. Config file              → source: 'config'   ← current production path
3. Hard fallback            → source: 'fallback'
```

Per-field precedence (allows partial DB adoption):

| Field | Order |
|-------|-------|
| `prices` | DB active rows for client → flatten baseline catalog → `[]` |
| `lesson_capacity.default_daily_cap` | DB default scope → `DEFAULT_DAILY_CAP` (24) |
| `lesson_capacity.overrides` | DB weekday/date rows → `[]` |
| `lesson_times` | DB rules expanded for today+7d → `portal_demo.lesson_slots` → `common_slot_times` → `[]` |
| `business_info` | Always from baseline `_meta` (no DB table in MVP) |
| `change_history` | DB audit log → `[]` |

When DB returns data for a section, `read_only` remains `true` until writes enabled. `source` reflects highest layer that supplied **any** data: `'db'` if any section from DB, else `'config'`, else `'fallback'`.

Existing API contract unchanged:

```json
{
  "success": true,
  "client_slug": "sunset",
  "read_only": true,
  "source": "config",
  "prices": [...],
  "lesson_capacity": { "default_daily_cap": 24, "overrides": [] },
  "lesson_times": [...],
  "business_info": {...},
  "change_history": []
}
```

---

## Luna consumption (future)

Luna must **not** read Admin tables directly. Shared path:

```
Luna quote / capacity / schedule intents
  → resolveTenantBusinessConfig(tenant_id | client_slug)  [same module]
  → or thin wrapper: resolveLunaBusinessConfig(tenantId)
  → enforce pricing_policy gates (confirmed-only for live quote)
```

Benefits:

- Single truth for portal Admin tab and Luna engine
- Tenant isolation enforced once in resolver + session/API layer
- Config file remains emergency fallback if DB unavailable (read-only degrade)

Wiring is a **later slice** after DB read path is proven. No SOUL changes in schema slice.

---

## Feature flag: admin writes

| Env var | Default | Behavior |
|---------|---------|----------|
| `SUNSET_ADMIN_WRITES_ENABLED` | `false` | When false: all write routes return `403 { error: 'writes_disabled' }`; Admin UI stays read-only; audit table receives no application writes except import tooling. |
| `SUNSET_ADMIN_DB_READ_ENABLED` | `false` (proposed) | When false: resolver skips DB layer (current behavior). When true: resolver attempts DB read before config file. Allows read rollout before writes. |

Both flags default off. Staging may enable `SUNSET_ADMIN_DB_READ_ENABLED=true` only after migration + backfill verified.

---

## Proposed migration file

**Filename:** `database/migrations/021_sunset_admin_business_config.sql`  
**Header:** `-- NOT YET APPLIED — Sunset Admin business config tables (spec 2026-06-20). Captain approval required.`

Contents: `BEGIN;` → four `CREATE TABLE IF NOT EXISTS` → indexes → `COMMENT ON TABLE` → `COMMIT;`

No data migration in the DDL file. Backfill is a separate approved script.

### Migration safety plan

1. **Additive only** — new tables, no ALTER on Wolfhouse-critical tables.
2. **Empty on apply** — zero runtime behavior change until resolver flag enabled.
3. **Apply on Sunset staging DB first** — `luna-sunset-staging-pg-app` / `sunset_staging` schema.
4. **Wolfhouse staging regression** — run `verify:portal-tenant-isolation` (37/37) after migration apply; Wolfhouse paths must not query new tables until explicitly scoped.
5. **No migration ledger** — follow existing manual apply order per `database/migrations/README.md` (after `020`).
6. **Parity** — migration is safe no-op on empty DB; Wolfhouse-only DBs simply gain empty tables.

### Rollback plan

If migration applied but not yet populated or read-enabled:

```sql
BEGIN;
DROP TABLE IF EXISTS tenant_config_audit_log;
DROP TABLE IF EXISTS tenant_lesson_time_rules;
DROP TABLE IF EXISTS tenant_lesson_capacity_rules;
DROP TABLE IF EXISTS tenant_price_rules;
COMMIT;
```

If audit log contains production edits (future): **do not drop** — disable `SUNSET_ADMIN_WRITES_ENABLED`, revert resolver to config-only, retain tables for forensic review.

---

## Seed / backfill plan (Sunset staging only — not executed in this slice)

**Script (future):** `scripts/fixtures/sunset-admin-config-backfill.js`

1. **Target:** `client_slug = 'sunset'`, `tenant_id = 'sunset'` only.
2. **Prices:** Import from `config/clients/sunset.baseline.json`:
   - Walk `catalog.rentals.offerings`, `catalog.lessons.offerings`, `catalog.accommodation.offerings`
   - Map `prices_eur` keys → `unit` enum
   - Skip null / `_note`-only entries
   - Set `active = true`, `effective_from = NULL`, `updated_by = NULL`, `action = 'import'` in audit log
3. **Capacity:** Insert one `scope='default'` row with `capacity = 24`.
4. **Lesson times:** Import `portal_demo.lesson_slots` when present; else expand `common_slot_times` to weekday rules (Mon–Sun or owner-defined set — **open question**).
5. **Idempotent:** Upsert on unique indexes; second run produces zero net new rows.
6. **Guard:** Refuse to run if `client_slug != 'sunset'` or `NODE_ENV=production`.
7. **Verification:** After backfill, `GET /staff/admin/config?client=sunset` with `SUNSET_ADMIN_DB_READ_ENABLED=true` returns `source: 'db'` and price count matches baseline flatten count (~23 today).

---

## API surface (current vs future)

### Implemented (read-only)

- `GET /staff/admin/config?client=sunset` — `handleAdminConfig` in `staff-query-api.js`
- Surf-vertical gated; Wolfhouse → `403 unsupported_client`
- Audit intent: `api:admin.config` (API access log, not `tenant_config_audit_log` yet)

### Future write routes (behind `SUNSET_ADMIN_WRITES_ENABLED`)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/staff/admin/config/prices` | Create/update price rule |
| `POST` | `/staff/admin/config/capacity` | Create/update capacity rule |
| `POST` | `/staff/admin/config/lesson-times` | Create/update time rule |
| `POST` | `/staff/admin/config/deactivate` | Soft-deactivate any rule (`active = false`) |

All writes: owner/admin role check (TBD), transactional audit insert, session client scope enforced.

---

## Verification plan

### Now (no DB)

| Gate | Command | Asserts |
|------|---------|---------|
| Resolver unit | `npm run verify:tenant-business-config` | Sunset config source, 24 cap, prices, lesson times, Wolfhouse blocked |
| Portal v1 | `npm run verify:sunset-portal-v1` | Admin API route, `handleAdminConfig`, resolver import |
| Tenant isolation | `npm run verify:portal-tenant-isolation` | 37/37 — session scope, Wolfhouse no Admin/Schedule bleed, Sunset Schedule tab |

### After migration DDL (no data)

- Migration SQL syntax check / dry-run on empty local Postgres
- Confirm zero rows; resolver still returns `source: 'config'`

### After backfill (staging)

- `verify:tenant-business-config` extended: mock DB fixture **or** staging integration test with `SUNSET_ADMIN_DB_READ_ENABLED=true`
- `GET /staff/admin/config` returns `source: 'db'`, `price_count` ≥ baseline count
- `verify:portal-tenant-isolation` unchanged PASS

### After write slice (later)

- Admin write tests behind `SUNSET_ADMIN_WRITES_ENABLED=true` in CI only
- Audit log tests: every mutation creates row; `before_json`/`after_json` accurate
- Flag-off tests: writes return 403
- `verify:portal-tenant-isolation` — no regression

### Luna integration (later)

- Golden quote tests: lesson/rental prices from resolver match DB row
- Capacity golden: date override beats default
- Lesson time golden: weekday recurrence expands correctly
- No quote from `unverified_seed` / non-confirmed rows when live gate on

---

## Wolfhouse isolation (unchanged)

- Admin tab and routes remain **surf-vertical gated** (`is_surf_vertical`).
- Wolfhouse `client_slug=wolfhouse-somo` must not expose Admin nav or endpoints.
- Tenant isolation gate must assert Wolfhouse excludes Admin UI and visible Sunset schedule markup.

---

## Inventory note

Boards/wetsuits remain **unlimited** for MVP — no inventory count tables in Admin until explicitly scoped.

---

## Open questions

1. **`pricing_status` on DB rows** — mirror baseline `unverified_seed | provisional | confirmed` in `tenant_price_rules`, or keep status in baseline only until Luna live gate needs DB authority?
2. **Per-slot capacity** — defer to `tenant_lesson_capacity_rules.scope='date'` only, or add `slot_id` FK to time rules later?
3. **Package pricing** — accommodation packages are `partner_confirmed`; should `tenant_price_rules` allow `amount_cents = NULL` with `active = false` until partner confirms?
4. **Audit retention** — indefinite append vs 90-day hot + archive?
5. **RLS vs app-filter** — is app-layer `client_slug` filter sufficient for shared DB, or mandate Postgres RLS before write enablement?
6. **Weekday default for `common_slot_times` backfill** — all seven days vs Mon–Sat surf schedule?
7. **Migration numbering** — confirm `021` is next free slot after `020_wolfhouse_room_gender_metadata.sql`.
8. **`SUNSET_ADMIN_DB_READ_ENABLED`** — approve as companion flag to write flag, or single flag with read-always-on once migrated?

---

## Related files (reference only — no changes in this slice)

| Path | Role |
|------|------|
| `scripts/lib/tenant-business-config.js` | Current config-file resolver |
| `scripts/staff-query-api.js` | `GET /staff/admin/config` |
| `scripts/verify-tenant-business-config.js` | Offline resolver tests |
| `scripts/verify-portal-tenant-isolation.js` | Staging tenant gate (37/37) |
| `config/clients/sunset.baseline.json` | Seed source for future backfill |
| `database/migrations/README.md` | Apply order |
