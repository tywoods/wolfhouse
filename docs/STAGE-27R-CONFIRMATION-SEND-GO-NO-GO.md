# Stage 27r — Confirmation Send Go/No-Go (No Automatic Send)

**Status:** PASS — local verifier (2026-06-08).  
**Parent:** [STAGE-27Q-CONFIRMATION-PREVIEW.md](STAGE-27Q-CONFIRMATION-PREVIEW.md) · [STAGE-27P-STRIPE-PAYMENT-TRUTH.md](STAGE-27P-STRIPE-PAYMENT-TRUTH.md)  
**Module:** `scripts/lib/luna-guest-confirmation-send-go-no-go.js`  
**Verifier:** `npm run verify:stage27r-confirmation-send-go-no-go`

**Non-negotiables:** Explicit `confirm_send:true` required · **no automatic send** · respects `WHATSAPP_DRY_RUN` · reuses 27q message · no Stripe · no payment truth writes · no Meta/n8n activation.

---

## 1. Purpose

Stage **27q** produces `proposed_confirmation_message` for staff review (`confirmation_send_allowed: false`). Stage **27r** adds the explicit **go/no-go** layer: send only when the caller passes `confirm_send: true` and the 27q preview is send-ready.

This is a **working staging feature**, not shadow mode — but live WhatsApp remains blocked while `WHATSAPP_DRY_RUN=true`.

---

## 2. Prerequisite — Stage 27q

| 27q output | 27r requirement |
|------------|-----------------|
| `confirmation_preview_ready: true` | Required to attempt send |
| `proposed_confirmation_message` | Passed through unchanged |
| `next_safe_step: ready_for_confirmation_send_go_no_go` | Send may be evaluated |
| `confirmation_send_allowed: false` | Expected — 27r still requires `confirm_send` |

---

## 3. Reused send path

Delegates to **`sendLunaBookingConfirmation`** (Phase **20j**) with an **injected preview loader** that returns the 27q message — **no regeneration** via `getLunaBookingConfirmationPreview` DB path.

Downstream: `evaluateGuestReplySendRouteWithPause` → `sendLunaWhatsAppMessage` (respects env gates + pause).

Route anchor: `POST /staff/bot/bookings/send-confirmation`

---

## 4. API

```js
await runGuestConfirmationSendGoNoGo(input, context)
```

### Input

| Field | Required | Notes |
|-------|----------|-------|
| `confirmation_preview_result` | ✓ | Full 27q output object |
| `confirm_send` | ✓ must be `true` to send | Default blocked |
| `to` | ✓ when sending | Guest WhatsApp phone |
| `idempotency_key` | ✓ when sending | Guest message send idempotency |
| `client_slug` / `booking_id` / `booking_code` | optional | Override routing context |

### Context

| Field | Notes |
|-------|-------|
| `env` | Must include `WHATSAPP_DRY_RUN=true` for staging |
| `pg` | Postgres client for send audit rows |
| `sendLunaBookingConfirmation` | Injectable for tests |

---

## 5. Behavior matrix

| Condition | `send_attempted` | `send_status` | WhatsApp |
|-----------|------------------|---------------|----------|
| `confirm_send !== true` | `false` | `not_approved` | No |
| 27q not ready | `false` | `not_ready` | No |
| Staff review / handoff | `false` | `staff_review_required` | No |
| Bed-number leak in message | `false` | `staff_review_required` | No |
| Ready + `confirm_send` + `WHATSAPP_DRY_RUN=true` | `true` | `blocked_dry_run` | No (audit only) |
| Ready + `confirm_send` + live gates pass | `true` | `sent` | Yes* |

\*Live send requires explicit env approval (`WHATSAPP_DRY_RUN=false` + provider config). **Staging default: dry-run only.**

---

## 6. Output

```json
{
  "success": true,
  "send_attempted": true,
  "send_status": "blocked_dry_run",
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "preview_regenerated": false,
  "proposed_confirmation_message": "... from 27q ...",
  "next_safe_step": "confirmation_send_audit_only",
  "whatsapp_dry_run": true,
  "payment_truth_mutated": false
}
```

Blocked without approval:

```json
{
  "send_attempted": false,
  "send_status": "not_approved",
  "next_safe_step": "awaiting_confirmation_send_go_no_go"
}
```

---

## 7. Safety

- **No automatic send** — `confirm_send` must be explicitly `true`
- **No message regeneration** — injected 27q preview loader only
- **No Stripe** — send path does not create checkout sessions
- **No payment truth mutation** — does not update payment paid status
- **No Meta/n8n activation** — uses existing gated WhatsApp provider only
- **`WHATSAPP_DRY_RUN=true`** — provider returns `whatsapp_dry_run_active`, no Graph API live send

---

## 8. Hosted proof steps (staging)

Prerequisites: staging deploy (if requested), `WHATSAPP_DRY_RUN=true`, payment truth + 27q preview ready.

1. **Health:** `GET /healthz` → 200
2. **Preview:** Run 27q → `confirmation_preview_ready: true`, copy `proposed_confirmation_message`
3. **Go/no-go blocked:** Call 27r with `confirm_send: false` → `send_status: not_approved`, no WhatsApp
4. **Go/no-go dry-run:** Call 27r with `confirm_send: true` → `send_status: blocked_dry_run`, `sends_whatsapp: false`
5. **Verify:** No live WhatsApp delivery; no Stripe/payment writes; optional `guest_message_sends` audit row only

---

## 9. Next slice

Explicit **live send approval** workflow (owner sign-off, `WHATSAPP_DRY_RUN=false`) — separate from 27r; not wired to public guest automation.

---

## 10. Verifier

```bash
npm run verify:stage27r-confirmation-send-go-no-go
npm run verify:stage27q-confirmation-preview
```
