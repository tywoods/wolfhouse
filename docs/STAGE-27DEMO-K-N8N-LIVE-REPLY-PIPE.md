# Stage 27demo-k — n8n Open Demo WhatsApp Inbound Live Reply Pipe

**Status:** RUNTIME SLICE — gated **live WhatsApp reply** via staging n8n → Staff API.  
**Parent:** [STAGE-27DEMO-J-N8N-INBOUND-REVIEW-PIPE.md](STAGE-27DEMO-J-N8N-INBOUND-REVIEW-PIPE.md) · [STAGE-27DEMO-C-OPEN-DEMO-LIVE-WHATSAPP-REPLY.md](STAGE-27DEMO-C-OPEN-DEMO-LIVE-WHATSAPP-REPLY.md)  
**Verifier:** `npm run verify:stage27demo-k-n8n-live-reply-pipe`  
**Next:** **27demo-l** — booking write through n8n (gated hold/draft only)

---

## 0. What this slice does

| In scope | Out of scope |
|----------|--------------|
| n8n pipe passes `send_live_reply_confirmed: true` | Booking/hold/payment writes |
| Staff API owns live send gates + Graph API send | Stripe checkout / payment links |
| One live package-explainer reply when gates open | Confirmation send |
| Pre-live blocked proof (gates closed) | Production n8n Main changes |
| Meta-shaped webhook POST to staging n8n | New Luna logic inside n8n |

**Architecture:** Meta WhatsApp → **n8n (pipe only)** → **Staff API (brain)** → Luna review + optional live send.

n8n must **not** call `graph.facebook.com`, Stripe, or write booking data. Staff API performs the WhatsApp send when all gates pass.

---

## 1. n8n workflow

| Field | Value |
|-------|-------|
| **Name** | `Luna Open Demo WhatsApp Inbound Live Reply Pipe` |
| **Repo export** | `n8n/Luna Open Demo WhatsApp Inbound Live Reply Pipe.json` |
| **Staging import id** | `stage27demoKLive01` (suggested) |
| **Webhook path** | `open-demo-whatsapp-inbound-live-reply-27k` |
| **Staging URL (when active)** | `https://wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io/webhook/open-demo-whatsapp-inbound-live-reply-27k` |
| **Credential** | `Luna Bot Internal Token (staging)` → `X-Luna-Bot-Token` |
| **Default in repo** | `active: false` |

**Separate from 27demo-j review pipe** — do not modify `Luna Open Demo WhatsApp Inbound Review Pipe` for live send.

---

## 2. Payload mapping (Meta → n8n → Staff API)

Same normalization as [27demo-j](STAGE-27DEMO-J-N8N-INBOUND-REVIEW-PIPE.md) §2, plus **one** outbound flag:

```json
{
  "source": "n8n_open_demo_whatsapp_inbound",
  "client_slug": "wolfhouse-somo",
  "channel": "whatsapp",
  "phone_number_id": "1152900101233109",
  "guest_phone": "+491726422307",
  "message_text": "What are the packages?",
  "wamid": "wamid.HBgM…",
  "inbound_message_id": "wamid.HBgM…",
  "received_at": "2026-06-09T22:00:00.000Z",
  "send_live_reply_confirmed": true
}
```

### 2.1 `send_live_reply_confirmed` rules

| Rule | Detail |
|------|--------|
| **When set** | Only in this **27demo-k live-reply pipe** workflow (staging proof) |
| **Who decides send** | Staff API — evaluates `evaluateOpenDemoWhatsAppLiveReplyGate` + `WHATSAPP_DRY_RUN` |
| **n8n must not** | Call Meta send API directly |
| **Blocked when** | `WHATSAPP_DRY_RUN=true` and/or `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=false` |

### 2.2 Must **not** include (27demo-k)

- `create_demo_hold_draft_confirmed`
- `assign_demo_bed_confirmed`
- `create_stripe_test_link_confirmed`
- `send_payment_link_whatsapp_confirmed`

---

## 3. Env gates

### 3.1 Safe baseline (default / after proof)

| Variable | Value |
|----------|-------|
| `WHATSAPP_DRY_RUN` | `true` |
| `OPEN_DEMO_WHATSAPP_ENABLED` | `true` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `false` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `false` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `false` |
| `OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID` | `1152900101233109` |

### 3.2 Short live-send window (proof only)

| Variable | Value |
|----------|-------|
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `true` |
| `WHATSAPP_DRY_RUN` | `false` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `false` (unchanged) |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `false` (unchanged) |

**Restore immediately** after one live send.

---

## 4. Pre-live blocked proof

**Gates:** baseline §3.1  
**Message:** `What are the packages?` via Meta-shaped POST to staging n8n webhook  
**n8n body includes:** `send_live_reply_confirmed: true`

**Expected Staff API / n8n debug response:**

```json
{
  "staff_api_success": true,
  "proposed_luna_reply": "…package explainer…",
  "live_send_blocked": true,
  "whatsapp_sent": false,
  "sends_whatsapp": false,
  "no_write_performed": true
}
```

No booking, no Stripe checkout, no confirmation, no `guest_message_sends` row with `sent` status.

---

## 5. Live-send proof

**Gates:** §3.2 (brief window)  
**Recipient:** `+491726422307` (Ty — manual receipt verification)  
**Message:** `What are the packages?`

**Expected:**

```json
{
  "staff_api_success": true,
  "whatsapp_sent": true,
  "sends_whatsapp": true,
  "live_send_blocked": false,
  "send_performed": true,
  "guest_message_send_status": "sent",
  "provider_message_id": "wamid.…"
}
```

**DB / safety:**

- `guest_message_sends` +1 for intended test only
- No new bookings
- No Stripe checkout sessions
- No confirmation send
- No `LUNA_REVIEW_DRY_RUN_ERROR`

---

## 6. Rollback / disable

1. Restore Staff API env:

```bash
az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg \
  --set-env-vars WHATSAPP_DRY_RUN=true \
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=false \
  OPEN_DEMO_BOOKING_WRITES_ENABLED=false \
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=false
```

2. **Deactivate** `Luna Open Demo WhatsApp Inbound Live Reply Pipe` on staging n8n (`active: false`).
3. Clear `webhook_entity` row for `open-demo-whatsapp-inbound-live-reply-27k` if imported via DB.
4. Meta callback remains on production n8n Cloud `booking-assistant` unless explicitly changed for handset test.

---

## 7. Next step — 27demo-l

**27demo-l — booking write through n8n:** same pipe pattern with gated `create_demo_hold_draft_confirmed` / `assign_demo_bed_confirmed` on final turn only when `OPEN_DEMO_BOOKING_WRITES_ENABLED=true`. Still no Stripe / confirmation unless separately scoped.

---

## 8. Related

- [STAGE-27DEMO-J-N8N-INBOUND-REVIEW-PIPE.md](STAGE-27DEMO-J-N8N-INBOUND-REVIEW-PIPE.md) — review-only pipe (no send flag)
- [STAGE-27DEMO-C-OPEN-DEMO-LIVE-WHATSAPP-REPLY.md](STAGE-27DEMO-C-OPEN-DEMO-LIVE-WHATSAPP-REPLY.md) — Staff API live reply gates (harness proof)
