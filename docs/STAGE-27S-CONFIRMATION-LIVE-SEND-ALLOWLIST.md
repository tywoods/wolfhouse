# Stage 27s — Confirmation Live-Send Allowlist (Staging Proof)

**Status:** PASS — local verifier (2026-06-08).  
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

## 8. Verifier

```bash
npm run verify:stage27s-confirmation-live-send-allowlist
npm run verify:stage27r-confirmation-send-go-no-go
npm run verify:stage27q-confirmation-preview
```

---

## 9. Next slice

Wire guest intake automation only after explicit product approval — not part of 27s.
