# Sunset Admin Config — Future DB-Backed Settings (Spec Only)

**Status:** SPEC ONLY — no migration, no write endpoints, no Luna wiring in this slice  
**Date:** 2026-06-20  
**Branch:** `feature/sunset-schedule-page`  
**Portal slice:** read-only Admin tab skeleton

---

## Purpose

Sunset staff will eventually manage business settings that Luna quotes and offers:

- **Prices** — lesson/rental/package price rules
- **Lesson capacity** — seats per day/slot (fallback today: 24 seats/day)
- **Lesson times** — scheduled offering windows
- **Business info** — school name, contact, policies surfaced to guests
- **Change history** — audit trail of admin edits

This document defines proposed tables. **Do not run migrations until Captain approves a dedicated slice.**

---

## Proposed tables (Postgres)

### `tenant_price_rules`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `client_slug` | text NOT NULL | e.g. `sunset` |
| `offering_key` | text NOT NULL | e.g. `group_lesson`, `wetsuit_rental` |
| `currency` | text | default `EUR` |
| `amount_cents` | integer | |
| `valid_from` | date | optional effective window |
| `valid_to` | date | optional |
| `source` | text | `admin` \| `import` |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

Unique: `(client_slug, offering_key, valid_from)` or versioned rows.

### `tenant_lesson_capacity_rules`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `client_slug` | text NOT NULL | |
| `rule_type` | text | `daily_default` \| `slot` |
| `slot_id` | text NULL | when `rule_type=slot` |
| `max_seats` | integer NOT NULL | MVP default: 24/day fallback |
| `effective_from` | date | |
| `effective_to` | date NULL | |
| `created_at` | timestamptz | |

Wolfhouse rows must never share `client_slug=sunset` bleed — enforce RLS or `client_slug` filter on all queries.

### `tenant_lesson_time_rules`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `client_slug` | text NOT NULL | |
| `slot_id` | text | stable id |
| `weekday` | smallint NULL | 0=Sun … 6=Sat; NULL = date-specific |
| `service_date` | date NULL | optional override date |
| `slot_time` | time NOT NULL | |
| `offering_label` | text | e.g. Morning surf lesson |
| `session_type` | text | |
| `active` | boolean | default true |
| `created_at` | timestamptz | |

Until migrated, portal may continue to read `portal_demo.lesson_slots` from baseline JSON.

### `tenant_config_audit_log`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `client_slug` | text NOT NULL | |
| `section` | text | `prices` \| `capacity` \| `lesson_times` \| `business_info` |
| `change_summary` | text | human-readable |
| `before_json` | jsonb NULL | |
| `after_json` | jsonb NULL | |
| `changed_by_email` | text | staff portal user |
| `changed_at` | timestamptz | |

---

## API shape (future — not implemented)

Read-only (future slice):

- `GET /staff/admin/config?client=sunset` — aggregate current config for Admin UI

Write (later slice, owner/admin only):

- `POST /staff/admin/config/...` — disabled until audit log + validation exist

**This slice:** no routes added; Admin tab renders client-side placeholders only.

---

## Wolfhouse isolation

- Admin tab and routes must remain **surf-vertical gated** (`is_surf_vertical`).
- Wolfhouse `client_slug=wolfhouse-somo` must not expose Admin nav or endpoints.
- Tenant isolation gate must assert Wolfhouse excludes Admin UI.

---

## Inventory note

Boards/wetsuits remain **unlimited** for MVP — no inventory count tables in Admin until explicitly scoped.
