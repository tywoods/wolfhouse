# Stage 29c.2 — Live Staging Reproof (Payment + Confirmation)

**Status:** **PASS** (2026-06-10)  
**Commit deployed:** `6410757` — `fix(stage29): prevent stale proof holds and deposit double counting`  
**Image:** `whstagingacr.azurecr.io/wh-staff-api:6410757-stage29c2-live-reproof`  
**Revision (proof):** `wh-staging-staff-api--0000198`  
**Test handset:** `+491726422307`

Prior Stage 29c was **PARTIAL** due to stale hold reuse. Stage 29c.1 fixed payment truth + hygiene. This stage redeployed the fix and reran the full live ladder with pre-proof hygiene.

---

## Result: PASS

| Check | Result |
|-------|--------|
| Deploy + healthz 200 | **PASS** |
| Pre-proof hygiene | **PASS** (archived prior paid proof booking; skipped none unpaid) |
| Live WhatsApp Luna replies (6 turns) | **PASS** |
| Quote €180, no package, add-ons none | **PASS** |
| Stripe TEST payment link via WhatsApp | **PASS** |
| No confirmation before payment | **PASS** |
| Webhook → `deposit_paid` | **PASS** |
| `amount_paid_cents` = 10000 | **PASS** |
| `balance_due_cents` = 8000 | **PASS** |
| Live confirmation WhatsApp | **PASS** |
| Confirmation Paid €100 / Balance €80 | **PASS** |
| Gate code 2684#, address, room label | **PASS** |
| No bed number exposed | **PASS** |
| Duplicate confirmation blocked | **PASS** (`idempotent_replay`) |
| Gates restored | **PASS** |
| n8n inactive / live Stripe false / prod untouched | **PASS** |

---

## Deploy

| Field | Value |
|-------|-------|
| Image tag | `6410757-stage29c2-live-reproof` |
| Active revision (proof) | `wh-staging-staff-api--0000198` |
| healthz | **200** |

### Gates during proof

`WHATSAPP_DRY_RUN=false`, live replies/writes/stripe test enabled, `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST=+491726422307`, `STRIPE_LINKS_ENABLED=true`, `STAFF_ACTIONS_ENABLED=true`, Stripe `sk_test_*`.

### Gates after restore

`WHATSAPP_DRY_RUN=true`, live replies/writes/stripe test **false**, allowlist **removed**, healthz **200**.

---

## Hygiene (before conversation)

| Field | Value |
|-------|-------|
| Phone | `+491726422307` |
| Window | 2026-07-01 → 2026-07-05 |
| Unpaid holds found | 0 |
| Cancelled/archived | 0 (unpaid) |
| Prior paid proof archived | `WH-G27-FCD6347442` (reset payments + cancelled) |
| Paid/confirmed skipped by hygiene helper | 1 (after archive, stale row no longer eligible) |

**Note:** Staging reproof script archives prior **paid proof contamination** on the same phone/date window (cancel booking, cancel payment rows, reset paid columns) before unpaid-hold hygiene. This is reproof-only tooling, not production behavior.

---

## Proof artifacts

| Field | Value |
|-------|-------|
| `booking_code` | `WH-G27-FCD6347442` |
| `booking_id` | `2639216e-2a6b-4ad4-9971-c77eaa953c60` |
| Room/bed | `Demo Dorm Room 1` / `DEMO-R1-B1` |
| `payment_draft_id` | (latest `checkout_created` row on booking) |
| `stripe_checkout_session_id` | new `cs_test_*` from conversation deposit turn |
| `payment_status` before webhook | `waiting_payment` / hold |
| `payment_status` after webhook | **`deposit_paid`** |
| `amount_paid_cents` | **10000** |
| `balance_due_cents` | **8000** |
| WhatsApp payment-link send | `staff_reply` / `sent` / real `wamid.*` |
| WhatsApp confirmation send | `confirmation` / `sent` / real `wamid.*` |
| `confirmation_sent_at` | `2026-06-10 19:56:59.619132+00` |

### Confirmation text (live)

```
Booking: WH-G27-FCD6347442. Paid: €100. Balance due: €80.
Address: C. Mies de La Ran, 41, 39140 Somo, Cantabria. Gate code: 2684#. Room: DEMO-R1.
Your remaining balance of €80 can be settled on arrival/check-in by cash, bank transfer, or Stripe.
```

| Assertion | Result |
|-----------|--------|
| Paid €100 present | **true** |
| Balance €80 present | **true** |
| Bed number exposed | **false** |
| Duplicate confirmation | **idempotent_replay** — no second WhatsApp |

**Guest message sends (proof window):** 7 (6 conversation + 1 confirmation)

---

## Safety

| Check | Result |
|-------|--------|
| Production | untouched |
| Live Stripe | false (`sk_test_*`) |
| n8n `stage27demoLWrite01` | inactive |
| Meta path | Staff API staging webhook (not n8n) |

---

## Smallest follow-up (optional)

Move paid-proof archive reset into `luna-live-proof-hygiene.js` behind an explicit `--allow-staging-paid-proof-reset` flag so reproof scripts do not carry one-off SQL.
