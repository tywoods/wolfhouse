# Stage 36c — Ale/Cami Staging Demo Rehearsal

**Status:** **PASS** (with pre-demo hygiene note)  
**Runbook:** `docs/STAGE-36B-ALE-CAMI-STAGING-DEMO-RUNBOOK.md`  
**Rehearsal date:** 2026-06-11  
**Runtime image:** `whstagingacr.azurecr.io/wh-staff-api:1d8a6d3-stage35b-messy-flow-proof`  
**Revision:** `wh-staging-staff-api--stage35b-messy-flow`

---

## Result summary

| Phase | Result |
|-------|--------|
| Preflight | **PASS** |
| Mode A — Staff Portal / Ask Luna | **PASS** |
| Mode B — Live WhatsApp → TEST link | **PASS** (reuse hold — see note) |
| Mode B Script 2 (yoga mini-flow) | **Skipped** (time; Script 1 sufficient) |
| Restore | **PASS** |
| Post-run verifiers | **PASS** |

**Overall: PASS** — demo can be executed cleanly with one hygiene step before Mode B.

---

## Preflight

| Check | Result |
|-------|--------|
| healthz | **200** |
| Deployed image | `1d8a6d3-stage35b-messy-flow-proof` |
| Stripe | `sk_test_*` only |
| n8n `stage27demoLWrite01` | **inactive** |
| Production | **untouched** |
| Safe baseline gates | **PASS** |

### Gates before rehearsal

| Gate | Value |
|------|-------|
| `WHATSAPP_DRY_RUN` | `true` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `false` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `false` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `false` |
| `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` | unset |

---

## Phase 2 — Mode A (safe walkthrough)

No live WhatsApp. No booking writes. Ask Luna against **staging DB** (read-only).

| Question | Intent | Result |
|----------|--------|--------|
| Who asked for yoga? | `services.pending_yoga` | 1 pending — WH-G27-4C1BA48A9A |
| Who needs meals scheduled? | `services.pending_meals` | None ✅ |
| Show pending manual services | `services.pending_manual` | 1 yoga pending |
| What does WH-G27-FCD6347442 need? | `bookings.lookup` | Hold, deposit paid, €80 balance |
| Who still owes money? | `payments.balance_due` | List with balances |
| Who is checking in today? | `bookings.arrivals_today` | None today |
| Who is checking out tomorrow? | `bookings.checkouts_tomorrow` | None tomorrow |
| What services need staff follow-up? | `services.pending_manual` | 1 yoga pending |

**Staff copy:** No raw JSON/metadata leaks. Pending lines readable (`Yoga — requested by guest, needs scheduling`).

**Staff Portal screens (manual):** Inbox, booking drawer, payment/balance, pending services card, Ask Luna — all documented in runbook; Mode A data confirms Ask Luna + lookup paths work on live staging rows.

---

## Phase 3 — Mode B (Script 1)

**Phone:** `+491726422307` (owner demoted for guest routing)

### Gates during Mode B

| Gate | Value |
|------|-------|
| `WHATSAPP_DRY_RUN` | `false` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `true` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `true` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `true` |
| `STAFF_ACTIONS_ENABLED` | `true` |
| `STRIPE_LINKS_ENABLED` | `true` |
| `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` | unset |
| n8n | **inactive** |

### Transcript (outbound Luna sends)

| Guest | Luna (summary) |
|-------|----------------|
| hi … book a stay … July 1-5 … 1 | *(stale context: 2× Malibu Jul 10–17 €299 — see hygiene note)* |
| no thanks, I have my own stuff | €180 accommodation; deposit/full prompt |
| deposit | Hold message + **Stripe TEST link** (`cs_test_a1aJwO8…`) |

### Mode B facts

| Field | Value |
|-------|-------|
| **booking_code** | `WH-G27-FCD6347442` *(existing Jul 1–5 hold reused)* |
| **payment_draft_id** | `71a2afce-db3d-466c-a404-0d2675c8c68a` |
| **Stripe TEST link sent** | **true** |
| **checkout session** | `cs_test_a1aJwO8TyIsEkSKeHp85LTDI4Oe5smyZR3BOfT98X6JD61FG7xOxpamlCc` |
| **Confirmation sent** | **false** |
| **Quote €180** | **true** (in outbound copy) |
| **Proactive yoga/meals** | **none** |
| **Live Stripe** | **false** (`sk_test` only) |

### Pre-demo hygiene note (important)

Before Ale/Cami Mode B, **reset conversation context** on test phone (fresh start). Without it, first replies may echo an old Malibu thread. Rehearsal still reached correct €180 + deposit link after add-on decline.

**Recommended before live demo:**

```bash
# Conversation reset via staging DB tooling or prior proof hygiene helper
# Then run Script 1 from clean state
```

### Staff Portal visibility (Script 1 booking)

- **WH-G27-FCD6347442** — Jul 1–5, 1 guest, accommodation hold
- Payment: deposit paid, **€80 balance due** (from Mode A lookup)
- Package: accommodation-only path
- Pending yoga: on **WH-G27-4C1BA48A9A** (Script 2 booking), not Script 1 — use Script 2 if demoing yoga card live

---

## Phase 4 — Script 2 (optional)

**Not run** in this rehearsal. Pending yoga visibility already proven via Mode A on WH-G27-4C1BA48A9A. Run Script 2 live only if Ale/Cami need to watch yoga attach on phone.

---

## Phase 5 — Restore

| Check | Result |
|-------|--------|
| `WHATSAPP_DRY_RUN` | `true` |
| `OPEN_DEMO_BOOKING_WRITES_ENABLED` | `false` |
| `OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED` | `false` |
| `OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED` | `false` |
| `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` | unset |
| healthz | **200** |
| n8n inactive | **true** |

Command used: `playground:open-demo-off` pattern via Azure env restore (same as runbook).

---

## Safety proof

| Check | Result |
|-------|--------|
| Production untouched | **PASS** |
| n8n inactive | **PASS** |
| Live Stripe | **false** |
| Confirmation send | **none** |
| Gates restored | **PASS** |

---

## Post-run verifiers

| Verifier | Result |
|----------|--------|
| `verify:stage36b-demo-runbook` | 64/64 PASS |
| `verify:stage36a-demo-readiness-staff-visibility` | 76/76 PASS |
| `luna:guest-flow-batch --local --fixture-set booking-core` | 26/26 PASS |

---

## Demo blockers

| Blocker | Severity | Mitigation |
|---------|----------|------------|
| Stale WhatsApp context on test phone | **Low** | Fresh-start conversation before Mode B |
| Script 1 reuses existing Jul 1–5 hold | **Info** | Acceptable for demo; or preclean holds |
| Yoga pending on different booking than Script 1 | **Info** | Use Ask Luna WH-G27-4C1BA48A9A in Mode A; run Script 2 for live yoga attach |

**No product code blockers.**

---

## Next recommendation

**Run the real Ale/Cami demo** using the same Stage 36b runbook:

1. Mode A first (10 min)
2. Fresh-start test phone
3. Mode B Script 1 (15 min)
4. Optional Script 2 if yoga attach on phone matters
5. Restore gates

**Do not build more features before the demo** unless a blocker appears during the live session.
