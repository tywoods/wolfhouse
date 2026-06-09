# Stage 27demo-b — Open Demo WhatsApp Inbound (Dry Run)

**Status:** RUNTIME SLICE — inbound pipe only, **no live WhatsApp replies**.  
**Parent:** [STAGE-27DEMO-A-OPEN-WHATSAPP-BOOKING-STRIPE-DEMO-DESIGN.md](STAGE-27DEMO-A-OPEN-WHATSAPP-BOOKING-STRIPE-DEMO-DESIGN.md)  
**Stability baseline:** `51977c6-stage27test-t1-pg-pool`  
**Verifier:** `npm run verify:stage27demo-b-open-demo-inbound`  
**Next:** **27demo-c** — live WhatsApp reply proof (gated outbound send)

---

## 0. What this slice does

| In scope | Out of scope |
|----------|--------------|
| n8n-shaped inbound payload → Staff API | Live WhatsApp outbound send |
| Demo env gates (enabled + phone_number_id) | Booking/hold/payment writes |
| Luna inbound review (27x.1 path) | Stripe checkout links |
| Staff Portal inbox + `staff_reply_draft` persistence | Meta/n8n workflow activation |
| Review artifact + slim guest_context | Guest phone allowlist |

**Architecture:** Meta WhatsApp → **n8n (pipe)** → **Staff API (brain)** → Luna review → Staff Portal inbox.

---

## 1. Endpoint

```
POST /staff/bot/open-demo-whatsapp-inbound-dry-run
```

- **Auth:** `requireBotAuth` — `X-Luna-Bot-Token: $LUNA_BOT_INTERNAL_TOKEN`
- **Mode:** Review + conversation metadata persistence only
- **Safety flags (always):** `sends_whatsapp: false`, `live_send_blocked: true`, `no_write_performed: true` (via 27x.1)

### 1.1 Example n8n → Staff API payload

```json
{
  "source": "n8n_open_demo_whatsapp_inbound",
  "client_slug": "wolfhouse-somo",
  "channel": "whatsapp",
  "phone_number_id": "123456789012345",
  "guest_phone": "+34600995555",
  "message_text": "Hi, we are 2 people interested in the Malibu package",
  "wamid": "wamid.HBgLMzQ2MDA5OTU1NTUVAgARGBI5...",
  "inbound_message_id": "wamid.HBgLMzQ2MDA5OTU1NTUVAgARGBI5...",
  "received_at": "2026-06-08T14:22:00.000Z",
  "contact_name": "Demo Guest",
  "raw_meta_message_id": "wamid.HBgLMzQ2MDA5OTU1NTUVAgARGBI5..."
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `client_slug` | ✓ | e.g. `wolfhouse-somo` |
| `channel` | ✓ | Must be `whatsapp` |
| `guest_phone` | ✓ | E.164 from Meta `from` |
| `message_text` | ✓ | Normalized inbound text |
| `wamid` or `inbound_message_id` | ✓ | Meta message id for idempotency |
| `phone_number_id` | optional* | WhatsApp business number id; required when env gate set |
| `received_at` | optional | ISO timestamp from Meta |
| `contact_name` | optional | WhatsApp profile display name |
| `raw_meta_message_id` | optional | Alias for dedupe/debug |
| `guest_context` | optional | Multi-turn chain state from prior response |

\*When `OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID` is set on Staff API, inbound `phone_number_id` must match. When unset (local/dev), harness payloads are allowed.

### 1.2 Example success response (abbreviated)

```json
{
  "success": true,
  "dry_run": true,
  "open_demo": true,
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "no_write_performed": true,
  "review_persistence_performed": true,
  "conversation_id": "…",
  "review": {
    "proposed_luna_reply": "Hi! I'd love to help you with the Malibu package…",
    "proposed_next_action": "collect_dates",
    "result": { "message_lane": "booking_intake" }
  },
  "slim_guest_context_for_next_turn": { "…": "…" },
  "demo_gate": "open_demo_whatsapp_enabled"
}
```

### 1.3 Gate-blocked response

When `OPEN_DEMO_WHATSAPP_ENABLED` is not `true`, or in production:

```json
{
  "success": false,
  "dry_run": true,
  "open_demo": true,
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "demo_gate_blocked": true,
  "demo_gate_code": "demo_disabled",
  "error": "open demo WhatsApp inbound is disabled (set OPEN_DEMO_WHATSAPP_ENABLED=true on staging)"
}
```

---

## 2. Required env gates (Staff API)

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPEN_DEMO_WHATSAPP_ENABLED` | `false` (unset) | Master switch — must be `true` on staging to accept inbound |
| `OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID` | unset | Optional Meta business `phone_number_id` guard |
| `WHATSAPP_DRY_RUN` | should stay `true` | No live outbound in this slice |
| `LUNA_BOT_INTERNAL_TOKEN` | required | n8n / harness bot auth |

**Production:** Always rejects open demo inbound regardless of `OPEN_DEMO_WHATSAPP_ENABLED`.

**No guest phone allowlist** — anyone messaging the demo WhatsApp number is accepted when gates pass.

---

## 3. Local harness

```bash
# Gate must be enabled on local Staff API:
# OPEN_DEMO_WHATSAPP_ENABLED=true node scripts/staff-query-api.js

npm run open-demo:whatsapp-inbound -- --fixture booking-turn-1
npm run open-demo:whatsapp-inbound -- --fixture booking-turn-1 --fixture booking-turn-2
npm run open-demo:whatsapp-inbound -- --fixture package-question
npm run open-demo:whatsapp-inbound -- --message "Transfer from Bilbao airport"
npm run open-demo:whatsapp-inbound -- --json --fixture transfer-question
```

Fixtures:

| Name | Message |
|------|---------|
| `booking-turn-1` | Hi, we are 2 people interested in the Malibu package |
| `booking-turn-2` | July 10 to July 17 |
| `package-question` | What are the packages? |
| `transfer-question` | Transfer from Bilbao airport |

Harness options: `--base-url`, `--client-slug`, `--phone-number-id`, `--guest-phone`, `--wamid`, `--contact-name`, `--reference-date`, `--json`.

---

## 4. Staging proof

Deploy image with env:

```bash
OPEN_DEMO_WHATSAPP_ENABLED=true
OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID=<staging-demo-meta-phone-number-id>
WHATSAPP_DRY_RUN=true
```

Run harness against staging:

```bash
node scripts/run-open-demo-whatsapp-inbound-dry-run.js \
  --base-url https://staff-staging.lunafrontdesk.com \
  --phone-number-id <staging-demo-meta-phone-number-id> \
  --fixture booking-turn-1 \
  --json
```

**Expected:**

1. HTTP 200, `success: true`, `review.proposed_luna_reply` populated
2. Staff Portal **Inbox** shows conversation for guest phone
3. `staff_reply_draft` / `last_message_preview` updated (27x.1 persistence)
4. No outbound WhatsApp message sent
5. No booking/hold/Stripe side effects

---

## 5. Staff Portal persistence (27x.1)

Same as `POST /staff/bot/guest-inbound-review-dry-run`:

- Upsert guest conversation by `client_slug` + `guest_phone` + channel
- Insert inbound message (idempotent on `wamid`)
- Persist Luna review artifact
- Update `staff_reply_draft` and `last_message_preview` for inbox UI

---

## 6. Safety limits (27demo-b)

| Guard | Behavior |
|-------|----------|
| `OPEN_DEMO_WHATSAPP_ENABLED` | Default off; staging-only when on |
| Production `NODE_ENV` | Always 403 |
| `phone_number_id` | Blocks wrong Meta number/workflow |
| `requireBotAuth` | No public webhook |
| `runGuestInboundReviewDryRun` | Review-only orchestrator path |
| Response flags | `sends_whatsapp: false`, `live_send_blocked: true` |
| No writes | No hold, payment draft, booking create, Stripe link |

---

## 7. Next step — 27demo-c

**27demo-c — live reply proof:** Enable gated outbound WhatsApp send on staging demo number after inbound review GO. Still Stripe TEST only; still no production.

See [STAGE-27DEMO-A-OPEN-WHATSAPP-BOOKING-STRIPE-DEMO-DESIGN.md](STAGE-27DEMO-A-OPEN-WHATSAPP-BOOKING-STRIPE-DEMO-DESIGN.md) § implementation sequence.
