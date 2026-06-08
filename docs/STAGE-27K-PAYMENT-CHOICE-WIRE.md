# Stage 27k — Guest Intake Payment Choice Wire

**Status:** PASS — local verifier (2026-06-08).  
**Parent:** [STAGE-27J-PAYMENT-CHOICE-DRY-RUN.md](STAGE-27J-PAYMENT-CHOICE-DRY-RUN.md) · [STAGE-27I-GUEST-INTAKE-QUOTE-WIRE.md](STAGE-27I-GUEST-INTAKE-QUOTE-WIRE.md)  
**Endpoint:** `POST /staff/bot/guest-intake-dry-run`  
**Harness:** `npm run guest:intake:dry-run`  
**Verifier:** `npm run verify:stage27k-payment-choice-wire`

**Non-negotiables:** No deploy · no booking writes · no holds · no payment drafts/links · no Stripe · no WhatsApp · no Meta · no n8n · no live guest automation.

---

## 1. Purpose

Wire Stage **27j** `runGuestPaymentChoiceDryRun` into the guest intake dry-run endpoint and harness so a **second guest message** (e.g. “Deposit is fine”) can be interpreted using prior quote context from `guest_context`.

Router, availability, and quote behavior from Stages **27b–27i** are unchanged.

---

## 2. Response shape

```json
{
  "success": true,
  "dry_run": true,
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "no_write_performed": true,
  "result": { "...router..." },
  "availability": { "...27f..." },
  "quote": { "...27h..." },
  "payment_choice": {
    "payment_choice_detected": true,
    "payment_choice": "deposit",
    "payment_choice_ready": true,
    "payment_choice_reasons": [],
    "next_safe_step": "ready_for_hold_payment_draft",
    "proposed_luna_reply": "...",
    "dry_run": true,
    "sends_whatsapp": false,
    "live_send_blocked": true
  }
}
```

When not eligible (no prior quote / `payment_choice_needed`):

```json
{
  "payment_choice": {
    "payment_choice_detected": false,
    "payment_choice": null,
    "payment_choice_ready": false,
    "payment_choice_reasons": ["not_ready"],
    "next_safe_step": "not_ready"
  }
}
```

---

## 3. Wire gate

Payment choice runs when **request** `guest_context` indicates a prior ready quote:

| Field | Requirement |
|-------|-------------|
| `guest_context.quote.payment_choice_needed` or `guest_context.payment_choice_needed` | `true` |
| `guest_context.quote.quote_status` (when quote object present) | `"ready"` |

The current message is evaluated as a payment choice response **even if** the router classifies it as `payment_question` or `general_question`. Prior `message_lane: "new_booking_inquiry"` in `guest_context` is preserved for evaluation.

---

## 4. Examples

### First turn — quote asks deposit vs full

**Request:**

```json
{
  "message_text": "Hi, we're 2 people looking to stay from June 15 to June 22, interested in the Malibu package",
  "reference_date": "2026-06-08"
}
```

**Response (excerpt):** `quote.quote_status: "ready"`, `quote.payment_choice_needed: true`, reply asks deposit or full amount. `payment_choice.next_safe_step: "not_ready"` (no prior context).

---

### Second turn — “Deposit is fine” with guest_context

**Request:**

```json
{
  "message_text": "Deposit is fine",
  "guest_context": {
    "message_lane": "new_booking_inquiry",
    "quote": {
      "quote_status": "ready",
      "payment_choice_needed": true,
      "quote_total_cents": 123456
    },
    "payment_choice_needed": true
  }
}
```

**Response (excerpt):** `payment_choice.payment_choice: "deposit"`, `payment_choice_ready: true`, `next_safe_step: "ready_for_hold_payment_draft"`. No hold, payment draft, or link created.

---

### Second turn — “Send me the link” with guest_context

Detects `payment_link_request`. Does **not** create or send a link. `payment_choice_ready: false`.

---

### Second turn — “Can I pay cash on arrival?” with guest_context

Detects `arrival_payment_question`. Reply explains cash/bank transfer/Stripe on arrival or check-in and asks deposit vs full. `next_safe_step: "answer_arrival_payment_question"`.

---

### Payment choice without quote context

**Request:** `{ "message_text": "Deposit is fine" }` (no `guest_context`)

**Response:** `payment_choice_detected: false`, `payment_choice_ready: false`, `next_safe_step: "not_ready"`.

---

## 5. Harness

```bash
# Built-in fixture with guest_context
npm run guest:intake:dry-run -- --fixture en-deposit-after-quote

# Custom guest_context JSON
npm run guest:intake:dry-run -- --message "Deposit is fine" \
  --guest-context-json '{"quote":{"quote_status":"ready","payment_choice_needed":true},"payment_choice_needed":true}'

# Full JSON output
npm run guest:intake:dry-run -- --fixture en-full-after-quote --json
```

Prints payment choice summary: `payment_choice_detected`, `payment_choice`, `payment_choice_ready`, `next_safe_step`, `payment_choice_reasons`.

Fixtures: `en-deposit-after-quote`, `en-full-after-quote`, `en-send-link-after-quote`, `en-cash-arrival-after-quote`.

---

## 6. Safety

Always: `dry_run: true`, `sends_whatsapp: false`, `live_send_blocked: true`.

No hold field · no payment draft field · no payment link field · no booking confirmation · no send action.

Replies never claim payment link is ready, booking is confirmed/held, or payment received.

---

## 7. Next stage

**Stage 27l** — hosted staging proof for payment choice wire (optional) or hold/payment draft dry-run adapter.
