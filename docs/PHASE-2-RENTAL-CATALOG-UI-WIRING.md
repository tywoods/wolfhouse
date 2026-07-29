# Phase 2 — Rental catalog: UI + drawer wiring + DB smoke (last mile)

**Status:** backend spine DONE + tested offline. This is the remaining
DB/visually-verified pass (the plan's "Needs DB → Skipper"). Each step below has a
verification that must be run against a **staging DB with the seed applied** —
the staff panel/drawer live in one giant HTML template literal whose client-JS
`node --check` cannot validate (fetch the served page + parse `<script>` blocks).

## Already landed (offline, tested)

- Table: `database/migrations/051_tenant_rental_offerings.sql`.
- Engine `scripts/lib/tenant-rental-offerings.js`: `listRentalOfferings`,
  `createRentalOffering`, `updateRentalOffering`, `deleteRentalOffering`,
  `seedRentalOfferings`, `applyRentalMutualExclusion` — gate
  `scripts/verify-tenant-rental-offerings-crud.js` (27 checks).
- Seed rows builder: `scripts/lib/tenant-rental-offerings-seed.js`
  (`buildRentalOfferingRows`).
- Admin CRUD endpoints (`scripts/staff-query-api.js`):
  `GET/POST/PATCH/DELETE /staff/admin/config/rental-offerings[/:offering_key]`.

## Step 1 — Seed Sunset (DB)

Run once against staging (and later prod), idempotent:

```js
const { buildRentalOfferingRows } = require('./scripts/lib/tenant-rental-offerings-seed');
const { seedRentalOfferings } = require('./scripts/lib/tenant-rental-offerings');
// for each Sunset location:
await seedRentalOfferings(pg, { clientSlug: 'sunset', locationId, rows: buildRentalOfferingRows('sunset') });
```

Verify: `GET /staff/admin/config/rental-offerings?client=sunset&location=sunset-somo`
returns board / wetsuit / bundle / sup with the bundle's `excludes` =
`["board_rental","wetsuit_rental"]`.

## Step 2 — Panel: data-driven Rentals box

In the admin config panel template, replace the hardcoded rentals section with one
that on load `fetch`es `GET …/rental-offerings` and renders:
- **empty state** when `offerings:[]` (a fresh tenant) with a "＋ Add rental item".
- per item: name (rename → `PATCH …/:key {label}`), delete (→ `DELETE …/:key`),
  and the existing period+price editor (unchanged — still writes
  `tenant_price_rules` via `POST /staff/admin/config/prices` with
  `item_code = offering_key + '__' + period_window`).
- "Add rental item" → `POST …/rental-offerings {offering_key,label,group_key,excludes}`.

Client-JS escaping: this is inside the template literal — use `\\'` not `\'`
(see the staff-ui-template-literal memory). Verify by fetching the served page.

## Step 3 — Drawer: read catalog + data exclusion

Replace hardcoded `board_and_suit_rental` client-JS in `staff-query-api.js` with
catalog + `applyRentalMutualExclusion`:
- `22141-22142` board/wetsuit-on derivation → derive from selected keys vs each
  row's `excludes[]`.
- `23154/23166/23207/23223` bundle detection → `catalog.get(key).excludes`.
- `23293-23294` & `23519-23523` `scheduleApplyRentalMutualExclusion` → port to
  the symmetric `applyRentalMutualExclusion(selectedKeys, catalog)` semantics.
- `23406/23420/23423` bundle-only price filter, `23461` label fallback → row
  `label`. Render rental rows by iterating the catalog, not the 4 fixed keys.

The drawer needs the catalog client-side: expose it via the schedule bootstrap
JSON (same place `scheduleAdminPricesCache` is seeded) sourced from
`listRentalOfferings`.

## Step 4 — Retire server enums

`scripts/lib/tenant-admin-writes.js`: `resolveRentalGroupOffering` (391-392) and
display resolution (761-762, 840) read from `listRentalOfferings` instead of the
frozen `RENTAL_GROUP_KEYS/OFFERING/DISPLAY` (38-50). Keep the maps only as a
migration fallback until the seed is confirmed live in prod.

## Step 5 — DB smoke gate (the acceptance test)

Extend the template smoke gate to prove, against staging DB:
- Sunset's 4-item catalog renders + books **byte-identical** to pre-change.
- A NEW item `kayak_rental` (group `sup`, a price row `kayak_rental__full_day`)
  added via the endpoints renders in panel + drawer, books, and its `excludes`
  are honored.
- Deleting an item removes it from panel + drawer without touching history.

## Do-not

- Do not land Steps 2–4 without Step 1 seeded in the same environment — the live
  path would read an empty table and Sunset rentals would vanish.
- Do not move price-per-period off `tenant_price_rules`; this catalog owns
  identity only.
