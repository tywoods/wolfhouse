# PRICING-DEPOSIT-ADD-500-001 — staging publisher handoff

## Status and scope

Local repair and verification; **not a staging success claim**. Captain has not
pushed, applied a remote migration, deployed, restarted a gateway, or sent a guest
message. Guest-lookup BUILD and all excluded projects remain untouched.

The exact TYPE Deposits / Standard deposit / Per booking / Per person form maps
to `scripts/browser/wolfhouse-admin-pricing-ui.js`. It sends:

1. `PUT /staff/admin/wh/pricing/items?client=wolfhouse-somo`
2. `PUT /staff/admin/wh/pricing/prices?client=wolfhouse-somo`

This API deliberately refuses `client=sunset` (404). Sunset's pricing handlers
and tables are separate. Confirm the actual host/client/request before applying;
do not widen the tenant guard or assume a Sunset-only database needs this repair.

## Root cause established locally

The shipped migration 076 CHECK on `wh_pricing_items.item_type` accepts only
`package`, `rental`, `service`. Current validators and the form also support
`deposit`, `supplement`. The first Save insert fails before the price write:

```text
SQLSTATE 23514
new row for relation "wh_pricing_items" violates check constraint "wh_pricing_items_item_type_check"
```

This is a PostgreSQL-engine error observed with the exact migration, not an
injected error. The existing fake-SQL pricing gate passes despite this defect.
Runtime-created tables lack that historical CHECK, explaining why the two
installation paths can behave differently. Catalog promotion also encounters
the historical constraint. Migration 106 repairs either installation shape.

The reported staging exception is **not yet obtained**. In the same migrated
local schema a season Save with a valid staff actor succeeds. Therefore the
separate Seasons banner remains unproven/unfixed; do not silently attribute it
to the deposit CHECK. A missing staff actor still fails with FK SQLSTATE 23503,
as it should. Do not strip `updated_by` or swallow database errors to hide it.

## Change

`106_wh_pricing_catalog_extra_types.sql` atomically replaces only the named CHECK
with the five already-supported catalog types. It retains all data, indexes,
foreign keys, role/write-flag checks, and tenant boundaries. An absent table is
a no-op. Reapplication preserves catalog rows. Lock acquisition is bounded at
5 seconds; validation failure rolls back the statement. No auto-down migration:
restoring the old CHECK after deposits exist would reject valid new data.

**An API image deploy alone does not apply this fix.** The authorized publisher
must explicitly apply the reviewed migration to the confirmed staging database.
No runtime schema mutation or new retry behavior was added.

## Repeatable local proof

Requires the existing dev dependencies PGlite and (for browser proof) Playwright
with Chromium. No staging DSN, Azure, Stripe, guest, or outbound transport used.

```bash
# Intentionally fails with HTTP 500 and the real 23514 above:
node scripts/verify-pricing-deposit-add-500-001.js --baseline

# Must pass (migration + real handlers + store SQL + real Chromium form):
npm run verify:pricing-deposit-add-500-001
node scripts/verify-wolfhouse-admin-pricing.js
```

Browser proof loads the unchanged production pricing module in a minimal portal
shell. Its actual fetches dispatch to real pricing handlers and PGlite (Postgres
WASM), not fabricated API results. It clicks Add/Save for both units, checks both
writes return 200, reloads the catalog, and checks the persisted label, unit and
1975 cents. It does not test live authentication or the complete staging portal.

Other checks cover season Save, API deposit create/edit/read-back, supplement,
invalid types, Sunset rejection, operator rejection, disabled writes,
idempotence/data preservation, FK retention, absent-table no-op and upgrade of
runtime-created tables. Existing pricing gate: 238 passed, 0 failed.

## Skipper: evidence required before staging acceptance

1. Capture the failed Save's host, client slug, URL/method, timestamp, status and
   response `code`. Read the matching `[wh.pricing.item_save]` server exception;
   preserve its message/constraint. For Seasons capture its own request and log.
   Do not post cookies, credentials, full guest records or raw row DETAIL in chat.
2. On the approved **staging** DB, read:
   ```sql
   SELECT current_database(), to_regclass('public.wh_pricing_items');
   SELECT conname, pg_get_constraintdef(oid)
   FROM pg_constraint
   WHERE conrelid = to_regclass('public.wh_pricing_items') AND contype = 'c';
   ```
   If the incident is not the catalog CHECK mismatch, stop and return its real
   error rather than treating this patch as proof of its cause.
3. Review/land CLEAN.diff against current GitHub master. Reserve/renumber 105 if
   another migration took it. Apply the SQL with the established authorized
   staging migration workflow and error-stop enabled. Do not edit a production
   connection or build/deploy any unrelated image.
4. Read back the CHECK. In the confirmed Wolfhouse staging portal, Save two
   clearly labelled QA deposits (per booking and per person) using agreed test
   amounts. Record both PUT responses and confirm label/amount/unit after a
   hard refresh. Do not overwrite an existing standard deposit for the probe.
   Retain test IDs for approved cleanup; do not delete real pricing records.
5. Reproduce the Seasons Save separately. Supply its real error if it still
   fails. Sunset needs its own incident evidence if that was truly the host;
   this patch does not change Sunset pricing.
6. Return host/client, revision/migration receipt, red error, green HTTP/read-back
   evidence, and QA screenshot. Only then mark staging proof complete.

Captain's browser reached the Sunset staging sign-in page; there is no Azure
CLI/session in the sandbox. Those limits block live server-log retrieval and
staging Save proof, not the offline schema reproduction above.
