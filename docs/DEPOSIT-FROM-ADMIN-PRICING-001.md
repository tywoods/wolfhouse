# DEPOSIT-FROM-ADMIN-PRICING-001

## Scope and audit result

Local-only audit/repair against GitHub master `de8a70871566dd99e3a94c65040a5343e6daf902`.
Chief owns acceptance; Deckhand owns Staff publication/landing to staff-staging.
No production, 8094, WABA, guest sends, Stripe sessions, or deployments performed.

The existing Admin Pricing integration is credited, not rebuilt. Commit
`c8e2154be5313d68b0997f3ecede5589e39d7f04` (#1256) already wires the two
Wolfhouse deposit rates into quotes, the booking-context invoice, and group
payment-link amounts. It is **not an unconditional €100/€200 calculation**.

- Admin Pricing → Extras → Deposits → **6 nights or more** stores
  `standard_package`; **5 nights or fewer** stores `custom_or_short_stay`.
- Stay length selects the band; the saved per-person rate is multiplied by
  guest count. It is **not** rate × number of nights × guest count.
- Package name and legacy `per_booking` scope must not replace the night-band
  rule or collapse a group's deposit to one person.

### Existing ownership traced

| Path | Rate source / owner |
|---|---|
| Admin Save and catalog read | `wolfhouse-pricing-routes.js` → `wolfhouse-pricing-store.js`, tenant-scoped `wh_pricing_rules` |
| Effective quote config | `loadWolfhouseQuoteConfigWithOverlay` in `staff-query-api.js`; `applyOverlayRentalPricesToConfig` is an alias of the full overlay resolver, including deposits |
| Quote / per-guest breakdown | `wolfhouse-quote-calculator.js` and `booking-guests.js` use overlaid config deposit tiers |
| Staff create command | `luna-front-desk-accommodation-booking-create-service.js` calculates with trusted effective quote config |
| Invoice | booking-context handler supplies `stay_deposit_rates`; `booking-invoice.js` selects the night band and multiplies guests |
| Booking deposit link | `booking-deposit-payment-link.js` loads current rates and subtracts receipts/caps at unpaid invoice total |
| Existing per-guest links | consume persisted `booking_guests.deposit_amount_cents`; no new live repricing of historical guest contracts introduced |

## Reproduced defect and bounded fix

`loadWolfhouseDepositRates(pg)` attempted schema-creation DDL before its SELECT.
On a real PostgreSQL-engine **read-only transaction**, that DDL failed, its catch
skipped the saved rates and returned the seed €200/€100, falsely labelled
`admin_pricing`. The transaction was also left aborted.

Reproduction saved €257.50 / €132.25 through the real Admin handlers on an
isolated PGlite database, read those values back, then called the rate loader in
`BEGIN READ ONLY`. Before the fix it returned 20000 / 10000 cents instead of
25750 / 13225. This is a loader/transaction defect, **not a claim that deployed
staff-staging currently uses a read-only DB role**.

Repair: remove schema initialization from the deposit reader. The existing
migration/Admin-write lifecycle still owns table initialization. The reader
now performs SELECT only and retains both saved rates and a usable transaction.
No arithmetic, schema, UI, route authorization, payment or deployment changes.

### Explicit compatibility boundary

JSON seed/default prices (currently €200/€100) remain the existing behavior when
there is no saved override, no PG supplied to a pure helper, or a genuine pricing
lookup outage. This packet does **not** claim that all numeric fallbacks were
removed or introduce a new fail-closed outage policy. It fixes readable Admin
rates being discarded merely because a read path attempted DDL. Pricing source
metadata on genuine fallback remains a separate existing limitation.

## Verification

```sh
npm run verify:deposit-from-admin-pricing
```

The dedicated offline verifier exercises:

1. Real Admin Save/read-back on migrations 076 + 106 with isolated PostgreSQL.
2. RED → GREEN saved-rate lookup inside `BEGIN READ ONLY`, SELECT-only query log,
   and a succeeding subsequent SELECT in the same transaction.
3. Three changed-rate sets × ten cases (1/5/6/7/10 nights × 1/3 guests): actual
   bot preview handler, calculator, per-guest deposits, Staff create command
   construction, group deposit link amount, receipts, invoice cap and balance.
4. Chromium editing the real Admin Pricing module, dispatched to real handlers
   and the same isolated database; saved rates feed the real invoice row renderer
   at the 5/6-night boundary. Both per-person and legacy per-booking scope tested.
5. Existing rejection of zero/negative/malformed Admin prices; failed edits do
   not change saved rates. No validation was weakened to suit a test.

All browser requests are intercepted. Browser proof omits the full portal/auth
shell and passes DB-loaded rates to the invoice renderer; it is not a live
booking-context HTTP or deployed-permissions proof. Create proof constructs a
command only; it does not reserve beds, persist guest bookings, or call Stripe.

Compatibility commands are separately receipted against the untouched base and
candidate: Admin Pricing, package-minimum transport, per-guest booking payments,
short-stay create, per-guest deposit links, totals deposit link, Hermes send flags,
and `verify:luna-all`. Raw results and any baseline exceptions belong to the
sealed packet's acceptance record, not a blanket all-green assertion here.

## Landing acceptance (Deckhand, after Chief dispatch)

Apply the reviewed commit on current master; preserve any newer edits. Re-run
the dedicated gate and scoped compatibility checks. Follow repository sync and
clean-master image-build preflights. Staff-staging only. No migration needed.
Staging inspection should confirm that the two existing Admin deposit rates
reach invoice/quote amounts at the 5/6-night boundary. No real guest booking,
payment link or WABA send is authorized by this packet.
