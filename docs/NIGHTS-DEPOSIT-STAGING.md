# Wolfhouse staging: nights-based deposits

## Scope and release order

Ty-approved France **staging only** change. Chief's order is batch 3, then A/B
#1643 (and the separately owned display fix), then this deposit change.
Lookout or Seadog must independently review the exact PR head. Skip owns the
staging deployment; Lunabot owns the post-deployment retest. This document is
not production approval. No guest messages, payment-provider calls, booking
writes, production deployment or gateway restart are part of this PR.

## Staff behavior

Staff → Pricing → Extras has one **Deposit per person** card:

- Nights threshold, X.
- Amount per person for fewer than X nights.
- Amount per person for X nights or more.

The three settings save together in one database transaction. Both room-only
and package stays use this same rule. For X=6 and €100/€200, five nights uses
€100/person and six nights uses €200/person. Existing total/debt caps and paid
receipt deductions remain in the shared quote/financial/payment-link owners.
Historical bookings explicitly marked as per-guest-date quotes retain their
stored deposit and person-bound ceilings; this change does not rewrite them.

## Storage and migration 134

`database/migrations/134_wolfhouse_nights_deposit.sql` is settings-only and
idempotent. It touches only Wolfhouse rows in `wh_pricing_items` and
`wh_pricing_rules`:

- The initial threshold is six nights (the existing `LONG_STAY_NIGHTS` default).
- Existing accommodation-only/custom deposit becomes the below-threshold rate.
- Existing package deposit becomes the at-or-above-threshold rate.
- Existing custom amounts are preserved. Only missing rows receive €100/€200.
- Reapplying the migration preserves subsequently saved thresholds and amounts.

Legacy storage keys `custom_or_short_stay` and `standard_package` are retained
for compatibility. `standard_package` item metadata owns `nights_threshold`.
Existing generic price writes remain compatible, but the UI now saves the whole
policy through `PUT /staff/admin/wh/pricing/deposit-policy` with the
same owner/write-permission checks as other Pricing writes.

No booking, guest, payment, receipt or conversation rows are migrated. This is
not a replay of migrations 132/133 or a generic pending-migration sweep.

## Mandatory staging deploy gate (Skip)

Use `scripts/france-wolfhouse-staging-fast-deploy.js` from the reviewed merged
checkout, with the actual previous image SHA and reviewed merged SHA. Follow
the normal staging backup, health and rollback runbook first.

Before changing **any running Staff or Luna image**, the Staff deployment path:

1. Confirms the existing Staff container belongs to
   `/srv/staff/compose/compose.yml`.
2. Supplies the reviewed migration and applier over stdin to that Staff
   container. No credentials are copied or printed.
3. Requires its database URL **and** `current_database()` to identify
   `wolfhouse_staging`.
4. Reads the existing deposit settings, applies only migration 134, and reads
   back the threshold and both amount rows.
5. Requires `MIGRATION134_PASS` before replacing the Staff image. A database,
   migration or read-back failure aborts deployment before the image swap.
6. Saves the receipt (migration SHA-256 plus before/after pricing settings) in
   the deploy backup directory as `nights-deposit-migration.log`.

**Shipping the SQL file alone is not deployment.** Do not bypass this gate with
a manual image-only swap. The receipt and saved settings must be included in
Skip's staging evidence. No live migration/deployment was run during authoring.

## Offline verification

Run from the repo with its existing Node development dependencies and Chromium:

```sh
node --test scripts/verify-nights-deposit.test.js
node scripts/verify-nights-deposit-settings.js
node scripts/verify-nights-deposit-deploy.js
node scripts/verify-deposit-from-admin-pricing.js
node --test scripts/verify-package-driven-deposit.test.js
node scripts/verify-per-guest-dates-deposit.js
node scripts/verify-france-staging-fast-deploy.js
node scripts/verify-hermes-send-flags.js
node --test scripts/verify-totals-deposit-payment-link.js
```

The settings proof uses isolated PGlite and intercepted Chromium requests to
real Pricing handlers: migration application/read-back/idempotence, custom
amount preservation, one rendered card, all three settings saved and reloaded,
and invalid-input rejection. The deploy proof intercepts process execution;
it does **not** connect to Docker or staging. It proves apply-before-swap and
stop-on-failure ordering. The Admin regression runs three 40-case quote/preview/
per-person/total-cap matrices and emitted invoice checks. The historical-date
suite retains its existing KEEP, unknown, refund, receipt and invoice tests.

At author verification, the Totals suite has **21 passed, 3 failed**. The exact
same three failures reproduce using the unmodified base test and modules:

- Two extracted booking-context cases lack `projectBlockedBedDisplay` in their
  existing VM harness.
- The existing foreign-tenant receipt case returns 20000 instead of its expected
  30000. That failure is not changed or claimed fixed by this deposit PR.

These baseline failures remain visible; they are not skipped or relabeled PASS.
The relevant changed deposit-cap case passes with the nights-based expectation.

The broader `node scripts/verify-luna-all.js` run reports **44/75 green** on
both this change and a separate, unmodified worktree at base `fe29aa59d`.
Both runs list the same 31 failed steps; no newly failing step was added.
This is baseline comparison evidence, not a claim that the broad gate is green.
Full logs and the failed-step comparison are in Captain's
`artifacts/nights-deposit/` evidence directory.

## Ownership boundaries

No changes to `scripts/staff-query-api.js`, `scripts/browser/booking-invoice.js`,
`scripts/lib/staff-manual-override-accommodation-line.js`, `scripts/verify-staff-override-accommodation-line.js`,
or any Hermes runtime files. Deckhand #1644 and Seadog's booking-save/offer guard
remain outside this PR. The existing tests keep their filenames for compatibility.

## Lunabot retest after deployment

1. Load Extras and verify one deposit card, with the migrated custom amounts.
2. Save X and non-default amounts; reload and verify all three values.
3. Test a room-only stay and a package stay immediately below and at X nights.
4. Check Staff invoice/totals, Luna quote, and deposit-link amount agree for the
   same stay/headcount, and none exceeds the actual amount owed.
5. Restore the intended staging settings and attach the migration receipt,
   deployed SHA and outcome evidence for Chief.
