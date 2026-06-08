# Phase 26i — Manual booking quote fixes + transfer totals + live balance pebbles

## Summary

Focused patch for Staff Portal booking quotes, invoice totals, Services Add/Remove controls, and live payment/balance UI updates. No DB schema changes, no Stripe business-logic refactor, no WhatsApp/Meta/n8n/guest AI side effects.

## Transfer charges in invoice totals

- `booking_transfers` rows with `price_cents > 0` and status `requested` or `confirmed` are included in running invoice / balance due / payment link amount.
- Removed, `not_needed`, and `cancelled` transfers are excluded.
- Included transfers at `price_cents = 0` do not change totals.
- Manual override transfer prices count when active.
- Payments tab shows a **Transfers** section with per-direction line items.
- Saving a transfer does **not** create a payment row.

## Manual booking package defaults

- Stay **&lt; 7 nights** → default package **No package / accommodation only**.
- Stay **≥ 7 nights** → default **Malibu**.
- Auto-default applies until staff manually changes the package dropdown.

## No package pricing

- `package_none` is handled explicitly in `calculateWolfhouseQuote()` (no unknown package error).
- Nightly accommodation = Malibu weekly price for season ÷ 7, rounded up to nearest €5 (Formula B), × nights × guests.
- No package services are included.

## Manual Price Override

- Dropdown label: **Manual Price Override**.
- **Price per night** input appears when selected (EUR).
- Quote uses price/night × nights × guests (+ room supplement rules unchanged).
- Missing/invalid price blocks with: `Enter a valid price per night for Manual Price Override.`

## Add Services (Create New Booking)

- Section heading renamed from **Add-ons** to **Add Services**.
- Visible **Meal** label (not Meals).

## Services tab — multi Add / Remove

- **Confirm Add** supports multiple service rows (Add another service).
- **Remove** supports multi-select; **Confirm Remove** removes all selected records in one action.
- After remove, list refreshes and Confirm Remove is not stuck disabled.
- Services tab stays active; Balance Due pebbles refresh in place.

## Live payment / balance updates

- `bcRefreshBookingFinancialSummary()` refreshes drawer header pebbles, calendar block pebbles, Overview payment summary, and optionally Payments tab.
- Triggered after: service Add/Remove, transfer Save/Remove, Generate Payment Link, Record Cash Payment.
- Generate Payment Link stays on Payments tab; link is not sent to guest.

## Env / keys

No new env vars. Existing flags:

- `STAFF_ACTIONS_ENABLED=true`
- `STRIPE_LINKS_ENABLED=true`
- `WHATSAPP_DRY_RUN=true`

## Safety

- No payment rows from transfer save or service Add/Remove.
- No WhatsApp sends from payment link generation.
- Stripe checkout creation unchanged except amount reflects transfer-inclusive balance.
