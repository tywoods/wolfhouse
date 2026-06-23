# Wolfhouse Services admin — spec

**Created:** 2026-06-23. Owner ask (Ale via Earthling): a small, extensible "Services" admin in the **Wolfhouse staff portal** (`staff-staging.lunafrontdesk.com` → `wh-staging-staff-api`), starting with a **Create service** button + modal. This is the catalog layer Wolfhouse is missing (services are currently hardcoded in policy + per-type tables; `add_on_orders`/`add_on_items` only hold booked instances).

> "Keep it small — we'll expand this admin a lot." So: minimal, clean, schema future-proofed.

## Service = add-on service
A service is an **add-on**: its **name is the line item** added to a booking and (when spanning) applied across the stay. **Price always multiplies per guest.**

## Data model — `tenant_services` (scoped to `client_slug='wolfhouse-somo'`)
| field | type | notes |
|---|---|---|
| id | uuid pk | |
| tenant_id / client_slug | text | tenant scoping (reuse pattern) |
| name | text, required | the line-item label on the booking |
| category | text | experience / meal / transfer / rental / lesson / other |
| notes_for_luna | text | what Luna may say about it |
| keywords | text[] | so Luna detects guest questions ("do you do X?") |
| start_date, end_date | date, nullable | "running dates"; null = always available |
| price_cents | int | per-guest unit rate |
| price_unit | text | `per_day` (default) / `per_stay` / `one_off` |
| per_guest | bool, default true | always true here (add-on convention) |
| span_booking | bool | auto-apply across the stay (the checkbox) |
| luna_visible | bool, default true | Luna may offer it vs staff-only/internal |
| active | bool, default true | pause without deleting |
| created_at / updated_at / updated_by | | |

Runtime `ensureServicesTable()` (`CREATE TABLE IF NOT EXISTS`) so it works on staging without a manual migration run — same idempotent pattern as `ensureLessonTimeCapacityColumn`. Migration `028_tenant_services.sql` for the record.

## Pricing / span semantics (stored in v1, applied in v3)
`nights_in_window` = overlap(booking nights, [start_date, end_date]) — or all booking nights if no dates.
- `span_booking && price_unit='per_day'` → **charge = price_cents × guests × nights_in_window**.
- else → charge = price_cents × guests (one_off / per_stay).
Example: "Breakfast", per_day, span on, €10, 4 guests, 5 nights in window → €200.

## Phasing
- **v1 (build now):** CRUD admin — Services section in the staff portal, Create button + modal (Name, Start/End date, Notes for Luna, Price, "span across booking" checkbox) + the extras (active, Luna-visible, price_unit, keywords, category), list with edit/delete/toggle. Backend table + write API. Stores data only.
- **v2:** Luna reads `notes_for_luna` + `keywords` (describe + handoff; merge into the knowledge resolver, DB-or-config like Sunset).
- **v3:** bookable — `span_booking`/`per_day`/`per_guest` wires into `add_on_items` so it auto-applies and bills at booking.

## API (mirror Sunset admin plumbing: gate + audit + withPgClient)
- `GET  /staff/admin/services?client=wolfhouse-somo` — list
- `POST /staff/admin/services` — create
- `PATCH /staff/admin/services/:id` — edit
- `DELETE /staff/admin/services/:id` — soft-delete (active=false)

## Build status
- [x] spec
- [ ] migration 028 + write module + validation + verify (this increment)
- [ ] API handlers + routes in staff-query-api.js
- [ ] portal UI section (generic module, not entangled with sunset-admin-ui.js)
- [ ] deploy to wh-staging-staff-api + smoke test

Nothing deploys to live Wolfhouse without explicit go.
