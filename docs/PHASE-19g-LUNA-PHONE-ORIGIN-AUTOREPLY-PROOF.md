# Phase 19g — Luna phone-origin auto-reply proof (closeout)

**Status:** PASS (hosted staging, phone-origin)  
**Proof slice:** 19g.12-retry  
**Image:** `d2f4dae-stage19g11a-ui-fix` (`d2f4dae` — UI reset fix + prior reset route)  
**Date:** 2026-06-06

## Summary

The full real loop from Ty's WhatsApp to Luna's automatic reply is proven on staging:

**Ty phone → Wolfhouse WhatsApp → Meta → Staff API webhook → Luna draft → send gate → WhatsApp reply → Ty phone**

Prior slices (19g.8–19g.11) proved Meta-shaped POST and controlled auto-send. **19g.12-retry** is the first proof where Meta delivered a real inbound `wamid.*` from physical WhatsApp send, Luna auto-replied once, replay blocked duplicate send, and a risky refund message did not send.

## Staging revisions

| Role | Revision |
|------|----------|
| Proof (live gates) | `wh-staging-staff-api--stage19g12-retry-proof` |
| Restored (safe) | `wh-staging-staff-api--stage19g12-retry-safe` |

## Proof env gates (proof revision only)

All of the following were set on the proof revision only:

| Env | Proof value |
|-----|-------------|
| `LUNA_AUTO_SEND_ENABLED` | `true` |
| `WHATSAPP_DRY_RUN` | `false` |
| `WHATSAPP_LIVE_SENDS_ENABLED` | `true` |
| `LUNA_GUEST_LIVE_SEND_OWNER_APPROVED` | `true` |
| `WHATSAPP_CLOUD_ACCESS_TOKEN` | Key Vault secret ref `meta-whatsapp-token` |
| `WHATSAPP_PHONE_NUMBER_ID` | Key Vault secret ref `meta-whatsapp-phone-id` |

## Safe restored env (active after proof)

| Env | Restored value |
|-----|----------------|
| `WHATSAPP_DRY_RUN` | `true` |
| `LUNA_AUTO_SEND_ENABLED` | unset |
| `WHATSAPP_LIVE_SENDS_ENABLED` | unset |
| `LUNA_GUEST_LIVE_SEND_OWNER_APPROVED` | unset |
| `WHATSAPP_CLOUD_ACCESS_TOKEN` | unset (removed from active revision) |
| `WHATSAPP_PHONE_NUMBER_ID` | unset (removed from active revision) |

Meta webhook callback remained on Staff API (`GET /staff/meta/whatsapp/webhook` hub challenge verified).

## Pre-proof reset (19g.11a)

Before each test cycle, reset test phone rows via Staff Portal **Reset test phone** or:

```http
POST /staff/test/reset-luna-phone
{
  "client_slug": "wolfhouse-somo",
  "phone": "491726422307"
}
```

Deletes only `guest_message_events` and `guest_message_sends` for that client/phone. Does not delete bookings, payments, or conversations.

## Live Case A — phone-origin partial IT auto-reply

**From:** `+491726422307`  
**To:** Wolfhouse `+34 663 43 94 19`  
**Message sent:**

> Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?

### Inbound (Meta → Staff API)

| Field | Value |
|-------|--------|
| Inbound `wa_message_id` | `wamid.HBgMNDkxNzI2NDIyMzA3FQIAEhgWM0VCMEIzQzcwNjRBRjJFOUU2MjdGOQA=` |
| `from_phone` | `491726422307` |
| `draft_called` | `true` |
| `next_action` | `ask_missing_field` |
| `send_attempted` | `true` |
| `send_status` | `sent` |

### Luna reply (outbound)

| Field | Value |
|-------|--------|
| Reply text | `Quali date di check-in e check-out avete in mente?` |
| Outbound `provider_message_id` | `wamid.HBgMNDkxNzI2NDIyMzA3FQIAERgSRTk2QzdBMTZEQUM0QTNGREMwAA==` |
| Idempotency key sent rows | **1** |

Durable proof tables: `guest_message_events` (inbound + decision) and `guest_message_sends` (outbound send row with `status=sent`).

Staff Portal Message Events panel showed matching row (`next_action`, `send_status`, blocked reasons empty).

## Replay / idempotency (Case A)

Re-posted the exact `raw_payload` for Case A `wa_message_id` to `POST /staff/meta/whatsapp/webhook`.

| Check | Result |
|-------|--------|
| `duplicate` | `true` |
| `idempotent_replay` | `true` |
| Second `guest_message_sends` sent row | **none** |
| Sent row count for idempotency key | **1** (unchanged) |
| Second Graph API outbound | **none** |
| Second WhatsApp reply to guest | **none** |

## Safety Case B — phone-origin risky no-send

**Message sent:**

> I want a refund and need to talk to someone.

| Field | Value |
|-------|--------|
| Inbound `wa_message_id` | `wamid.HBgMNDkxNzI2NDIyMzA3FQIAEhgWM0VCMDUyODUwMzMxQzA2QkIzQzk3OQA=` |
| `next_action` | `handoff_to_staff` |
| `handoff_required` | `true` |
| `send_attempted` | `false` |
| `guest_message_sends` sent row | **none** |

## Safety proof (19g.12-retry)

| Check | Result |
|-------|--------|
| Bookings created | none |
| Payments created | none |
| Stripe called | no |
| n8n activation/deactivation | no |
| Outbound sends | exactly **one** (Case A only) |
| Env reverted after proof | yes |

## Prior debug note (19g.12-debug)

First phone send while safe revision was active (`WHATSAPP_DRY_RUN=true`, auto-send unset) correctly persisted inbound but blocked send with `luna_auto_send_not_enabled` / `auto_send_not_ready`. Retry with proof gates active before send succeeded.

## Related phases

| Phase | What it proved |
|-------|----------------|
| 19g.8 | Meta webhook + inbound persistence |
| 19g.9 | Message events read API |
| 19g.10 | Message Events Staff Portal panel |
| 19g.11a | Staging test phone reset route + UI |
| 19g.11 | Controlled auto-send (Meta-shaped POST) |
| **19g.12-retry** | **Phone-origin auto-reply (this closeout)** |

## Verifier

```bash
npm run verify:luna-agent-phase19-phone-origin-autoreply-closeout
```

## Recommended Phase 20

Move from staging proof to production auto-send gate policy: document owner-approved production gate matrix, monitoring for `guest_message_events` / `guest_message_sends`, and optional production cutover checklist — without enabling live guest sends until explicitly approved.
