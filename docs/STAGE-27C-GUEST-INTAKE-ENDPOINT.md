# Stage 27c — Guest Intake Dry-Run Endpoint

**Status:** PASS — local verifier (2026-06-08).  
**Route:** `POST /staff/bot/guest-intake-dry-run`  
**Handler:** `handleBotGuestIntakeDryRun` in `scripts/staff-query-api.js`  
**Router:** `runLunaGuestMessageRouterDryRun` ([STAGE-27B-GUEST-MESSAGE-ROUTER.md](STAGE-27B-GUEST-MESSAGE-ROUTER.md))  
**Verifier:** `npm run verify:stage27c-guest-intake-endpoint`

**Non-negotiables:** Dry-run only · no DB writes · no deploy required for PASS · no Stripe · no WhatsApp · no Meta · no n8n · no payment links · no live guest automation.

---

## 1. Auth

Same as other `/staff/bot/*` routes: **`requireBotAuth`** (`X-Luna-Bot-Token` or session when configured). Token auth applies only under `/staff/bot/*`.

---

## 2. Request

```http
POST /staff/bot/guest-intake-dry-run
Content-Type: application/json
X-Luna-Bot-Token: <staging bot token>
```

```json
{
  "message_text": "Hi, we're 2 people looking to stay from June 15 to June 22, interested in the Malibu package",
  "language_hint": "en",
  "guest_context": {
    "intake_state": "collecting_required_details",
    "extracted_fields": { "guest_count": 2 }
  },
  "reference_date": "2026-06-08",
  "guest_phone": "+34999000123"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `message_text` | ✓ | Non-empty string after trim |
| `language_hint` | — | Optional `en` · `it` · `es` · `de` · `fr` |
| `guest_context` | — | Prior intake state / extracted fields / booking hints |
| `reference_date` | — | ISO date for relative date parsing (harness only) |
| `guest_phone` | — | Optional E.164 for context |

---

## 3. Success response (200)

```json
{
  "success": true,
  "dry_run": true,
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "no_write_performed": true,
  "result": {
    "success": true,
    "dry_run": true,
    "preview_only": true,
    "no_write_performed": true,
    "sends_whatsapp": false,
    "live_send_blocked": true,
    "message_lane": "new_booking_inquiry",
    "intake_state": "collecting_required_details",
    "detected_language": "en",
    "confidence": 0.82,
    "extracted_fields": {
      "check_in": "2026-06-15",
      "check_out": "2026-06-22",
      "guest_count": 2,
      "package_interest": "malibu"
    },
    "missing_required_fields": [],
    "safe_handoff_required": false,
    "handoff_reasons": [],
    "proposed_luna_reply": "Hi! I'm Luna from Wolfhouse 🌊 …",
    "allowed_next_actions": ["collect_complete_await_stage27c", "await_guest_reply", "classify_only"]
  },
  "auth_mode": "bot_token",
  "elapsed_ms": 3
}
```

---

## 4. Error responses

**400 — missing/empty `message_text`:**

```json
{
  "success": false,
  "dry_run": true,
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "error": "message_text is required"
}
```

**400 — router validation failure** (same safety flags, `error` from router).

**500 — unexpected exception:**

```json
{
  "success": false,
  "dry_run": true,
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "error": "guest intake dry-run failed"
}
```

No stack traces in HTTP responses.

---

## 5. Safety

| Rule | Enforcement |
|------|-------------|
| Dry-run only | Handler calls sync router only; no `withPgClient` |
| No DB writes | No SQL in handler path |
| No Stripe | No payment link / checkout calls |
| No WhatsApp / Meta | `sends_whatsapp:false`, `live_send_blocked:true` on every response |
| No n8n | No workflow activation or external fetch |
| No live send | Proposed reply is draft only; endpoint never sends |

Audit log entry: `api:bot_guest_intake_dry_run` (in-memory append only).

---

## 6. Verification

```bash
npm run verify:stage27c-guest-intake-endpoint
```

**Next:** **Stage 27d** — hosted staging harness + optional n8n inactive pipe (still no live send).
