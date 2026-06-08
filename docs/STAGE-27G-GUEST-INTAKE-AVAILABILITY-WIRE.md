# Stage 27g — Guest Intake Availability Wire

**Status:** PASS — local verifier (2026-06-08).  
**Parent:** [STAGE-27F-GUEST-AVAILABILITY-DRY-RUN.md](STAGE-27F-GUEST-AVAILABILITY-DRY-RUN.md) · [STAGE-27C-GUEST-INTAKE-ENDPOINT.md](STAGE-27C-GUEST-INTAKE-ENDPOINT.md)  
**Endpoint:** `POST /staff/bot/guest-intake-dry-run`  
**Harness:** `npm run guest:intake:dry-run`  
**Verifier:** `npm run verify:stage27g-guest-intake-availability-wire`

**Non-negotiables:** No deploy · no booking writes · no holds · no quotes · no payment drafts/links · no Stripe · no WhatsApp · no Meta · no n8n · no live guest automation.

---

## 1. Purpose

Wire Stage **27f** `runGuestAvailabilityDryRun` into the existing guest intake dry-run endpoint and manual harness. Availability is checked **only** when Stage **27e** readiness says the booking inquiry is ready.

---

## 2. Eligibility gate

All must be true on `result`:

| Field | Value |
|-------|--------|
| `message_lane` | `new_booking_inquiry` |
| `booking_intake_ready` | `true` |
| `readiness_state` | `ready_for_availability_check` |

When eligible: handler calls `runGuestAvailabilityDryRun` with read-only `withPgClient` (same bed calendar SELECT as `POST /staff/bot/availability-check`).

When not eligible: handler returns `buildGuestAvailabilitySkippedResponse(result)` — **no** delegated availability check, **no** DB reads.

---

## 3. Request

```http
POST /staff/bot/guest-intake-dry-run
Content-Type: application/json
X-Luna-Bot-Token: <optional on local open auth>

{
  "message_text": "...",
  "language_hint": "en",
  "reference_date": "2026-06-08",
  "guest_phone": "+34...",
  "guest_context": {},
  "client_slug": "wolfhouse-somo"
}
```

---

## 4. Response examples

### 4a. Not-ready booking inquiry (missing dates)

```json
{
  "success": true,
  "dry_run": true,
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "no_write_performed": true,
  "result": {
    "message_lane": "new_booking_inquiry",
    "booking_intake_ready": false,
    "readiness_state": "collecting_required_details",
    "proposed_luna_reply": "Hi! I'm Luna from Wolfhouse 🌊 What check-in and check-out dates..."
  },
  "availability": {
    "availability_check_attempted": false,
    "availability_status": "not_ready",
    "availability_result_summary": "Availability check skipped — booking intake not ready.",
    "availability_handoff_required": false,
    "availability_handoff_reasons": ["booking_intake_not_ready"]
  }
}
```

### 4b. Ready booking inquiry (availability attempted)

```json
{
  "success": true,
  "dry_run": true,
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "result": {
    "message_lane": "new_booking_inquiry",
    "booking_intake_ready": true,
    "readiness_state": "ready_for_availability_check",
    "intake_state": "ready_for_availability_check"
  },
  "availability": {
    "availability_check_attempted": true,
    "availability_status": "available",
    "availability_result_summary": "Possible beds found for 2026-06-15 to 2026-06-22 (2 guest(s)): BED-1, BED-2.",
    "availability_handoff_required": false,
    "availability_handoff_reasons": [],
    "proposed_luna_reply": "Hi! I'm Luna from Wolfhouse 🌊 — Thanks — I found a possible option..."
  }
}
```

(`availability_status` may also be `unavailable`, `needs_staff_review`, or `error` depending on DB state.)

### 4c. Non-booking lane (service request)

```json
{
  "success": true,
  "dry_run": true,
  "result": {
    "message_lane": "add_service_request",
    "booking_intake_ready": false
  },
  "availability": {
    "availability_check_attempted": false,
    "availability_status": "not_ready",
    "availability_handoff_reasons": ["booking_intake_not_ready"]
  }
}
```

Router `result.proposed_luna_reply` is unchanged for not-ready paths; availability `proposed_luna_reply` mirrors router copy when skipped.

---

## 5. Harness (27g)

```bash
npm run guest:intake:dry-run -- --base-url http://127.0.0.1:3036 --fixture en-booking
```

Summary now includes:

- `availability_check_attempted`
- `availability_status`
- `availability_result_summary`
- `availability_handoff_required`
- `availability_handoff_reasons`

Use `--json` for full response including `availability`.

---

## 6. Safety limits

| Action | 27g |
|--------|-----|
| Router dry-run | ✅ always |
| Read-only bed calendar SELECT | ✅ only when eligible + DB available |
| Booking create / hold / quote / payment | ❌ |
| Stripe / WhatsApp / Meta / n8n | ❌ |
| Top-level `dry_run: true` · `sends_whatsapp: false` · `live_send_blocked: true` | ✅ always |

Errors in availability path return safe `availability_status: error` — no stack traces in HTTP response.

---

## 7. Verification

```bash
npm run verify:stage27g-guest-intake-availability-wire
```

**Next:** **Stage 27h** — optional hosted staging proof (still no live send).
