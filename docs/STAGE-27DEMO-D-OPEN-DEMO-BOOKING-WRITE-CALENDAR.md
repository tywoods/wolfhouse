# Stage 27demo-d — Open Demo Booking Hold + Draft Write + Calendar Proof

**Status:** RUNTIME SLICE — gated staging hold/draft write only.  
**Parent:** [STAGE-27DEMO-C-OPEN-DEMO-LIVE-WHATSAPP-REPLY.md](STAGE-27DEMO-C-OPEN-DEMO-LIVE-WHATSAPP-REPLY.md)  
**Verifier:** `npm run verify:stage27demo-d-open-demo-booking-write`  
**Hosted proof baseline:** `514d6a3-stage27demo-c-live-reply`

---

## 0. What this slice does

| In scope | Out of scope |
|----------|--------------|
| Gated booking hold + payment draft write after inbound review | Stripe checkout link creation |
| Reuses `runGuestHoldPaymentDraftWriteDryRunApproved` (27n) | Payment link WhatsApp send |
| Explicit `create_demo_hold_draft_confirmed: true` | Confirmation send |
| Staff Portal Booking Calendar proof | Live Stripe |
| Staging/test data only | n8n workflow activation |
| Works with `WHATSAPP_DRY_RUN=true` (no WhatsApp from write path) | Production |

**Endpoint:** same as 27demo-b/c — `POST /staff/bot/open-demo-whatsapp-inbound-dry-run`  
Add `"create_demo_hold_draft_confirmed": true` on the turn where the guest confirms deposit (typically turn 3).

---

## 1. Env gates

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPEN_DEMO_WHATSAPP_ENABLED` | `false` | Master inbound demo switch (27demo-b) |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `false` | **New** — booking hold/draft write kill switch |
| `OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID` | unset | Inbound payload guard (same as 27demo-b) |
| `WHATSAPP_DRY_RUN` | `true` | Does **not** block booking writes (staging data only); still blocks live WhatsApp send (27demo-c) |
| `LUNA_BOT_INTERNAL_TOKEN` | secret | Bot auth for harness/n8n |
| `NODE_ENV` | — | Must **not** be `production` |

**Production:** Always blocks booking writes (`NODE_ENV=production`).

**No guest phone allowlist** — any guest phone in payload may receive a hold/draft when all gates pass and the review chain is ready.

**Staging write environment:** The underlying 27n helper additionally requires a staging/local host via `isStagingResetEnvironment` (same as simulator path).

---

## 2. Write preconditions (review chain)

Booking write runs only when **all** of the following are true after inbound review:

1. `create_demo_hold_draft_confirmed: true` in request body
2. `OPEN_DEMO_BOOKING_WRITES_ENABLED=true`
3. Open demo inbound gate passes (enabled + phone_number_id match)
4. Review chain ready:
   - `review.payment_choice.payment_choice_ready === true`
   - `review.payment_choice.next_safe_step === "ready_for_hold_payment_draft"`
   - `review.hold_payment_draft_plan.plan_status === "ready"`

If not ready, response returns `write_status: "not_ready"` with `write_block_reasons`.

---

## 3. Harness flow (3-turn booking → deposit → write)

```bash
node scripts/run-open-demo-whatsapp-inbound-dry-run.js \
  --base-url https://staff-staging.lunafrontdesk.com \
  --phone-number-id 1152900101233109 \
  --guest-phone +34600995555 \
  --guest-email open-demo+34600995555@example.test \
  --fixture booking-deposit-write \
  --create-demo-hold-draft-confirmed
```

Composite fixture `booking-deposit-write` runs:

| Turn | Message | Write flag |
|------|---------|------------|
| 1 | `Hi, we are 2 people interested in the Malibu package` | — |
| 2 | `July 10 to July 17` | — |
| 3 | `Deposit is fine` | `create_demo_hold_draft_confirmed: true` |

Or run turns individually with `--fixture booking-turn-1`, `--fixture booking-turn-2`, then a custom message with the confirm flag.

Guest context carries forward automatically via `slim_guest_context_for_next_turn`.

---

## 4. Request example (turn 3 with write)

```json
{
  "client_slug": "wolfhouse-somo",
  "channel": "whatsapp",
  "phone_number_id": "1152900101233109",
  "guest_phone": "+34600995555",
  "message_text": "Deposit is fine",
  "wamid": "wamid.HBgL...turn3",
  "inbound_message_id": "wamid.HBgL...turn3",
  "received_at": "2026-06-09T20:00:00.000Z",
  "reference_date": "2026-06-08",
  "guest_context": { "...": "from prior turns" },
  "guest_email": "open-demo+34600995555@example.test",
  "create_demo_hold_draft_confirmed": true
}
```

### Response when created

```json
{
  "success": true,
  "open_demo": true,
  "create_demo_hold_draft_confirmed": true,
  "demo_booking_write": true,
  "write_status": "created",
  "booking_code": "WH-G27-...",
  "booking_id": "...",
  "payment_draft_id": "...",
  "next_safe_step": "ready_for_stripe_test_link",
  "stripe_link_created": false,
  "payment_link_sent": false,
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "reused_write_path": "runGuestHoldPaymentDraftWriteDryRunApproved"
}
```

### Response when gate closed

```json
{
  "success": true,
  "create_demo_hold_draft_confirmed": true,
  "demo_booking_write_blocked": true,
  "demo_booking_write_gate_code": "booking_writes_disabled",
  "write_status": "blocked",
  "stripe_link_created": false,
  "payment_link_sent": false
}
```

---

## 5. Expected booking / payment status

After successful write:

| Field | Expected |
|-------|----------|
| Booking hold | Exists (`booking_id`, `booking_code`) |
| Payment draft | Exists (`payment_draft_id`) |
| Payment status | `draft` / pending checkout |
| `stripe_link_created` | `false` |
| `payment_link_sent` | `false` |
| `booking_confirmed` | `false` |
| WhatsApp outbound from write | None |

---

## 6. Staff Portal Booking Calendar proof

1. Deploy staging image with `OPEN_DEMO_BOOKING_WRITES_ENABLED=true`.
2. Run harness 3-turn flow (section 3) against staging Staff API.
3. Note `booking_code` from turn 3 response.
4. Open Staff Portal → **Booking Calendar**.
5. Confirm booking appears for guest phone / dates with hold status.

   **Grid note:** The calendar grid lists `booking_beds` assignments. A fresh hold write creates the booking + draft payment without a bed row, so it may not appear on the grid until staff assigns a bed. Use booking code lookup (`GET /staff/bookings/{booking_code}/context`) to verify hold + payment draft.

6. Open booking detail (if available) and verify:
   - Payment draft row exists
   - No Stripe checkout URL
   - No confirmation sent flag
7. Optional DB spot-check: `payment_drafts.status = 'draft'`, no `stripe_checkout_session_id`.

---

## 7. Idempotency behavior

- Re-running the same 3-turn flow with identical idempotency keys may return `write_status: "reused_existing"` from the 27n helper when hold/draft already exist for the planner idempotency key.
- Inbound review persistence remains idempotent per `inbound_message_id` / wamid (27demo-b).
- Write confirm flag on a turn that already wrote should reuse existing records rather than duplicate holds when keys match.

---

## 8. Cleanup notes

- Test bookings created via demo write use staging hold expiry (6 hours default in 27n).
- Use existing staging reset tools / test phone cleanup if re-running proofs with the same guest phone.
- After hosted proof, restore safe defaults:
  - `OPEN_DEMO_BOOKING_WRITES_ENABLED=false`
  - `WHATSAPP_DRY_RUN=true`
  - `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=false`

---

## 9. Safety summary

| Check | Result |
|-------|--------|
| Default (no confirm flag) | Review only — no write |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED=false` | `write_status: blocked` |
| Production | Hard block |
| Stripe link helper | Not called |
| Payment link send | Not called |
| Confirmation send | Not called |
| WhatsApp from write path | Not sent |
| `WHATSAPP_DRY_RUN=true` | Booking write allowed; live reply still blocked |

---

## 10. Next step — 27demo-e

**27demo-e:** Stripe **TEST** link creation + gated payment link send (still no confirmation, no live Stripe).

See future doc `STAGE-27DEMO-E-OPEN-DEMO-STRIPE-TEST-LINK.md` (not yet implemented).
