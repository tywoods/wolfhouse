# Stage 27demo-e — Open Demo Stripe TEST Link + WhatsApp Payment Link

**Status:** IMPLEMENTED (local verifier)  
**Parent:** [STAGE-27DEMO-D-OPEN-DEMO-BOOKING-WRITE-CALENDAR.md](STAGE-27DEMO-D-OPEN-DEMO-BOOKING-WRITE-CALENDAR.md)  
**Verifier:** `npm run verify:stage27demo-e-stripe-test-link-whatsapp`

## Goal

After a staging open-demo hold + draft payment exists, create/reuse a **Stripe TEST** Checkout link and optionally send that link to the guest over WhatsApp from the demo number.

**This stage may:**
- Create/reuse Stripe TEST checkout link
- Send payment link over WhatsApp (when live send gates allow)

**This stage must not:**
- Use live Stripe (`sk_live_`, `livemode: true`)
- Mark payment paid from chat
- Send booking confirmation
- Run in production

Payment truth is applied via **Stripe webhook / Stage 27p** only — verified separately. Confirmation remains off.

---

## Env gates

| Variable | Required | Notes |
|----------|----------|-------|
| `OPEN_DEMO_WHATSAPP_ENABLED` | yes | Inbound demo route |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | yes | **New** — default `false` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | yes | Hold/draft must exist |
| `STRIPE_LINKS_ENABLED` | yes | Staging Staff API |
| `STAFF_ACTIONS_ENABLED` | yes | Reused 27o gate |
| `STRIPE_SECRET_KEY` | yes | Must be `sk_test_` |
| `WHATSAPP_DRY_RUN` | `true` for link-only proof | Blocks WhatsApp send |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | yes for live send | With `WHATSAPP_DRY_RUN=false` |
| `OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID` | staging proof | Must match inbound `phone_number_id` |

Production is hard-blocked.

---

## Endpoint

`POST /staff/bot/open-demo-whatsapp-inbound-dry-run`

**New request flags (final turn):**

| Flag | Purpose |
|------|---------|
| `create_stripe_test_link_confirmed: true` | Create/reuse Stripe TEST checkout for existing draft |
| `send_payment_link_whatsapp_confirmed: true` | Send link via WhatsApp (requires prior stripe flag + live send gates) |

Requires hold + draft (`payment_draft_id`) from same-turn write or existing booking for guest phone.

---

## Payment-link WhatsApp copy

```
Perfect, here's the secure test payment link for your deposit: <stripe_checkout_url>
```

Does **not** say booking is confirmed or payment received.

---

## Harness

```bash
node scripts/run-open-demo-whatsapp-inbound-dry-run.js \
  --base-url https://staff-staging.lunafrontdesk.com \
  --phone-number-id 1152900101233109 \
  --fixture booking-deposit-write-clean \
  --create-demo-hold-draft-confirmed \
  --assign-demo-bed-confirmed \
  --create-stripe-test-link-confirmed \
  --json
```

Optional live send (staging only, explicit gates):

```bash
  --send-payment-link-whatsapp-confirmed
```

With `WHATSAPP_DRY_RUN=true`: Stripe link create/reuse allowed; WhatsApp send blocked.

---

## Expected statuses

| Step | Before | After link |
|------|--------|------------|
| Payment row | `draft` | `checkout_created` |
| `next_safe_step` | `ready_for_stripe_test_link` | `awaiting_payment_truth` |
| Response | — | `stripe_link_created` or `stripe_link_reused`, `stripe_checkout_url` set |

---

## Idempotency

- Re-run with same draft → `stripe_link_reused: true`, same checkout URL, no duplicate Checkout Session.
- WhatsApp send idempotent per inbound message id (`open-demo:…:payment-link` key).

---

## Hosted proof steps (staging)

1. Deploy image with 27demo-e.
2. Enable gates (see table); keep `WHATSAPP_DRY_RUN=true` for link-only pass.
3. Run harness on existing clean booking `WH-G27-8E83FAD8BB` (`+34600995556`) with `--create-stripe-test-link-confirmed` only (write/assign reuse).
4. Expect `stripe_link_reused` or `stripe_link_created`, `stripe_checkout_url` present.
5. Optional second proof: set `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=true`, `WHATSAPP_DRY_RUN=false`, add `--send-payment-link-whatsapp-confirmed`.
6. Restore safe defaults; verify no confirmation send.

---

## Safety summary

| Check | Result |
|-------|--------|
| Live Stripe | blocked |
| Payment truth from chat | no |
| Confirmation send | no |
| Duplicate checkout on rerun | idempotent reuse |
| Production | hard-block |
