# Stage 27m — Hold + Payment Draft Planner (Dry-Run)

**Status:** PASS — local verifier (2026-06-08).  
**Parent:** [STAGE-27L-HOLD-PAYMENT-DRAFT-DESIGN.md](STAGE-27L-HOLD-PAYMENT-DRAFT-DESIGN.md) · [STAGE-27K-PAYMENT-CHOICE-WIRE.md](STAGE-27K-PAYMENT-CHOICE-WIRE.md)  
**Adapter:** `scripts/lib/luna-guest-hold-payment-draft-planner.js`  
**Verifier:** `npm run verify:stage27m-hold-payment-draft-planner`

**Non-negotiables:** No deploy · **no writes** · no DB · no booking/hold/payment draft creation · no Stripe · no payment links · no WhatsApp · no Meta · no n8n · no live guest automation.

---

## 1. Purpose

After Stages **27b–27k** complete the read-only chain through payment choice, this adapter produces a **structured plan** for the future state-changing step (hold + quote snapshot + payment draft) — **without performing any writes**.

This is a **no-write planner only**. Wiring into `POST /staff/bot/guest-intake-dry-run` is a follow-on stage.

---

## 2. API

```js
runGuestHoldPaymentDraftPlannerDryRun(chainResult, context)
```

| Param | Shape |
|-------|--------|
| `chainResult.result` | Router output (`runLunaGuestMessageRouterDryRun`) |
| `chainResult.availability` | Availability output |
| `chainResult.quote` | Quote output |
| `chainResult.payment_choice` | Payment choice output |
| `context` | Optional `{ client_slug, guest_phone, conversation_id }` |

---

## 3. Entry gate (all required)

| Check | Value |
|-------|--------|
| `result.message_lane` | `new_booking_inquiry` |
| `result.booking_intake_ready` | `true` |
| `result.readiness_state` | `ready_for_availability_check` |
| `availability.availability_status` | `available` |
| `quote.quote_status` | `ready` |
| `payment_choice.payment_choice_ready` | `true` |
| `payment_choice.next_safe_step` | `ready_for_hold_payment_draft` |

Otherwise: `plan_status: not_ready`, all `would_create_*` false.

---

## 4. Output fields

| Field | Notes |
|-------|--------|
| `hold_payment_draft_plan_attempted` | `true` when gate passed and planner evaluated |
| `plan_status` | `not_ready` · `ready` · `needs_staff_review` · `error` |
| `would_create_hold` | `true` only when `plan_status === ready` |
| `would_create_quote_snapshot` | same |
| `would_create_payment_draft` | same |
| `would_create_stripe_link` | **always `false` in 27m** |
| `hold_expires_in_hours` | `6` when ready; else `null` |
| `payment_amount_cents` | Deposit or full per choice |
| `payment_kind` | `deposit` · `full_payment` |
| `balance_due_after_payment_cents` | `quote_total - payment_amount`, min 0 |
| `idempotency_key_preview` | Stable SHA-256 prefix from structured fields |
| `planned_records` | Summary objects (see §6) |
| `plan_handoff_required` | `true` on blocked/ambiguous paths |
| `plan_handoff_reasons` | Machine-readable codes |
| `proposed_luna_reply` | Safe Luna copy |

Safety flags: `dry_run: true`, `sends_whatsapp: false`, `live_send_blocked: true`.

---

## 5. Payment amount behavior

| Choice | Amount |
|--------|--------|
| `deposit` | `quote.deposit_options.deposit_required_cents` (€200 weekly / €100 shorter stay from engine) |
| `full_payment` | `quote.quote_total_cents` |

- Payment draft plan is **not payment truth** (`planned_records.payment_draft.is_payment_truth: false`).
- `balance_due_after_payment_cents = max(0, quote_total_cents - payment_amount_cents)`.

---

## 6. Example — deposit (7-night Malibu)

**Chain:** ready intake → available → quote ready → `"Deposit is fine"` → `payment_choice_ready: true`

**Plan (excerpt):**

```json
{
  "plan_status": "ready",
  "would_create_hold": true,
  "would_create_quote_snapshot": true,
  "would_create_payment_draft": true,
  "would_create_stripe_link": false,
  "hold_expires_in_hours": 6,
  "payment_kind": "deposit",
  "payment_amount_cents": 20000,
  "balance_due_after_payment_cents": 123456,
  "planned_records": {
    "booking_hold": { "check_in": "2026-06-15", "hold_expires_in_hours": 6 },
    "quote_snapshot": { "quote_total_cents": 143456 },
    "payment_draft": { "payment_kind": "deposit", "is_payment_truth": false }
  }
}
```

*(Balance illustrative — actual cents from live quote engine.)*

---

## 7. Example — full payment

**Chain:** same through quote; payment message `"I'll pay the full amount"`

```json
{
  "plan_status": "ready",
  "payment_kind": "full_payment",
  "payment_amount_cents": 143456,
  "balance_due_after_payment_cents": 0,
  "would_create_stripe_link": false
}
```

---

## 8. Idempotency preview

Stable key derived from (no random IDs):

- `client_slug`
- `check_in` / `check_out`
- `guest_count`
- package code
- `payment_kind`
- `guest_phone` (when available)
- optional `conversation_id`

Returns 32-char hex SHA-256 prefix: `idempotency_key_preview`.

---

## 9. Handoff / blocked cases

| Reason | Effect |
|--------|--------|
| Gate not met | `not_ready`, no writes planned |
| Missing quote total | `plan_handoff_required` |
| Missing/unclear payment choice | handoff |
| Availability not `available` | `not_ready` |
| Missing intake fields | handoff |
| Transfer/service ambiguity | `needs_staff_review` |
| Payment amount undetermined | handoff / error |

---

## 10. Reply safety

When `plan_status === ready`, Luna may say the next step **would be preparing secure payment**.

Must **not**:

- Say booking is held  
- Say payment link is ready  
- Confirm booking  
- Mention hold expiry proactively  
- Say payment received  

---

## 11. Next stage

**Stage 27n** — gated staging **write** for hold + payment draft (no Stripe link), per [STAGE-27L-HOLD-PAYMENT-DRAFT-DESIGN.md](STAGE-27L-HOLD-PAYMENT-DRAFT-DESIGN.md).

**Optional wire (later):** add planner to guest intake dry-run response after `payment_choice` when gate passes.

---

## 12. Verifier

```bash
npm run verify:stage27m-hold-payment-draft-planner
```
