# Sunset Rental Equipment Stock Implementation Plan

> **For Hermes:** Implement only after Monshies explicitly approves, using an isolated worktree and TDD.

**Goal:** Let Sunset staff set physical rental stock in Admin and prevent Staff/Luna from creating overlapping rentals beyond the remaining units on any day.

**Architecture:** Add location-scoped stock to the existing authoritative `tenant_rental_offerings` catalog. Every rental offering is created through the same Admin **Add rental item** flow and becomes an independent stock-controlled product. `Surfboard + Wetsuit` is only a possible user-created item name—not a predefined bundle type. Compute remaining stock from active booking service records for that exact offering across every date in the requested rental window, and enforce the same calculation inside the booking transaction. The system never creates hidden component relationships or subtracts one offering from another.

**Tech Stack:** Node.js, PostgreSQL, generated Staff Portal browser modules, existing Staff API rental catalog/quote/create/edit flows.

---

## Current state

- Admin already owns rental item identity in `tenant_rental_offerings` and prices in `tenant_price_rules`.
- Create/Edit already support per-item quantities and date ranges.
- Legacy `board_and_suit_rental` paths persist component rows; implementation must preserve historical reads while removing that special behavior from new catalog/booking paths.
- Current “Available” means enabled/bookable with a positive price. It does not represent physical units.
- There is no authoritative stock field or transactional overbooking guard.

## Product rules

1. Admin sets **Total stock** per physical rental item and location, for example 12 surfboards and 20 wetsuits.
2. Stock is a whole number from 0–999. Zero means sold out, not deleted.
3. A unit is reserved on every calendar date touched by the rental.
4. Remaining stock for a date is `total stock − active reserved quantity`.
5. A multi-day request uses the lowest remaining count across its full date range.
6. Cancelled or permanently deleted bookings do not consume stock. Active unpaid/paid bookings do consume it.
7. Restore must re-check stock and fail if the units were sold after cancellation.
8. Create and Edit must re-check under a database lock before writing; two simultaneous bookings cannot oversell.
9. There is no special bundle model. A user may create an item named `Surfboard + Wetsuit` exactly like any other rental item, with its own prices, durations, enabled state, and stock.
10. Remove/avoid hardcoded `board_and_suit_rental` component or bundle behavior on all new booking paths. Persist and count the exact user-created offering identity only.
11. Historical rows remain readable. Missing stock configuration fails closed for new sales rather than pretending unlimited stock.
12. Staff API is the authority. Admin, Schedule, Luna quote/availability, create, edit, cancel, restore, and invoice read the same result.
13. Admin can edit a rental's display name without changing its stable internal `offering_key`.
14. Admin can edit an existing duration and price, add another duration, or remove/deactivate a future duration.
15. Catalog edits apply to future sales only. Confirmed and historical bookings retain booking-time name, duration, quantity, unit price, and total snapshots.
16. Duration edits are atomic and reject duplicate/invalid duration identities; they never leave half-renamed price rows.

## Implementation slices

### 1. Persist stock on the existing rental catalog

**Likely files**
- Create `database/migrations/055_tenant_rental_offering_stock.sql`
- Modify `database/migrations/canonical-manifest.json`
- Modify `scripts/lib/tenant-rental-offerings.js`
- Modify `scripts/verify-tenant-rental-offerings-crud.js`

**Change**
- Add `stock_quantity INTEGER` with `CHECK (stock_quantity BETWEEN 0 AND 999)`.
- Keep it nullable during migration so existing tenants do not receive invented stock.
- Return and validate stock through existing location-scoped Admin rental-offering CRUD.
- Do not put stock in price rows.

### 2. Add one canonical stock calculator

**Likely files**
- Create `scripts/lib/tenant-rental-stock.js`
- Create `scripts/verify-tenant-rental-stock.js`

**Change**
- Resolve physical demand by offering, quantity, and every service date.
- Count only active, non-cancelled, non-archived booking service records for the exact tenant/location.
- Exclude the booking being edited.
- Calculate per-day reserved/remaining stock and the limiting date.
- Calculate each offering independently by its exact `offering_key`; never infer hidden bundle components.
- Return safe structured failures such as `rental_stock_not_configured` and `rental_stock_unavailable`, including requested and remaining quantities for Staff/Luna copy.

### 2A. Give Edit full catalog control

**Likely files**
- Modify `scripts/browser/sunset-admin-ui.js`
- Modify `scripts/lib/tenant-rental-offerings.js`
- Modify the Admin price-row write owner in `scripts/lib/tenant-admin-writes.js`
- Modify the matching authenticated routes in `scripts/staff-query-api.js`
- Extend `scripts/verify-sunset-rental-edit-functionality.js`
- Extend `scripts/verify-tenant-rental-offerings-crud.js`

**Change**
- Add an editable **Rental name** field to the expanded rental editor.
- Rename only the display label; keep `offering_key` stable across catalog and booking references.
- Add editable duration value + unit controls to every existing duration card, alongside amount.
- Save a duration identity change atomically; reject blank, zero, fractional, unsupported, or duplicate duration identities.
- Continue supporting **New time + price** and duration removal/deactivation.
- Persist booking-time display label, duration identity, quantity, unit amount, and total so later Admin edits never rewrite history.
- Use identical controls for every user-created item; no special Surfboard/Wetsuit/combined-item branches.

### 3. Expose date-range availability from Staff API

**Likely files**
- Modify `scripts/staff-query-api.js`
- Modify `scripts/browser/sunset-schedule-rental-availability.js`
- Extend `scripts/verify-sunset-schedule-rental-availability.js`

**Change**
- Add an authenticated tenant/location-scoped availability endpoint accepting offering keys, quantities, and date range.
- Schedule Create/Edit loads availability after dates change.
- Show `X available` beside each item; disable `+` at the remaining count and clearly show Sold out.
- Show every user-created offering's own remaining stock; the UI has no special bundle branch.
- Browser values are advisory only; the server remains authoritative.

### 4. Enforce stock transactionally on Create/Edit/Restore

**Likely files**
- Modify `scripts/staff-query-api.js`
- Modify the existing rental create/edit owner modules identified during implementation
- Extend `scripts/verify-sunset-rental-quantity-create-edit.js`
- Extend `scripts/verify-sunset-edit-authoritative-requote.js`
- Extend `scripts/verify-sunset-schedule-booking-lifecycle.js`

**Change**
- Lock the exact tenant/location physical stock rows in stable key order.
- Recalculate reservations inside the same transaction immediately before persistence.
- Reject the whole write before any booking/payment mutation if one date lacks stock.
- Edit excludes its current records, then checks the replacement quantities/dates.
- Restore runs the same check before returning a cancelled booking to active.
- Cancel automatically releases stock because cancelled rows are excluded from reservation counts.
- Add a concurrency test proving two requests for the last unit cannot both succeed.

### 5. Wire Luna to the same authority

**Likely files**
- Modify the existing Staff API bot rental availability/quote handlers in `scripts/staff-query-api.js`
- Modify the relevant Luna rental tool adapter only if the current response shape cannot carry remaining stock
- Extend Luna rental availability/quote/create verifiers

**Change**
- Luna asks Staff API for date-range stock before quoting or creating.
- Luna never claims availability from model memory.
- If unavailable, Luna reports the available quantity or asks the guest to choose another date/item—without internal stock jargon.
- Final create still performs the transactional stock check to handle races.

### 6. Admin presentation and operational proof

**Likely files**
- Modify `scripts/browser/sunset-admin-ui.js`
- Modify `scripts/lib/staff-portal-i18n.js`
- Modify `scripts/lib/staff-portal-i18n-es-sunset.js`
- Add/extend an Admin stock verifier

**Change**
- On each physical rental card, add **Total stock** with Save.
- Show a read-only **Available today** value beneath it.
- Give every rental card created through **Add rental item** the same editable **Total stock** control.
- Audit every stock change with actor, tenant, location, old value, and new value.

## Verification

- Database constraints, tenant/location isolation, unauthorized writes, and audit record.
- One-day and multi-day remaining-stock math.
- Quantity greater than remaining fails before write.
- Concurrent last-unit race allows one booking only.
- Edit quantity/date changes and same-booking exclusion.
- Cancel releases; restore re-checks; delete does not double-release.
- A user-created combined item behaves exactly like Kayak/Towel/any other item and only its exact offering's bookings reduce its stock.
- No new Create/Edit/Luna path splits a combined item into component service records or invokes hardcoded bundle rules.
- Generic rental items use their own stock.
- Rename changes future Staff/Luna labels while old bookings and invoices keep the original name.
- Duration edits change future selection only; old bookings retain their original duration and price.
- Invalid or duplicate duration edits fail before any row changes.
- Full Edit supports name, duration, price, stock, enabled state, add duration, and remove duration for every user-created item.
- Admin, Schedule, Luna, quote, create, invoice, and persisted quantities agree.
- Authenticated Sunset staging journey with disposable bookings, cancellation cleanup, and stock restored to the starting value.

## Deployment order

1. Merge and apply additive migration.
2. Deploy API with stock still unconfigured/fail-closed.
3. Admin enters real Sunset stock counts.
4. Run authenticated Staff Create/Edit/Cancel/Restore tests.
5. Run Luna availability + create test.
6. Keep Wolfhouse and production untouched until separately approved.

## Risks and controls

- **Overselling race:** transaction locks plus final in-transaction recalculation.
- **Hidden coupling:** availability is keyed only by the exact Admin-created offering; no inferred bundle/component deductions.
- **Incorrect historical occupancy:** only active reservation records count; cancelled/archived rows are excluded.
- **Unknown starting numbers:** no invented defaults; Admin must enter real stock.
- **Hourly reuse:** current rentals lack authoritative pickup/return times, so stock is conservatively reserved for the calendar day. Time-slot reuse should be a later feature only after rental times become authoritative.
