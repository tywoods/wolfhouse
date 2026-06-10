# Stage 29c — Live Staging Payment + Confirmation Proof

**Status:** **PARTIAL PASS** (2026-06-10)  
**Commit deployed:** `0fc24e1` — `test(stage29): prove confirmation send go/no-go`  
**Image:** `whstagingacr.azurecr.io/wh-staff-api:0fc24e1-stage29c-live-proof`  
**Revision (proof window):** `wh-staging-staff-api--0000195`  
**Revision (after restore):** `wh-staging-staff-api--0000197`  
**Test handset:** `+491726422307` (allowlisted; demoted from staff/owner for proof)

---

## Result summary

| Area | Result |
|------|--------|
| Deploy + healthz | **PASS** |
| Live WhatsApp Luna replies | **PASS** (6 outbound `staff_reply`, real `wamid.*`) |
| Quote €180 / deposit hold | **PASS** |
| Stripe TEST payment link via WhatsApp | **PASS** |
| No confirmation before payment | **PASS** |
| Stripe TEST webhook payment truth | **PASS** (payment draft `paid`; webhook 200) |
| `deposit_paid` + `amount_paid_cents=10000` | **FAIL** — reused booking accumulated two deposits → `paid`, `18000` |
| Live confirmation WhatsApp | **PASS** (allowlisted send) |
| Confirmation idempotency | **PASS** (`idempotent_replay` on duplicate) |
| Safety (prod / live Stripe / n8n) | **PASS** |
| Gates restored | **PASS** |

**Overall: PARTIAL** — full live ladder exercised; payment/confirmation amounts wrong due to stale booking reuse on same phone + dates.

---

## Deploy

- ACR build + `az containerapp update` to staging Staff API only.
- `/healthz` → **200**, revision **Healthy**, 100% traffic.
- Stripe key confirmed **`sk_test_*`** (Key Vault).
- Production untouched; n8n workflow `stage27demoLWrite01` **inactive**.

### Gates during proof window

| Gate | Value |
|------|-------|
| `WHATSAPP_DRY_RUN` | `false` |
| `OPEN_DEMO_WHATSAPP_ENABLED` | `true` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `true` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `true` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `true` |
| `STRIPE_LINKS_ENABLED` | `true` |
| `STAFF_ACTIONS_ENABLED` | `true` |
| `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` | `+491726422307` |
| `WHATSAPP_PHONE_NUMBER_ID` | `1152900101233109` (staging demo) |

### Gates after restore

| Gate | Value |
|------|-------|
| `WHATSAPP_DRY_RUN` | `true` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `false` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `false` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `false` |
| `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` | **removed** |
| `STRIPE_LINKS_ENABLED` | `true` (unchanged baseline) |

---

## Live test script

Inbound: signed POST to `https://staff-staging.lunafrontdesk.com/staff/meta/whatsapp/webhook` (Staff API — **not** n8n).  
Outbound: **real WhatsApp** to allowlisted handset.

| Turn | Guest message | Notes |
|------|---------------|-------|
| 1 | hi | Luna intro |
| 2 | book a stay | intake |
| 3 | July 1-5 | dates |
| 4 | 1 | guest count |
| 5 | no thanks, i have my own stuff | add-ons declined; **extra** room-preference question inserted |
| 6 | deposit | hold + Stripe TEST link sent |

---

## Proof artifacts

| Field | Value |
|-------|-------|
| `booking_code` | `WH-G27-FCD6347442` |
| `booking_id` | `2639216e-2a6b-4ad4-9971-c77eaa953c60` |
| Check-in / check-out | 2026-07-01 → 2026-07-05 |
| Assigned bed | `DEMO-R1-B1` / room `Demo Dorm Room 1` |
| `payment_draft_id` (this session) | `a7afd5d1-3b52-4c81-bbf6-ac8120301de0` |
| `stripe_checkout_session_id` | `cs_test_a1aRUr3eWj6J3WqC2O8VQRFXSYasTItKk9aNxr9Bv4bGyKIMDIiKqgEWAq` |
| Stripe mode | **test** |
| `payment_status` before pay | `waiting_payment` (stale `amount_paid_cents=10000` from prior run) |
| `payment_status` after webhook | `paid` (expected `deposit_paid`) |
| `amount_paid_cents` after webhook | `18000` (expected `10000`) |
| `balance_due_cents` after webhook | `0` (expected `8000`) |

### WhatsApp sends (this session)

| Kind | Status | Provider ID | Excerpt |
|------|--------|-------------|---------|
| Payment link (`staff_reply`) | `sent` | `wamid.…QkFCAA==` | €100 deposit + `checkout.stripe.com/...cs_test_a1aRUr3e...` |
| Confirmation (`confirmation`) | `sent` | `wamid.…NDc4NDU5AA==` | Booking code, address, gate `2684#`, room `DEMO-R1` |
| Duplicate confirmation attempt | `idempotent_replay` | same wamid | no second send |

`guest_message_sends` for proof window: **7** (6 conversation + 1 confirmation).

### Confirmation message (live)

```
Hi Stage29c Guest ☀️ Payment received — your Wolfhouse booking is confirmed!
Booking: WH-G27-FCD6347442. Paid: €180.
Address: C. Mies de La Ran, 41, 39140 Somo, Cantabria. Gate code: 2684#.
Room: DEMO-R1.
```

- Booking code: **yes**
- Gate code `2684#`: **yes**
- Address: **yes**
- Room label: **yes** (`DEMO-R1` — code not human room number)
- No bed number: **yes**
- Paid €100 / balance €80: **no** (showed €180 paid — double-deposit artifact)

`confirmation_sent_at`: `2026-06-10 19:30:16.983691+00`

---

## Safety checks

| Check | Result |
|-------|--------|
| Production deploy | none |
| Live Stripe | false (`sk_test_*` only) |
| n8n active | false (`stage27demoLWrite01`) |
| Meta callback path | Staff API staging webhook |
| Allowlist required for confirmation | yes |
| Duplicate confirmation blocked | yes (`idempotent_replay`) |

---

## Failures / deviations

1. **Booking reuse** — same phone + July 1–5 matched an existing hold from earlier staging runs (created `2026-06-10 11:43 UTC`). A second deposit payment draft was added; webhook double-counted → `paid` / €180 instead of `deposit_paid` / €100 + €80 balance.
2. **Extra intake turn** — after declining add-ons, Luna asked room preference before deposit (brain path variance vs local fixtures).
3. **Confirmation not auto-sent on webhook** — expected; live send exercised via `runGuestConfirmationLiveSendAllowlisted` (Stage 27r path), same as 29b.4 ladder.

---

## Smallest next patch (recommended)

1. **Pre-proof hygiene:** cancel or archive prior `hold` bookings for allowlisted phone + date window (Stage 28h6 fresh-start pattern) before live E2E.
2. **Payment truth on reused booking:** when applying deposit webhook, set `deposit_paid` + correct balance if total paid < booking total (do not jump to `paid` on second deposit unless full amount).
3. **Optional:** wire confirmation auto-send after webhook when allowlist + gates permit (separate stage; not required for 29c closeout).

---

## Commands used (temp orchestrator — not committed)

```bash
node .tmp-stage29c-hosted-proof.js deploy
node .tmp-stage29c-hosted-proof.js preflight
node .tmp-stage29c-hosted-proof.js conversation
node .tmp-stage29c-hosted-proof.js pay
node .tmp-stage29c-hosted-proof.js confirm
node .tmp-stage29c-hosted-proof.js restore
```
