# Stage 39a — Multilingual Out-of-Order Fixture Results

**Date:** 2026-06-10  
**Reference date:** 2026-06-08 (batch default) / 2026-06-10 per fixture where set  
**Mode:** local, review-only (no WhatsApp, Stripe, confirmations, n8n, deploy)  
**Overall:** **PARTIAL PASS** — fixture pack + runner + verifier complete; Luna behavior exposes clear Stage 39b targets.

## Summary

| Metric | Value |
|--------|-------|
| Fixtures | 12 |
| PASS | 3 |
| PARTIAL | 0 |
| FAIL | 9 |
| Batch runner bug fixed | `fixture` → `fixtures[i]` in conversation batch loop |

## Fixture results

| # | Fixture | Lang | Result | Quote ready | Final intent / lane | Failure category |
|---|---------|------|--------|-------------|---------------------|------------------|
| 1 | it-short-stay-out-of-order | it | FAIL | no | new_booking_inquiry | date_parsing, guest_count, stale quote |
| 2 | it-package-addons-messy | it | FAIL | no | clarify | date_parsing, service/add-on intent, guest_count (`solo` leak) |
| 3 | it-yoga-dinner-midflow | it | FAIL | yes (turn 1) | clarify | guest_count (`solo` leak), service/add-on intent (meals/yoga copy) |
| 4 | en-clean-but-casual | en | PASS | yes | new_booking_inquiry | — |
| 5 | es-short-stay-cash-question | es | FAIL | no (after cash Q) | payment_question | guest_count (`solo alojamiento`), stale quote/correction |
| 6 | de-package-question | de | FAIL | n/a | side_question | package intent, date_parsing, guest_count (side Q drops facts) |
| 7 | mixed-it-en-booking | mixed | PASS | yes | new_booking_inquiry | — |
| 8 | typo-heavy-booking | it | FAIL | no | new_booking_inquiry | date_parsing (`luglo`), guest_count, package intent |
| 9 | emoji-heavy-surf-addons | it | FAIL | n/a | add_service_request | date_parsing, guest_count, service/add-on intent (lane mis-route) |
| 10 | correction-language-switch | it→en | FAIL | no | new_booking_inquiry | date_parsing, guest_count, stale quote/correction |
| 11 | reset-spanish | es | FAIL | no | passthrough | reset, date_parsing, guest_count |
| 12 | german-transfer-side-question | de | PASS | yes | side_question | — (transfer answered, context kept) |

## Failure categories (count)

| Category | Fixtures affected |
|----------|-------------------|
| date_parsing | 1, 2, 8, 9, 10, 11 (+ partial 6) |
| guest_count (`solo` / accommodation-only false positive) | 1, 2, 3, 5, 8, 10 |
| package intent | 6, 8 |
| service/add-on intent | 2, 3, 9 |
| side-question context | 6 (package Q drops booking facts) |
| stale quote/correction | 5, 10 |
| reset | 11 |
| composer tone | 3 (yoga/dinner reply copy) |

## Top 3 fixes for Stage 39b

1. **Italian/Spanish compact date ranges** — Parse `1-5 luglio`, `10-17 luglio`, `1-5 julio` as check-in/check-out (currently single day or wrong range).
2. **Stop `solo` guest-count false positive** — `solo alloggio`, `solo alojamiento`, `solo il soggiorno` must not set `guest_count=1` or overwrite guest name.
3. **Side-question + reset hardening** — Package/transfer questions should retain parsed dates/guests; Spanish `empezamos de nuevo` should trigger `reset_new_booking` and clear prior Malibu context.

## Booking-core regression

`npm run luna:guest-flow-batch -- --local --fixture-set booking-core` — run at commit time (expected green).

## Safety proof

- No WhatsApp send path added
- No live Stripe checkout path added
- No confirmation send path added
- No n8n activation
- No production / Azure deploy
- Batch mode: `review_only: true`

## Next stage

**Stage 39b** — Fix top multilingual/out-of-order failures from this pack (dates, `solo` guest leak, reset + side-question context).

After 39b: **Stage 40a** — Randomized stress tester / hammer harness.
