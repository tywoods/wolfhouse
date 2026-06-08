# Stage 27e — Booking Intake Readiness Gate

**Status:** PASS — local verifier (2026-06-08).  
**Parent:** [STAGE-27B-GUEST-MESSAGE-ROUTER.md](STAGE-27B-GUEST-MESSAGE-ROUTER.md) · [STAGE-27A-GUEST-INTAKE-DESIGN.md](STAGE-27A-GUEST-INTAKE-DESIGN.md)  
**Module:** `scripts/lib/luna-guest-message-router.js`  
**Verifier:** `npm run verify:stage27e-booking-intake-readiness`

**Non-negotiables:** No DB writes · no deploy · no availability calls · no pricing · no holds · no Stripe · no WhatsApp · no Meta · no n8n · no live guest automation.

---

## 1. Purpose

Deterministic **readiness gate** for `message_lane=new_booking_inquiry` only. Decides whether Luna has enough structured booking details to move toward availability/quote **later** — without performing any of those actions in this stage.

---

## 2. Readiness output fields

| Field | Notes |
|-------|--------|
| `booking_intake_ready` | `true` only when all required fields are present and no staff handoff |
| `readiness_state` | `collecting_required_details` · `ready_for_availability_check` · `staff_handoff_required` |
| `readiness_missing_fields` | Granular keys: `check_in`, `check_out`, `guest_count`, `package_interest` |
| `readiness_reasons` | e.g. `missing_required_fields`, `price_before_required_details`, `availability_before_required_details`, `not_booking_inquiry_lane` |

Non-booking lanes always emit `booking_intake_ready: false` and `readiness_reasons: ['not_booking_inquiry_lane']`.

---

## 3. Required fields before `ready_for_availability_check`

| Field | Rule |
|-------|------|
| `check_in` | Parsed stay start date |
| `check_out` | Parsed stay end date |
| `guest_count` | Integer ≥ 1 |
| `package_interest` | Named package **or** explicit `no_package` / `accommodation_only` intent |

---

## 4. Reply behavior (27e)

| State | Reply |
|-------|--------|
| `collecting_required_details` | Ask **one** missing question at a time (dates → guests → package) |
| `ready_for_availability_check` | Thank guest; say Luna can look into the **best option** next — explicitly **not** confirming availability |
| `staff_handoff_required` | Existing handoff copy (price/availability-before-details, cancel/refund, etc.) |

**Never in replies:** price quotes · availability confirmation · booking confirmation · payment link ready.

---

## 5. Explicitly deferred (Stage 27f+)

- Availability API / bed calendar checks
- Quote engine / pricing
- Holds, booking writes, payment drafts
- Stripe links, WhatsApp sends, n8n/Meta wiring

---

## 6. Verification

```bash
npm run verify:stage27e-booking-intake-readiness
```

Fixtures cover: complete inquiry, missing dates/guests/package, accommodation-only, price-before-details handoff, availability-before-details handoff, non-booking service lane, cancellation handoff, output shape, forbidden actions, safe reply wording.

**Next:** **Stage 27f** — availability check integration (still dry-run / gated).
