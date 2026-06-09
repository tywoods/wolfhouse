# Stage 27demo-j — n8n Open Demo WhatsApp Inbound Review Pipe

**Status:** RUNTIME SLICE — **review-only** inbound pipe via staging n8n → Staff API.  
**Parent:** [STAGE-27DEMO-B-OPEN-DEMO-WHATSAPP-INBOUND.md](STAGE-27DEMO-B-OPEN-DEMO-WHATSAPP-INBOUND.md) · [STAGE-27DEMO-CLOSEOUT.md](STAGE-27DEMO-CLOSEOUT.md)  
**Stability baseline:** `565/565` hosted torture clean after shared PG pool  
**Verifier:** `npm run verify:stage27demo-j-n8n-review-pipe`  
**Next:** **27demo-k** — live WhatsApp reply through n8n (gated outbound send)

---

## 0. What this slice does

| In scope | Out of scope |
|----------|--------------|
| Real/demo Meta WhatsApp webhook → **staging n8n (pipe)** → Staff API | Live WhatsApp outbound reply |
| Luna inbound review + Staff Portal inbox/draft persistence | Booking/hold/payment writes |
| Demo `phone_number_id` guard | Stripe checkout / payment links |
| Idempotent inbound via `wamid` | Confirmation sends |
| Negative proof (wrong phone_number_id) | Production n8n Main changes |
| | New Luna logic inside n8n |

**Architecture:** Meta WhatsApp → **n8n (pipe only)** → **Staff API (brain)** → Luna review → Staff Portal inbox.

n8n must **not** generate replies, call Meta send API, call Stripe, or write booking data directly.

---

## 1. n8n workflow

| Field | Value |
|-------|-------|
| **Name** | `Luna Open Demo WhatsApp Inbound Review Pipe` |
| **Repo export** | `n8n/Luna Open Demo WhatsApp Inbound Review Pipe.json` |
| **Staging import id** | `stage27demoJReview01` (suggested) |
| **Webhook path** | `open-demo-whatsapp-inbound-review-27j` |
| **Staging URL (when active)** | `https://wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io/webhook/open-demo-whatsapp-inbound-review-27j` |
| **Credential** | `Luna Bot Internal Token (staging)` → header `X-Luna-Bot-Token` |
| **Default in repo** | `active: false` — import into **staging n8n only**; never replace production Main on n8n Cloud |

### 1.1 Pipe guardrails (workflow JSON)

- `review_pipe_mode: true` / `dry_run: true` / `live_send_enabled: false` set in Code node (no `$env`; staging n8n blocks env in expressions).
- **Only** accept `phone_number_id === 1152900101233109` (demo Wolfhouse number).
- Non-text Meta messages → safe placeholder `[non-text message: {type}]` forwarded to Staff API.
- **No** `graph.facebook.com`, **no** `api.stripe.com`, **no** guest-reply-send node.
- Staff API response logged in execution output (`proposed_luna_reply_preview`, safety flags).

---

## 2. Payload mapping (Meta → n8n → Staff API)

### 2.1 Meta webhook ingress (n8n normalizes)

Primary path: `body.entry[0].changes[0].value.messages[0]`

| Meta field | Normalized Staff API field |
|------------|---------------------------|
| `value.metadata.phone_number_id` | `phone_number_id` |
| `messages[0].from` | `guest_phone` (E.164 `+…`) |
| `contacts[0].profile.name` | `contact_name` (optional) |
| `messages[0].text.body` (or button/interactive title) | `message_text` |
| `messages[0].id` | `wamid`, `inbound_message_id`, `raw_meta_message_id` |
| `messages[0].timestamp` | `received_at` (ISO) |
| (constant) | `client_slug: wolfhouse-somo` |
| (constant) | `channel: whatsapp` |
| (constant) | `source: n8n_open_demo_whatsapp_inbound` |

### 2.2 Staff API request (review-only — **no write/send flags**)

```
POST https://staff-staging.lunafrontdesk.com/staff/bot/open-demo-whatsapp-inbound-dry-run
X-Luna-Bot-Token: (staging secret)
```

Example body (27demo-j — flags **absent**):

```json
{
  "source": "n8n_open_demo_whatsapp_inbound",
  "client_slug": "wolfhouse-somo",
  "channel": "whatsapp",
  "phone_number_id": "1152900101233109",
  "guest_phone": "+491726422307",
  "message_text": "What are the packages?",
  "wamid": "wamid.HBgMNDkxNzI2NDIyMzA3FQIAEh…",
  "inbound_message_id": "wamid.HBgMNDkxNzI2NDIyMzA3FQIAEh…",
  "received_at": "2026-06-09T22:00:00.000Z",
  "contact_name": "Demo Guest"
}
```

**Must not include** (remain false/absent in 27demo-j):

- `send_live_reply_confirmed`
- `create_demo_hold_draft_confirmed`
- `assign_demo_bed_confirmed`
- `create_stripe_test_link_confirmed`
- `send_payment_link_whatsapp_confirmed`

---

## 3. Required env gates (Staff API staging)

| Variable | Required value (27demo-j) |
|----------|---------------------------|
| `WHATSAPP_DRY_RUN` | `true` |
| `OPEN_DEMO_WHATSAPP_ENABLED` | `true` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `false` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `false` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `false` |
| `OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID` | `1152900101233109` |

Production always rejects open-demo inbound regardless of flags.

---

## 4. Proof message

From any phone, send to the demo WhatsApp number (**+34 663 43 94 19**, Meta ID `1152900101233109`):

```
What are the packages?
```

### 4.1 Expected Staff API response (abbreviated)

```json
{
  "success": true,
  "dry_run": true,
  "open_demo": true,
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "no_write_performed": true,
  "review_persistence_performed": true,
  "review": {
    "proposed_luna_reply": "…package explainer (Malibu / Ericeira / …)…",
    "proposed_next_action": "…"
  }
}
```

### 4.2 Expected n8n debug response

```json
{
  "staff_api_status": 200,
  "staff_api_success": true,
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "no_write_performed": true,
  "proposed_luna_reply_preview": "…package explainer…"
}
```

### 4.3 Staff Portal / DB proof

- `conversations` row exists/updates for sender phone.
- `last_message_preview` ≈ `What are the packages?`
- `staff_reply_draft` contains Luna package explainer.
- **No** new `guest_message_sends` row.
- **No** new booking.

### 4.4 Negative / safety proof

- Wrong `phone_number_id` → blocked by n8n IF guard and/or Staff API `phone_number_id_mismatch`.
- Same `wamid` replay → idempotent (no duplicate conversation weirdness).
- Logs: no `LUNA_REVIEW_DRY_RUN_ERROR`.
- Gates remain as §3 after proof.

---

## 5. Import / activate (staging only)

1. Import `n8n/Luna Open Demo WhatsApp Inbound Review Pipe.json` into **staging n8n** (`wh-staging-n8n-main…`).
2. Bind credential **Luna Bot Internal Token (staging)** on `HTTP - Open Demo Inbound Review`.
3. Leave **production n8n Cloud Main** untouched (`booking-assistant` path unchanged).
4. For pipe proof: activate **only** this staging workflow temporarily OR run manual execution with pinned Meta payload.
5. For **real WhatsApp** ingress: temporarily point Meta app callback to staging webhook URL (§1), send proof message, then **revert** Meta callback to production n8n Cloud `booking-assistant` (see §6).

Harness (Staff API brain, no n8n):

```bash
node scripts/run-open-demo-whatsapp-inbound-dry-run.js \
  --base-url https://staff-staging.lunafrontdesk.com \
  --phone-number-id 1152900101233109 \
  --fixture package-question \
  --guest-phone +491726422307
```

---

## 6. Rollback / disable

1. **Deactivate** workflow `Luna Open Demo WhatsApp Inbound Review Pipe` on staging n8n (`active: false`).
2. **Restore Meta webhook** to production n8n Cloud if changed:
   - `https://tywoods.app.n8n.cloud/webhook/booking-assistant`
3. **Restore Staff API env** (safe defaults):

```bash
az containerapp update --name wh-staging-staff-api --resource-group wh-staging-rg \
  --set-env-vars WHATSAPP_DRY_RUN=true \
  OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=false \
  OPEN_DEMO_BOOKING_WRITES_ENABLED=false \
  OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED=false
```

(`OPEN_DEMO_WHATSAPP_ENABLED` may stay `true` for later slices; set `false` to fully close demo inbound.)

4. Delete or archive staging workflow import if no longer needed.

---

## 7. Next step — 27demo-k

**27demo-k — live reply through n8n:** same pipe, gated outbound path where Staff API (not n8n) owns send decision; n8n may call open-demo endpoint with `send_live_reply_confirmed: true` only when env gates allow. Still no booking writes / Stripe / confirmation in that slice unless explicitly scoped.

---

## 8. Related

- [STAGE-27DEMO-B-OPEN-DEMO-WHATSAPP-INBOUND.md](STAGE-27DEMO-B-OPEN-DEMO-WHATSAPP-INBOUND.md) — endpoint + harness
- [STAGE-27X-LITE-INBOUND-REVIEW-WIRING-DESIGN.md](STAGE-27X-LITE-INBOUND-REVIEW-WIRING-DESIGN.md) — generic review wiring design
- [PHASE-19f-N8N-STAFF-API-CUTOVER-PLAN.md](PHASE-19f-N8N-STAFF-API-CUTOVER-PLAN.md) — Meta webhook ownership notes
