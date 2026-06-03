# Stage 8.7.2 — Staging Demo Script (Wolfhouse / Luna)

**Status:** PASS — docs only (2026-06-03).  
**Audience:** Ty presenting to Ale/Cami (shadow mode; no live sends).  
**Duration:** ~20–30 minutes (core path ~15 min).  
**Non-negotiables:** No code. No deploy. No n8n activation. No WhatsApp. No Stripe changes.

**Prerequisite review:** [STAGE-8.7.1-MVP-READINESS-GAP-REVIEW.md](STAGE-8.7.1-MVP-READINESS-GAP-REVIEW.md)

---

## Decisions (this stage)

| Question | Decision | Rationale |
|----------|----------|-----------|
| **Keep or clean test bookings?** | **Keep** existing Luna proof bookings on staging | They are the evidence chain (8.5.6–8.5.19). No purge until a dedicated cleanup slice. |
| **Golden demo booking** | **`MB-WOLFHO-20260801-4f10c3`** (guest: Luna Test 855) | Only booking with **both** deposit-paid payment truth **and** persisted **Luna confirmation draft** in drawer (8.5.17 + 8.5.19). |
| **Supporting bookings (do not open unless asked)** | `MB-WOLFHO-20260822-3a4d1a` (Luna exec #5; paid, no draft panel focus), `MB-WOLFHO-20260815-4d37a0` (exec #4; may be unpaid), `MB-WOLFHO-20260705-30e9d3` (manual-booking E2E 8.4.13) | Historical proofs; opening them adds clutter. |
| **What not to show** | Live WhatsApp; operator block/release writes; move/cancel writes; confirmation **send** button; Developer Tools / raw Query Tools as the main story; production Main Luna workflow | All blocked, skeleton, or NO_GO per 8.7.1. |

---

## Environment quick reference

| Item | Value |
|------|-------|
| Staff Portal | `https://staff-staging.lunafrontdesk.com` |
| Login | Company: `wolfhouse-somo` · Email: `admin.stage72c@example.test` · Password: see comment in [`scripts/fixtures/stage7.2c-auth-seed.sql`](../scripts/fixtures/stage7.2c-auth-seed.sql) |
| Staff API revision (8.5.19) | `wh-staging-staff-api--0000022` |
| n8n editor (read-only for demo) | `https://wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io/home` |
| Golden booking | `MB-WOLFHO-20260801-4f10c3` · check-in **2026-08-01** · check-out **2026-08-06** |
| Bed Calendar date range | **From** `2026-07-28` **To** `2026-08-10` → click **Load** |

**Opening line for audience:** *“This is Azure staging in shadow mode — Stripe test mode, no WhatsApp sends, workflows inactive. We’re showing the shared booking/payment engine and read-only staff tools.”*

---

## Core demo path (~15 min)

### Step 1 — Staff Portal login (~1 min)

1. Open `https://staff-staging.lunafrontdesk.com/staff/login`
2. Company: `wolfhouse-somo`
3. Sign in with staging admin (seed file above)
4. **Point out:** staging / shadow banners if visible; **no** live-send controls in inbox

**Say:** *Login is per-user staff auth; this is not the guest WhatsApp channel.*

---

### Step 2 — Bed Calendar → golden booking drawer (~5 min)

1. Click **Bed Calendar**
2. Set **From** `2026-07-28`, **To** `2026-08-10` → **Load**
3. Click block **MB-WOLFHO-20260801-4f10c3 – Luna Test 855**

**Payment truth — confirm visible:**

| Check | Expected |
|-------|----------|
| Banner | **Deposit paid ✓** (green) |
| Totals | Paid **€100.00** · Balance **€150.00** (deposit path) |
| Payment row | **Paid ✓** · `paid_at` set · Stripe session/intent IDs · checkout URL copy |
| Stripe | Test mode only; truth came from signed webhook (8.5.17) |

**Luna confirmation draft — scroll to panel `#bc-luna-confirmation-draft`:**

| Check | Expected |
|-------|----------|
| Header | **Luna confirmation draft ready** |
| Fields | Booking `MB-WOLFHO-20260801-4f10c3` · Guest **Luna Test 855** · **Deposit paid ✓** |
| Amounts | **€100.00** paid · **€150.00** balance due |
| Room / access | **DEMO-R1** · gate **2684#** |
| Safety | `sends_whatsapp: false` · `whatsapp_dry_run: true` |
| Footer | *Draft only — not sent. No WhatsApp in this slice.* |
| Buttons | **No Send** — Copy only |

**Say:** *After Stripe webhook marks deposit paid, the same engine builds a confirmation draft and stores it on the booking — staff can review before any guest message goes out. Send is intentionally not wired yet.*

---

### Step 3 — Ask Luna tab (~5 min)

1. Click **Ask Luna**
2. Run these three questions (Enter or **Ask** after each):

| # | Question | Expected intent | Notes |
|---|----------|-----------------|-------|
| 1 | `Who still owes money?` | `payments.balance_due` | Should show ≥1 row (staging guests with balance) |
| 2 | `Who leaves today?` | `departures_today` | May be `row_count: 0` unless today matches a check-out |
| 3 | `Which rooms need cleaning?` | `rooms_or_beds_need_cleaning` | Same — depends on today’s departures |

**Point out on each result:** intent badge · answer text · `read_only` / no write · **no WhatsApp send**

**Say:** *Staff can ask operational questions from the portal today; the same API backs a future staff-WhatsApp path — still dry-run only.*

---

## Optional extensions

### Step 4 — Manual booking (optional, ~8 min)

**Only if** banner/flags show staff actions **enabled** (`STAFF_ACTIONS_ENABLED` + `MANUAL_BOOKING_ENABLED` — proven on staging at 8.4.13; re-check banner before demo).

1. **Bed Calendar** → select **empty bed cell(s)** in desired date range
2. Fill guest fields · package · room type · payment choice
3. **Calculate Quote** → show itemized total/deposit/balance
4. **Create Manual Booking** → note `booking_code` + `payment_id`
5. **Create Stripe Payment Link** → copy test `checkout_url` (do **not** require guest payment unless you want fresh proof)
6. **Skip** live checkout unless Ty explicitly wants a new webhook demo

**Say:** *Same quote engine as Luna bot — amounts never come from the browser.*

**If flags disabled:** show quote preview only; say create/link are gated off for this demo.

---

### Step 5 — Guest Luna dry-run proof (optional, ~5 min)

**Do not activate workflow. Do not run a new execution during the demo unless pre-rehearsed.**

1. Open n8n → workflow **`Wolfhouse Booking Assistant - Main - Shared Engine Dry Run`** (`stage8510SharedDryRun01`)
2. Confirm **`Active` = off**
3. Open **Executions** → select **manual execution #5** (8.5.12 proof)

**Highlight in execution output:**

| Field | Expected |
|-------|----------|
| Guard | `dry_run: true` · `live_send_enabled: false` |
| Chain | booking-preview → availability-check → booking-create → Stripe link → draft reply |
| `booking_code` | `MB-WOLFHO-20260822-3a4d1a` (created in that run) |
| `reply_draft` | Payment-link text with Staff API `checkout_url` |
| `whatsapp_sent` | `false` |
| Absent | `graph.facebook.com` · direct `api.stripe.com` from n8n |

**Say:** *Guest Luna on the shared engine is proven via inactive dry-run — not connected to live inbound WhatsApp yet.*

---

### Step 6 — Staff Ask Luna WhatsApp dry-run proof (optional, ~5 min)

**Do not activate. Do not send.**

1. n8n → **`Wolfhouse Staff Ask Luna - WhatsApp Dry Run`** (`stage863AskLuna01`)
2. Confirm **`Active` = off**
3. Open **Executions** → **manual execution #3** (8.6.7)

**Highlight:**

| Field | Expected |
|-------|----------|
| Inbound (pinned) | `+34999000999` · `who still owes money` |
| HTTP node | `POST …/staff/ask-luna` · `source: staff_whatsapp` |
| Response | `intent: payments.balance_due` · `reply_draft` populated |
| Safety | `whatsapp_sent: false` · `dry_run: true` |
| Absent | `graph.facebook.com` |

**Say:** *Allowlisted staff phone → same Ask Luna brain as the portal tab — WhatsApp outbound still blocked.*

---

## Do-not-show list (redirect if asked)

| Topic | Redirect |
|-------|----------|
| **Live guest WhatsApp booking** | Main workflow still on legacy path; shared engine is dry-run fork only (8.5.1 map) |
| **Send confirmation to guest** | Draft panel is read-only; `confirmation_sent_at` not set; policy TBD (8.5.20+) |
| **Tour Operator block / room release** | Forms visible under Tour Operator tab; **buttons disabled** (8.3r skeleton) |
| **Move / cancel beds from calendar** | Planned `8.3p+`; not enabled |
| **Live staff WhatsApp reply** | 8.6.8 **NO_GO** until owner sign-off |
| **Developer Tools / Query Tools** | Mention as dev-only; don’t lead the demo here |

---

## Rehearsal record — Stage 8.7.3 (2026-06-03)

**Result:** PASS with **one UI blocker** (Ask Luna button). Backend + drawer path demo-ready.

| Step | Result | Notes |
|------|--------|-------|
| Login | **PASS** | `admin.stage72c@example.test` / `wolfhouse-somo` |
| Golden booking drawer | **PASS** | Deposit paid ✓ · €100 paid / €150 balance · Luna confirmation draft ready · gate **2684#** · no Send button |
| Ask Luna (portal UI) | **FIXED (8.7.4)** | Was **BLOCKED** in 8.7.3 — `window.alAsk = alAsk` added; re-run rehearsal before client demo |
| Ask Luna (API, session) | **PASS** | Same session cookie: `Who still owes money?` → `payments.balance_due` / **4 rows**; `Who leaves today?` → `departures_today` / **0 rows**; `Which rooms need cleaning?` → `rooms_or_beds_need_cleaning` / **0 rows**; all `read_only:true`, `sends_whatsapp:false` |
| n8n inactive | **PASS** | `stage8510SharedDryRun01` + `stage863AskLuna01` both `active:false` |
| No live WhatsApp / Stripe / n8n from portal | **PASS** | No `graph.facebook.com`, `stripe.com`, or n8n URLs in session network log |

**UI notes (non-blocking):**

- Bed Calendar **defaults** to ~today + 30 days — golden booking (Aug 2026) is **hidden until you change the range** (script step still required).
- Only **one** booking block in the demo date range — sparse but sufficient.
- Switching to **Ask Luna** tab leaves the **booking drawer open** on the right — can distract; close drawer first or call out as known UX.
- Departures/cleaning **empty on demo day** (2026-06-03) is expected — explain date-driven SQL.

**Demo-day workaround until Ask button fixed:** ~~do not rely on the Ask button~~ **Resolved in Stage 8.7.4** (`window.alAsk = alAsk`). Re-run Step 3 once on staging after deploy.

---

## Pre-demo checklist (5 min before call)

- [ ] Staff Portal login works
- [ ] Golden booking visible in range `2026-07-28` → `2026-08-10`
- [ ] Drawer shows **Deposit paid ✓** + **Luna confirmation draft ready**
- [ ] Ask Luna: `Who still owes money?` returns rows
- [ ] n8n workflows `stage8510SharedDryRun01` and `stage863AskLuna01` still **`active: false`**
- [ ] No workflow activation planned during demo

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Booking block not visible | Widen date range; confirm `wolfhouse-somo` client |
| No confirmation draft panel | Wrong booking — use **4f10c3** only for draft story |
| Ask Luna button silent | Fixed 8.7.4 — was `alAsk` not global; redeploy Staff API then re-test |
| Ask Luna empty on departures/cleaning | Normal if no check-outs **today**; explain date-driven SQL |
| Manual booking buttons greyed | Flags off — quote-only demo |
| n8n execution list empty | Use Stage 8.5.12 / 8.6.7 doc screenshots as backup |

---

## After demo

- Leave staging bookings **unchanged** (keep policy)
- Do **not** activate n8n workflows
- Log any failed step for a targeted proof slice — not ad-hoc fixes during the call

**Related:** [STAGE-8.7.1-MVP-READINESS-GAP-REVIEW.md](STAGE-8.7.1-MVP-READINESS-GAP-REVIEW.md) · [STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md](STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md) · [ROADMAP.md](ROADMAP.md) § 8.6.8
