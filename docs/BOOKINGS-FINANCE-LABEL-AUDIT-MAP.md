# Bookings / Finance / Label audit map

Branch: `feat/bookings-finance-label-audit`
Scope: Finance soft-fail data quality, Bookings code → Schedule deep-link, shared item display-name resolver, cancelled/hidden Type.

## 1. Display surfaces checklist

| Surface | Former authority / hardcoding | Final resolver path | Tests |
|--------|--------------------------------|---------------------|--------|
| **Bookings list Type** | `buildTypeCategories` skipped `status=cancelled` services → `—` after cancel | `classifyServiceTypeCategory` includes cancelled rows; occupancy unchanged | `verify-sunset-bookings-admin-sort-type.js` cancelled/hidden Type |
| **Bookings list items / expand card** | `sm.course_label \|\| sm.label \|\| service_type` ad-hoc | `resolveItemDisplayName` via `item-display-name.js` + catalog map from `listRentalOfferings` | `verify-item-display-name.js` |
| **Schedule drawer line labels** | `resolveRentalOfferingFriendlyLabel` + local course/accom strings | Same shared `resolveItemDisplayName` (rental path) in `formatSunsetDrawerDailyItemLabel` | `verify-item-display-name.js` + existing drawer/label verifiers |
| **Invoice / service-record lines** | `resolveGenericRentalInvoiceLabel` → rental helper only | `formatServiceRecordInvoiceLineText` prefers `resolveItemDisplayName` | invoice/line consumers + `verify-item-display-name.js` |
| **Luna guest-copy (addon ledger labels)** | Hardcoded `SERVICE_TYPE_LABELS` + staff_ui; shared resolver called **without** current catalog map (stale historical won after Admin rename) | `serviceTypeStaffLabel` → `resolveItemDisplayName` with **current** `catalogLabelMap` from `listRentalOfferings` / `buildRentalCatalogLabelMap`; historical snapshot only when current identity absent. Wired by `buildServiceChargesDueFromContext` (booking context) and `syncGuestAddonServicePaymentLedger` (optional map or load by location). **Hold/add-on production path:** public entry `runGuestHoldPaymentDraftWriteDryRunApproved` → both reuse+create branches in `executeHoldPaymentDraftWrite` call `attachAll` via `buildHoldWriteAddonAttachOpts` (propagates `locationId` so ledger loads current Admin catalog). Proof is behavioral entry-point RED/GREEN for both branches (not regex/helper alone). | `verify-item-display-name.js` entry/reuse + entry/create attach→ledger RED/GREEN |
| **Finance summary money** | Hard throw on any malformed cents / material drift → 503 whole tab | Soft-fail per row (malformed → 0 + ID log) **and** soft-fail material balance drift (flag + recon log); incomplete legacy (null total + malformed BSR) → `reconciliation_unavailable` (never false drift); only overflow/structure hard | `verify-sunset-finance-summary.js`, `verify-sunset-finance-data.js`, `verify-sunset-finance-endpoint.js` |
| **Bookings code control** | Static monospace text (row expand only) | Keyboard/ARIA button → **generated** `openBookingInSchedule` (`window.openBookingInSchedule`) → `scheduleOpenDayDetail` + `openScheduleDetailDrawer`. Gate exercises production owner; intercepts only tab/day/drawer boundaries; negative seam disables production owner without reimplementation | `verify-sunset-bookings-admin-n1.js` Playwright |

## 2. Shared resolver owner

**File:** `scripts/lib/item-display-name.js`

- **Rentals:** `offering_key` → `buildRentalCatalogLabelMap` / `resolveRentalOfferingFriendlyLabel` (catalog first, historical snapshot fallback).
  **Proof:** fixture catalog label `Surfboard + Wetsuit` for `board_and_suit_rental` — **not** a string constant in the resolver.
- **Accommodation:** `package_name` / package labels → room → bed → `"Accommodation"`.
- **Lessons:** `course_label` / `private_lesson_label`.
- **Historical:** `offering_label`, `display_name`, `label`, `service_name` when current catalog identity is absent.

### Authority honesty (exact)

| Layer | Authority |
|-------|-----------|
| Current Admin rental label | `listRentalOfferings` → `buildRentalCatalogLabelMap` → `catalogLabelMap` / `catalogLabel` |
| Rental display resolve | `resolveRentalOfferingFriendlyLabel` (catalog first, then historical) |
| Cross-surface display | `resolveItemDisplayName` (calls rental helper for rental-like rows) |
| Luna guest-copy | `serviceTypeStaffLabel` / `formatServiceChargeDueLine` — **must receive** current catalog map; does not assume pre-enriched metadata |
| Luna hold/add-on write attach | Public entry `runGuestHoldPaymentDraftWriteDryRunApproved` → reuse (~496) + create (~686) branches → `buildHoldWriteAddonAttachOpts` → `attachAllGuestAddonServices` → `syncGuestAddonServicePaymentLedger` (load by `locationId` when map omitted). Optional `context.attachAllGuestAddonServices` inject for tests only (defaults production). |
| Bookings list / drawer / invoice | Callers load catalog map and pass into `resolveItemDisplayName` |
| Finance money totals | Persisted `total_amount_cents` when present; legacy null → full effective BSR sum only when **all** BSR commercial amounts for that booking parse cleanly |

Do **not** duplicate lookup logic in UI strings or Luna copy. Do **not** invent money from incomplete BSR after soft-filtering malformed rows.

## 3. Finance soft-fail / diagnostics

| Concern | Behaviour |
|--------|-----------|
| Malformed / null / NaN / non-integer row amounts | Contribute **0**; log `[finance.data_quality] malformed_monetary_row` with **IDs only** (`booking_id`, `payment_id`, `refund_id`, `service_record_id`, `source`, `reason`) |
| Material balance drift (stale `balance_due` vs total−paid) | Soft-fail per booking: log `[finance.data_quality] material_balance_drift` with `booking_id` + reconciliation fields (`computed_cents`, `persisted_cents`, `delta_cents`); flag in `data_quality.balance_drift` / `flagged_booking_ids`; **summary still returns (HTTP 200)**. Outstanding uses total−paid, not persisted balance_due. |
| Legacy null total + malformed BSR (incomplete inputs) | Malformed soft-fails/logs; reconciliation **skipped** for that booking with `data_quality.reconciliation_unavailable` (`reason: incomplete_inputs_malformed_bsr`). **Never** emit false `material_balance_drift` from partial clean BSR. Unaffected bookings still aggregate. Do not guess money. |
| Unsafe overflow / unrecoverable structure | Still `FinanceDataQualityError` → endpoint **503** `FINANCE_DATA_QUALITY` |
| Captain diagnostic | `scripts/diagnose-sunset-finance-data-quality.js` (read-only; SQL fallback if no DB) |

### Live incident (authoritative evidence — do not repair from this branch)

- **One** finance drift booking: `c713c1d7-7f11-4087-bb95-f78c0eaec65e`, status confirmed.
- `total_amount_cents=3500`, persisted `balance_due_cents=2000`, no matching captured payment.
- Reconcile: expected owed **3500** vs persisted **2000**, material delta **1500**.
- 38 checked, only discrepancy; `BADINT=[]` (no null/NaN/non-integer money rows).
- Service records active — **not** restore-leaves-cancelled-records.
- Root cause class: **stale balance versus payments** (likely partial payment/refund/edit test history); exact money truth unconfirmed.
- **Owner decision required (do not guess live data):** either set balance owed **3500** if unpaid, **or** capture missing **1500** payment if it was paid. Captain real-DB revalidates after owner choice.

Cancel → refund → restore: BSR status cancelled/restored confirmed; payments/totals not rewritten on cancel. No invented live DB mutation.

## 4. Bookings code → Schedule

Owner chain (no duplicate nav):

1. `adminBookingsOpenInSchedule` (Bookings UI)
2. **`window.openBookingInSchedule`** (portal export of generated production owner)
3. `window.switchToTab` / free `switchToTab` → Schedule tab
4. `scheduleOpenDayDetail` (canonical date nav; prefers `window.scheduleOpenDayDetail` when set)
5. `openScheduleDetailDrawer` (existing drawer; prefers window when set)

Uses `service_date_start` (now includes cancelled service dates for list deep-link).

Gate integrity: Playwright exercises the real generated `openBookingInSchedule` (not a test reimplementation). Legitimate boundary intercepts only (tab / day / drawer). Negative seam disables production `openBookingInSchedule` without stubbing a working reimplementation — asserts no tab/day/drawer.

## 5. Cancelled / hidden Type

- **Root cause:** cancel sets all BSR `status='cancelled'`; type derivation skipped those rows → empty `type_categories` → UI `—`.
- **Fix:** type derivation includes cancelled services; `serviceDateSpan` includes cancelled dates for list/nav.
- **Unchanged:** inventory/occupancy SQL and charged fallback still exclude cancelled where intended.

## 6. Verification commands

```bash
node scripts/verify-sunset-finance-summary.js
node scripts/verify-sunset-finance-data.js
node scripts/verify-sunset-finance-endpoint.js
node scripts/verify-sunset-batch-a1-f1-f3-cancel-hide.js
node scripts/verify-sunset-cancel-hide-v2.js
node scripts/verify-sunset-bookings-admin-sort-type.js
node scripts/verify-item-display-name.js
node scripts/verify-sunset-rental-labels-p0e.js
node scripts/verify-sunset-bookings-admin-n1.js
```

## 7. Captain real-DB (operator-owned)

```bash
# Read-only diagnose (staging DATABASE_URL)
node scripts/diagnose-sunset-finance-data-quality.js --client=sunset --location=sunset-somo

# Or run the SQL printed by that script against staff DB.
# After identifying IDs: repair amount columns / balance_due only; re-fetch finance summary.
# Deploy/image push: operator laptop from master after merge — not this branch checkout.
```

Do not claim live repair from this agent branch.
