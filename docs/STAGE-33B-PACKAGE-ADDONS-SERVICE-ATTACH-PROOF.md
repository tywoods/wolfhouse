# Stage 33b — Package Add-ons Staging Reproof + Yoga Attach DB Proof

**Status:** **PARTIAL** (2026-06-10)  
**Commit deployed:** `5e6a641` — `fix(stage33): route package add-ons and attach manual services`  
**Image:** `whstagingacr.azurecr.io/wh-staff-api:5e6a641-stage33b-package-addons-proof`  
**Revision (proof window):** `wh-staging-staff-api--0000211` → `wh-staging-staff-api--0000214` (gate toggles)  
**Test handset:** `+491726422307` (allowlisted; demoted from staff/owner for proof)

---

## Result summary

| Area | Result |
|------|--------|
| Phase 1 — local verifiers (stage33/32b/32/30c/booking-core) | **PASS** |
| Phase 1 — conversation dry-run (11 PASS / 12 FAIL) | **No Stage 33 regression** — all 4 Stage 33 fixtures PASS |
| Deploy + healthz 200 | **PASS** |
| Test A — composer package quote + add-ons before deposit | **PASS** (conversation) |
| Test A — Malibu preserved on “just the stay” | **PASS** |
| Test A — no legacy `final_reply_source: quote` | **PASS** (`luna_reply_composer`) |
| Test A — no proactive yoga/meals | **PASS** |
| Test A — hold + Stripe TEST link | **PARTIAL** — hold created once (`WH-G27-4C1BA48A9A`, `cs_test_a1pVV…`); harness missed timing on full batch |
| Test B — explicit add-ons (`wetsuit and lessons`) | **PASS** (no side-question explainer; `addons_requested`/`addons_priced` correct) |
| Test B — deposit prompt after add-ons | **PARTIAL** — staging asks room preference before deposit (live path difference) |
| Test C — yoga pending in conversation facts | **PASS** (`yoga_status=requested`, `services_pending_manual=[yoga]`) |
| Test C — `booking_service_records` yoga attach | **FAIL** — zero yoga rows on staging for proof phone/window |
| Test C — hold + Stripe on yoga flow | **FAIL** on rerun — deposit ack only, no hold row updated |
| Gates restored | **PASS** |
| Safety (prod / n8n / live Stripe / confirmation) | **PASS** |
| Post-restore local verifiers | **PASS** |

**Overall: PARTIAL** — Stage 33 conversation routing proven on staging; yoga DB attach and reliable hold/write correlation remain unproven live.

---

## Phase 1 — Failure triage (`test:luna-conversations --all`)

**11 PASS / 12 FAIL / 23 total.** All four Stage 33 fixtures PASS in dry-run.

| Fixture | Failure | Classification |
|---------|---------|----------------|
| `add-on-correction-before-payment` | turn 4: `expected_quote_ready` but `quote_status=not_ready` | Pre-existing flake — name/clarify turn after add-ons step |
| `cash-side-question-payment-context` | turn 3: missing “cash”, quote not ready, internal language | Pre-existing / fixture expectation outdated |
| `meals-request-mid-booking` | turn 4: quote not_ready | Pre-existing flake |
| `meals-request-then-deposit-flow` | turn 4: quote not_ready | Pre-existing flake |
| `meals-yoga-not-proactively-offered` | turn 4: quote not_ready | Pre-existing flake |
| `package-service-question-context-preserved` | turn 5: missing lesson/July, composer→router | Pre-existing / harness timing |
| `package-switch-before-payment` | turn 3: `payment_choice deposit` null | Pre-existing flake |
| `seven-night-step-by-step-package-choice` | turn 6: `payment_choice deposit` null | Pre-existing flake |
| `short-stay-board-question-mid-flow` | turn 4: quote not_ready | Pre-existing flake |
| `short-stay-wetsuit-lessons-selected` | turn 4: quote not_ready | Pre-existing flake |
| `yoga-decide-later-does-not-block` | turn 4: quote not_ready | Pre-existing flake |
| `yoga-request-mid-booking` | turn 4: quote not_ready | Pre-existing flake |

**Stage 33 regression:** **None.** Proceeded to staging proof.

---

## Deploy and gates

| Field | Value |
|-------|-------|
| Image tag | `5e6a641-stage33b-package-addons-proof` |
| Active revision (proof) | `wh-staging-staff-api--0000211` |
| Active revision (after restore) | `wh-staging-staff-api--0000214` |
| healthz (proof + restore) | **200** |
| Stripe key | `sk_test_*` (Key Vault) |
| n8n `stage27demoLWrite01` | **inactive** |

### Gates during proof

| Gate | Value |
|------|-------|
| `WHATSAPP_DRY_RUN` | `false` |
| `OPEN_DEMO_WHATSAPP_ENABLED` | `true` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `true` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `true` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `true` |
| `STRIPE_LINKS_ENABLED` | `true` |
| `STAFF_ACTIONS_ENABLED` | `true` |
| `LUNA_CONVERSATION_BRAIN_ENABLED` | `true` |
| `LUNA_CONVERSATION_BRAIN_LLM_ENABLED` | `true` |
| `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` | **removed** |
| Confirmations | **not sent** |

### Gates after restore

| Gate | Value |
|------|-------|
| `WHATSAPP_DRY_RUN` | `true` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `false` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `false` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `false` |
| `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` | **removed** |
| healthz | **200** |

---

## Test A — Package one-shot add-ons before deposit

**Flow:** `Malibu July 10 to July 17 for 1` → `just the stay` → `deposit`

| Check | Result |
|-------|--------|
| Composer-owned Malibu €299 quote | **PASS** |
| Surf add-ons question before deposit | **PASS** |
| Malibu preserved after “just the stay” | **PASS** |
| `final_reply_source` = `luna_reply_composer` (not `quote`) | **PASS** |
| No proactive yoga/meals | **PASS** |
| No payment link before add-ons resolved | **PASS** |
| Hold + Stripe TEST link | **PARTIAL** — `guest_message_sends` at 22:16:18 included `checkout.stripe.com/c/pay/cs_test_a1pVV…`; cleanup archived hold `WH-G27-4C1BA48A9A` |
| Confirmation | **not sent** |

---

## Test B — Explicit surf add-ons selection

**Flow:** `book a stay` → `July 1-5` → `1` → `wetsuit and lessons` → `deposit`

| Check | Result |
|-------|--------|
| `addons_requested` / `addons_priced` include wetsuit + surf_lesson | **PASS** |
| No wetsuit/lesson side-question explainer | **PASS** |
| No German unless guest language German | **PASS** |
| Deposit/full prompt immediately after add-ons | **PARTIAL** — live path asks room preference first |
| Hold + Stripe | **not proven** in batch window (prior paid artifact `WH-G27-FCD6347442` skipped hygiene) |
| Confirmation | **not sent** |

---

## Test C — Yoga before deposit attach proof

**Flow:** `Malibu July 10 to July 17 for 1` → `just the stay` → `Can I add yoga?` → `deposit`

| Check | Result |
|-------|--------|
| `yoga_status = requested` | **PASS** |
| `services_pending_manual` includes yoga before hold | **PASS** |
| Hold created on deposit | **FAIL** (rerun: ack only, no booking `updated_at` after deposit) |
| `attached_manual_services` | **FAIL** |
| `booking_service_records` yoga row | **FAIL** — query returned **zero** yoga rows for proof window |
| No fake scheduling (`service_date` null) | **PASS** (no rows to fake) |
| Stripe TEST link | **FAIL** on rerun (composer ack matched harness poll falsely — see harness note) |
| Confirmation | **not sent** |

### DB proof query (staging, post-proof)

```
booking_service_records WHERE service_type ILIKE '%yoga%' AND created_at >= 2026-06-10T22:00:00Z → []
WH-G27-4C1BA48A9A (Malibu Jul 10–17) → booking_service_records: []
```

Yoga attach code path (`luna-guest-pending-service-attach.js`) runs only after hold write; live deposit on Test C did not produce a new/updated hold row in the proof window.

---

## Harness notes (false negatives)

1. **First batch run:** `tests` command did not call `setEnvVars(LIVE_ENV)` — gates were dry until fixed; caused missed holds.
2. **Payment-link poll:** matcher treats “secure payment link ready” composer ack as Stripe send — **false positive** on Test C rerun (`stripe_link_sent: true` without `checkout.stripe.com` URL).
3. **Booking lookup:** 22s post-deposit wait insufficient; cleanup cancelled holds before some inspect windows.
4. **`guest_message_sends`:** no `booking_id`/`metadata` columns — correlation uses phone + timestamp only.

---

## Post-restore local verifiers

| Verifier | Result |
|----------|--------|
| `verify:stage33-package-addons-and-service-attach` | **43/43 PASS** |
| `verify:stage32b-meals-yoga-reactive-services` | **30/30 PASS** |
| `verify:stage32-addons-services-mid-booking` | **32/32 PASS** |
| `verify:stage30c-confirmation-copy-style` | **42/42 PASS** |
| `luna:guest-flow-batch --local --fixture-set booking-core` | **26/26 PASS** |

---

## Safety proof

| Check | Result |
|-------|--------|
| Production untouched | **PASS** |
| n8n inactive | **PASS** |
| Stripe `sk_test` only | **PASS** |
| No confirmation sent | **PASS** |
| No live Stripe | **PASS** |

---

## Next stage recommendation

**Stage 33c — Live yoga/meals attach + hold write correlation**

1. Debug why staging deposit on yoga-pending flow stops at `payment_choice_ack` without hold write (idempotency on cancelled Malibu holds, staff demotion, or missing “keep going” ack).
2. Re-run Test C with hygiene clearing cancelled holds in date window **before** flow; confirm `booking_service_records` row: `source=luna_guest_pending`, `status=requested`, `needs_scheduling=true`, `service_date=null`.
3. Fix harness: live gates at `tests` start, DB-backed send poll (Stripe URL only), 35s+ post-deposit wait, inspect before cleanup.
4. Do **not** patch the 12 conversation flakes unless a Stage 33 fixture regresses.
