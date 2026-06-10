# Stage 30d — Live Staging Luna Personality Reproof

**Status:** **PASS** (2026-06-10)  
**Commit deployed:** `0c15364` — `feat(stage30): apply Luna style to confirmation copy`  
**Image:** `whstagingacr.azurecr.io/wh-staff-api:0c15364-stage30d-live-reproof`  
**Revision (proof window):** `wh-staging-staff-api--0000201`  
**Revision (after restore):** `wh-staging-staff-api--0000203`  
**Test handset:** `+491726422307` (allowlisted; demoted from staff/owner for proof)

---

## Result summary

| Area | Result |
|------|--------|
| Deploy + healthz 200 | **PASS** |
| Pre-proof hygiene (paid reset) | **PASS** |
| Live WhatsApp Luna replies (6 turns) | **PASS** — warm, natural, no forbidden/internal language |
| Quote €180 / no package / add-ons none | **PASS** |
| Stripe TEST payment link via WhatsApp | **PASS** |
| No confirmation before payment | **PASS** |
| Stripe TEST webhook → `deposit_paid` | **PASS** |
| `amount_paid_cents` = 10000 | **PASS** |
| `balance_due_cents` = 8000 | **PASS** |
| Live confirmation WhatsApp | **PASS** (allowlisted send) |
| Confirmation Paid €100 / Balance €80 | **PASS** |
| Gate code 2684#, address, room label | **PASS** |
| No bed number exposed | **PASS** |
| Style contract on confirmation | **PASS** |
| Duplicate confirmation blocked | **PASS** (`idempotent_replay`) |
| Gates restored | **PASS** |
| Safety (prod / live Stripe / n8n) | **PASS** |
| Post-restore verifiers + fixtures | **PASS** |

**Overall: PASS** — full live ladder with Stage 30a–30c Luna personality copy validated on-device.

---

## Deploy

| Field | Value |
|-------|-------|
| Image tag | `0c15364-stage30d-live-reproof` |
| Active revision (proof) | `wh-staging-staff-api--0000201` |
| Active revision (restored) | `wh-staging-staff-api--0000203` |
| healthz (proof + restore) | **200** |

### Gates before proof

Staging was on prior revision; deploy rolled `0c15364` and opened live proof gates.

### Gates during proof

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
| Stripe key | `sk_test_*` (Key Vault) |

### Gates after restore

| Gate | Value |
|------|-------|
| `WHATSAPP_DRY_RUN` | `true` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `false` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `false` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `false` |
| `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` | **removed** |
| healthz | **200** |

---

## Hygiene (before conversation)

| Field | Value |
|-------|-------|
| Phone | `+491726422307` |
| Window | 2026-07-01 → 2026-07-05 |
| `allow_hygiene` | `true` |
| `allow_staging_paid_proof_reset` | `true` |
| Unpaid holds found | 0 |
| Prior paid proof archived | `WH-G27-FCD6347442` (1 booking reset via hygiene helper) |
| Real customer bookings | refused (not touched) |

---

## Live WhatsApp transcript

| Turn | Guest | Luna (exact) | Copy quality |
|------|-------|--------------|--------------|
| 1 | hi | Hey! I'm Luna from Wolfhouse 🌊 Are you looking to book a stay, or just checking some info? | Natural ✓ · one question ✓ · no forbidden terms ✓ |
| 2 | book a stay | Nice! What dates are you thinking for check-in and check-out? | Natural ✓ · one question ✓ |
| 3 | July 1-5 | Perfect — July 1 to July 5. How many guests will be staying? | Natural ✓ · preserves dates ✓ |
| 4 | 1 | Great — I'll check accommodation for July 1 to July 5 for 1 guest. Good news — we have space for those dates. Accommodation comes to €180. Are you going to need a wetsuit, surfboard, and/or lessons, or just the stay? | Natural ✓ · €180 quote ✓ · no package prompt ✓ · dates repeated once (minor) |
| 5 | no thanks, i have my own stuff | Perfect — accommodation only then 😊 To hold the spot, would you prefer to pay the €100 deposit now, or pay the full €180? | Natural ✓ · add-ons accepted as none ✓ · deposit choice clear ✓ |
| 6 | deposit | Perfect — I've held your stay. You can pay the €100 deposit here: `https://checkout.stripe.com/c/pay/cs_test_a1paKMwSMdwq0wdUDERzmu97k1duZMfu4bVfUCzeOq15mSrDP0NUOwqQfM…` Once that's paid, your booking will be confirmed. | Natural ✓ · Stripe TEST link sent ✓ · no confirmation yet ✓ |
| — | *(Stripe TEST paid)* | Hi Stage30d Guest ☀️ Payment received — your Wolfhouse booking is confirmed! Booking: WH-G27-FCD6347442. Paid: €100. Balance due: €80. Address: C. Mies de La Ran, 41, 39140 Somo, Cantabria. Gate code: 2684#. Room: DEMO-R1. Your remaining balance of €80 can be settled on arrival/check-in by cash, bank transfer, or Stripe. | Style contract ✓ · grounded facts ✓ · no internal language ✓ |

All turns: **no forbidden/internal language** (dry run, staging, quote_status, orchestrator, preview ready, etc.).

---

## Proof artifacts

| Field | Value |
|-------|-------|
| `booking_code` | `WH-G27-FCD6347442` |
| `booking_id` | `2639216e-2a6b-4ad4-9971-c77eaa953c60` |
| Room / bed (internal) | Demo Dorm Room 1 / `DEMO-R1-B1` |
| Room label (guest copy) | `DEMO-R1` |
| `payment_draft_id` | `3a28596c-d817-47be-bcaf-342de336fd1d` |
| `stripe_checkout_session_id` | `cs_test_a1paKMwSMdwq0wdUDERzmu97k1duZMfu4bVfUCzeOq15mSrDP0NUOwqQfM` |
| Payment link WhatsApp | `staff_reply` / `sent` / `wamid.HBgMNDkxNzI2NDIyMzA3FQIAERgSREJEMjlBQzc5NTVBNzJBRDYwAA==` |
| `payment_status` after webhook | **`deposit_paid`** |
| `amount_paid_cents` | **10000** |
| `balance_due_cents` | **8000** |
| Confirmation WhatsApp | `confirmation` / `sent` / `wamid.HBgMNDkxNzI2NDIyMzA3FQIAERgSNzVBMkIyMjU2NzFCRjk4QTZCAA==` |
| `confirmation_sent_at` | `2026-06-10 20:22:12.256374+00` |
| Duplicate confirmation | **idempotent_replay** — no second WhatsApp |

| Assertion | Result |
|-----------|--------|
| Paid €100 present | **true** |
| Balance €80 present | **true** |
| Bed number exposed | **false** |
| Gate code 2684# | **true** |

---

## Safety

| Check | Result |
|-------|--------|
| Production | untouched |
| Live Stripe | false (`sk_test_*`) |
| n8n `stage27demoLWrite01` | **inactive** |
| Meta path | Staff API staging webhook (not n8n) |
| Gates restored | **PASS** |

---

## Post-restore verification

| Suite | Result |
|-------|--------|
| `verify:stage30c-confirmation-copy-style` | 42/42 PASS |
| `verify:stage30b-composer-side-question-coverage` | 36/36 PASS |
| `verify:stage30a-smart-reply-composer-personality` | 59/59 PASS |
| `test:luna-conversations --all` | 4/4 PASS |
| `luna:guest-flow-batch --local --fixture-set booking-core` | 26/26 PASS |

---

## Copy notes (optional 30d.1)

Turn 4 repeats the date window twice (“July 1 to July 5” in opener and quote line). Acceptable for proof; smallest follow-up would trim the lead-in on live staging when quote is already ready.

---

## Next stage

**Stage 31a** — messy conversation intelligence: corrections, reset/start-over, stale quote invalidation, and side-question recovery.
