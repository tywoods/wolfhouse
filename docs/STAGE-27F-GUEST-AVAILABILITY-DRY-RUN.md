# Stage 27f — Guest Availability Dry-Run Adapter

**Status:** PASS — local verifier (2026-06-08).  
**Parent:** [STAGE-27E-BOOKING-INTAKE-READINESS.md](STAGE-27E-BOOKING-INTAKE-READINESS.md) · [STAGE-27B-GUEST-MESSAGE-ROUTER.md](STAGE-27B-GUEST-MESSAGE-ROUTER.md)  
**Adapter:** `scripts/lib/luna-guest-availability-dry-run.js`  
**Verifier:** `npm run verify:stage27f-guest-availability-dry-run`

**Non-negotiables:** No deploy · no booking writes · no holds · no quotes · no payment drafts/links · no Stripe · no WhatsApp · no Meta · no n8n · no live guest automation.

---

## 1. Purpose

When Stage **27e** marks a `new_booking_inquiry` as `booking_intake_ready: true` / `readiness_state: ready_for_availability_check`, this adapter prepares Luna’s path to **check bed availability** using the **existing shared Staff API engine** — without inventing new availability logic.

---

## 2. Reused helper (do not duplicate)

| Layer | Path |
|-------|------|
| **Adapter** | `runGuestAvailabilityDryRun(routerResult, context)` in `scripts/lib/luna-guest-availability-dry-run.js` |
| **Delegated helper** | `runAvailabilityCheckDryRun(fields, pg)` in `scripts/lib/luna-guest-booking-dry-run.js` |
| **HTTP anchor** | `POST /staff/bot/availability-check` (`handleBotAvailabilityCheck` in `scripts/staff-query-api.js`) |
| **Read-only SQL** | `getBedCalendarRoomsQuery()` · `getBedCalendarBlocksQuery()` from `scripts/lib/staff-bed-calendar-queries.js` |

The adapter **only** calls `runAvailabilityCheckDryRun`. It does **not** embed bed overlap logic, pricing, or booking creation.

---

## 3. Gate (when availability runs)

All must be true:

- `message_lane === "new_booking_inquiry"`
- `booking_intake_ready === true`
- `readiness_state === "ready_for_availability_check"`

Otherwise: `availability_check_attempted: false`, `availability_status: not_ready`, and the router’s existing `proposed_luna_reply` is preserved.

---

## 4. Input mapping

From router `extracted_fields` (+ optional context):

| Field | Source |
|-------|--------|
| `check_in` | `extracted_fields.check_in` |
| `check_out` | `extracted_fields.check_out` |
| `guest_count` | `extracted_fields.guest_count` |
| `package_code` | `extracted_fields.package_interest` (informational; bed check does not quote) |
| `room_type` | `extracted_fields.room_type` or context default `shared` |
| `client_slug` | context default `wolfhouse-somo` |

Optional `context.pg` enables read-only SELECT (same as bot availability-check). Without `pg`, the delegated helper skips DB and status becomes `needs_staff_review`.

---

## 5. Output fields

| Field | Values / notes |
|-------|----------------|
| `availability_check_attempted` | `true` only when gate passed and delegated helper invoked |
| `availability_status` | `not_ready` · `available` · `unavailable` · `needs_staff_review` · `error` |
| `availability_result_summary` | Human-readable summary (bed codes when available) |
| `availability_handoff_required` | `true` for unavailable, error, or skipped DB |
| `availability_handoff_reasons` | e.g. `not_enough_available_beds`, `no_pg_client` |
| `proposed_luna_reply` | Safe Luna copy — no price, no booking confirmation, no payment link |
| `availability_detail` | Raw delegated helper result (when attempted) |
| `reused_helper` | Always `runAvailabilityCheckDryRun` |
| `anchor_route` | `POST /staff/bot/availability-check` |

---

## 6. Reply rules (27f)

| Status | Reply |
|--------|--------|
| `not_ready` | Keep Stage 27e router reply (missing-field questions) |
| `available` | May say a **possible option** was found; team can help with next step — **not** confirming booking |
| `unavailable` / `needs_staff_review` / `error` | Hand off or ask team to confirm |

**Never:** quote price · confirm booking · mention payment links.

---

## 7. Safety limits

| Action | 27f |
|--------|-----|
| Read-only bed calendar SELECT | ✅ via delegated helper when `pg` provided |
| Booking create / hold / bed assignment write | ❌ |
| Quote / pricing engine | ❌ |
| Payment draft / Stripe link | ❌ |
| WhatsApp / Meta / n8n | ❌ |
| `dry_run: true` · `live_send_blocked: true` · `sends_whatsapp: false` | ✅ always |

---

## 8. Verification

```bash
npm run verify:stage27f-guest-availability-dry-run
```

Covers gate behavior, mock-pg available/unavailable paths, no-pg staff review, output shape, safety flags, reply wording, and adapter source checks (no duplicated bed algorithm).

**Next:** **Stage 27g** — wire adapter into guest intake dry-run endpoint/harness (still gated, no live send).
