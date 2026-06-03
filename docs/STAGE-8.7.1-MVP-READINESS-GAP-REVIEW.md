# Stage 8.7.1 — MVP Readiness Gap Review

**Status:** PASS — docs only (2026-06-03).  
**Basis:** Stages 8.4.13 (Staff manual booking MVP), 8.5.19 (Luna confirmation drawer), 8.6.10 (Ask Luna hosted), Phase 7.6 pilot checklist (**NO_GO**).  
**Non-negotiables:** No code. No deploy. No n8n activation. No WhatsApp. No Stripe changes.

**Legend**

| Label | Meaning |
|-------|---------|
| **Demo-ready** | Safe to show on `staff-staging.lunafrontdesk.com` in a guided walkthrough (Stripe test mode; no live sends). |
| **Dry-run ready** | Engine/path proven inactive or read-only; manual trigger or portal-only; `whatsapp_sent:false` / no send button. |
| **Live blocker** | Must be resolved before real guest/staff WhatsApp pilot or production cutover. |

**Overall pilot posture:** **NO_GO** for live WhatsApp and autonomous guest operation. **GO** for a staged shadow/demo walkthrough on Azure staging.

---

## 1. Staff Portal

| Capability | Demo-ready | Dry-run ready | Live blocker |
|------------|:----------:|:-------------:|--------------|
| **Manual booking create** | ✓ Stage 8.4.13 E2E on staging (`STAFF_ACTIONS_ENABLED=true`, `MANUAL_BOOKING_ENABLED=true`) | ✓ Same path; creates real Postgres rows in staging | Production Stripe keys; Cami/Ale pilot accounts; spreadsheet-replacement sign-off; accidental duplicate bookings without cleanup policy |
| **Quote / invoice preview** | ✓ Calculate Quote UI + `POST /staff/quote-preview`; itemized line items, deposit, balance | ✓ `preview_only:true`; no write until Create | `REQUIRED_FROM_STAFF` pricing gaps (group discounts, operator pricing, add-on charge timing) — see [`wolfhouse-somo.pricing.json`](../config/clients/wolfhouse-somo.pricing.json) |
| **Stripe payment link** | ✓ Create + copy link from portal; test Checkout URL | ✓ Test mode only; `amount_paid_cents=0` until webhook | Live Stripe account + webhook endpoint on prod domain |
| **Webhook payment truth** | ✓ Signed `checkout.session.completed` → drawer shows Deposit paid ✓ (8.4.13, 8.5.13) | ✓ HMAC-valid staging webhook; idempotent | Prod webhook secret rotation; monitoring/alerting on failed webhooks |
| **Confirmation draft drawer** | ✓ Read-only **Luna confirmation draft ready** panel (8.5.19) | ✓ Persisted `metadata.confirmation_draft`; no send button | **No confirmation send** wired — `confirmation_sent_at` never set from drawer; guest message policy undefined |
| **Ask Luna tab** | ✓ Portal tab; session auth; payments / handoffs / departures / cleaning (8.6.2–8.6.10) | ✓ `read_only:true`, `sends_whatsapp:false` | Real staff mobiles in allowlist; live WhatsApp pipe (8.6.8 **NO_GO**) |

**Staff Portal gaps for pilot:** Bed calendar **move / cancel / operator block / operator release** writes remain future slices (`8.3p+`); Tour Operator forms are **skeleton only** (buttons disabled). Inbox remains **copy-only** for guest replies (no send from portal).

---

## 2. Guest Luna (WhatsApp booking bot)

| Capability | Demo-ready | Dry-run ready | Live blocker |
|------------|:----------:|:-------------:|--------------|
| **Dry-run workflow imported inactive** | ✓ Explain in demo | ✓ `stage8510SharedDryRun01`, `active:false` (8.5.10–8.5.12) | Must stay inactive until explicit GO |
| **Quote → availability → booking → Stripe link → draft reply** | Partial — show manual n8n exec log or API proofs | ✓ Full chain via Staff API bot endpoints (8.5.10 exec #4/#5); `whatsapp_sent:false` | **Live inbound WhatsApp not wired** to shared-engine path; production **Main** workflow still Airtable/direct-Stripe (8.5.1 map) |
| **Webhook payment truth** | ✓ Show drawer after test payment (Luna bookings `MB-WOLFHO-*`) | ✓ Same Staff API webhook as portal path (8.5.13–8.5.17) | Guest completes real payment without staff supervision |
| **Confirmation draft** | ✓ Drawer panel + persisted metadata (8.5.18–8.5.19) | ✓ Draft only; `sends_whatsapp:false` | **No live confirmation send** to guest; n8n Send Confirmation not redirected to Postgres draft |

**Guest Luna demo script today:** Manual n8n execution (pinned payload) **or** Staff Portal drawer on an existing Luna test booking — **not** end-to-end live WhatsApp conversation.

---

## 3. Staff Ask Luna

| Capability | Demo-ready | Dry-run ready | Live blocker |
|------------|:----------:|:-------------:|--------------|
| **Portal Ask Luna** | ✓ Tab + hosted proofs (8.6.4, 8.6.10) | ✓ Session auth; no writes | — |
| **WhatsApp dry-run workflow** | ✓ Describe inactive workflow | ✓ `stage863AskLuna01`, manual exec #3; `reply_draft` + `whatsapp_sent:false` (8.6.7) | Activation + outbound send node |
| **Allowlisted staff phone path** | ✓ Staging test `+34999000999` only | ✓ `staff_whatsapp_enabled` + allowlist config | **Real Ty/Cami/Ale numbers** not in config; Gate 3 **PARTIAL** (8.6.8) |
| **Payment / ops questions** | ✓ `who still owes money`, waiting payments, handoffs, arrivals | ✓ All read-only SQL | Wrong answer liability without owner review of intent coverage |
| **Departures / cleaning** | ✓ Hosted 8.6.10 (`departures_today`, `rooms_or_beds_need_cleaning`) | ✓ Same | Data quality depends on bed assignments + check-out dates in Postgres |

---

## 4. Live blockers (summary)

| Blocker | Status | Notes |
|---------|--------|-------|
| **WhatsApp live send approval** | **NO_GO** | 8.6.8 checklist; owner sign-off required for staff or guest sends |
| **Real staff phone numbers** | Open | Allowlist uses staging test numbers only (`+34999000999` etc.) |
| **Confirmation send policy** | Open | Draft exists; no approved path to set `confirmation_sent_at` or message guest |
| **Demo / test data cleanup** | Open | Disposable Luna bookings left on staging (`MB-WOLFHO-20260801-4f10c3`, `…15-…`, `…22-…`); no purge runbook for demo vs real |
| **Wolfhouse business rules** | Partial | Formula B + packages seeded; multiple `REQUIRED_FROM_STAFF` fields (deposits by package/room, add-on timing, operator pricing, retreats) — [`STAGE-8.4.1-WOLFHOUSE-PRICING-PAYMENT-CONFIG-PLAN.md`](STAGE-8.4.1-WOLFHOUSE-PRICING-PAYMENT-CONFIG-PLAN.md) |
| **Operator / manual booking UI completeness** | Partial | Manual booking MVP ✓; move/cancel/operator block/release **not enabled** in UI (`8.3p+`); spreadsheet replacement incomplete |
| **Phase 7.6 pilot gates** | **NO_GO** | 81 gates; Cami/Ale accounts, monitoring, backup drills largely deferred |
| **Production Main Luna workflow** | **Not migrated** | Shared engine proven only on inactive dry-run fork |

---

## 5. Next recommended live-safe test

**Recommendation: stay dry-run and run a clean demo flow.**

Rationale: live WhatsApp is explicitly **NO_GO** (8.6.8); guest Luna live has the largest blast radius (booking creation + payment link + possible mis-route); staging already supports a credible end-to-end **demo** without sends.

### Preferred demo path (no activation)

1. Log in to `staff-staging.lunafrontdesk.com`.
2. **Bed Calendar** → open `MB-WOLFHO-20260801-4f10c3` → show payment truth + **Luna confirmation draft** panel.
3. **Ask Luna** tab → `who still owes money` / `who leaves today` / `which rooms need cleaning`.
4. Optional: **Manual booking** slice — quote → create → Stripe link → (Ty completes test checkout) → drawer updates.
5. Optional: show n8n **inactive** dry-run workflows and last manual execution logs (no activation).

### If one live micro-test is desired later (requires 8.6.8 GO)

| Option | Risk | When to choose |
|--------|------|----------------|
| **Staff Ask Luna → Ty's phone only** | Low — read-only answer; single allowlisted number | Smallest live WhatsApp proof after owner GO + real number in allowlist |
| **Guest Luna → Ty only** | High — creates booking/payment state; old Main workflow still live elsewhere | **Not recommended** until Main workflow cutover + confirmation policy |
| **Stay dry-run** | None | **Default now** — matches pilot NO_GO and current proof coverage |

---

## 6. Suggested next slices (after this review)

| Priority | Slice | Why |
|----------|-------|-----|
| 1 | **8.7.2 Demo runbook** | Single scripted walkthrough for Ale/Cami (dates, bookings, talking points) |
| 2 | **8.6.11 Live staff WhatsApp** (gated) | Only after 8.6.8 GO + Ty pilot reply |
| 3 | **8.5.20 Confirmation send policy** | Define when/how guest confirmation may fire (still gated) |
| 4 | **8.3p+ Calendar writes** | Move/cancel/operator — spreadsheet replacement |
| 5 | **Pricing REQUIRED_FROM_STAFF closure** | Ale/Cami answers for deposit/add-on/operator rules |

---

**Related docs:** [`PROJECT-STATE.md`](PROJECT-STATE.md) · [`ROADMAP.md`](ROADMAP.md) · [`STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md`](STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md) · [`PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md`](PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md)
