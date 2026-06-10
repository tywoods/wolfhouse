# Stage 28c.3 — Meta Staff API → Open Demo Booking Path

## Why Stage 28c failed

Real handset proof (Ty, `+491726422307`) reached staging through the restored Meta callback:

`https://staff-staging.lunafrontdesk.com/staff/meta/whatsapp/webhook`

Preflight passed and all three WhatsApp turns were captured. Two separate gaps blocked booking write:

1. **Owner routing** — While `staff_phone_access` marked the handset as active owner, inbound was routed to the owner command center instead of guest automation. Demoting `is_active=false` fixed routing but exposed gap #2.
2. **Preview-only Meta path** — The Meta webhook called `buildInboundBookingWritePreview` only. It never invoked the proven open-demo handler that accumulates `guest_context` and performs hold/draft/bed writes.

Turn state did not accumulate on the legacy path because `WHATSAPP_DRY_RUN=true` blocks outbound replies and the old draft path did not persist multi-turn intake the way the open-demo review path does.

## Why live replies are not the fix

Enabling `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` would let Luna ask follow-up questions on the handset, but it is not required for proof when the guest sends three pre-planned turns. The harness and n8n proofs already demonstrate that **open-demo inbound review** persists `guest_context` across turns without live WhatsApp.

Live replies also increase blast radius (Graph API send, guest_message_sends audit) and were explicitly out of scope for Stage 28c.

## Architecture (Stage 28c.3)

```
Meta Cloud API
    → POST /staff/meta/whatsapp/webhook   (Staff API — brain)
        → meta-open-demo-inbound-adapter
        → executeOpenDemoWhatsAppInbound (same core as bot route)
            → runGuestInboundReviewDryRun (guest_context accumulation)
            → [when ready] runGuestHoldPaymentDraftWriteDryRunApproved
            → [when ready] runOpenDemoBookingBedAssignApproved
```

**Rejected patterns:**

- Meta → Staff API → n8n → Staff API (circular bridge)
- Enabling live replies as a workaround for missing write wiring

**Accepted pattern:**

- Meta → Staff API directly, reusing `POST /staff/bot/open-demo-whatsapp-inbound-dry-run` execution logic internally.

## Gates

### Baseline (safe staging)

| Env | Value |
|-----|-------|
| `WHATSAPP_DRY_RUN` | `true` |
| `OPEN_DEMO_WHATSAPP_ENABLED` | `true` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `false` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `false` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `false` |
| `OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID` | `1152900101233109` |

### Proof window only

| Env | Value |
|-----|-------|
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `true` |

Keep `WHATSAPP_DRY_RUN=true` and live replies **off**.

### Owner handset note

If the proof phone is in `staff_phone_access` as active owner, demote `is_active=false` for the proof window so guest open-demo routing applies. Restore after proof.

## Meta route behavior

When `OPEN_DEMO_WHATSAPP_ENABLED=true` and `phone_number_id` matches `OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID`:

1. Active owner phones still use owner command center (unchanged).
2. Guest phones (including inactive owner rows) map to open-demo inbound body and call `executeOpenDemoWhatsAppInbound`.
3. Review/inbox persistence runs every turn.
4. When `OPEN_DEMO_BOOKING_WRITES_ENABLED=true` **and** review reaches `payment_choice_ready` + hold plan ready, Meta path auto-confirms:
   - `create_demo_hold_draft_confirmed: true`
   - `assign_demo_bed_confirmed: true`
5. Meta path **never** passes:
   - `send_live_reply_confirmed`
   - `create_stripe_test_link_confirmed`
   - `send_payment_link_whatsapp_confirmed`

## 3-turn hosted proof script

**Phone:** `+491726422307` (demote owner row during proof)  
**Dates:** 2026-11-10 → 2026-11-17 (pick clean 7-night window if occupied)  
**Demo WhatsApp:** `+34 663 43 94 19`

Send exactly:

1. `Hi, we are 2 people interested in the Malibu package`
2. `November 10 to November 17`
3. `Deposit is fine`

After each turn, poll `guest_message_events.normalized.open_demo_result` for the proof phone.

**Turn 3 expected:**

- `payment_choice_ready: true`
- `write_status: created`
- `assignment_write_status: created`
- `booking_code`, `booking_id`, `payment_draft_id` present
- `calendar_visible_expected: true`
- `stripe_link_created: false`
- `payment_link_sent: false`
- `confirmation_sent: false`

Use `.tmp-stage28c-staff-api-handset-proof.js` or equivalent DB/API polling.

## Rollback

1. `OPEN_DEMO_BOOKING_WRITES_ENABLED=false`
2. `WHATSAPP_DRY_RUN=true`
3. `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=false`
4. `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=false`
5. Restore owner `staff_phone_access.is_active=true` if demoted
6. Leave Meta callback on Staff API staging webhook (current intended staging callback)
7. Keep n8n booking-write workflow **inactive**

## Safety boundaries

- No production (`NODE_ENV=production` blocks open-demo gates)
- No Stripe checkout unless explicit Stripe flag on HTTP route (Meta never sets it)
- No payment link WhatsApp send
- No confirmation send
- No n8n activation required for this path
- No live WhatsApp unless explicit live-reply flag on HTTP route (Meta never sets it)

## Stage 28c.6 — guest_email synthesis

Stage **28c.5** handset proof (`+491726422307`, July 24–31) passed routing, context accumulation, pricing, and `payment_choice_ready`, but hold write failed with `missing_guest_email`. The harness already supplies `open-demo+{phone_digits}@example.test`; the Meta open-demo adapter did not.

**28c.6** synthesizes staging `guest_email` from the guest phone when none is present on the Meta inbound body (e.g. `+491726422307` → `open-demo+491726422307@example.test`). `guest_name` is taken from Meta `profile_name` when present but is not required. Owner command center routing is unchanged; production and non-demo flows are not affected.

**Next hosted rerun (28c.7):** use the same July 24–31 window after deploy.

## Verifier

```bash
npm run verify:stage28c3-meta-staffapi-open-demo-booking-path
```
