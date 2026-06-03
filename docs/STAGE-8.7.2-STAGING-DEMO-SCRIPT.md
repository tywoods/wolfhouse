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
| Staff API revision (8.7.9) | `wh-staging-staff-api--0000025` |
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

1. Click **Bed Calendar** — calendar auto-loads **Next 30 days** on first open (Stage 8.7.8; no manual Load click required for default range)
2. For golden booking demo range, set **From** `2026-07-28`, **To** `2026-08-10` → **Load** (or use **Jul – Aug** chip if present)
3. Click block **MB-WOLFHO-20260801-4f10c3 – Luna Test 855**

**Payment truth — confirm visible:**

| Check | Expected |
|-------|----------|
| Header | Booking code + **Deposit paid ✓** pill + **5 nights** (Stage 8.7.6/8.7.7 — no separate Guest/Stay headings) |
| Totals | Paid **€100.00** · Balance **€150.00** (compact payment rows, left-aligned amounts) |
| Payment row | **Paid ✓** · `paid_at` set · Stripe session/intent IDs · checkout URL copy |
| Beds | Summary line only (e.g. **DEMO-R1-B1, DEMO-R1-B2**) — no duplicate per-bed rows |
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

### Step 3 — Luna tab (~5 min)

1. Click **Luna**
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
| Ask Luna (portal UI) | **PASS (8.7.5)** | Ask button works on `--0000023`; `who still owes money` -> 4 rows; no console ReferenceErrors |
| Ask Luna (API, session) | **PASS** | Same session cookie: `Who still owes money?` → `payments.balance_due` / **4 rows**; `Who leaves today?` → `departures_today` / **0 rows**; `Which rooms need cleaning?` → `rooms_or_beds_need_cleaning` / **0 rows**; all `read_only:true`, `sends_whatsapp:false` |
| n8n inactive | **PASS** | `stage8510SharedDryRun01` + `stage863AskLuna01` both `active:false` |
| No live WhatsApp / Stripe / n8n from portal | **PASS** | No `graph.facebook.com`, `stripe.com`, or n8n URLs in session network log |

**UI notes (non-blocking):**

- Bed Calendar **defaults** to Next 30 days and **auto-loads** on first tab open (8.7.8) — golden booking (Aug 2026) still needs **Jul–Aug range** or manual dates + Load.
- Only **one** booking block in the demo date range — sparse but sufficient.
- Switching to **Luna** tab leaves the **booking drawer open** on the right — can distract; close drawer first or call out as known UX.
- Departures/cleaning **empty on demo day** (2026-06-03) is expected — explain date-driven SQL.

**Demo-day workaround until click handlers fixed:** ~~do not rely on the Ask button~~ **Resolved in Stage 8.7.4; proven on staging in 8.7.5** (`--0000023`).

---

## Hosted click-handler proof — Stage 8.7.5 (2026-06-03)

**Result:** **PASS** — 8.7.3 UI blocker cleared on hosted staging.

| Check | Result | Notes |
|-------|--------|-------|
| Deploy | **PASS** | `wh-staff-api:fdb1e36-stage875-click-handlers` · ACR `cbh` · revision `--0000023` |
| Console globals | **PASS** | `typeof window.alAsk/switchToTab/switchToTabOnly` → `function`; no ReferenceErrors |
| Today → Needs Human | **PASS** | `conversations` / `handoffs` |
| Today → Open Conversations | **PASS** | `conversations` / `inbox` |
| Today → Bed Calendar | **PASS** | `bed-calendar` tab active |
| Ask Luna button | **PASS** | `POST /staff/ask-luna` · `source:staff_portal` · `payments.balance_due` · **4 rows** |
| Safety | **PASS** | No `graph.facebook.com`, no `api.stripe.com`, no n8n URLs; n8n workflows inactive; no live send |

**Drawer layout (8.7.6 — deploy pending):** Header shows status + nights; Guest/Stay labels removed; bed assignments summarized; payment amounts compact. **Proven on staging in 8.7.7** (`--0000024`).

---

## Hosted drawer cleanup proof — Stage 8.7.7 (2026-06-03)

**Result:** **PASS** — cleaned drawer live on staging.

| Check | Result | Notes |
|-------|--------|-------|
| Deploy | **PASS** | `wh-staff-api:b223cea-stage877-drawer-cleanup` · ACR `cbj` · revision `--0000024` |
| No Guest heading | **PASS** | No `<h3>Guest</h3>` in drawer |
| No Stay heading | **PASS** | No `<h3>Stay</h3>` in drawer |
| No duplicate bed rows | **PASS** | `ctx-bed-row` count 0; Beds summary only (`DEMO-R1-B1`) |
| Header meta | **PASS** | `#bc-detail-meta`: **Deposit paid ✓** + **5 nights** |
| Payment layout | **PASS** | `.ctx-pay-row` uses compact grid (`108px` label column) |
| Luna confirmation draft | **PASS** | `#bc-luna-confirmation-draft` visible; draft fields present |
| No send button | **PASS** | No confirmation send control |
| Safety | **PASS** | `GET /staff/bookings/MB-WOLFHO-20260801-4f10c3/context` only; no stripe.com / graph.facebook.com / n8n |

---

## Hosted Bed Calendar UX proof — Stage 8.7.9 (2026-06-03)

**Result:** **PASS** — auto-load + selection fixes live on staging.

| Check | Result | Notes |
|-------|--------|-------|
| Deploy | **PASS** | `wh-staff-api:d50da7e-stage879-bed-calendar-ux` · ACR `cbk` · revision `--0000025` |
| Auto-load Next 30 days | **PASS** | Tab open → `2026-06-03`→`2026-07-03` · chip **Next 30 days** active · grid rendered without manual Load |
| Load button | **PASS** | `#bc-load` still present |
| Empty cell select | **PASS** | `#bc-sel-panel` opens |
| Cell toggle deselect | **PASS** | Re-click clears selection; panel hides when none remain |
| Booking click | **PASS** | Manual panel closes; `#bc-detail` visible with golden booking |
| Safety | **PASS** | `/staff/bed-calendar` + `/staff/bookings/.../context` only; no stripe.com / Facebook / n8n |

---

## Hosted UI cleanup proof — Stage 8.7.12 (2026-06-03)

**Result:** **PASS** — 8.7.10 nav labels + 8.7.11 payment/add-ons live on staging.

| Check | Result | Notes |
|-------|--------|-------|
| Deploy | **PASS** | `wh-staff-api:039afdf-stage8712-ui-cleanup` · ACR `cbm` · revision `--0000026` · 100% traffic |
| Preflight | **PASS** | `039afdf`; query-ui 60/60; bed-calendar-ui 328/328 |
| Nav labels | **PASS** | Today · Inbox · Bed Calendar · **Luna** · Tour Operator · Developer Tools; Luna tab no bot emoji |
| Luna tab | **PASS** | Hero **Luna**; Ask button; `POST /staff/ask-luna` → `payments.balance_due` / 4 rows / `sends_whatsapp:false` |
| Golden booking drawer | **PASS** | Range `2026-07-28`→`2026-08-10`; `MB-WOLFHO-20260801-4f10c3`; `.ctx-pay-box` 340px contained; Total / Deposit required / Booking paid / Balance due; confirmation draft; no send button |
| Manual add-ons | **PASS** | `#bk-ao-meals` present; “on-site / not priced in quote yet”; compact grid CSS in served UI; meals visual-only (not in `buildAddOns()`) |
| Safety | **PASS** | `/staff/bed-calendar` + `/staff/bookings/.../context` + `/staff/ask-luna` only; no stripe.com / graph.facebook.com / n8n |

---

## UI cleanup — Stage 8.7.11 (2026-06-03)

**Result:** **PASS** — implemented in `039afdf`; proven on staging in 8.7.12 (see above).

| Check | Result | Notes |
|-------|--------|-------|
| Payment contained box | **PASS** | `.ctx-pay-box` wraps Payment section; max-width ~340px left-aligned |
| No full-width green stretch | **PASS** | Payment records use `.ctx-pay-record` classes, not drawer-width inline cards |
| Payment truth fields | **PASS** | Total, deposit, booking paid, balance, amount due/paid, paid_at, session/intent, checkout URL |
| Luna confirmation draft | **PASS** | `#bc-luna-confirmation-draft` unchanged |
| Add-ons compact layout | **PASS** | Grid rows; labels left-aligned (no `flex:1` gap) |
| Meals add-on | **PASS** | `#bk-ao-meals` qty input + “on-site / not priced in quote yet” note |
| Meals pricing | **VISUAL-ONLY** | Not in `buildAddOns()` — not sent to quote API |
| Safety | **PASS** | UI-only; no graph.facebook.com / n8n / Stripe API calls |

---

## Inbox filter — Stage 8.7.13 (2026-06-03, not yet deployed)

**Result:** **PASS** — Needs Human is an Inbox filter, not a separate page.

| Check | Result | Notes |
|-------|--------|-------|
| Nav labels | **PASS** | Unchanged: Today · Inbox · Bed Calendar · Luna · Tour Operator · Developer Tools |
| Today → Needs Human | **PASS** | Switches to Inbox tab + **Needs human** filter (no separate sub-page) |
| Filter controls | **PASS** | **All conversations** · **Needs human** chips in Inbox toolbar |
| Layout | **PASS** | Single `inbox-two-col` — no `hq-list` / `hq-right` duplicate |
| Auto-select | **PASS** | Top conversation selected when filtered list has rows |
| Empty state | **PASS** | “No conversations need staff review right now.” |
| Safety | **PASS** | Client-side filter on `/staff/conversations`; no `/staff/handoffs` UI fetch; no WhatsApp/n8n/Stripe |

---

## Hosted Staff Portal parse fix proof — Stage 8.7.21 (2026-06-03)

**Result:** **PASS** — 8.7.20 fix live on staging; Today tiles, nav, and Ask Luna restored.

| Check | Result | Notes |
|-------|--------|-------|
| Deploy | **PASS** | `wh-staff-api:6790bef-stage8721-portal-parse-fix` · ACR `cbr` · revision `--0000030` |
| Preflight | **PASS** | `6790bef`; `verify-staff-query-ui.js` 64/64; `verify-staff-bed-calendar-ui.js` 366/366 |
| Console | **PASS** | No `Uncaught SyntaxError`; no `Unexpected token` |
| Globals | **PASS** | `typeof window.switchToTab/switchToTabOnly/alAsk` → `function` |
| Today → Needs Human | **PASS** | Switches to Inbox / conversations tab |
| Today → Open Conversations | **PASS** | Switches to Inbox / conversations tab |
| Today → Bed Calendar | **PASS** | `bed-calendar` tab active |
| Nav tabs | **PASS** | Today, Inbox, Bed Calendar, Luna, Tour Operator, Developer Tools all switch |
| Ask Luna button | **PASS** | `POST /staff/ask-luna` · `source:staff_portal` · `payments.balance_due` · **4 rows** |
| Bed Calendar auto-load | **PASS** | `2026-06-03`–`2026-07-03`; grid visible with rows |
| Manual booking form | **PASS** | `.bk-compact-grid` present; no add-on checkboxes |
| Tour Operator forms | **PASS** | Start/end + room select; no Nights/Beds fields; Create disabled |
| Safety | **PASS** | No graph.facebook.com / api.stripe.com / n8n URL fetch; no WhatsApp send |

---

## Staff Portal script parse fix — Stage 8.7.20 (2026-06-03)

**Result:** **PASS** — local UI-only; **deployed in 8.7.21** (`--0000030`).

| Check | Result | Notes |
|-------|--------|-------|
| Root cause | **PASS** | Missing `}` closing `if (_notice)` in `renderBedCalendar()` (8.7.17 Tour Operator edit) |
| Symptom | **PASS** | Hosted console: `Uncaught SyntaxError: Unexpected token ')'` ~ui:3291; script fails to parse |
| Impact | **PASS** | `switchToTab` / `switchToTabOnly` / `alAsk` never registered; Today tiles + nav + Ask Luna broken |
| Fix | **PASS** | Added closing `}` before `toRefreshRoomSelects()` call |
| Embedded parse | **PASS** | Verifiers extract UI `<script>` IIFE and `vm.Script` parse-check (stub `${STAFF_ACTIONS_ENABLED}` etc.) |
| Globals | **PASS** | `window.switchToTab`, `window.switchToTabOnly`, `window.alAsk` present in embedded script |
| Verifier | **PASS** | `verify-staff-query-ui.js` 64/64; `verify-staff-bed-calendar-ui.js` 366/366 |
| Safety | **PASS** | UI-only; no backend routes; no WhatsApp/n8n/Stripe/Azure |

---

## Hosted Tour Operator + manual form cleanup proof — Stage 8.7.19 (2026-06-03)

**Result:** **PASS** — 8.7.17 + 8.7.18 live on staging.

| Check | Result | Notes |
|-------|--------|-------|
| Deploy | **PASS** | `wh-staff-api:a4f14b8-stage8719-operator-manual-form-cleanup` · ACR `cbq` · revision `--0000029` |
| Preflight | **PASS** | `a4f14b8`; verifier 364/364 |
| Tour Operator Block | **PASS** | Start/end dates; room `<select>`; Nights/Beds/Block type/Est guest count/defaults removed; Create/Preview disabled |
| Operator Room Release | **PASS** | Block `<select>`; release start/end; room `<select>`; beds/release type/defaults removed; Release/Preview disabled |
| Manual booking Guest | **PASS** | `.bk-compact-grid`; name/phone/email `bk-input-sm` (not full-width) |
| Manual booking Payment | **PASS** | `.bk-compact-grid`; inputs left-aligned with add-ons |
| Room type | **PASS** | Shared + Private only; Double absent |
| Safety | **PASS** | No graph.facebook.com / n8n / Stripe / operator create-release fetch |

---

## Manual booking guest + payment alignment — Stage 8.7.18 (2026-06-03)

**Result:** **PASS** — local UI-only; not deployed.

| Check | Result | Notes |
|-------|--------|-------|
| Guest layout | **PASS** | `.bk-compact-grid` — labels + fields left-aligned (max-width 440px) |
| Payment layout | **PASS** | Same compact grid; no 148px label gutter |
| Guest fields | **PASS** | name/phone/email use `bk-input-sm`, not full-width |
| Room type | **PASS** | Shared + Private only; Double removed |
| Quote payload | **PASS** | `runQuotePreview` still uses `bk-room-type` |
| Verifier | **PASS** | 364/364 |
| Safety | **PASS** | UI-only; no WhatsApp/n8n/Stripe |

---

## Tour Operator form simplification — Stage 8.7.17 (2026-06-03)

**Result:** **PASS** — local UI-only; not deployed.

| Check | Result | Notes |
|-------|--------|-------|
| Block form | **PASS** | Start/end dates + room `<select>`; operator contact + notes kept |
| Removed (block) | **PASS** | Nights, Beds, Block type, Est guest count, visible defaults |
| Room release | **PASS** | Operator block dropdown; read-only block dates; release start/end editable |
| Removed (release) | **PASS** | Beds to release, Release type, visible defaults |
| Buttons | **PASS** | Create/Preview/Release all disabled |
| Verifier | **PASS** | `verify-staff-bed-calendar-ui.js` 354/354 |
| Safety | **PASS** | No create/release fetch; no WhatsApp/n8n/Stripe |

**Gaps (documented):** Operator block list and room options use placeholders until dedicated API endpoints; rooms populate from Bed Calendar when loaded.

---

## Hosted manual booking add-ons layout proof — Stage 8.7.16 (2026-06-03)

**Result:** **PASS** — Create Manual Booking notes/add-ons layout clean on staging.

| Check | Result | Notes |
|-------|--------|-------|
| Deploy | **PASS** | `wh-staff-api:acb2bd0-stage8716-manual-addons-layout` · ACR `cbp` · revision `--0000028` |
| Preflight | **PASS** | `acb2bd0`; `verify-staff-bed-calendar-ui.js` 350/350 |
| Notes layout | **PASS** | `.bk-notes-block` — label + textarea stacked left (same x-offset ~45px) |
| Add-ons checkboxes | **PASS** | None — qty spinbuttons only |
| Qty defaults | **PASS** | All add-on inputs default to `0` |
| Unit labels | **PASS** | days / lessons / classes / meals visible beside inputs |
| Compact alignment | **PASS** | Add-on names + qty fields left-aligned, close together |
| Meals visual-only | **PASS** | Meals row present; note “on-site / not priced in quote yet”; quote unchanged when meals qty = 10 |
| Quote add-ons | **PASS** | Wetsuit 3d + surf 2 + yoga 1: total €80.00 → €170.00 (line items present) |
| Safety | **PASS** | Session fetches: `/staff/bed-calendar`, `/staff/quote-preview` only; no graph.facebook.com / n8n / Stripe |

---

## Manual booking notes + add-ons layout — Stage 8.7.15 (2026-06-03)

**Result:** **PASS** — local UI patch only; not deployed.

| Check | Result | Notes |
|-------|--------|-------|
| Notes layout | **PASS** | `.bk-notes-block` — label + textarea stacked left (max-width 420px) |
| Add-ons alignment | **PASS** | Compact left-aligned `.bk-ao-grid` rows |
| Checkboxes removed | **PASS** | Qty-only; default `0`; qty > 0 selects add-on |
| Unit labels | **PASS** | days / lessons / classes / meals visible beside inputs (`.bk-ao-unit`) |
| buildAddOns | **PASS** | `aoQtyInput()` + `> 0`; no `.checked` |
| Meals | **PASS** | Visual-only — `#bk-ao-meals` + on-site note; excluded from `buildAddOns()` |
| Verifier | **PASS** | `node scripts/verify-staff-bed-calendar-ui.js` |
| Safety | **PASS** | UI-only; no graph.facebook.com / n8n / Stripe / Azure deploy |

---

## Hosted Inbox filter proof — Stage 8.7.14 (2026-06-03)

**Result:** **PASS** — Needs Human is an Inbox filter on staging.

| Check | Result | Notes |
|-------|--------|-------|
| Deploy | **PASS** | `wh-staff-api:3a431c0-stage8714-inbox-filter` · ACR `cbn` · revision `--0000027` |
| Preflight | **PASS** | `3a431c0`; verifier 82 PASS (+3 known pre-existing monolith failures) |
| Inbox layout | **PASS** | `inbox-two-col`; filter chips **All conversations** / **Needs human** |
| Auto-select | **PASS** | Top conversation detail loads on open |
| Today → Needs Human | **PASS** | Stays in Inbox tab; needs-human filter active; **1** conversation shown (of 3 total) |
| All conversations | **PASS** | Filter returns full list (**3** conversations) |
| Old separate page | **PASS** | No `subtab-handoffs`, `hq-list`, `hq-right`, `hq-table` |
| Safety | **PASS** | `/staff/conversations` only; no graph.facebook.com / n8n / Stripe; no pause/resume controls |

---

## Pre-demo checklist (5 min before call)

- [ ] Staff Portal login works
- [ ] Bed Calendar auto-loads on first tab open (Next 30 days)
- [ ] Golden booking visible in range `2026-07-28` → `2026-08-10`
- [ ] Drawer shows **Deposit paid ✓** + **Luna confirmation draft ready**
- [ ] Ask Luna **Ask button** works (not just API fetch)
- [ ] Today tiles navigate (Needs Human / Open Conversations / Bed Calendar)
- [ ] n8n workflows `stage8510SharedDryRun01` and `stage863AskLuna01` still **`active: false`**
- [ ] No workflow activation planned during demo

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Booking block not visible | Widen date range; confirm `wolfhouse-somo` client |
| No confirmation draft panel | Wrong booking — use **4f10c3** only for draft story |
| Ask Luna button silent | Fixed 8.7.4 / proven 8.7.5 on `--0000023` |
| Today tile clicks fail | Fixed 8.7.4 / proven 8.7.5 on `--0000023` |
| Ask Luna empty on departures/cleaning | Normal if no check-outs **today**; explain date-driven SQL |
| Manual booking buttons greyed | Flags off — quote-only demo |
| n8n execution list empty | Use Stage 8.5.12 / 8.6.7 doc screenshots as backup |

---

## After demo

- Leave staging bookings **unchanged** (keep policy)
- Do **not** activate n8n workflows
- Log any failed step for a targeted proof slice — not ad-hoc fixes during the call

**Related:** [STAGE-8.7.1-MVP-READINESS-GAP-REVIEW.md](STAGE-8.7.1-MVP-READINESS-GAP-REVIEW.md) · [STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md](STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md) · [ROADMAP.md](ROADMAP.md) § 8.6.8
