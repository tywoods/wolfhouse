# Phase 25e — Owner data catalog + approved query patterns

**Status:** IMPLEMENTED (catalog + templates; no AI planner)  
**Date:** 2026-06-07  
**Scope:** Curated owner BI table/column policies and safe SQL templates for Stage **25f** AI planning

---

## 1. Purpose

Stage **25d** added a read-only SQL validator/executor. Stage **25e** adds the **data catalog** that future AI SQL planning must obey:

- Safe **tables** and **columns**
- **Client scoping** rules per table
- **Sensitive field** policy
- **Approved query templates** (data only — not auto-executed)

**Not in scope:** AI SQL planner (25f), WhatsApp sends/routing, Stripe, Meta webhooks, n8n, env changes, DB migrations.

---

## 2. Module

`scripts/lib/owner-data-catalog.js`

| Export | Role |
|--------|------|
| `getOwnerDataCatalog({ client_slug? })` | Full catalog snapshot |
| `getOwnerAllowedTables()` | SQL allowlist (feeds 25d validator) |
| `getOwnerAllowedColumns(table)` | Per-table column allowlist |
| `getOwnerTablePolicy(table)` | Scope mode, joins, sensitive columns |
| `getOwnerApprovedQueryTemplates()` | Curated owner BI SQL templates |
| `describeOwnerCatalogForAi({ client_slug? })` | Text summary for 25f planner prompt |

---

## 3. Client scoping modes

| Mode | Meaning |
|------|---------|
| `direct_client_slug` | Table has `client_slug`; filter with `client_slug = $1` |
| `join_required` | No safe direct slug column; use approved join/subquery |
| `global_reference` | Inventory/reference; scope via assignment/booking anchor |
| `blocked` | Not owner-visible (auth, secrets, etc.) |

### Staging caveat: `bookings` has no `client_slug`

On staging Postgres, **`bookings` uses `client_id`** (FK to `clients`), not `client_slug`. The **`clients` table is not** in the owner SQL allowlist.

Therefore:

- **`bookings` is `join_required`**, not `direct_client_slug`.
- Approved pattern: scope via **`booking_service_records.client_slug = $1`** subquery or join.
- The 25d validator still requires the literal text **`client_slug = $1`** somewhere in SQL ( satisfied by the BSR anchor ).

**`booking_service_records`** is `direct_client_slug` and is the primary tenant anchor used in hosted 25d.1 proofs.

---

## 4. Catalogued tables

| Table | Scope mode | Notes |
|-------|------------|-------|
| `bookings` | join_required | BSR subquery anchor |
| `payments` | join_required | Join BSR on `booking_id` |
| `booking_beds` | join_required | BSR subquery on `booking_id` |
| `booking_service_records` | direct_client_slug | Primary scope anchor |
| `rooms` | global_reference | Scope via assignments |
| `beds` | global_reference | Scope via assignments |
| `conversations` | join_required | `guest_message_events` phone anchor |
| `messages` | join_required | Via conversations |
| `guest_message_events` | direct_client_slug | Event-level BI |
| `staff_phone_access` | direct_client_slug | **Diagnostics only** — not SQL-allowlisted |

**Blocked (not allowlisted):** auth/session tables, `clients`, `guests`, `guest_message_sends`, secrets, etc.

---

## 5. Sensitive fields (hidden by default)

Blocked or hidden from owner projections unless explicitly allowlisted:

- `raw_payload`, full `metadata` JSON blobs, `normalized` webhook JSON
- Stripe provider IDs (`stripe_checkout_session_id`, `stripe_payment_intent_id`, …)
- WhatsApp provider message IDs
- `session_state`, auth tokens, secrets

**Allowed for owner business context:** `guest_name`, `phone`, `email`, `booking_code`, dates, package, room/bed assignment, payment status/balance, service/add-on fields, conversation summaries.

---

## 6. Approved query templates

Templates are **data** in the catalog. Each includes `id`, `description`, `required_params`, SQL (`$1` = `client_slug`), `expected_row_shape`, `allowed_role: owner`, and `validation_status`.

| ID | Status | Description |
|----|--------|-------------|
| `outstanding_balances` | approved | Positive balance due |
| `revenue_summary_by_month` | approved | Paid totals by month |
| `arrivals_on_date` | approved | Check-ins on `$2` |
| `arrivals_tomorrow` | approved | Check-ins tomorrow |
| `checkouts_on_date` | approved | Check-outs on `$2` |
| `occupancy_by_date` | approved | Assignments on `$2` |
| `package_popularity` | approved | Counts by package |
| `addon_revenue` | approved | Service revenue by type |
| `bookings_by_source` | approved | Counts by source |
| `underbooked_dates_basic` | pending | Heuristic low-occupancy dates |

All approved templates include `client_slug = $1` and `LIMIT` or safe aggregation.

---

## 7. Validator integration (25d)

`scripts/lib/owner-readonly-sql.js` reads **`getOwnerAllowedTables()`** from this catalog. Existing 25d validation behavior is unchanged.

---

## 8. What comes next

| Stage | Scope |
|-------|--------|
| **25f** | AI SQL planner bound to catalog + templates; all generated SQL must pass `validateOwnerReadOnlySql` |
| **25e.1** (optional) | Hosted proof: deploy, run templates via `/staff/owner/sql/validate` or `/execute`, confirm read-only |

---

## 9. Explicit non-goals (25e)

- No AI SQL planner
- No WhatsApp sends or routing changes
- No Stripe / Meta / n8n changes
- No booking/payment writes
- No env or migration changes unless absolutely required

---

## 10. Verification

```bash
npm run verify:luna-agent-phase25-owner-data-catalog
npm run verify:luna-agent-phase25-owner-readonly-sql
npm run verify:luna-agent-phase25-owner-whatsapp-router
```
