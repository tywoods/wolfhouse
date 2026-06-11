# Stage 40a — Random Hammer Test Results

**Harness:** Stage 40a randomized multilingual stress tester  
**Mode:** local review-only (no writes, Stripe, WhatsApp, confirmations, n8n, production)

## Initial hammer runs

| Seed | Count | PASS | PARTIAL | FAIL | Result |
|------|-------|------|---------|------|--------|
| 40401 | 50 | 29 | 7 | 14 | FAIL |
| 40402 | 100 | 49 | 18 | 33 | FAIL |

JSON reports: `tmp/luna-hammer-report-40401.json`, `tmp/luna-hammer-report-40402.json`

---

## Seed 40401 (50 scenarios)

### Language breakdown

| Language | PASS | PARTIAL | FAIL |
|----------|------|---------|------|
| en | 4 | 1 | 7 |
| es | 12 | 1 | 2 |
| de | 8 | 4 | 1 |
| it | 5 | 1 | 4 |

### Scenario breakdown

| Scenario | PASS | PARTIAL | FAIL |
|----------|------|---------|------|
| short_stay_accommodation | 3 | 0 | 2 |
| package_booking | 4 | 0 | 1 |
| package_surf_addons | 2 | 2 | 0 |
| short_stay_surf_addons | 2 | 1 | 1 |
| lesson_addon | 0 | 2 | 2 |
| yoga_request | 4 | 0 | 0 |
| dinner_meals_request | 0 | 1 | 3 |
| transfer_side_question | 4 | 0 | 0 |
| cash_payment_side_question | 1 | 0 | 3 |
| correction_flow | 2 | 0 | 1 |
| reset_flow | 2 | 1 | 1 |
| out_of_order_all_in_one | 3 | 0 | 0 |

### Top failure categories (40401)

- **internal_error** — 12
- **service_addon_intent** — 7
- **guest_count** — 5
- **accommodation_intent** — 3
- **yoga_meals_intent** — 3
- **cash_side_question** — 3
- **date_parsing** — 2
- **package_intent** — 2

---

## Seed 40402 (100 scenarios)

### Language breakdown

| Language | PASS | PARTIAL | FAIL |
|----------|------|---------|------|
| de | 15 | 9 | 2 |
| it | 14 | 2 | 9 |
| en | 8 | 1 | 19 |
| es | 12 | 6 | 3 |

### Scenario breakdown

| Scenario | PASS | PARTIAL | FAIL |
|----------|------|---------|------|
| short_stay_accommodation | 6 | 0 | 3 |
| package_booking | 8 | 0 | 1 |
| package_surf_addons | 5 | 4 | 0 |
| short_stay_surf_addons | 3 | 6 | 0 |
| lesson_addon | 0 | 4 | 4 |
| yoga_request | 6 | 0 | 2 |
| dinner_meals_request | 2 | 4 | 2 |
| transfer_side_question | 6 | 0 | 2 |
| cash_payment_side_question | 1 | 0 | 7 |
| correction_flow | 1 | 0 | 7 |
| reset_flow | 5 | 0 | 3 |
| out_of_order_all_in_one | 6 | 0 | 2 |

### Top failure categories (40402)

- **internal_error** — 31
- **guest_count** — 19
- **service_addon_intent** — 18
- **date_parsing** — 13
- **cash_side_question** — 7
- **yoga_meals_intent** — 6
- **package_intent** — 5
- **reset** — 3
- **accommodation_intent** — 2
- **transfer_side_question** — 2

### Top 10 failure examples (40402)

#### hammer-40402-0005 (FAIL)
- Type: lesson_addon · Lang: it
- Categories: accommodation_intent, internal_error, service_addon_intent
- Failures: final package_interest expected accommodation_only got null; quote not ready; missing surf_lesson

#### hammer-40402-0006 (FAIL)
- Type: yoga_request · Lang: en
- Categories: internal_error, date_parsing
- Failures: quote not ready; check_in/check_out null on turn 1

#### hammer-40402-0008 (FAIL)
- Type: transfer_side_question · Lang: en
- Categories: internal_error, date_parsing, transfer_side_question
- Failures: quote not ready; dates null when side question embedded

#### hammer-40402-0009 (FAIL)
- Type: cash_payment_side_question · Lang: en
- Categories: internal_error, date_parsing, cash_side_question
- Failures: quote not ready; dates null on cash side-Q turn

#### hammer-40402-0010 (FAIL)
- Type: correction_flow · Lang: it
- Categories: internal_error, date_parsing, guest_count
- Failures: quote not ready; stale quote not invalidated after correction

#### hammer-40402-0021 (FAIL)
- Type: cash_payment_side_question · Lang: es
- Categories: internal_error, cash_side_question
- Failures: quote not ready on payment side-Q turn

#### hammer-40402-0023 (FAIL)
- Type: reset_flow · Lang: en
- Categories: internal_error, guest_count, reset
- Failures: guest_count null; reset not detected

#### hammer-40402-0050 (FAIL)
- Type: package_booking · Lang: en
- Categories: handoff_unexpected
- Failures: unexpected handoff on package booking

#### hammer-40402-0085 (FAIL)
- Type: short_stay_accommodation · Lang: en
- Categories: accommodation_intent
- Failures: expected accommodation_only but package_interest=no_package

#### hammer-40402-0095 (FAIL)
- Type: reset_flow · Lang: it
- Categories: guest_count, reset
- Failures: guest_count null after reset flow

---

## Regression fixture sets (unchanged baseline)

| Fixture set | PASS | PARTIAL | FAIL |
|-------------|------|---------|------|
| multilingual-out-of-order (12) | 11 | 1 | 0 |
| booking-core (26) | 26 | 0 | 0 |

Known non-blocking PARTIAL: `it-yoga-dinner-midflow` (composer copy missing "yoga" on one turn).

---

## Top 5 recommended fixes for Stage 40b

1. **Quote readiness on embedded side-questions** — cash/transfer/yoga flows fail `expected_quote_ready` when dates+side-Q arrive in one turn (EN especially).
2. **Guest count extraction** — null guest_count after reset/correction and in lesson flows.
3. **Service add-on intent** — wetsuit/surfboard/surf_lesson not detected on first turn in surf/lesson scenarios.
4. **Date parsing under stress** — compact/multilingual ranges null on turn 1 in randomized EN/IT flows.
5. **Accommodation-only intent** — lesson/short-stay scenarios expect `accommodation_only` but parser returns null or `no_package`.

---

## Safety

No writes, live Stripe, WhatsApp, confirmations, n8n activation, or production changes were performed during hammer runs.
