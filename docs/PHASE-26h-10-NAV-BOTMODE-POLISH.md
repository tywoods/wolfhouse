# Phase 26h.10 — Navigation labels + bot mode pebble refresh

Final UI polish before staging sign-off (on top of 26h.8 + 26h.9).

## Navigation labels

Staff Portal main nav visible labels:

| Before | After |
|--------|-------|
| Inbox | **WhatsApp** |
| Command Center | **Luna Staff** |

Internal tab ids/routes unchanged (`conversations`, `ask-luna`). Functionality unchanged.

## Conversation / Handoff bot mode pebble

Overview drawer **Conversation / Handoff** card shows Luna vs Staff pebble from current pause state:

- Luna active → blue **Luna** pebble (`pill-luna`)
- Luna paused → green **Staff** pebble (`pill-staff-source`)

Pause/Resume Luna in WhatsApp (Inbox) detail now calls `bcUpdateDrawerConvBotModePebble()` to refresh the open booking drawer in place. Active drawer tab is preserved.

`isLunaGuestAutomationPaused()` also honors `luna_paused` from booking context API.

## Safety

- No live WhatsApp sends (`WHATSAPP_DRY_RUN=true` on staging)
- No Meta webhook / n8n / payment / Stripe changes in this patch

## Staging deploy

Deployed with `STAFF_ACTIONS_ENABLED=true`, `STRIPE_LINKS_ENABLED=true`, `WHATSAPP_DRY_RUN=true`.
