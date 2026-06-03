# Stage 8.7.2 — Staging Demo Script (Wolfhouse / Luna)

**Status:** **DEMO-READY** on `wh-staging-staff-api--0000038` (2026-06-03, Stage 8.8.22 addon_service webhook proof live).  
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
| Staff API revision | `wh-staging-staff-api--0000037` |
| n8n editor (read-only for demo) | `https://wh-staging-n8n-main.braveplant-5c685569.northeurope.azurecontainerapps.io/home` |
| Golden booking | `MB-WOLFHO-20260801-4f10c3` · check-in **2026-08-01** · check-out **2026-08-06** |
| Bed Calendar date range | **From** `2026-07-28` **To** `2026-08-10` → click **Load** (or **Jul – Aug** chip) |

**Range chips (8.7.23):** This week · Next 30 days (default auto-load) · Jul – Aug — **Today chip removed**.

**Selected Stay (8.7.25):** Check-in · Check-out · Nights + bed chips (room/bed) — **Room and Bed field rows removed** (redundant with chips).

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

## Hosted Ask Luna service-record query proof — Stage 8.8.12 (2026-06-03)

**Result:** **PASS** — Stage 8.8.11 service intents live on staging revision `--0000035` (`ef122ac`).

| Check | Result | Notes |
|-------|--------|-------|
| Deploy | **PASS** | `wh-staff-api:ef122ac-stage8812-service-queries` · ACR `cbw` · revision `--0000035` · Healthy · 100% traffic |
| Preflight | **PASS** | `ef122ac`; `verify-staff-ask-luna-api.js` 118/118 |
| Who paid for yoga today? | **PASS** | `services.yoga.paid_on_date` · 1 row · Demo Yoga Guest 888 |
| Who paid for yoga tomorrow? | **PASS** | `services.yoga.paid_on_date` · 1 row |
| Who paid for meals tomorrow? | **PASS** | `services.meal.paid_on_date` · 1 row |
| Who paid for meals on June 15? | **PASS** | `services.meal.paid_on_date` · 1 row (qty 2) |
| Who has a lesson today? | **PASS** | `services.surf_lesson.on_date` · 1 row · paid lesson |
| Who has a lesson on June 15? | **PASS** | `services.surf_lesson.on_date` · 1 row · pending lesson |
| Who needs a wetsuit today? | **PASS** | `services.wetsuit.on_date` · 2 rows |
| How many wetsuits ready today? | **PASS** | `services.wetsuit.count_on_date` · **3** · “3 wetsuits needed today.” |
| Who needs a surfboard today? | **PASS** | `services.surfboard.on_date` · 2 rows |
| How many surfboards ready today? | **PASS** | `services.surfboard.count_on_date` · **4** · “4 surfboards needed today.” |
| Who still needs to pay? | **PASS** | `payments.balance_due` · **4 rows** (regression) |
| Who leaves today? | **PASS** | `departures_today` · 0 rows (regression) |
| Quien sale hoy? | **PASS** | `departures_today` · 0 rows (regression) |
| Which rooms need cleaning? | **PASS** | `rooms_or_beds_need_cleaning` · 0 rows (regression) |
| Safety | **PASS** | All responses `read_only:true` · `no_write_performed:true` · `sends_whatsapp:false`; structured `booking_service_records` only for service answers; no graph.facebook.com / n8n / api.stripe.com |

**Optional demo add-on (Luna tab):** Try *“How many wetsuits do we need ready today?”* (count **3**) and *“Who paid for yoga tonight?”* (same as today) to show structured service data vs legacy booking queries.

---

## Hosted booking drawer service-record proof — Stage 8.8.15 (2026-06-03)

**Result:** **PASS** — Stage 8.8.14 drawer panel live on staging revision `--0000036` (`ab67ea8`).

| Check | Result | Notes |
|-------|--------|-------|
| Deploy | **PASS** | `wh-staff-api:ab67ea8-stage8815-service-records-drawer` · ACR `cbx` · revision `--0000036` · Healthy · 100% traffic |
| Preflight | **PASS** | `ab67ea8`; `verify-staff-bed-calendar-ui.js` 406/406 |
| Golden booking drawer | **PASS** | `MB-WOLFHO-20260801-4f10c3` · Bed Calendar 2026-07-28 → 2026-08-10 |
| Services & Add-ons panel | **PASS** | Section renders below Payment |
| Empty state | **PASS** | *“No services/add-ons recorded for this booking.”* |
| Payment truth | **PASS** | Deposit paid · €250 total · €100 paid · €150 balance · paid_at + session/intent |
| Luna confirmation draft | **PASS** | Gate 2684# · `sends_whatsapp:false` · no send button |
| Context API | **PASS** | `service_records:[]` · `service_records_available:true` |
| Demo fixture context | **GAP** | `DEMO-SVC-888-YOGA-TODAY` → **404** (no `bookings` row for fixture codes) |
| Populated drawer rows | **DEFERRED** | Needs **8.8.16** booking-create writes to tie service records to real bookings |
| Ask Luna regression | **PASS** | `Who paid for yoga today?` → `services.yoga.paid_on_date` · 1 row |
| Safety | **PASS** | Read-only drawer; no Add/Edit/Send/payment-link in service panel; no DB writes / WhatsApp / n8n / Stripe from session |

**Optional demo add-on (Bed Calendar):** Open **`MB-WOLFHO-20260901-cb4799`** (Sep 1–8 2026 range) — Services panel shows **wetsuit + yoga paid**, **surf lesson pending** (Stage 8.8.22 webhook proof).

---

## Hosted addon_service webhook proof — Stage 8.8.22 (2026-06-03)

**Result:** **PASS** — Stage 8.8.21 webhook branch live on staging revision `--0000038` (`fb9a9d9`).

| Check | Result | Notes |
|-------|--------|-------|
| Deploy | **PASS** | `wh-staff-api:fb9a9d9-stage8822-addon-service-webhook` · ACR `cb10` · revision `--0000038` · Healthy · 100% traffic |
| Preflight | **PASS** | `fb9a9d9`; `verify-staff-stripe-webhook-api.js` 92/92 |
| Proof payment | **PASS** | `payment_id:3318b16c-506a-4277-9c75-4ec588f797e1` · `payment_kind=addon_service` · €30.00 (yoga €15 + wetsuit €15) · `checkout_created` → webhook |
| Service linkage | **PASS** | Linked yoga + wetsuit rows on `MB-WOLFHO-20260901-cb4799`; surf lesson left unlinked (`pending`) |
| Webhook | **PASS** | Signed `checkout.session.completed` → **200** · `addon_service_payment:true` · `service_records_paid_count:2` · `no_booking_payment_status_change:true` · `no_confirmation_sent/no_whatsapp/no_n8n:true` |
| DB proof | **PASS** | Payment `paid` · `amount_paid_cents=3000` · `paid_at` set · linked rows `payment_status=paid` · surf lesson still `pending` · booking `payment_status=not_requested` unchanged · `confirmation_sent_at` null |
| Idempotency | **PASS** | Replay → **200** · `idempotent:true` · `service_records_paid_count:2` stable |
| Drawer proof | **PASS** | Context API: wetsuit + yoga **paid**; surf lesson **pending**; booking payment panel unchanged (`not_requested`) |
| Ask Luna | **PASS** | “Who paid for yoga on September 1 2026?” → `services.yoga.paid_on_date` · 1 row · **Stage8817 Addon Test** |
| Cleanup | **LEFT** | Proof payment + linkage on staging (disposable evidence on existing test booking) |
| Safety | **PASS** | Staging only; HMAC-valid webhook (no SKIP_VERIFY); no WhatsApp/n8n/confirmation send; no booking payment mutation |

---

## Hosted manual add-ons → service records proof — Stage 8.8.17 (2026-06-03)

**Result:** **PASS** — Stage 8.8.16 write path live on staging revision `--0000037` (`7fd3ea0`).

| Check | Result | Notes |
|-------|--------|-------|
| Deploy | **PASS** | `wh-staff-api:7fd3ea0-stage8817-manual-addons-service-records` · ACR `cby` · revision `--0000037` · Healthy · 100% traffic |
| Preflight | **PASS** | `7fd3ea0`; `verify-staff-manual-booking-create-api.js` 65/65 |
| Manual create | **PASS** | Guest **Stage8817 Addon Test** · Malibu 7n · deposit · wetsuit 3d + 2 lessons + 1 yoga |
| Create response | **PASS** | `MB-WOLFHO-20260901-cb4799` · `payment_id` returned · `service_records_created:3` · `service_records_available:true` · `no_stripe/no_whatsapp/no_n8n:true` |
| DB proof | **PASS** | 3 rows: `wetsuit`/`surf_lesson`/`yoga` · `booking_id` linked · `source=staff_manual` · `status=confirmed` · `payment_status=pending` · `needs_scheduling` on lesson/yoga · `rental_days:3` on wetsuit · no meal rows |
| Drawer proof | **PASS** | Services & Add-ons shows Surf lesson + Wetsuit + Yoga with amounts; Payment panel intact; no Add/Edit/Send/payment-link in service panel |
| Ask Luna wetsuit | **PASS** | “Who needs a wetsuit on September 1 2026?” → `services.wetsuit.on_date` · **Stage8817 Addon Test** |
| Ask Luna lesson | **PASS** | “Who has a lesson on September 1 2026?” → `services.surf_lesson.on_date` · **Stage8817 Addon Test** |
| Cleanup | **LEFT** | Disposable test booking **`MB-WOLFHO-20260901-cb4799`** kept on staging (evidence chain) |
| Safety | **PASS** | Staging only; no production; no WhatsApp/n8n; payment draft only; no service row `paid` |

---

## Hosted multilingual Ask Luna router proof — Stage 8.8.5 (2026-06-03)

**Result:** **PASS** — Stage 8.8.4 multilingual intent router live on staging revision `--0000034` (`3193636`).

| Check | Result | Notes |
|-------|--------|-------|
| Deploy | **PASS** | `wh-staff-api:3193636-stage885-multilingual-ask-luna` · ACR `cbv` · revision `--0000034` · Healthy · 100% traffic |
| Preflight | **PASS** | `3193636`; `verify-staff-ask-luna-api.js` 99/99 |
| Who leaves today? | **PASS** | `departures_today` · 0 rows |
| who's room needs to be cleaned? | **PASS** | `rooms_or_beds_need_cleaning` · 0 rows |
| Quien sale hoy? | **PASS** | `departures_today` · 0 rows |
| Cual cuartos tengo que limpiar hoy? | **PASS** | `rooms_or_beds_need_cleaning` · 0 rows |
| Chi parte oggi? | **PASS** | `departures_today` · 0 rows |
| Welche Zimmer müssen heute gereinigt werden? | **PASS** | `rooms_or_beds_need_cleaning` · 0 rows |
| Qui part aujourd'hui? | **PASS** | `departures_today` · 0 rows |
| Who still needs to pay? | **PASS** | `payments.balance_due` · **4 rows** |
| Quien debe pagar? | **PASS** | `payments.balance_due` · **4 rows** |
| Who is checking in tomorrow? | **PASS** | `check_ins.on_date` · regression |
| How many people are checking out on Saturday? | **PASS** | `check_outs.count` · regression |
| Which rooms need cleaning? | **PASS** | `rooms_or_beds_need_cleaning` · regression |
| Who paid for yoga tonight? | **PASS** | `unsupported_intent` · add-on gap message |
| Who needs a wetsuit today? | **PASS** | `unsupported_intent` · add-on gap message |
| Safety | **PASS** | All responses `read_only:true` · `no_write_performed:true` · `sends_whatsapp:false`; Luna tab UI loads (`alAsk`); no graph.facebook.com / n8n URL / api.stripe.com from Luna session |

**Optional demo add-on (Luna tab):** Try one multilingual question (e.g. *“Quien sale hoy?”*) and one blocked add-on (*“Who paid for yoga tonight?”*) to show i18n routing vs structured-records gap.

---

## Hosted Ask Luna date-query proof — Stage 8.8.3 (2026-06-03)

**Result:** **PASS** — Stage 8.8.2 date-aware intents live on staging revision `--0000033` (`b7c74c8`).

| Check | Result | Notes |
|-------|--------|-------|
| Deploy | **PASS** | `wh-staff-api:b7c74c8-stage883-ask-luna-date-queries` · ACR `cbu` · revision `--0000033` · Healthy · 100% traffic |
| Preflight | **PASS** | `b7c74c8`; `verify-staff-ask-luna-api.js` 80/80 |
| Who checking in today? | **PASS** | `check_ins.on_date` · `query_date:2026-06-03` · 0 rows · “No guests are checking in today.” |
| Who checking in tomorrow? | **PASS** | `check_ins.on_date` · `query_date:2026-06-04` · 0 rows |
| How many check in tomorrow? | **PASS** | `check_ins.count` · “0 guests checking in tomorrow.” · UI: `CHECK_INS.COUNT • ARRIVALS` |
| Who checking out today? | **PASS** | `check_outs.on_date` · `query_date:2026-06-03` · 0 rows *(“Who leaves today?” still → `departures_today`)* |
| Who checking out tomorrow? | **PASS** | `check_outs.on_date` · `query_date:2026-06-04` |
| How many check out tomorrow? | **PASS** | `check_outs.count` · “0 guests checking out tomorrow.” |
| How many check out Saturday? | **PASS** | `check_outs.count` · `query_date:2026-06-06` |
| Who checking in June 15? | **PASS** | `check_ins.on_date` · `query_date:2026-06-15` |
| Who still owes money? | **PASS** | `payments.balance_due` · **4 rows** (regression) |
| Which rooms need cleaning? | **PASS** | `rooms_or_beds_need_cleaning` · 0 rows (regression) |
| Who paid for yoga tonight? | **PASS** | `unsupported_intent` · add-on gap message (not chat-log guess) |
| Who needs a wetsuit today? | **PASS** | `unsupported_intent` · add-on gap message |
| Safety | **PASS** | All responses `read_only:true` · `no_write_performed:true` · `sends_whatsapp:false`; no graph.facebook.com / n8n URL / api.stripe.com from Luna tab session |

**Optional demo add-on (Luna tab):** After core Step 4, try one date question (e.g. *“How many people check in tomorrow?”*) and one blocked add-on (*“Who paid for yoga tonight?”*) to show structured-data vs not-yet-implemented paths.

---

## Final demo-ready confirmation — Stage 8.7.27 (2026-06-03)

**Result:** **PASS — DEMO-READY** on revision `--0000032` (`b2a3b9f`). Full core demo path verified after 8.7.23–8.7.26 Bed Calendar polish batch.

| Area | Result | Notes |
|------|--------|-------|
| Hard refresh | **PASS** | `/staff/ui` reload clean |
| Nav | **PASS** | Today · Inbox · Bed Calendar · Luna · Tour Operator · Developer Tools |
| Today tiles | **PASS** | Needs Human · Open Conversations · Bed Calendar |
| Inbox filters | **PASS** | All conversations · Needs human **1**; top conversation auto-selected |
| Bed Calendar | **PASS** | Next 30 auto-load; no Today chip; manual form clean (check-in/out/nights + chips only) |
| Golden booking | **PASS** | Jul–Aug range → `MB-WOLFHO-20260801-4f10c3`; Deposit paid ✓; €100 paid / €150 balance; Luna draft + 2684# |
| Luna · who owes | **PASS** | `payments.balance_due` · **4 rows** |
| Luna · departures | **PASS** | `departures_today` · 0 rows |
| Luna · cleaning | **PASS** | `rooms_or_beds_need_cleaning` · 0 rows |
| Tour Operator | **PASS** | Simplified forms; Preview/Create/Release disabled |
| Safety | **PASS** | No graph.facebook.com / n8n URL fetch / api.stripe.com; Approve & Send disabled; no write routes |

**Demo-ready:** Ale/Cami shadow demo on staging is cleared to run from [core demo path](#core-demo-path-15-min) without UI blockers.

---

## Hosted Bed Calendar final polish proof — Stage 8.7.26 (2026-06-03)

**Result:** **PASS** — 8.7.23–8.7.25 Bed Calendar range + Selected Stay polish live on staging.

| Check | Result | Notes |
|-------|--------|-------|
| Deploy | **PASS** | `wh-staff-api:b2a3b9f-stage8726-bed-calendar-final-polish` · ACR `cbt` · revision `--0000032` |
| Preflight | **PASS** | `b2a3b9f`; `verify-staff-bed-calendar-ui.js` 391/391 |
| Bed Calendar tab | **PASS** | Tab opens; grid rendered |
| Auto-load Next 30 | **PASS** | `2026-06-03`–`2026-07-03`; Next 30 days chip active |
| Today chip removed | **PASS** | No `data-chip="today"` |
| Range chips | **PASS** | This week · Next 30 days · Jul – Aug |
| Load button | **PASS** | 📅 Load present |
| Empty-cell select | **PASS** | Manual booking panel opens (`bc-sel-panel`) |
| Selected Stay layout | **PASS** | `.bk-compact-grid` left-aligned; max-width 440px |
| Stay fields | **PASS** | check-in / check-out / nights populate; **no Room or Bed rows** |
| Bed chips | **PASS** | `.bc-sel-bed-tag` e.g. `DEMO-R1 / DEMO-R1-B1` |
| Safety | **PASS** | No graph.facebook.com / n8n URL fetch / api.stripe.com; no write routes from UI session |

---

## Selected Stay — remove redundant Room field — Stage 8.7.25 (2026-06-03)

**Result:** **PASS** — local UI-only; **deployed in 8.7.26** (`--0000032`).

| Check | Result | Notes |
|-------|--------|-------|
| Room field row | **PASS** | No `bc-sel-room` in Selected Stay HTML |
| Bed field row | **PASS** | No `bc-sel-bed` (from 8.7.24) |
| Stay fields kept | **PASS** | check-in / check-out / nights |
| Bed chips | **PASS** | `#bc-sel-beds-list` + `.bc-sel-bed-tag` with room/bed |
| Selection logic | **PASS** | `bcSelectedBeds` + cell click handler unchanged |
| Quote/create payload | **PASS** | `selected_bed_codes` from `bcSelectedBeds.map(...)` |
| Verifier | **PASS** | `verify-staff-bed-calendar-ui.js` 391/391 |
| Safety | **PASS** | No backend / WhatsApp / n8n / Stripe / Azure |

---

## Selected Stay — remove redundant Bed field — Stage 8.7.24 (2026-06-03)

**Result:** **PASS** — local UI-only; **not deployed** (batch with next redeploy).

| Check | Result | Notes |
|-------|--------|-------|
| Bed field row | **PASS** | No `bc-sel-bed` in Selected Stay HTML |
| Stay fields kept | **PASS** | check-in / check-out / nights / room |
| Bed chips | **PASS** | `#bc-sel-beds-list` + `.bc-sel-bed-tag` unchanged |
| Selection logic | **PASS** | `bcSelectedBeds` + cell click handler unchanged |
| Quote/create payload | **PASS** | `selected_bed_codes` from `bcSelectedBeds.map(...)` |
| Verifier | **PASS** | `verify-staff-bed-calendar-ui.js` 383/383 |
| Safety | **PASS** | No backend / WhatsApp / n8n / Stripe / Azure |

---

## Hosted Bed Calendar polish proof — Stage 8.7.24 (2026-06-03)

**Result:** **PASS** — 8.7.23 Bed Calendar range chips + Selected Stay layout polish live on staging.

| Check | Result | Notes |
|-------|--------|-------|
| Deploy | **PASS** | `wh-staff-api:1b3f822-stage8724-bed-calendar-polish` · ACR `cbs` · revision `--0000031` |
| Preflight | **PASS** | `1b3f822`; `verify-staff-bed-calendar-ui.js` 376/376 |
| Bed Calendar tab | **PASS** | Tab opens; grid rendered |
| Auto-load Next 30 | **PASS** | `2026-06-03`–`2026-07-03`; Next 30 days chip active |
| Today chip removed | **PASS** | No `data-chip="today"` |
| Range chips | **PASS** | This week · Next 30 days · Jul – Aug |
| Load button | **PASS** | 📅 Load present |
| Empty-cell select | **PASS** | Manual booking panel opens (`bc-sel-panel`) |
| Selected Stay layout | **PASS** | `.bk-compact-grid` left-aligned like Guest/Payment |
| Stay fields populate | **PASS** | check-in / check-out / nights / room / bed filled from selection |
| Bed chips | **PASS** | `.bc-sel-bed-tag` chips in `#bc-sel-beds-list` |
| Safety | **PASS** | No graph.facebook.com / n8n URL fetch / api.stripe.com; no write routes from UI session |

---

## Final full staging demo rehearsal — Stage 8.7.22 (2026-06-03)

**Result:** **PASS** — full demo script on `--0000030` after parse fix (8.7.20/8.7.21) and UI cleanup batch.

| Area | Result | Notes |
|------|--------|-------|
| Console | **PASS** | No SyntaxError / Unexpected token; no `switchToTab`/`alAsk` ReferenceErrors |
| Today → Needs Human | **PASS** | Inbox tab + **Needs human** filter active |
| Today → Open Conversations | **PASS** | Inbox tab + **All conversations** filter |
| Today → Bed Calendar | **PASS** | Bed Calendar tab active |
| Inbox auto-select | **PASS** | Top conversation selected on load |
| Inbox filters | **PASS** | Needs human **1** / All **3** |
| Bed Calendar auto-load | **PASS** | Next 30 days; grid rendered |
| Cell select/deselect | **PASS** | Empty cell toggles selection + panel |
| Manual booking layout | **PASS** | `.bk-compact-grid`, `.bk-notes-block`, qty-only add-ons |
| Golden booking drawer | **PASS** | `MB-WOLFHO-20260801-4f10c3` · Deposit paid ✓ · 5 nights · €100 paid / €150 balance |
| Drawer cleanup | **PASS** | No Guest/Stay headings; no duplicate ctx-bed-row; `.ctx-pay-box` |
| Luna confirmation draft | **PASS** | Panel visible · DEMO-R1 · 2684# · sends_whatsapp:false |
| Luna · who owes | **PASS** | `payments.balance_due` · 4 rows |
| Luna · departures | **PASS** | `departures_today` · 0 rows (expected for demo date) |
| Luna · cleaning | **PASS** | `rooms_or_beds_need_cleaning` · 0 rows |
| Tour Operator | **PASS** | Start/end + room select; Create/Preview/Release disabled |
| Safety | **PASS** | No graph.facebook.com / n8n / Stripe from UI session; no live send |

**Demo-ready:** Core path (Today → Inbox → Bed Calendar golden drawer → Luna ×3 → Tour Operator skeleton) is reliable on staging for Ale/Cami shadow demo.

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
