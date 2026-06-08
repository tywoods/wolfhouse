# Phase 26 — Staff Portal Operations (closeout)

**Status:** PASS (local verifiers + staging hosted proofs)  
**Final commit:** `3dc2921` — `fix(phase26): polish nav and bot mode status`  
**Staging revision:** `wh-staging-staff-api--stage26h10-nav-botmode`  
**Staging image:** `whstagingacr.azurecr.io/wh-staff-api:3dc2921-stage26h10-nav-botmode`  
**Date:** 2026-06-08  
**/healthz:** 200 on staging

---

## 1. Stage 26 final status

Phase 26 delivers **staff-facing booking operations** in the Staff Portal: airport transfers, services scheduling, drawer UX polish, payments (test-mode Stripe links), and navigation/bot-state polish. All Phase 26 slices verified locally and proven on staging with safety gates intact.

**Closeout scope:** documentation and static verifier only — no runtime code changes in this slice.

---

## 2. Deployed baseline (staging)

| Item | Value |
|------|-------|
| Commit | `3dc2921` |
| Revision | `wh-staging-staff-api--stage26h10-nav-botmode` |
| Image | `whstagingacr.azurecr.io/wh-staff-api:3dc2921-stage26h10-nav-botmode` |
| Host | `staff-staging.lunafrontdesk.com` |

### Environment (staging)

| Variable | Value |
|----------|-------|
| `STAFF_ACTIONS_ENABLED` | `true` |
| `STRIPE_LINKS_ENABLED` | `true` |
| `WHATSAPP_DRY_RUN` | `true` |
| WhatsApp live-send env | **none** (no live-send vars set) |

---

## 3. Airport transfers (completed)

- **`booking_transfers` table** — persistence for arrival/departure transfer rows per booking
- **Arrival / departure transfers** — separate legs with direction, airport, timing, and charge metadata
- **Santander / Bilbao rules** — airport-specific defaults and pricing behavior
- **Transfer calendar pebble** — calendar block shows transfer summary pebble
- **Transfer drawer editor** — Transfers tab in booking drawer for edit/add/remove
- **Aviationstack provider / status** — flight lookup integration with provider status surfacing
- **Flight lookup / autofill** — staff can look up flights and autofill transfer fields
- **Transfer remove** — delete transfer rows from drawer
- **Manual Exception Override** — staff override for edge cases (e.g. rule exceptions)
- **Bilbao under-4 rule** — blocked unless Exception Override is set
- **Transfer header pebble live update** — header pebble refreshes in place after transfer actions

**Key modules:** `scripts/lib/booking-transfers.js`, `scripts/lib/staff-booking-transfers-routes.js`, `scripts/lib/client-transfer-config.js`, transfer UI in `scripts/staff-query-api.js`.

---

## 4. Services tab (completed)

- **Services language** — drawer uses “Services” (replaces Add-ons wording in drawer context)
- **Schedule grouped by stay date** — services organized by date within the booking stay
- **Paid / Requested services summary** — summary lines for paid and requested service records
- **Total services line** — aggregate count under paid/requested summaries (service records only)
- **Service colors** — color-coded pebbles/chips (board, wetsuit, yoga, soft board, etc.)
- **Quantity > 1 unit pebbles** — multi-unit services show count pebbles
- **Schedule Later** — add service with deferred scheduling (`schedule_later` mode)
- **Span Across Booking** — distribute service dates across stay (`span_across_booking` mode)
- **Schedule / unschedule (+ / −)** — in-tab actions without full drawer reload
- **`service_date` nullable migration** — supports unscheduled / schedule-later rows

**Key modules:** `scripts/lib/staff-booking-services-schedule.js`, service routes in `scripts/staff-query-api.js`.

---

## 5. Drawer UX (completed)

- **File-folder tabs:** Overview / Services / Transfers / Payments
- **Overview cards** — booking summary, conversation/handoff, payment quick view, etc.
- **Active tab preserved** — actions refresh in place or tab-only; no unexpected tab reset
- **In-place / tab-only updates** — prefer partial DOM refresh over full drawer reload
- **Payment Summary quick card** — Overview payment snapshot
- **Payments tab two-column layout** — running invoice + actions layout
- **Record Cash Payment before Generate Payment Link** — cash form ordered above Stripe link section

---

## 6. Staff navigation / bot state (completed)

| Before | After | Tab id |
|--------|-------|--------|
| Inbox | **WhatsApp** | `conversations` |
| Command Center | **Luna Staff** | `ask-luna` |

- **Overview Conversation / Handoff pebble** — Staff (green) vs Luna (blue) from current pause state
- **Live refresh** — Pause/Resume Luna from WhatsApp tab updates open drawer pebble via `bcUpdateDrawerConvBotModePebble()` without page refresh

---

## 7. Payments (completed / proven)

- **`STAFF_ACTIONS_ENABLED=true`** — staff write actions enabled on staging
- **`STRIPE_LINKS_ENABLED=true`** — Generate Payment Link enabled in drawer
- **Stripe test payment link generation** — proven on staging (test checkout URLs; no production key)
- **No live WhatsApp send** — `WHATSAPP_DRY_RUN=true`; no outbound guest sends in Phase 26 proofs
- **No production Stripe key** — staging uses test-mode Stripe secret only

---

## 8. Safety summary

| Gate | Status |
|------|--------|
| `WHATSAPP_DRY_RUN=true` | Enforced on staging |
| No WhatsApp live-send env | Confirmed — no live-send vars |
| Stripe test key only | No `sk_live` on staging proofs |
| No Meta webhook changes | Phase 26 did not modify Meta webhook handlers |
| No n8n changes | Phase 26 did not modify n8n workflows |
| Guest AI intake | **Deferred to Stage 27** — no generative guest extraction in Phase 26 |
| Production cutover | Requires **explicit go/no-go** — not auto-promoted |

---

## 9. Known caveats

1. **Aviationstack plan** — staging returned `function_access_restricted` on some flight lookup calls; live successful flight lookup may require API plan upgrade or valid endpoint access.
2. **Guest AI extraction** — deferred to **Stage 27** (intake, extraction, generative guest replies).
3. **Production cutover** — staging PASS does not imply production deploy; explicit go/no-go checklist required.
4. **Manual UI sign-off** — automated proofs cover wiring and API; operators should spot-check drawer tabs, pause/resume pebble, and transfer override flows in browser.

---

## 10. Phase 26 commit chain (high level)

| Slice | Focus |
|-------|-------|
| 26a–26d | Transfer foundation, editor, calendar pebble |
| 26e–26g | Aviationstack, flight lookup, services tab |
| 26h | Drawer tabs, services polish, transfers polish, schedule modes, nav/bot mode |

Final commit: **`3dc2921`** — nav labels (WhatsApp / Luna Staff) + bot mode pebble live refresh.

---

## 11. Recommended next steps

1. **Manual UI sign-off** on staging — booking drawer tabs, services schedule modes, transfer Bilbao override, payment link UI (test mode only).
2. **Stage 27 — guest intake / extraction design** — scope generative guest AI, extraction, and booking-write bridges separately from staff ops.
3. **Production cutover checklist** — if staging is approved: env review, `WHATSAPP_DRY_RUN` policy, Stripe key mode, traffic cutover, and explicit go/no-go sign-off.

---

## 12. Verification

```bash
npm run verify:luna-agent-phase26-closeout
npm run verify:luna-agent-phase26-nav-botmode-polish
npm run verify:luna-agent-phase26-service-add-schedule-modes
npm run verify:luna-agent-phase26-inplace-actions-transfer-final-polish
npm run verify:luna-agent-phase26-service-pebbles-transfer-payment-polish
```
