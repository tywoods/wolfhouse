# Stage 35b — Hosted Staging Messy-Flow Proof (Stale Quote / Reset / Cash)

**Status:** **PASS** (2026-06-11)  
**Deployed commit:** `1d8a6d3` — `feat(stage35): handle stale quotes and booking resets`  
**Image:** `whstagingacr.azurecr.io/wh-staff-api:1d8a6d3-stage35b-messy-flow-proof`  
**Revision (proof window):** `wh-staging-staff-api--stage35b-messy-flow`  
**Revision (after proof):** `wh-staging-staff-api--stage35b-messy-flow` (gates unchanged — no restore needed)  
**Harness:** `scripts/run-stage35b-hosted-messy-flow-proof.js`  
**Endpoint:** `POST /staff/bot/guest-inbound-review-dry-run` on `https://staff-staging.lunafrontdesk.com`

---

## Result summary

| Area | Result |
|------|--------|
| Deploy + healthz 200 | **PASS** |
| Proof A — date correction before payment | **PASS** |
| Proof B — reset after quote | **PASS** |
| Proof C — cash side question in payment context | **PASS** |
| Stale quote blocks payment/hold readiness | **PASS** |
| Forbidden guest language | **PASS** (none detected) |
| Gates safe (dry-run, no writes, no Stripe links) | **PASS** |
| n8n inactive | **PASS** |
| No production / WhatsApp send / confirmation | **PASS** |
| Post-run verifiers | **PASS** |

**Overall: PASS** — Stage 35a correction/reset/cash behavior works on the real hosted Staff API inbound review path with safe gates.

---

## Deploy and gates

| Field | Value |
|-------|-------|
| Image tag | `1d8a6d3-stage35b-messy-flow-proof` |
| healthz (proof + after) | **200** |
| n8n `stage27demoLWrite01` | **inactive** |

### Gates before / during / after proof

| Gate | Value |
|------|-------|
| `WHATSAPP_DRY_RUN` | `true` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `false` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `false` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `false` |
| `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` | **unset** |

No gate changes were required — staging was already on safe baseline. Prior revision `wh-staging-staff-api--0000220` (`57a9954-stage33f-yoga-service-attach-proof`) was replaced by deploy of `1d8a6d3`.

---

## Proof method

- **Hosted Staff API path:** `guest-inbound-review-dry-run` (orchestrator + conversation artifact persistence, review-only)
- **No Meta webhook / no live WhatsApp handset**
- **No booking/hold writes, no Stripe links, no confirmation send**
- Unique proof phones per flow (`+346298350*`, `+346298351*`, `+346298352*`)
- Bot auth via `luna-bot-internal-token` (Container App secret)
- Reference date: `2026-06-10`

---

## Proof A — Date correction before payment

**Flow:** book a stay → July 1-5 → 1 → no thanks, I have my own stuff → actually July 2-6  
**Phone:** `+3462983506686`

| Turn | Guest | Key facts |
|------|-------|-----------|
| 1 | book a stay | quote_status=not_ready, composer |
| 2 | July 1-5 | check_in=2026-07-01, check_out=2026-07-05 |
| 3 | 1 | quote_status=ready, package=accommodation_only, €180 quote |
| 4 | no thanks, i have my own stuff | quote_status=ready, deposit/full prompt, **stale_quote=false** |
| 5 | actually July 2-6 | check_in=2026-07-02, check_out=2026-07-06, **stale_quote=true**, **stale_quote_reason=dates_changed**, payment_choice_ready=false, no Stripe link, re-quote €180 |

**Luna (turn 5):** *Got it — updating those dates for July 2 to July 6. The stay comes to €180. To hold the spot, would you prefer to pay the €100 deposit now, or pay the full €180?*

---

## Proof B — Reset after quote

**Flow:** Malibu July 10 to July 17 for 2 → no no, start over → July 1-5  
**Phone:** `+3462983516598`

| Turn | Guest | Key facts |
|------|-------|-----------|
| 1 | Malibu July 10 to July 17 for 2 | quote_status=ready, package=malibu, €598 |
| 2 | no no, start over | **new_booking_reset=true**, quote cleared, fresh intake prompt |
| 3 | July 1-5 | check_in=2026-07-01, check_out=2026-07-05, **stale_quote=false**, no Malibu deposit leak |

**Luna (turn 2):** *No problem — we can start a new booking. What dates are you looking for, and how many guests?*

---

## Proof C — Cash side question in payment context

**Flow:** July 1-5 for 1 → no thanks, I have my own stuff → can I pay cash? → deposit  
**Phone:** `+3462983521470`

| Turn | Guest | Key facts |
|------|-------|-----------|
| 1 | July 1-5 for 1 | quote_status=ready, €180 |
| 2 | no thanks, I have my own stuff | quote_status=ready, **stale_quote=false** |
| 3 | can I pay cash? | **stale_quote=false**, context preserved, cash answer |
| 4 | deposit | **payment_choice=deposit**, payment_choice_ready=true, hold_plan_status=ready, **stale_quote=false**, no Stripe link in review path |

**Luna (turn 3):** *Yes — the remaining balance can be paid on arrival by cash, bank transfer, or Stripe. To hold the spot, would you prefer to pay the €100 deposit now, or pay the full €180?*

---

## Safety proofs

| Check | Result |
|-------|--------|
| WhatsApp send | **none** (`sends_whatsapp=false` every turn) |
| Booking/hold writes | **none** (`no_write_performed=true` every turn) |
| Stripe checkout links | **none** in replies (gates off + review-only path) |
| n8n activation | **inactive** |
| Production | **untouched** |
| Confirmation send | **none** (allowlist unset) |
| Forbidden internal language | **none** across all turns |

---

## Post-run verifiers

| Verifier | Result |
|----------|--------|
| `verify:stage35a-stale-quote-reset-corrections` | 44/44 PASS |
| `verify:stage34a-pending-manual-services-staff-visibility` | 62/62 PASS |
| `verify:stage33e1-pending-service-db-constraint-mapping` | 29/29 PASS |
| `verify:stage30c-confirmation-copy-style` | 42/42 PASS |
| `luna:guest-flow-batch --local --fixture-set booking-core` | 26/26 PASS |

---

## Next stage recommendation

**Stage 35c** — small live handset proof of one messy flow only (date correction or cash side-question), with dry-run gates unless explicitly enabling writes for hold proof.

Alternative: demo-readiness cleanup for Ale/Cami if handset proof can wait.
