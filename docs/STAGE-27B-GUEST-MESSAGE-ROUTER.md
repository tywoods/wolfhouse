# Stage 27b — Guest Message Router (dry-run)

**Status:** PASS — local verifier (2026-06-08).  
**Parent:** [STAGE-27A-GUEST-INTAKE-DESIGN.md](STAGE-27A-GUEST-INTAKE-DESIGN.md)  
**Module:** `scripts/lib/luna-guest-message-router.js`  
**Verifier:** `npm run verify:stage27b-guest-message-router`

**Non-negotiables:** No DB writes · no deploy · no Stripe · no WhatsApp · no Meta · no n8n · no payment links · no live guest automation.

---

## 1. Purpose

Deterministic **guest message router** dry-run: classify inbound text into `message_lane`, extract first-slice booking fields **only** for `new_booking_inquiry`, propose a safe Luna reply, and flag staff handoffs — without pricing, availability, holds, or sends.

---

## 2. API (library)

```javascript
const { runLunaGuestMessageRouterDryRun } = require('./scripts/lib/luna-guest-message-router');

runLunaGuestMessageRouterDryRun(
  {
    message_text: '...',
    language_hint: 'it',           // optional
    guest_context: {               // optional
      intake_state: 'collecting_required_details',
      extracted_fields: { guest_count: 2 },
      booking_code: 'MB-WOLFHO-...',
    },
  },
  { reference_date: '2026-06-08', guest_phone: '+34...' },
);
```

### Output (summary)

| Field | Notes |
|-------|--------|
| `message_lane` | One of 9 lane values (see 27a design) |
| `intake_state` | `inquiry_received` · `collecting_required_details` · `staff_handoff_required` |
| `detected_language` | `en` · `it` · `es` · `de` · `fr` |
| `extracted_fields` | Booking fields **only** when lane = `new_booking_inquiry` |
| `missing_required_fields` | `dates` · `guest_count` · `package_interest` |
| `safe_handoff_required` | Risk/ policy / low-confidence cases |
| `proposed_luna_reply` | Warm Luna-from-Wolfhouse copy; one question at a time |
| Safety flags | `dry_run`, `sends_whatsapp:false`, `live_send_blocked:true`, etc. |

---

## 3. Lanes (27b)

| Lane | 27b behavior |
|------|----------------|
| `new_booking_inquiry` | Classify + extract + ask missing fields |
| `existing_booking_question` | Classify; ask booking code |
| `add_service_request` | Classify; ask booking context |
| `transfer_request` | Classify; ask booking / transfer context |
| `payment_question` | Classify; ask booking code or hand off pay-now |
| `checkin_house_info_question` | Classify; defer to team for exact info |
| `cancel_or_change_request` | Classify; staff handoff |
| `general_question` | Classify; staff handoff when outside policy |
| `staff_handoff_required` | Bilbao-no-package and similar |

---

## 4. Explicitly deferred (Stage 27c+)

- HTTP route `POST /staff/bot/guest-intake-dry-run`
- Availability check / quote engine calls
- Booking or payment writes
- n8n / WhatsApp pipe wiring
- Live send gates beyond library safety flags

---

## 5. Verification

```bash
npm run verify:stage27b-guest-message-router
```

13 fixture messages (EN/IT/ES/DE/FR) + shape/safety/handoff/multilingual checks.

**Next:** **Stage 27c** — HTTP dry-run endpoint + hosted harness (still no live send).
