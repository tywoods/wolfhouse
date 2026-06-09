# Stage 27demo-l — n8n Open Demo Booking Write + Calendar

**Status:** PASS — staging n8n booking-write pipe proved 2026-06-09 (`WH-G27-0ECC1D9B57`).  
**Parent:** [STAGE-27DEMO-K-N8N-LIVE-REPLY-PIPE.md](STAGE-27DEMO-K-N8N-LIVE-REPLY-PIPE.md) · [STAGE-27DEMO-D-OPEN-DEMO-BOOKING-WRITE-CALENDAR.md](STAGE-27DEMO-D-OPEN-DEMO-BOOKING-WRITE-CALENDAR.md)  
**Verifier:** `npm run verify:stage27demo-l-n8n-booking-write`  
**Next:** **27demo-m** — Stripe TEST link through n8n

---

## 0. What this slice does

| In scope | Out of scope |
|----------|--------------|
| n8n pipe passes `create_demo_hold_draft_confirmed` + `assign_demo_bed_confirmed` | Stripe checkout link |
| Staff API hold + draft payment + demo bed assignment | Payment link WhatsApp send |
| Staff Portal Booking Calendar visibility | Live WhatsApp reply |
| Multi-turn via chained `guest_context` | Confirmation send |
| Staging/test data only | Production |

**Architecture:** Meta-shaped POST → **n8n (pipe only)** → **Staff API (brain)** → hold/draft/assignment.

---

## 1. n8n workflow

| Field | Value |
|-------|-------|
| **Name** | `Luna Open Demo WhatsApp Booking Write Pipe` |
| **Repo export** | `n8n/Luna Open Demo WhatsApp Booking Write Pipe.json` |
| **Staging import id** | `stage27demoLWrite01` |
| **Webhook path** | `open-demo-whatsapp-booking-write-27l` |
| **Credential** | `Luna Bot Internal Token (staging)` |
| **Default in repo** | `active: false` |

### Multi-turn chaining

Turns 2–3 include flat fields on the webhook body (alongside Meta envelope):

- `guest_context` — from prior response `slim_guest_context_for_next_turn`
- `guest_email` — e.g. `open-demo+34600995557@example.test`
- `reference_date` — harness date (default `2026-06-08`)

Write flags are sent on **every** turn; Staff API returns `write_status: not_ready` until turn 3 is ready.

---

## 2. Payload mapping

Same normalized fields as [27demo-j](STAGE-27DEMO-J-N8N-INBOUND-REVIEW-PIPE.md), plus:

```json
{
  "create_demo_hold_draft_confirmed": true,
  "assign_demo_bed_confirmed": true,
  "guest_email": "open-demo+34600995557@example.test",
  "guest_context": { "...": "from turn N-1 slim_guest_context_for_next_turn" }
}
```

### Must not include (27demo-l)

Do not send these flags in the 27demo-l proof payload:

- `send_live_reply_confirmed` — forbidden
- `create_stripe_test_link_confirmed` — forbidden
- `send_payment_link_whatsapp_confirmed` — forbidden

---

## 3. Env gates

### Baseline / after proof

| Variable | Value |
|----------|-------|
| `WHATSAPP_DRY_RUN` | `true` |
| `OPEN_DEMO_WHATSAPP_ENABLED` | `true` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `false` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `false` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `false` |
| `OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID` | `1152900101233109` |

### During booking-write proof

| Variable | Value |
|----------|-------|
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `true` |
| Others | unchanged from baseline |

---

## 4. Proof message sequence

**Phone:** `+34600995557`  
**Email:** `open-demo+34600995557@example.test`  
**Dates:** `September 9 to September 16` (clean 7-night window; Aug 26–Sep 2 misparses cross-month in Luna intake)

| Turn | Message | Write flags (n8n always sends) |
|------|---------|--------------------------------|
| 1 | `Hi, we are 2 people interested in the Malibu package` | yes (Staff API: `not_ready`) |
| 2 | `September 9 to September 16` | yes (`not_ready` until quote ready) |
| 3 | `Deposit is fine` | yes → **create + assign** |

Three Meta-shaped POSTs to staging n8n webhook; unique `wamid` per turn.

---

## 5. Expected turn 3 response

```json
{
  "staff_api_success": true,
  "write_status": "created",
  "assignment_write_status": "created",
  "booking_code": "WH-G27-…",
  "booking_id": "…",
  "payment_draft_id": "…",
  "assigned_bed_label": "DEMO-R?-B?",
  "assigned_room_label": "DEMO-R?",
  "calendar_visible_expected": true,
  "stripe_link_created": false,
  "payment_link_sent": false,
  "whatsapp_sent": false,
  "sends_whatsapp": false,
  "confirmation_sent": false
}
```

### Idempotency replay (same turn 3 wamid)

- `write_status`: `reused_existing`
- `assignment_write_status`: `reused_existing`
- No duplicate booking / booking_beds / payment draft

### Calendar proof

- Booking visible on Staff Portal Bed Calendar for stay dates
- `bookings.status`: hold
- `payment_status`: waiting_payment (draft)
- `assignment_status`: assigned
- No Stripe checkout URL/session

---

## 6. Rollback

1. `OPEN_DEMO_BOOKING_WRITES_ENABLED=false`
2. Keep `WHATSAPP_DRY_RUN=true`, live-reply and Stripe gates `false`
3. Deactivate n8n workflow; clear `webhook_entity` if DB-imported

---

## 7. Next — 27demo-m

Stripe TEST link through n8n: add `create_stripe_test_link_confirmed` only when `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=true`. Still no payment-link send unless 27demo-e scope.

---

## 8. Related

- [STAGE-27DEMO-D1-OPEN-DEMO-CALENDAR-ASSIGNMENT.md](STAGE-27DEMO-D1-OPEN-DEMO-CALENDAR-ASSIGNMENT.md) — harness calendar proof
- [STAGE-27DEMO-J-N8N-INBOUND-REVIEW-PIPE.md](STAGE-27DEMO-J-N8N-INBOUND-REVIEW-PIPE.md) — review-only pipe
