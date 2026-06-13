# Stage 27demo-m — n8n Open Demo Stripe TEST Link

**Status:** IMPLEMENTED (local verifier + n8n export; hosted proof pending)  
**Parent:** [STAGE-27DEMO-L-N8N-BOOKING-WRITE-CALENDAR.md](STAGE-27DEMO-L-N8N-BOOKING-WRITE-CALENDAR.md) · [STAGE-27DEMO-E-STRIPE-TEST-LINK-WHATSAPP.md](STAGE-27DEMO-E-STRIPE-TEST-LINK-WHATSAPP.md)  
**Verifier:** `npm run verify:stage27demo-m-n8n-stripe-test-link`  
**Next:** **27demo-n** — real Stripe webhook payment truth from actual checkout

---

## Goal

Prove the n8n-shaped inbound pipe can create or reuse a **Stripe TEST** Checkout link for an existing open-demo hold + draft payment when explicitly approved. **Link creation only** — no WhatsApp payment-link send in this stage.

**Architecture:** Meta-shaped POST → **n8n (pipe only)** → **Staff API (brain)** → `runGuestStripeTestLinkCreateApproved`.

---

## n8n workflow

| Field | Value |
|-------|-------|
| **Name** | `Luna Open Demo WhatsApp Stripe Test Link Pipe` |
| **Repo export** | `n8n/Luna Open Demo WhatsApp Stripe Test Link Pipe.json` |
| **Suggested staging id** | `stage27demoMStripe01` |
| **Webhook path** | `open-demo-whatsapp-stripe-test-link-27m` |
| **Default in repo** | `active: false` |

### Payload mapping

Same normalized Meta fields as [27demo-j](STAGE-27DEMO-J-N8N-INBOUND-REVIEW-PIPE.md), plus:

```json
{
  "create_stripe_test_link_confirmed": true,
  "booking_code": "WH-G27-0ECC1D9B57",
  "payment_draft_id": "optional-if-known"
}
```

Staff API resolves the latest draft for `guest_phone` when refs are omitted.

### Do not include (27demo-m link-only proof)

- `send_live_reply_confirmed` — forbidden
- `send_payment_link_whatsapp_confirmed` — forbidden (27demo-e scope)
- `create_demo_hold_draft_confirmed` — not required when booking already exists
- `assign_demo_bed_confirmed` — not required for link-only proof

---

## Env gates (during proof)

| Variable | Value |
|----------|-------|
| `OPEN_DEMO_WHATSAPP_ENABLED` | `true` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | **`true`** |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | **`true`** (required by stripe gate even for link-only) |
| `STRIPE_LINKS_ENABLED` | `true` |
| `STAFF_ACTIONS_ENABLED` | `true` |
| `STRIPE_SECRET_KEY` | `sk_test_…` only |
| `WHATSAPP_DRY_RUN` | `true` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `false` |
| `OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID` | `1152900101233109` |

### Baseline / after proof

Restore: `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=false`, `OPEN_DEMO_BOOKING_WRITES_ENABLED=false`, keep dry-run and live-reply off.

---

## Expected response (link create/reuse)

```json
{
  "staff_api_success": true,
  "create_stripe_test_link_confirmed": true,
  "stripe_link_attempted": true,
  "stripe_link_created": true,
  "stripe_link_reused": false,
  "stripe_mode": "test",
  "booking_code": "WH-G27-…",
  "booking_id": "…",
  "payment_draft_id": "…",
  "stripe_checkout_session_id": "cs_test_…",
  "stripe_checkout_url": "https://checkout.stripe.com/c/pay/cs_test_…",
  "payment_link_sent": false,
  "whatsapp_sent": false,
  "sends_whatsapp": false,
  "confirmation_sent": false,
  "payment_truth_applied": false
}
```

Idempotency replay → `stripe_link_reused: true`, same session/URL, no duplicate Checkout Session.

---

## Proof commands (do not run without explicit approval)

### Harness (direct Staff API — no n8n)

```bash
node scripts/run-open-demo-whatsapp-inbound-dry-run.js \
  --base-url https://staff-staging.lunafrontdesk.com \
  --phone-number-id 1152900101233109 \
  --guest-phone +34600995557 \
  --message "Please send the deposit payment link" \
  --create-stripe-test-link-confirmed \
  --json
```

Uses existing booking **`WH-G27-0ECC1D9B57`** (27demo-l proof).

### Hosted n8n proof (after gates enabled + workflow DB-imported)

1. Import workflow `Luna Open Demo WhatsApp Stripe Test Link Pipe` to staging n8n (inactive in repo).
2. Enable proof env gates (table above); keep `WHATSAPP_DRY_RUN=true`.
3. POST Meta-shaped webhook to `open-demo-whatsapp-stripe-test-link-27m` with phone `+34600995557`, message e.g. `Please send the deposit payment link`, flat `booking_code: WH-G27-0ECC1D9B57`.
4. Expect `stripe_link_created` or `stripe_link_reused`, `stripe_checkout_url` present, no WhatsApp send.
5. Replay same wamid → `stripe_link_reused: true`.
6. Restore gates; deactivate workflow.

---

## Safety exclusions

| Check | Expected |
|-------|----------|
| Live Stripe (`sk_live_`) | blocked |
| Production | hard-block |
| Payment truth from chat | no (`payment_truth_applied: false`) |
| Confirmation send | no |
| WhatsApp payment link | no (default) |
| New booking on link-only | no (reuses existing draft) |

---

## Rollback

1. `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=false`
2. `OPEN_DEMO_BOOKING_WRITES_ENABLED=false`
3. Deactivate n8n workflow; clear `webhook_entity` if DB-imported

---

## Next — 27demo-n

Real Stripe webhook payment truth from an actual TEST checkout completion (deposit paid → booking truth updated). Still no confirmation send unless explicitly in later scope.
