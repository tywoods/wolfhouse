# Webhook Map

**Production base URL (current):** `https://tywoods.app.n8n.cloud/webhook/`  
**Future (Azure self-hosted):** `https://<n8n-host>/webhook/` — same paths recommended for zero Apps Script change.

| Path | Method | Workflow | Expected body (observed) | Called by |
|------|--------|----------|------------------------|-----------|
| `booking-assistant` | POST | Wolfhouse Booking Assistant - Main | WhatsApp Cloud API envelope `entry[0].changes[0].value.messages[0]` | Meta WhatsApp webhook subscription |
| `assign-beds-to-booking` | POST | Wolfhouse - Bed Assignment | `{ "record_id": "<airtable_booking_rec_id>" }` | Airtable automation (inferred) |
| `cancel-booking-beds` | POST | Wolfhouse - Cancel Bed Assignments | `{ "record_id": "<airtable_booking_rec_id>" }` | Airtable automation on cancel |
| `reassign-booking-beds` | POST | Wolfhouse - Reassign Bed Assignments | `{ "booking_record_id" \| "record_id", "reason", "room_preference", "guest_gender_group_type", "stay_together", "rooming_notes", "preserve_booking_status", "send_guest_reply" }` | Airtable automation; **Main** HTTP node |
| `send-confirmation` | POST | Wolfhouse - Send Confirmation | Webhook trigger then internal search — may accept empty body | Airtable automation when `Send Confirmation` checked |
| `operator-room-release` | POST | Wolfhouse - Operator Room Release | `{ "record_id": "<release_request_rec_id>" }` | Airtable automation |
| `wolfhouse-manual-entries-queue` | POST | Wolfhouse - Manual Entries Queue Processor | `{ "action": "create"\|"update"\|"delete"\|"manual_sync_button", "manualEntryId": "...", ... }` from Apps Script | Google Sheets Apps Script |
| `send-staff-reply` | POST | Wolfhouse Booking Assistant - Send Staff Reply | `{ "recordId": "<conversation_rec_id>" }` | Airtable button / staff UI |
| `return-to-bot` | POST | Wolfhouse Booking Assistant - Return Conversation To Bot | `{ "recordId": "<conversation_rec_id>" }` | Airtable button / staff UI |

## Secondary / internal webhooks

| Path | Workflow | Notes |
|------|----------|-------|
| `e22ec0ce-5f25-448d-beb2-f004aa992987` | Main (`Webhook1`) | UUID-style path — likely legacy test webhook; verify before production |

## Webhook IDs (n8n internal)

| webhookId | Workflows sharing ID |
|-----------|---------------------|
| `a17ba7e1-7a97-4613-9f8b-d35b50460017` | Manual Entries Queue **and** Send Confirmation (**different paths** — fix on Azure import) |
| `76de4db6-f820-41db-b47c-65bd056a04d6` | Bed Assignment |
| `8ab9d454-04d3-48c1-9cf4-8b0f305e26e7` | Cancel Bed Assignments |
| `53a8b6e4-f0ee-48dd-8a26-7ed58035ed99` | Reassign |
| `57ad4c53-f371-4d6f-a632-b8133abdd315` | Operator Room Release |
| `76b6b624-0d6a-4cfc-98bd-d5e1253b0978` | Send Staff Reply |
| `1e645f9a-3bde-424f-b7fd-d4abaea4bb12` | Return To Bot |

## Phase 2b — Local Stripe webhooks (local n8n only)

**Base URL:** `http://localhost:5678/webhook/` — do **not** register on hosted n8n Cloud.

| Path | Method | Workflow | Body | Notes |
|------|--------|----------|------|-------|
| `create-payment-session` | POST | Wolfhouse - Create Payment Session | `{ "booking_id": "<uuid>", "payment_kind": "deposit_only" \| "full_amount" }` | Default `deposit_only`; idempotent open checkout |
| `stripe-webhook` | POST | Wolfhouse - Stripe Webhook Handler | Raw Stripe event body (local may use parsed body + `STRIPE_WEBHOOK_SKIP_VERIFY`) | Production: HMAC on raw body; forward via `stripe listen` |
| `stripe-checkout-success` | GET | Wolfhouse - Stripe Checkout Success | `?session_id={CHECKOUT_SESSION_ID}` | HTML thank-you page after Checkout (no DB writes) |

See `docs/PHASE-2b.md` and `n8n/phase2/README.md`.

## Authentication

Current webhooks use n8n **public webhook URLs** (no HMAC in exports). For production:

1. Add header secret validation node (fail closed).
2. WhatsApp: verify Meta signature (`X-Hub-Signature-256`).
3. Stripe: verify `Stripe-Signature`.
4. Apps Script: shared secret header from Script Properties.

## Response expectations

Most operational webhooks do not return guest-facing data; WhatsApp path uses `respondToWebhook` in Main for Meta challenge/ACK — confirm live workflow settings when migrating.
