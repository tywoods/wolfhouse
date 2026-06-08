# Stage 27j — Guest Payment Choice Capture Dry-Run

**Status:** PASS — local verifier (2026-06-08).  
**Parent:** [STAGE-27I-GUEST-INTAKE-QUOTE-WIRE.md](STAGE-27I-GUEST-INTAKE-QUOTE-WIRE.md) · [STAGE-27H-GUEST-QUOTE-PROPOSAL-DRY-RUN.md](STAGE-27H-GUEST-QUOTE-PROPOSAL-DRY-RUN.md)  
**Adapter:** `scripts/lib/luna-guest-payment-choice-dry-run.js`  
**Verifier:** `npm run verify:stage27j-payment-choice-dry-run`

**Non-negotiables:** No deploy · no booking writes · no holds · no payment drafts/links · no Stripe · no WhatsApp · no Meta · no n8n · no live guest automation.

---

## 1. Purpose

After Stage **27h/27i** produces a quote with `payment_choice_needed: true`, this adapter **recognizes** the guest’s payment choice from their next message — deposit, full payment, arrival/cash/bank question, link request, or unclear — without creating holds, payment drafts, Stripe links, or confirming the booking.

This stage is **dry-run only** (standalone adapter). Wiring into `POST /staff/bot/guest-intake-dry-run` is a follow-on stage (27k).

---

## 2. Chain position

```
27b router → 27e readiness → 27f availability → 27h quote → 27j payment choice (this stage)
```

Prior chain fields are passed via `guest_context`:

| Field | Use |
|-------|-----|
| `message_lane` | Must be `new_booking_inquiry` for ready path |
| `readiness_state` / `intake_state` | Context only (unchanged) |
| `extracted_fields` | Context only |
| `availability` | Context only |
| `quote` | `quote_status`, `payment_choice_needed` |
| `quote_status` | Top-level mirror when present |
| `payment_choice_needed` | Top-level mirror when present |

---

## 3. Gate (when capture is “ready”)

All must be true on `guest_context`:

| Field | Value |
|-------|--------|
| `message_lane` | `new_booking_inquiry` |
| `quote.quote_status` or `quote_status` | `ready` |
| `quote.payment_choice_needed` or `payment_choice_needed` | `true` |

Otherwise: detection may still run, but `payment_choice_ready` stays `false`.

Non-booking lanes (e.g. `payment_question`) never set `payment_choice_ready`.

---

## 4. API

```js
runGuestPaymentChoiceDryRun(input, guestContext)
```

| Param | Notes |
|-------|--------|
| `input.message_text` | Guest reply after quote |
| `input.language_hint` | Optional; falls back to router `detected_language` |
| `guestContext` | Prior dry-run chain (see §2) |

---

## 5. Payment choice detection

Deterministic patterns on `message_text` (first match wins):

| `payment_choice` | Examples |
|------------------|----------|
| `payment_link_request` | “Send me the link”, “payment link” |
| `arrival_payment_question` | cash on arrival, bank transfer, pay at check-in |
| `full_payment` | “pay the full amount”, “pay in full” |
| `deposit` | “deposit is fine”, “pay the deposit” |
| `unclear` | “yes”, “ok”, “sure” |
| `null` | No recognizable choice |

---

## 6. Output fields

| Field | Notes |
|-------|--------|
| `payment_choice_detected` | `true` when a choice/intent was recognized |
| `payment_choice` | Enum above or `null` |
| `payment_choice_ready` | `true` only for clear deposit/full + quote gate |
| `payment_choice_reasons` | e.g. `quote_payment_choice_not_needed`, `arrival_balance_question` |
| `next_safe_step` | See §7 |
| `proposed_luna_reply` | Safe Luna copy (EN/IT/ES/DE/FR) |

Safety flags (always): `dry_run: true`, `sends_whatsapp: false`, `live_send_blocked: true`, no hold/payment/Stripe/booking writes.

---

## 7. Behavior / next_safe_step

| Situation | `payment_choice_ready` | `next_safe_step` |
|-----------|-------------------------|------------------|
| Clear deposit + quote gate | `true` | `ready_for_hold_payment_draft` |
| Clear full payment + quote gate | `true` | `ready_for_hold_payment_draft` |
| Cash/bank/on-arrival question | `false` | `answer_arrival_payment_question` |
| “Send link” after quote | `false` | `staff_handoff_required` |
| Unclear after quote | `false` | `collect_payment_choice` |
| No quote / wrong lane | `false` | `collect_payment_choice` or `staff_handoff_required` |

**Arrival reply:** explains remaining balance can be paid cash, bank transfer, or Stripe on arrival/check-in; does not create links or confirm booking.

**Link request:** detected but **no** link created or sent.

**Unclear:** one question only — deposit or full amount.

---

## 8. Reply safety

Replies must **not**:

- Say payment link is ready or sent  
- Confirm booking or say booking is held  
- Say payment has been received  

---

## 9. Preserved chain (unchanged)

- Router / intake (27b/27e)  
- Availability (27f/27g)  
- Quote (27h/27i)  
- Non-booking lanes  

---

## 10. Verifier fixtures

| Message | Expected |
|---------|----------|
| “Deposit is fine” | `deposit`, ready |
| “I'll pay the full amount” | `full_payment`, ready |
| “Can I pay cash when I arrive?” | `arrival_payment_question` |
| “Can I pay by bank transfer?” | `arrival_payment_question` |
| “Send me the link” | `payment_link_request`, no link |
| “Yes” (after quote) | `unclear`, collect choice |
| Deposit without quote context | detected, **not** ready |
| Balance question on `payment_question` lane | **not** ready |

---

## 11. Next stage

**Stage 27k** — wire payment choice capture into guest intake dry-run endpoint/harness (mirror 27g→27i pattern).
