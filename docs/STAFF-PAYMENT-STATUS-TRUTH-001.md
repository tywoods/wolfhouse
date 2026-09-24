# STAFF-PAYMENT-STATUS-TRUTH-001 — local handoff

## Scope and base

Read/display-only payment and stay-date consistency for Sunset and Wolfhouse.
Branch: `captain/staff-payment-status-truth-001`.
Original base: `2cec171078f8cd934b1a048bdb65e14c4538df08`.
Rebased base: `290bae4b8187976f0191bfb2dfdf6bdd609d7a13` (includes #1172).
No push, merge, deployment, live database writes, guest sends, or gateway restart.
The parent checkout's staged auth work is untouched. No task diff in #1172 files.

## What changed

- Guests and both Inbox context paths hydrate payment status, paid amount, remaining
  balance and unambiguous accommodation dates from persisted booking/service/ledger data.
- Bookings and invoice/summary chips use amount-derived payment labels instead of stale
  booking/payment-link labels. Settled ledger amounts win over stale larger stored paid amounts;
  existing legacy/manual stored-paid fallback remains when no eligible settled rows exist.
- Single accommodation stays supply dates; multiple distinct stays are not flattened.
- Wolfhouse invoice accommodation calculation retains existing persisted-total guards
  against zero quote snapshots and double-counted bundled services.
- Continuation: Guests now reuses `PAYMENT_COLLECTED_SCOPE_SQL` exactly (paid_at,
  finance exclusion, test-cancelled and schedule-deleted fences), and Bookings'
  `computeChargedCents` persisted-service fallback when the booking total is missing.
  The hydration query includes service amounts; signed custom lines and explicit zero
  are preserved. No repricing, ledger mutation, or changes to the #1172 drawer routing.
- Invoice continuation: ordinary Wolfhouse context filters collected-payment eligibility
  without changing the ledger history used by write paths, and supplies Bookings'
  persisted-service total fallback. Its invoice avoids re-adding raw history rows.
- Sunset invoice paid sums/rows use the same collected scope, and invoice line totals
  ignore cancelled services. Raw service rows remain available for editing; cancellation,
  archive and restore keep their pre-existing operational paid aggregate.

## Verification

Run `node scripts/verify-staff-payment-status-truth.js` (repository dev dependencies
PGlite and Playwright, installed Chromium required). This executes production Guests
handler/SQL against a disposable in-memory database, compares actual Bookings payment
SQL and invoice/list helpers, and runs production-emitted Guests/invoice functions in
headless Chromium for both tenant fixtures. Unrelated CRM reads and Inbox conversation
lookups are fixture seams; these checks are **not live staging acceptance**.

Both reviewed Guests bugs were observed RED before their fixes: excluded payment
produced Paid instead of Partial; missing booking total produced Unknown instead of
Partial. The first independent review rejected invoice parity: the original browser
fixture had substituted hydrated Guests totals and constructed quote metadata, while
one service test had prefiltered cancelled rows. Those original passing checks alone
are not evidence for ordinary invoice-loader correctness. The replacement
`node scripts/verify-staff-payment-status-truth-invoice.js` (also called by the main
gate) now passes real SQL through `handleBookingContext` / `loadSunsetBookingBundle`
and feeds their raw results into production-emitted invoice helpers in Chromium.
Coverage includes all collected exclusions, tenant fences, pending links, missing
totals, cancelled services, signed custom discounts and explicit stored zero.
No synthetic quote snapshot or fixture-side cancelled-service filtering is used.

Additional passing gates (`node scripts/<name>.js`):
- `verify-inbox-thread-composite`: 192 passed; `verify-inbox-context`: 48 passed.
- `verify-sunset-booking-drawer-summary`: 96 passed.
- `verify-sunset-edit-header-partial-daycount`: 33 passed.
- `verify-sunset-stripe-payment-webhook`: 68 passed.
- `verify-sunset-bookings-admin-sort-type`: 82 passed.
- `verify-hermes-send-flags`: 53 passed.
- `verify-sunset-linked-booking-payment-labels`, `verify-gina-booking-payment-001`.
- `verify-wolfhouse-bookings-detail-route`: desktop + mobile passed, #1172 untouched.

### Three pre-existing Bookings gate failures

`node scripts/verify-sunset-bookings-admin-n1.js` returns **212 passed, 3 failed**
on both pristine `290bae4b` and the task tree, with identical failure labels:
1. Newest-first release: summary does not show newest collected EUR 99.99.
2. Stale-last release: summary does not retain newest rather than stale EUR 11.11.
3. Narrow 390px: collected/refunded KPI tones missing.

These are baseline failures, not repaired or hidden by this job. Additional pristine-base
checks also fail: `verify-sunset-edit-authoritative-requote` (97 passed / 13 failed)
and `verify-sunset-backend-blockers` (stale literal loader-call assertion). Final
verification compared these assertion failures unchanged against the pristine base.
The full repository suite is not claimed green. Transfer artifact includes focused
logs, RED evidence, base/current gate logs, independent review, commit patch/bundle,
and tip/base IDs.
