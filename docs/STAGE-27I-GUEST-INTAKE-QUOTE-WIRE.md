# Stage 27i — Guest Intake Quote Wire

**Status:** PASS — local verifier (2026-06-08).  
**Parent:** [STAGE-27H-GUEST-QUOTE-PROPOSAL-DRY-RUN.md](STAGE-27H-GUEST-QUOTE-PROPOSAL-DRY-RUN.md) · [STAGE-27G-GUEST-INTAKE-AVAILABILITY-WIRE.md](STAGE-27G-GUEST-INTAKE-AVAILABILITY-WIRE.md)  
**Endpoint:** `POST /staff/bot/guest-intake-dry-run`  
**Harness:** `npm run guest:intake:dry-run`  
**Verifier:** `npm run verify:stage27i-guest-intake-quote-wire`

**Non-negotiables:** No deploy · no booking writes · no holds · no payment drafts/links · no Stripe · no WhatsApp · no Meta · no n8n · no live guest automation.

---

## 1. Purpose

Wire Stage **27h** `runGuestQuoteProposalDryRun` into the guest intake dry-run endpoint and manual harness. Quote proposal runs **only** when Stage **27e** intake is ready **and** Stage **27f** availability reports `available`.

---

## 2. Eligibility gate

All must be true on `result` and `availability`:

| Field | Value |
|-------|--------|
| `result.message_lane` | `new_booking_inquiry` |
| `result.booking_intake_ready` | `true` |
| `result.readiness_state` | `ready_for_availability_check` |
| `availability.availability_check_attempted` | `true` |
| `availability.availability_status` | `available` |

When eligible: handler calls `runGuestQuoteProposalDryRun(result, availability, context)`.

When not eligible: handler returns `buildGuestQuoteSkippedResponse(result, availability)` with `quote_proposal_attempted: false` and `quote_status: "not_ready"`.

---

## 3. Request

Same as Stage 27g — see [STAGE-27G-GUEST-INTAKE-AVAILABILITY-WIRE.md](STAGE-27G-GUEST-INTAKE-AVAILABILITY-WIRE.md).

---

## 4. Response shape

```json
{
  "success": true,
  "dry_run": true,
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "no_write_performed": true,
  "result": { },
  "availability": { },
  "quote": { }
}
```

No `payment_link`, `hold`, `booking_confirmation`, or `send_action` fields.

---

## 5. Response examples

### 5a. Not-ready booking inquiry (missing dates)

```json
{
  "success": true,
  "dry_run": true,
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "result": {
    "message_lane": "new_booking_inquiry",
    "booking_intake_ready": false,
    "readiness_state": "collecting_required_details"
  },
  "availability": {
    "availability_check_attempted": false,
    "availability_status": "not_ready"
  },
  "quote": {
    "quote_proposal_attempted": false,
    "quote_status": "not_ready",
    "quote_total_cents": null,
    "deposit_options": null,
    "payment_choice_needed": false,
    "quote_handoff_required": false,
    "quote_handoff_reasons": ["booking_intake_not_ready", "availability_not_available"]
  }
}
```

### 5b. Ready booking inquiry with availability + quote attempted

```json
{
  "success": true,
  "dry_run": true,
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "result": {
    "message_lane": "new_booking_inquiry",
    "booking_intake_ready": true,
    "readiness_state": "ready_for_availability_check"
  },
  "availability": {
    "availability_check_attempted": true,
    "availability_status": "available"
  },
  "quote": {
    "quote_proposal_attempted": true,
    "quote_status": "ready",
    "quote_total_cents": 49800,
    "deposit_options": {
      "deposit_required_cents": 20000,
      "payment_options": ["deposit", "full"]
    },
    "payment_choice_needed": true,
    "quote_handoff_required": false,
    "quote_handoff_reasons": [],
    "proposed_luna_reply": "Hi! I'm Luna from Wolfhouse 🌊 — Thanks — for your stay I estimate a total of €498.00. Would you prefer to pay a €200.00 deposit or the full amount? I am not confirming the booking and I cannot send a payment link yet."
  }
}
```

### 5c. Unavailable booking inquiry (no quote)

```json
{
  "success": true,
  "dry_run": true,
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "result": {
    "message_lane": "new_booking_inquiry",
    "booking_intake_ready": true,
    "readiness_state": "ready_for_availability_check"
  },
  "availability": {
    "availability_check_attempted": true,
    "availability_status": "unavailable"
  },
  "quote": {
    "quote_proposal_attempted": false,
    "quote_status": "not_ready",
    "quote_total_cents": null,
    "deposit_options": null,
    "payment_choice_needed": false,
    "quote_handoff_reasons": ["availability_not_available"]
  }
}
```

### 5d. Non-booking lane (check-in info)

```json
{
  "success": true,
  "dry_run": true,
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "result": {
    "message_lane": "checkin_info",
    "booking_intake_ready": false
  },
  "availability": {
    "availability_check_attempted": false,
    "availability_status": "not_ready"
  },
  "quote": {
    "quote_proposal_attempted": false,
    "quote_status": "not_ready",
    "quote_total_cents": null,
    "payment_choice_needed": false
  }
}
```

---

## 6. Harness

```bash
npm run guest:intake:dry-run -- --fixture en-booking --reference-date 2026-06-08
npm run guest:intake:dry-run -- --fixture en-booking --json
```

Prints quote summary fields when `quote` is present in the response.

---

## 7. Safety

| Check | Expected |
|-------|----------|
| `dry_run` | `true` |
| `sends_whatsapp` | `false` |
| `live_send_blocked` | `true` |
| Booking writes | none |
| Holds | none |
| Payment drafts / links | none |
| Stripe / WhatsApp / Meta / n8n | none |
| Reply confirms booking | never |
| Reply says payment link ready | never |

---

## 8. Next

**Stage 27j** (future) — hosted staging proof of full intake → availability → quote chain.
