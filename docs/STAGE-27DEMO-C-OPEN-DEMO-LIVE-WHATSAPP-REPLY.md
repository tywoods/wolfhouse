# Stage 27demo-c — Open Demo Live WhatsApp Reply

**Status:** RUNTIME SLICE — gated live outbound replies only.  
**Parent:** [STAGE-27DEMO-B-OPEN-DEMO-WHATSAPP-INBOUND.md](STAGE-27DEMO-B-OPEN-DEMO-WHATSAPP-INBOUND.md)  
**Verifier:** `npm run verify:stage27demo-c-open-demo-live-reply`  
**Hosted proof baseline:** `6b59214-stage27demo-b-open-demo-inbound`

---

## 0. What this slice does

| In scope | Out of scope |
|----------|--------------|
| Gated live WhatsApp reply after inbound review | Booking/hold/payment writes |
| Reuses `evaluateGuestReplySendRouteWithPause` | Stripe checkout links |
| Explicit `send_live_reply_confirmed: true` | Confirmation send |
| Demo phone_number_id guard | Guest phone allowlist |
| Default remains review-only (27demo-b) | n8n workflow activation |

**Endpoint:** same as 27demo-b — `POST /staff/bot/open-demo-whatsapp-inbound-dry-run`  
Add `"send_live_reply_confirmed": true` to request body for live send attempt.

---

## 1. Env gates (all required for live send)

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPEN_DEMO_WHATSAPP_ENABLED` | `false` | Master inbound demo switch (27demo-b) |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `false` | **New** — live reply kill switch |
| `OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID` | unset | Inbound payload + send number guard |
| `WHATSAPP_DRY_RUN` | `true` | Must be `false` for actual Graph API send |
| `WHATSAPP_PHONE_NUMBER_ID` | secret | Must match demo phone_number_id when both set |
| `WHATSAPP_CLOUD_ACCESS_TOKEN` | secret | Meta Cloud API token |
| `LUNA_BOT_INTERNAL_TOKEN` | secret | Bot auth for harness/n8n |

**Production:** Always blocks live replies (`NODE_ENV=production`).

**No guest phone allowlist** — any guest phone in payload can receive reply when all gates pass.

---

## 2. Request example (live reply)

```json
{
  "client_slug": "wolfhouse-somo",
  "channel": "whatsapp",
  "phone_number_id": "1152900101233109",
  "guest_phone": "+34600995555",
  "message_text": "What are the packages?",
  "wamid": "wamid.HBgL...",
  "inbound_message_id": "wamid.HBgL...",
  "received_at": "2026-06-09T20:00:00.000Z",
  "send_live_reply_confirmed": true
}
```

### Response when sent

```json
{
  "success": true,
  "open_demo": true,
  "send_live_reply_confirmed": true,
  "sends_whatsapp": true,
  "whatsapp_sent": true,
  "live_send_blocked": false,
  "send_performed": true,
  "reused_send_path": "evaluateGuestReplySendRouteWithPause",
  "whatsapp_message_id": "wamid.outbound...",
  "review": { "proposed_luna_reply": "..." }
}
```

### Response when blocked (dry-run still on)

```json
{
  "success": true,
  "send_live_reply_confirmed": true,
  "live_reply_attempted": true,
  "live_send_blocked": true,
  "sends_whatsapp": false,
  "whatsapp_sent": false,
  "live_reply_gate_blocked": true,
  "live_reply_gate_code": "whatsapp_dry_run_active"
}
```

### Default (no confirm flag) — unchanged 27demo-b

`send_live_reply_confirmed` omitted → review + persistence only, `sends_whatsapp: false`.

---

## 3. Kill switches

Disable live sends immediately (any one):

1. `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=false`
2. `WHATSAPP_DRY_RUN=true`
3. `OPEN_DEMO_WHATSAPP_ENABLED=false` (blocks inbound entirely)

---

## 4. Local harness

```bash
# Review-only (default)
npm run open-demo:whatsapp-inbound -- --fixture package-question

# Live send attempt (blocked locally unless gates off)
npm run open-demo:whatsapp-inbound -- \
  --message "What are the packages?" \
  --guest-phone +34600995555 \
  --phone-number-id demo-local \
  --send-live-reply-confirmed \
  --json
```

---

## 5. Staging proof steps

### 1. Deploy

Build/deploy Staff API with 27demo-c commit:

```bash
az acr build --registry whstagingacr \
  --image wh-staff-api:<commit>-stage27demo-c-live-reply --file Dockerfile .

az containerapp update \
  --name wh-staging-staff-api \
  --resource-group wh-staging-rg \
  --image whstagingacr.azurecr.io/wh-staff-api:<commit>-stage27demo-c-live-reply \
  --revision-suffix stage27demo-c-live-reply
```

### 2. Enable live reply gate

```bash
az containerapp update \
  --name wh-staging-staff-api \
  --resource-group wh-staging-rg \
  --set-env-vars \
    OPEN_DEMO_WHATSAPP_ENABLED=true \
    OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=true \
    OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID=1152900101233109 \
    WHATSAPP_DRY_RUN=false \
    WHATSAPP_PHONE_NUMBER_ID=secretref:meta-whatsapp-phone-id \
    WHATSAPP_CLOUD_ACCESS_TOKEN=secretref:meta-whatsapp-token
```

Keep `STRIPE_LINKS_ENABLED` unchanged — not used in this stage.

### 3. Send one package-question live reply to real test phone

```bash
node scripts/run-open-demo-whatsapp-inbound-dry-run.js \
  --base-url https://staff-staging.lunafrontdesk.com \
  --phone-number-id 1152900101233109 \
  --guest-phone +<YOUR_REAL_TEST_PHONE> \
  --message "What are the packages?" \
  --send-live-reply-confirmed \
  --json
```

**Expect:** HTTP 200, `whatsapp_sent: true`, `sends_whatsapp: true`, package explainer text on phone.

### 4. Verify WhatsApp received

Check test phone for Luna package explainer message from demo business number.

### 5. Restore dry-run (recommended)

```bash
az containerapp update \
  --name wh-staging-staff-api \
  --resource-group wh-staging-rg \
  --set-env-vars WHATSAPP_DRY_RUN=true OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=false
```

### Negative checks

| Test | Expected |
|------|----------|
| Wrong `phone_number_id` in payload | 403 inbound gate |
| `send_live_reply_confirmed` omitted | No send |
| `WHATSAPP_DRY_RUN=true` + confirm | `live_reply_gate_code: whatsapp_dry_run_active` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=false` | `live_replies_disabled` |

---

## 6. Safety limits

- Live send only when **all** gates pass + explicit confirm flag + `proposed_luna_reply` present
- Reuses Phase 19 guest reply send route (`staff_reply` kind) — audit in `guest_message_sends`
- No booking/hold/payment/Stripe/confirmation paths in handler
- Idempotency: `open-demo:{client_slug}:whatsapp:{wamid}:live-reply`

---

## 7. Next step

**27demo-d** — booking hold + draft write + Staff Portal calendar proof (still Stripe TEST only when reached).
