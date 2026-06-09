# Stage 27x.1 — Inbound Guest Review Dry-Run

**Status:** IMPLEMENTED (2026-06-08)  
**Parent:** [STAGE-27X-LITE-INBOUND-REVIEW-WIRING-DESIGN.md](STAGE-27X-LITE-INBOUND-REVIEW-WIRING-DESIGN.md) · [STAGE-27V-GUEST-AUTOMATION-REVIEW.md](STAGE-27V-GUEST-AUTOMATION-REVIEW.md) · [STAGE-27U-GUEST-AUTOMATION-ORCHESTRATOR-DRY-RUN.md](STAGE-27U-GUEST-AUTOMATION-ORCHESTRATOR-DRY-RUN.md)  
**Verifier:** `npm run verify:stage27x1-guest-inbound-review`  
**Harness:** `npm run luna:guest-inbound:review`

Staff/bot-only endpoint that accepts an **n8n-shaped inbound WhatsApp guest message payload**, runs the Stage **27u** guest automation orchestrator in review-only mode, and returns a slim review artifact plus `slim_guest_context_for_next_turn` for multi-turn continuity.

**Not in scope (27x.1):** public webhook, Meta/n8n activation, live WhatsApp sends, booking/hold/payment writes, Stripe, confirmation send.

---

## Endpoint

```
POST /staff/bot/guest-inbound-review-dry-run
```

**Auth:** `requireBotAuth` — same pattern as `/staff/bot/guest-automation-review-dry-run` (`X-Luna-Bot-Token` or staff session). **Not a public route.**

---

## Request body

| Field | Required | Notes |
|-------|----------|-------|
| `client_slug` | ✓ | e.g. `wolfhouse-somo` |
| `channel` | ✓ | Expected `whatsapp` for this slice |
| `guest_phone` | ✓ | E.164 thread key |
| `message_text` | ✓ | Normalized inbound text |
| `inbound_message_id` | ✓* | Meta `wamid.*` or harness-generated if omitted |
| `conversation_id` | — | Existing Staff API conversation UUID |
| `idempotency_key` | — | Default `{client_slug}:{channel}:{inbound_message_id}` |
| `received_at` | — | ISO timestamp for audit |
| `reference_date` | — | Harness/staging date override (default from harness: `2026-06-08`) |
| `language_hint` | — | Optional language hint |
| `guest_context` | — | Prior slim chain state (harness chaining); loaded from DB when absent |
| `automation_gate_context` | — | Pause/takeover flags; merged with DB pause state |

\* Harness auto-generates `local-harness-*` / `harness-*` IDs when omitted.

### Example request

```json
{
  "source": "n8n_whatsapp_inbound",
  "client_slug": "wolfhouse-somo",
  "channel": "whatsapp",
  "guest_phone": "+34600999997",
  "message_text": "Hi, we are 2 people interested in the Malibu package",
  "inbound_message_id": "wamid.HBgLM-example",
  "reference_date": "2026-06-08",
  "automation_gate_context": {
    "public_guest_automation_enabled": false,
    "whatsapp_dry_run": true,
    "live_send_allowed": false
  }
}
```

---

## Response

Always review-only safety envelope:

| Flag | Value |
|------|-------|
| `dry_run` | `true` |
| `sends_whatsapp` | `false` |
| `live_send_blocked` | `true` |
| `no_write_performed` | `true` (no booking/hold/payment writes) |
| `public_guest_automation_enabled` | `false` |
| `whatsapp_dry_run` | `true` |

### Example response (abbreviated)

```json
{
  "success": true,
  "dry_run": true,
  "sends_whatsapp": false,
  "live_send_blocked": true,
  "no_write_performed": true,
  "public_guest_automation_enabled": false,
  "whatsapp_dry_run": true,
  "conversation_id": "550e8400-e29b-41d4-a716-446655440000",
  "inbound_message_id": "wamid.HBgLM-example",
  "idempotency_key": "wolfhouse-somo:whatsapp:wamid.HBgLM-example",
  "idempotent_replay": false,
  "review_persistence_performed": true,
  "review": {
    "automation_gate": { "gate_status": "allowed", "gate_reasons": [] },
    "proposed_next_action": "ask_missing_details",
    "proposed_luna_reply": "Great to hear from you! ...",
    "result": { "message_lane": "new_booking_inquiry", "extracted_fields": { "guest_count": 2 } },
    "availability": null,
    "quote": null,
    "payment_choice": null,
    "hold_payment_draft_plan": null,
    "handoff_reasons": []
  },
  "slim_guest_context_for_next_turn": {
    "message_lane": "new_booking_inquiry",
    "extracted_fields": { "guest_count": 2, "package_interest": "malibu" }
  },
  "auth_mode": "bot_token",
  "elapsed_ms": 842
}
```

Duplicate `idempotency_key` returns stored review with `idempotent_replay: true` when conversation persistence succeeds.

---

## Local / staging harness

```bash
# Single message
npm run luna:guest-inbound:review -- --message "Hi, we are 2 people interested in the Malibu package"

# Multi-turn fixtures (chains slim_guest_context_for_next_turn)
npm run luna:guest-inbound:review -- --fixture booking-turn-1 --fixture booking-turn-2 --fixture payment-turn

# Staging (requires LUNA_BOT_INTERNAL_TOKEN)
npm run luna:guest-inbound:review -- \
  --base-url https://staff-staging.lunafrontdesk.com \
  --fixture booking-turn-1 --json
```

**Fixtures:**

| Name | Message |
|------|---------|
| `booking-turn-1` | Hi, we are 2 people interested in the Malibu package |
| `booking-turn-2` | July 10 to July 17 |
| `payment-turn` | Deposit is fine |

Harness is **review-only** — no hold/draft or Stripe routes.

---

## Persistence decision

**Implemented (minimal, existing patterns):**

| Store | Field | Purpose |
|-------|-------|---------|
| `conversations.metadata.luna_guest_context` | JSONB | Slim multi-turn chain state for next inbound |
| `conversations.metadata.luna_inbound_reviews` | JSONB map keyed by `idempotency_key` | Idempotent review artifact cache |
| `conversations.staff_reply_draft` | TEXT | Latest proposed Luna reply (inbox draft surface) |
| `conversations.last_message_preview` | TEXT | Latest inbound preview |

**Deferred:**

| Item | Reason |
|------|--------|
| `messages` inbound row insert | Requires hostel/client message wiring; inbox bubble deferred to 27x.3 |
| Dedicated `luna_review_artifacts` table | No new schema in 27x.1 — metadata map sufficient for dry-run |

When DB is unavailable, endpoint still returns orchestrator review with `review_persistence_performed: false`.

---

## Safety limits

| Action | 27x.1 |
|--------|-------|
| Live WhatsApp send | ❌ |
| Public webhook route | ❌ |
| Meta Graph / n8n outbound | ❌ |
| Booking / hold / payment draft write | ❌ |
| Stripe link create | ❌ |
| Confirmation send | ❌ |
| Orchestrator dry-run (27u) | ✓ |
| Conversation review artifact persistence | ✓ (allowed) |

Orchestrator always receives:

```javascript
{
  dry_run: true,
  automation_gate_context: {
    public_guest_automation_enabled: false,
    whatsapp_dry_run: true,
    live_send_allowed: false,
    // + bot_paused / human_takeover from DB when available
  }
}
```

---

## Runtime files

| File | Role |
|------|------|
| `scripts/lib/luna-guest-inbound-review-dry-run.js` | Validation, idempotency, persistence, orchestrator call |
| `scripts/staff-query-api.js` | Route + `handleBotGuestInboundReviewDryRun` |
| `scripts/run-guest-inbound-review-dry-run.js` | CLI harness |

**Next:** 27x.2 — n8n pipe wiring (disabled/dry-run mode, still no live send).
