# Stage 27s — Confirmation Live-Send Allowlist (Staging Proof)

**Status:** PASS — local verifier (2026-06-08) · **hosted proof PASS (Stage 27s.1, 2026-06-08)**.  
**Parent:** [STAGE-27R-CONFIRMATION-SEND-GO-NO-GO.md](STAGE-27R-CONFIRMATION-SEND-GO-NO-GO.md) · [STAGE-27Q-CONFIRMATION-PREVIEW.md](STAGE-27Q-CONFIRMATION-PREVIEW.md)  
**Module:** `scripts/lib/luna-guest-confirmation-live-send-allowlist.js` (wired in 27r go/no-go)  
**Verifier:** `npm run verify:stage27s-confirmation-live-send-allowlist`

**Non-negotiables:** Staging only · **one allowlisted test phone** · explicit `confirm_send:true` · 27q message unchanged · no public guest automation · no n8n/Meta production · no Stripe/payment/booking truth writes.

---

## 1. Purpose

Stage **27r** gates confirmation send behind `confirm_send` and defaults to `WHATSAPP_DRY_RUN=true`. Stage **27s** adds a **hard recipient allowlist** so that when dry-run is disabled for staging proof, **only explicit test numbers** can receive a live WhatsApp confirmation.

---

## 2. Environment

| Variable | Staging proof value | Notes |
|----------|---------------------|-------|
| `WHATSAPP_DRY_RUN` | `false` (proof only) | Restore `true` after proof |
| `LUNA_AUTO_SEND_ENABLED` | `true` | Required for send route |
| `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` | `+491726422307` | Comma/space separated E.164 numbers |
| `WHATSAPP_CLOUD_ACCESS_TOKEN` | staging token | Existing staging-safe creds |
| `WHATSAPP_PHONE_NUMBER_ID` | staging phone id | Existing staging-safe creds |

---

## 3. Allowlist behavior

| Condition | Result |
|-----------|--------|
| `WHATSAPP_DRY_RUN=true` | Live allowlist skipped; dry-run audit (`blocked_dry_run`) |
| `WHATSAPP_DRY_RUN=false` + recipient **not** on allowlist | `send_status: recipient_not_allowlisted`, `live_send_blocked: true` |
| `WHATSAPP_DRY_RUN=false` + allowlist empty | Blocked (`live_send_allowlist_not_configured`) |
| `WHATSAPP_DRY_RUN=false` + allowlisted + `confirm_send:true` + 27q ready | Proceeds to existing WhatsApp provider path |

Phone matching normalizes to digits only (`+491726422307` → `491726422307`).

---

## 4. API

Same entry as 27r (allowlist enforced inside):

```js
await runGuestConfirmationSendGoNoGo(input, context)
// alias:
await runGuestConfirmationLiveSendAllowlisted(input, context)
```

Prerequisites unchanged: full **27q** `confirmation_preview_result`, `confirm_send: true`, `to`, `idempotency_key`.

---

## 5. Output (blocked non-allowlisted)

```json
{
  "send_attempted": true,
  "send_status": "recipient_not_allowlisted",
  "live_send_blocked": true,
  "sends_whatsapp": false,
  "live_send_allowlist_checked": true,
  "recipient_allowlisted": false,
  "next_safe_step": "awaiting_confirmation_send_go_no_go"
}
```

---

## 6. Safety

- **Fail closed** — empty allowlist blocks all live sends
- **No message regeneration** — injected 27q preview loader only
- **No Stripe / payment truth writes**
- **No booking status writes** from this slice (confirmation_sent_at only on successful live send via 20j path)
- **No n8n / Meta webhook production activation**

---

## 7. Hosted proof steps

1. Deploy **staging** only (if requested).
2. Set env:
   - `WHATSAPP_DRY_RUN=false`
   - `LUNA_AUTO_SEND_ENABLED=true`
   - `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST=+491726422307`
3. Confirm WhatsApp Cloud credentials are staging-safe.
4. Run **27q** → `confirmation_preview_ready: true`.
5. Call go/no-go with `confirm_send: false` → **no send**.
6. Call with **non-allowlisted** `to` → `recipient_not_allowlisted`.
7. Call with **allowlisted** test phone → **one live WhatsApp confirmation** (27q text).
8. Confirm no Stripe/payment truth writes.
9. **Restore:** `WHATSAPP_DRY_RUN=true`.
10. `GET /healthz` → 200.

---

## 9. Hosted proof — Stage 27s.1 (2026-06-08)

**Commit:** `b23f446` — confirmation live-send allowlist  
**Image:** `whstagingacr.azurecr.io/wh-staff-api:b23f446-stage27s1-live-send-allowlist` (ACR build `cb67`)  
**Proof revision:** `wh-staging-staff-api--stage27s1-live-send`  
**Restore revision:** `wh-staging-staff-api--stage27s1-restore-dryrun`  
**Host:** `https://staff-staging.lunafrontdesk.com` · `/healthz` **200** before and after

### Test booking

| Field | Value |
|-------|--------|
| `booking_code` | `MB-WOLFHO-20260924-e90132` |
| `booking_id` | `828538c7-c6cb-4c6f-b45a-57a641af37cc` |
| `payment_status` | `paid` |

### Env during proof

| Variable | Value |
|----------|--------|
| `WHATSAPP_DRY_RUN` | `false` |
| `LUNA_AUTO_SEND_ENABLED` | `true` |
| `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` | `+491726422307` |
| WhatsApp creds | staging secret refs (`meta-whatsapp-token`, `meta-whatsapp-phone-id`) |

Restored after proof: `WHATSAPP_DRY_RUN=true`, allowlist env removed.

### Proof steps and results

| Step | Input | Expected | Result |
|------|--------|----------|--------|
| 27q preview | ready paid booking | `confirmation_preview_ready: true`, gate `2684#` | **PASS** · `next_safe_step: ready_for_confirmation_send_go_no_go` |
| Not approved | `confirm_send: false` | `not_approved`, no send | **PASS** |
| Non-allowlisted | `to: +34600000099` | `recipient_not_allowlisted`, no send | **PASS** |
| Allowlisted live | `to: +491726422307`, `confirm_send: true` | one live WhatsApp | **PASS** · `send_status: sent` |

**Live send details:**

- `whatsapp_message_id`: `wamid.HBgMNDkxNzI2NDIyMzA3FQIAERgSNzQ5NzQwRUI2MDRENTE5NDZGAA==`
- Message **byte-identical** to 27q `proposed_confirmation_message`
- `preview_regenerated: false`
- `guest_message_sends`: exactly **one** confirmation row (`send_kind: confirmation`, `to_phone: +491726422307`)

**Post-restore check:** subsequent send with `WHATSAPP_DRY_RUN=true` → `blocked_dry_run` (no live WhatsApp).

### Safety (hosted)

- Payment rows **unchanged**
- Booking status **unchanged**
- `confirmation_sent_at` **unchanged** (prior send; not updated this run)
- **No Stripe writes**
- **No public guest loop**
- **No n8n / Meta production activation**
- Exactly **one** live confirmation to allowlisted test phone
- `WHATSAPP_DRY_RUN` **restored to `true`**

### Local verifiers at proof time

- `verify:stage27s-confirmation-live-send-allowlist` — **24/24**
- `verify:stage27r-confirmation-send-go-no-go` — **44/44**
- `verify:stage27q-confirmation-preview` — **52/52**

---

## 10. Verifier

```bash
npm run verify:stage27s-confirmation-live-send-allowlist
npm run verify:stage27r-confirmation-send-go-no-go
npm run verify:stage27q-confirmation-preview
npm run verify:stage27s1-hosted-proof-doc
```

---

## 11. Next slice

Wire guest intake automation only after explicit product approval — not part of 27s.
