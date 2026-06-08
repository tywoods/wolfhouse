# Stage 27v — Guest Automation Review (Staff-Only Dry-Run)

**Status:** PASS — local verifier (2026-06-08).  
**Parent:** [STAGE-27U-GUEST-AUTOMATION-ORCHESTRATOR-DRY-RUN.md](STAGE-27U-GUEST-AUTOMATION-ORCHESTRATOR-DRY-RUN.md) · [STAGE-27T-GUEST-AUTOMATION-GATE-DESIGN.md](STAGE-27T-GUEST-AUTOMATION-GATE-DESIGN.md)  
**Endpoint:** `POST /staff/bot/guest-automation-review-dry-run`  
**Verifier:** `npm run verify:stage27v-guest-automation-review`

**Non-negotiables:** Staff/bot auth only · **not public automation** · **not live send** · no DB writes · no holds/payment drafts · no Stripe · no payment links · no WhatsApp · no Meta · no n8n · no confirmation send.

---

## 1. Purpose

Expose Stage **27u** `runGuestAutomationOrchestratorDryRun` through a **staff-only** API so operators can preview:

- Automation **gate** result (27t)
- Full **chain state** (router → availability → quote → payment choice → hold plan)
- **Proposed Luna reply** (draft only — not sent)
- **Handoff reasons**

This is a **review surface**, not public guest WhatsApp wiring.

---

## 2. Auth

Same pattern as other `/staff/bot/*` dry-run routes:

- `requireBotAuth` — staff session or `X-Luna-Bot-Token` when configured
- **No** public webhook route
- **No** Meta/n8n inbound path

---

## 3. Request

`POST /staff/bot/guest-automation-review-dry-run`

```json
{
  "client_slug": "wolfhouse-somo",
  "channel": "whatsapp",
  "message_text": "Hi, we're 2 people June 15–22, Malibu package",
  "guest_phone": "+491726422307",
  "conversation_id": "conv-abc",
  "language_hint": "en",
  "reference_date": "2026-06-08",
  "guest_context": {},
  "automation_gate_context": {
    "public_guest_automation_enabled": false,
    "whatsapp_dry_run": true,
    "bot_paused": false,
    "human_takeover": false
  }
}
```

| Field | Required |
|-------|----------|
| `client_slug` | ✓ |
| `channel` | ✓ |
| `message_text` | ✓ |
| Others | Optional |

Missing required fields → **400** `success: false`.

---

## 4. Response (success)

```json
{
  "success": true,
  "dry_run": true,
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "no_write_performed": true,
  "review": {
    "automation_gate": {
      "gate_status": "allowed_dry_run",
      "gate_reasons": []
    },
    "proposed_next_action": "show_availability_quote",
    "proposed_luna_reply": "Hi! I'm Luna from Wolfhouse 🌊 — …",
    "result": { },
    "availability": { },
    "quote": { },
    "payment_choice": { },
    "hold_payment_draft_plan": null,
    "handoff_reasons": []
  },
  "auth_mode": "open",
  "elapsed_ms": 42
}
```

---

## 5. Errors

| Status | When |
|--------|------|
| **400** | Invalid JSON or missing `client_slug` / `channel` / `message_text` |
| **500** | Unexpected failure — safe message only (`guest automation review dry-run failed`), no stack trace |

---

## 6. Safety

| Limit | Policy |
|-------|--------|
| Public guest automation | **Not wired** |
| WhatsApp send | **Never** |
| DB / booking / hold / payment writes | **Never** |
| Stripe / payment links | **Never** |
| Confirmation send (27r/27s) | **Not invoked** |
| Availability check | Read-only SELECT via shared dry-run path (same as guest-intake) |

---

## 7. Local curl example

```bash
curl -sS -X POST "http://127.0.0.1:3036/staff/bot/guest-automation-review-dry-run" \
  -H "Content-Type: application/json" \
  -d '{"client_slug":"wolfhouse-somo","channel":"dry_run","message_text":"Hi, 2 guests June 15-22 Malibu","reference_date":"2026-06-08","automation_gate_context":{"public_guest_automation_enabled":false}}'
```

With token auth: add `-H "X-Luna-Bot-Token: $LUNA_BOT_INTERNAL_TOKEN"`.

---

## 8. Verifier

```bash
npm run verify:stage27v-guest-automation-review
```

---

## 9. Next step

**Staff Portal review panel** — UI that calls this endpoint and displays `review.*` for operator approval. Optional **27w** allowlisted guest live-send proof only after explicit product GO. This endpoint alone does **not** enable public automation.
