# Stage 40a — Random Hammer Test Results

**Seeds run:** 50001
**Count:** 200
**Result:** FAIL

## Totals

| PASS | PARTIAL | FAIL |
|------|---------|------|
| 140 | 24 | 36 |

## Language breakdown

| Language | PASS | PARTIAL | FAIL |
|----------|------|---------|------|
| es | 41 | 5 | 5 |
| it | 30 | 5 | 5 |
| de | 41 | 12 | 2 |
| en | 28 | 2 | 24 |

## Scenario breakdown

| Scenario | PASS | PARTIAL | FAIL |
|----------|------|---------|------|
| greeting_new_guest | 12 | 0 | 0 |
| greeting_booking_start | 12 | 0 | 0 |
| short_stay_accommodation | 10 | 0 | 2 |
| package_booking | 12 | 0 | 0 |
| package_surf_addons | 4 | 8 | 0 |
| short_stay_surf_addons | 1 | 0 | 11 |
| lesson_addon | 0 | 3 | 9 |
| yoga_request | 12 | 0 | 0 |
| dinner_meals_request | 5 | 7 | 0 |
| transfer_side_question | 12 | 0 | 0 |
| bilbao_transfer_extra | 12 | 0 | 0 |
| flight_times_update | 12 | 0 | 0 |
| surf_report_side_question | 9 | 0 | 3 |
| cash_payment_side_question | 0 | 6 | 5 |
| correction_flow | 6 | 0 | 5 |
| reset_flow | 11 | 0 | 0 |
| out_of_order_all_in_one | 10 | 0 | 1 |

## Top failure categories

- **service_addon_intent** — 31
- **accommodation_intent** — 23
- **package_intent** — 22
- **internal_error** — 14
- **cash_side_question** — 8
- **yoga_meals_intent** — 7
- **robotic_copy** — 3

## Top 10 failure examples

### hammer-50001-0005 (PARTIAL)
- Type: package_surf_addons · Lang: es
- Categories: service_addon_intent
- Failures: turn 1: expected_service_interest missing wetsuit; turn 1: expected_service_interest missing surfboard

### hammer-50001-0006 (FAIL)
- Type: short_stay_surf_addons · Lang: de
- Categories: accommodation_intent, internal_error, service_addon_intent
- Failures: final: final.expected_fields.package_interest expected "accommodation_only" got null; final: final expected_quote_ready but quote_status=not_ready; turn 1: expected_service_interest missing wetsuit

### hammer-50001-0007 (FAIL)
- Type: lesson_addon · Lang: it
- Categories: accommodation_intent, service_addon_intent, package_intent
- Failures: final: final.expected_fields.package_interest expected "accommodation_only" got "waimea"; turn 1: expected_service_interest missing surf_lesson; turn 1: expected_accommodation_only but package_interest=waimea

### hammer-50001-0014 (FAIL)
- Type: cash_payment_side_question · Lang: en
- Categories: package_intent, cash_side_question
- Failures: turn 1: expected_accommodation_only but package_interest=malibu

### hammer-50001-0015 (FAIL)
- Type: correction_flow · Lang: en
- Categories: package_intent
- Failures: turn 1: expected_accommodation_only but package_interest=malibu

### hammer-50001-0023 (FAIL)
- Type: short_stay_surf_addons · Lang: es
- Categories: accommodation_intent, internal_error, service_addon_intent
- Failures: final: final.expected_fields.package_interest expected "accommodation_only" got null; final: final expected_quote_ready but quote_status=not_ready; turn 1: expected_service_interest missing wetsuit

### hammer-50001-0024 (PARTIAL)
- Type: lesson_addon · Lang: de
- Categories: service_addon_intent
- Failures: turn 1: expected_service_interest missing surf_lesson

### hammer-50001-0030 (FAIL)
- Type: surf_report_side_question · Lang: en
- Categories: accommodation_intent, package_intent
- Failures: final: final.expected_fields.package_interest expected "accommodation_only" got "malibu"; turn 1: expected_accommodation_only but package_interest=malibu

### hammer-50001-0031 (PARTIAL)
- Type: cash_payment_side_question · Lang: es
- Categories: cash_side_question
- Failures: turn 2: reply_contains "efectivo" missing

### hammer-50001-0034 (FAIL)
- Type: out_of_order_all_in_one · Lang: en
- Categories: internal_error
- Failures: turn 1: expected_quote_ready but quote_status=not_ready

## Top 5 recommended fixes for Stage 40b

1. add-on parsing (muta/tavola/board/lesson)
1. accommodation-only intent + short-stay defaults
1. package detection + side-question context
1. orchestrator crash / missing import
1. payment side-Q copy + quote preservation

## Safety

No writes, live Stripe, WhatsApp, confirmations, n8n activation, or production changes.

