**8.8.26 HOSTED BOT ADDON PREVIEW PROOF -- PASS (2026-06-03):** Deployed `c22c787` → `wh-staff-api:c22c787-stage8826-bot-addon-preview` (ACR `cb12`), revision `wh-staging-staff-api--0000040` (Healthy, 100% traffic). Preflight: `verify-staff-bot-addon-request-api.js` **37/37 PASS**. Hosted bot token proofs on `MB-WOLFHO-20260901-cb4799`: A ask_service_date · B ask_quantity · C meal `meal_on_site_only` · D wetsuit €5 dry-run · E surf lesson 2×€30 bundle; DB no-write (3 service rows / 3 payments unchanged). No production/Stripe/WhatsApp/n8n. Doc: [STAGE-8.7.2 §8.8.26](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md). Next: 8.8.27 write path.

**8.8.25 BOT ADDON REQUEST DRY-RUN PREVIEW -- PASS (2026-06-03):** `POST /staff/bot/addon-request-preview` — Luna guest Flow B dry-run; `requireBotAuth`; validates booking/service/date/qty; read-only booking SELECT; returns previews + `reply_draft` + `next_action` (`ask_service_date`, `ask_quantity`, `booking_not_found`, `ready_for_addon_create_dry_run`, `ready_for_record_only`, `handoff_to_staff`); meals record-only (`meal_on_site_only`); pricing from Wolfhouse config when confirmed. Verifier **37/37 PASS**. **Hosted proof: 8.8.26.** Doc: [STAGE-8.8.6 §12.2](STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md).

**8.8.24 HOSTED ADDON SERVICE PAYMENT-LINK PROOF -- PASS (2026-06-03):** Deployed `62835c1` → `wh-staff-api:62835c1-stage8824-addon-service-payment-link` (ACR `cb11`), revision `wh-staging-staff-api--0000039` (Healthy, 100% traffic). Preflight: `verify-staff-addon-service-payment-api.js` **42/42 PASS**. Surf lesson `90d701db-f431-4264-9bec-33403fbf2772` on `MB-WOLFHO-20260901-cb4799` → `POST .../service-records/create-payment-link` → payment `a01c735e-ccbe-4a54-b70a-162b31df605b` (€60, `checkout_created`); idempotent link PASS; signed webhook → 200 (`addon_service_payment:true`, `service_records_paid_count:1`, `no_booking_payment_status_change:true`); yoga/wetsuit from 8.8.22 unchanged; all 3 services paid; drawer + Ask Luna lesson PASS; paid-only lesson filter **not supported** (routes to same intent). No production/WhatsApp/n8n/confirmation. Doc: [STAGE-8.7.2 §8.8.24](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md). Next: 8.8.25 bot add-on dry-run.

**8.8.23 ADDON SERVICE PAYMENT LINK API -- PASS (2026-06-03):** `POST /staff/bookings/:booking_id/service-records/create-payment-link` — gated staff endpoint creates `addon_service` payment + Stripe Checkout for selected `booking_service_records`; links rows via `payment_id`; amount from DB rows; idempotent on existing `checkout_created`; no booking payment mutation; no paid truth. Verifier `verify-staff-addon-service-payment-api.js` **42/42 PASS**. **Hosted proof: 8.8.24.** Doc: [STAGE-8.8.6 §12.2](STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md).

**8.8.22 HOSTED ADDON_SERVICE WEBHOOK PROOF -- PASS (2026-06-03):** Deployed `fb9a9d9` → `wh-staff-api:fb9a9d9-stage8822-addon-service-webhook` (ACR `cb10`), revision `wh-staging-staff-api--0000038` (Healthy, 100% traffic). Preflight: `verify-staff-stripe-webhook-api.js` 92/92 PASS. Proof payment `3318b16c-506a-4277-9c75-4ec588f797e1` (`addon_service`, €30) linked yoga+wetsuit on `MB-WOLFHO-20260901-cb4799`; signed HMAC webhook → 200 (`addon_service_payment:true`, `service_records_paid_count:2`, `no_booking_payment_status_change:true`); DB + idempotent replay + drawer context + Ask Luna yoga paid PASS; surf lesson pending; booking payment unchanged. No production/WhatsApp/n8n/confirmation. Doc: [STAGE-8.7.2 §8.8.22](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md). Next: 8.8.23 add-on checkout create.

**8.8.21 ADDON_SERVICE WEBHOOK SERVICE-RECORD PAYMENT TRUTH -- PASS (2026-06-03):** `POST /staff/stripe/webhook` `addon_service` branch — marks payment paid + linked `booking_service_records` by `payment_id`; no booking payment mutation; no confirmation_draft; idempotent; warning when zero linked rows. Verifier `verify-staff-stripe-webhook-api.js` **92/92 PASS**. **No Azure deploy / n8n / WhatsApp / add-on checkout create / full-payment allocation.** Next: deploy + hosted proof. Doc: [STAGE-8.8.6 §12.2](STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md).

**8.8.20 STAGING SERVICE PAYMENT LINKAGE APPLY -- PASS (2026-06-03):** Migration `011_service_payment_linkage.sql` applied to **staging Postgres only** (`wh-staging-pg-app` / `wolfhouse_staging`) via `node scripts/run-sql.js` + Key Vault `wolfhouse-database-url` (Ty-approved). **Not production.** Verified: `booking_service_records.payment_id` UUID nullable FK → `payments(id)`; `idx_booking_service_records_payment_id` partial index; `payment_kind` enum = `deposit_only`, `full_amount`, **`addon_service`**. Preserved: **11** demo fixture rows + **3** `MB-WOLFHO-20260901-cb4799` rows; **0** `payment_id` links; payment_status counts unchanged (6 paid demo, 6 pending, 2 not_requested). Pre-apply verifier **26/26 PASS**. No Staff API deploy / webhook / API / n8n / WhatsApp / Stripe. Next: 8.8.21 webhook allocation. Doc: [STAGE-8.8.6 §7](STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md).

**8.8.19 SERVICE PAYMENT LINKAGE SCHEMA SPEC -- PASS (2026-06-03):** Migration spec `011_service_payment_linkage.sql` — nullable `booking_service_records.payment_id` FK → `payments(id)` + partial index; `payment_kind` enum + `addon_service` via `ALTER TYPE` (matches 004 ENUM pattern). Verifier `verify-service-payment-linkage-schema.js` **26/26 PASS**. **NOT APPLIED** — no DB/Azure/API/webhook/n8n/WhatsApp/Stripe. Next: 8.8.20 apply + webhook allocation. Doc: [STAGE-8.8.6](STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md).

**8.8.18 SERVICE-RECORD PAYMENT TRUTH RULES -- PASS (2026-06-03):** Docs-only — defines when `booking_service_records.payment_status` changes: full-payment allocation vs deposit-only (no auto-mark add-ons paid), later Luna `addon_service` separate payments, staff manual audited truth, Ask Luna paid vs needs filters, drawer display rules. Future: migration 011 + webhook (8.8.19). No code/DB/API/UI/Azure/n8n/WhatsApp/Stripe. Doc: [STAGE-8.8.6 §12](STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md). Next: 8.8.19 webhook implementation.

**8.8.17 HOSTED MANUAL ADD-ONS SERVICE-RECORD PROOF -- PASS (2026-06-03):** Deployed `7fd3ea0` → `wh-staff-api:7fd3ea0-stage8817-manual-addons-service-records` (ACR `cby`), revision `wh-staging-staff-api--0000037` (Healthy, 100% traffic). Preflight: `7fd3ea0`; verifier 65/65 PASS. Created **`MB-WOLFHO-20260901-cb4799`** (Stage8817 Addon Test): `service_records_created:3`; DB rows wetsuit/surf_lesson/yoga linked via `booking_id`, `source=staff_manual`, `pending`, `needs_scheduling` on lesson/yoga; drawer shows all 3; Ask Luna wetsuit + lesson on 2026-09-01 includes guest. No Stripe paid / WhatsApp / n8n. Disposable booking left on staging. Doc: [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md) 8.8.17. Next: `payment_kind=addon_service` webhook hook.

**8.8.16 MANUAL CREATE SERVICE RECORDS -- PASS (2026-06-03):** `POST /staff/manual-bookings/create` writes `booking_service_records` in same transaction when add-ons present. Mapping: rentals→wetsuit/surfboard; combos→2 rows; lessons→surf_lesson; yoga→yoga; meals skipped. `source=staff_manual`; `booking_id` linked; quote line amounts; `needs_scheduling` for yoga/lessons; `rental_days` in metadata. Table-missing safe skip. `verify-staff-manual-booking-create-api.js` 65/65 PASS. No Azure deploy / Stripe / WhatsApp / n8n. Next: deploy + drawer populated proof. Doc: [STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md](STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md) §8 Flow A step 3.

**8.8.15 HOSTED SERVICE-RECORD DRAWER PROOF -- PASS (2026-06-03):** Deployed `ab67ea8` → `wh-staff-api:ab67ea8-stage8815-service-records-drawer` (ACR `cbx`), revision `wh-staging-staff-api--0000036` (Healthy, 100% traffic). Preflight: `ab67ea8`; `verify-staff-bed-calendar-ui.js` 406/406 PASS. Hosted drawer (golden `MB-WOLFHO-20260801-4f10c3`, Jul 28–Aug 10 range): **Services & Add-ons** panel + empty state; payment + Luna confirmation draft intact; no Add/Edit/Send/payment-link in service panel. Context API: `service_records[]` + `service_records_available:true` (0 rows for golden). Demo `DEMO-SVC-888-*` → context 404 (fixture rows have no `bookings` row) — populated drawer deferred to 8.8.16. Ask Luna regression: `services.yoga.paid_on_date` 1 row. No DB writes / WhatsApp / n8n / Stripe. Doc: [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md) 8.8.15. Next: 8.8.16 booking-create service row writes.

**8.8.14 BOOKING DRAWER SERVICES PANEL -- PASS (2026-06-03):** Read-only **Services & Add-ons** in Bed Calendar booking drawer from `booking_service_records`. Context API: `service_records[]` + `service_records_available`; query by `booking_id` + `booking_code` fallback; table-missing → empty array. Drawer fields: service_type, service_date, quantity, status, payment_status, amounts, source, notes. No Add/Edit/Send/payment buttons. `verify-staff-bed-calendar-ui.js` 406/406 PASS. No Azure deploy / DB writes / WhatsApp / n8n / Stripe. Doc: [STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md](STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md) §8 Flow C. Next: 8.8.15 booking-create service row writes.

**8.8.13 ADD-ON PAYMENTS DRAWER + LUNA GUEST REQUESTS DESIGN -- PASS (2026-06-03):** Docs-only — three connected flows (A booking-time add-ons, B later guest Luna requests with separate Stripe link, C Staff Portal drawer from `booking_service_records`). Key decisions: `service_date` gate, meals on-site/no link, `payment_kind=addon_service` extension, payment truth via webhook only. No code/DB/API/UI/Azure/n8n/WhatsApp/Stripe. Doc: [STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md](STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md) §8–§11. Next: 8.8.14 drawer read-only UI.

**8.8.12 HOSTED ASK LUNA SERVICE QUERY PROOF -- PASS (2026-06-03):** Deployed `ef122ac` → image `wh-staff-api:ef122ac-stage8812-service-queries` (ACR run `cbw`), revision `wh-staging-staff-api--0000035` (Healthy, 100% traffic). Preflight: `ef122ac`; `verify-staff-ask-luna-api.js` 118/118 PASS. Hosted Luna API: 10 service questions from `booking_service_records` PASS (yoga/meal paid today/tomorrow/June 15; lessons; wetsuit/surfboard who + count — today **3** wetsuits / **4** surfboards); regressions (`payments.balance_due` 4 rows, `departures_today`, ES `Quien sale hoy?`, cleaning) PASS. All `read_only:true` / `no_write_performed:true` / `sends_whatsapp:false`. No graph.facebook.com / n8n / Stripe. Doc: [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md) 8.8.12 section.

**8.8.11 ASK LUNA SERVICE RECORD QUERIES -- PASS (2026-06-03):** `POST /staff/ask-luna` extended with read-only `services.*` intents against `booking_service_records` (yoga/meal paid, surf lesson, wetsuit/surfboard who + count). English keyword router + 8.8.2 date resolver; no chat logs; `read_only:true` / `no_write_performed:true` / `sends_whatsapp:false`. `verify-staff-ask-luna-api.js` 118/118 PASS. **No Azure deploy** — redeploy required for hosted proof. Doc: [STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md](STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md) §7.

**8.8.10 STAGING SERVICE RECORDS APPLY -- PASS (2026-06-03):** Migration `010_booking_service_records.sql` + `booking-service-records-demo-up.sql` applied to **staging Postgres only** (`wh-staging-pg-app` / `wolfhouse_staging`) via `node scripts/run-sql.js` with Key Vault `wolfhouse-database-url`. **Not production.** Table + 4 indexes verified; `source` CHECK includes `demo_fixture_stage888`. Demo rows: **11** (`wolfhouse-somo`); today wetsuit **3** / surfboard **4**; paid + pending + not_requested mix. Static verifiers 49/49 + 38/38 PASS pre-apply. No Staff API deploy / n8n / WhatsApp / Stripe / live send. Next: Ask Luna read-only service query intents. Doc: [STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md](STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md) §7.

**8.8.9 SERVICE DEMO FIXTURE SOURCE CHECK -- PASS (2026-06-03):** `010_booking_service_records.sql` updated — `source` CHECK includes `demo_fixture_stage888` alongside staff_manual/luna_guest/import/stripe. Aligns with 8.8.8 demo fixture. **NOT APPLIED.** Verifiers PASS. No API/Azure.

**8.8.8 BOOKING SERVICE RECORDS DEMO FIXTURE -- PASS (2026-06-03):** `scripts/fixtures/booking-service-records-demo-up.sql` + `-down.sql` — 11 demo rows for wolfhouse-somo (`source=demo_fixture_stage888`): yoga/meal/lesson/wetsuit/surfboard; today/tomorrow/2026-06-15; paid + pending/not_requested; wetsuit/board count qty. **NOT APPLIED.** `verify-booking-service-records-demo-fixture.js` PASS. No API/UI/Azure.

**8.8.7 BOOKING SERVICE RECORDS DDL SPEC -- PASS (2026-06-03):** `database/migrations/010_booking_service_records.sql` — flat `booking_service_records` table (client_slug, booking_id, service_type/date, quantity, status, payment fields, source, metadata). CHECK constraints + indexes for Ask Luna queries. **NOT APPLIED.** `verify-booking-service-records-schema.js` PASS. No API/UI/Azure. Doc: [STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md](STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md) §5.

**8.8.6 STRUCTURED ADD-ON/SERVICE RECORDS DESIGN -- PASS (2026-06-03):** Docs-only design for Staff Ask Luna add-on questions (yoga/meals/lessons/wetsuits/surfboards + count queries). Defines `booking_service_records` logical shape, Postgres as source of truth, Stripe webhook payment truth, fixed intent→SQL mapping, phases 8.8.7 (migration spec) → 8.8.8 (fixture) → 8.8.9 (Ask Luna queries) → 8.8.10 (portal display). No chat-log answers; unsupported until structured data exists. No code/DB/Azure/n8n/WhatsApp/Stripe. Doc: [STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md](STAGE-8.8.6-STRUCTURED-ADDON-SERVICE-RECORDS.md).

**8.8.5 HOSTED MULTILINGUAL ASK LUNA ROUTER PROOF -- PASS (2026-06-03):** Deployed `3193636` → image `wh-staff-api:3193636-stage885-multilingual-ask-luna` (ACR run `cbv`), revision `wh-staging-staff-api--0000034` (Healthy, 100% traffic). Preflight: clean tree at `3193636`; `verify-staff-ask-luna-api.js` 99/99 PASS. Hosted Luna tab + session API: multilingual checkout/cleaning/payment questions (EN/ES/IT/DE/FR) route to `departures_today` / `rooms_or_beds_need_cleaning` / `payments.balance_due`; English date regressions (`check_ins.on_date`, `check_outs.count`) PASS; add-on questions (`yoga`/`wetsuit`) → `unsupported_intent`. All `read_only:true` / `no_write_performed:true` / `sends_whatsapp:false`. No graph.facebook.com / n8n / Stripe from Luna session. Doc: [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md) 8.8.5 section.

**8.8.4 MULTILINGUAL ASK LUNA INTENT ROUTER -- PASS (2026-06-03):** Deterministic EN/ES/IT/DE/FR keyword router in `scripts/staff-query-api.js` — `normalizeAskLunaQuestion` + `askLunaMatchesCheckout` / `askLunaMatchesCleaning` / `askLunaMatchesBalanceDue`; multilingual today/tomorrow (`hoy`, `oggi`, `heute`, `manana`, `demain`, …). Routes checkout/cleaning/payment-owing questions to safe structured intents before any LLM fallback (none in this slice). Add-on questions still `unsupported_intent`. No DB writes / WhatsApp / n8n / Stripe / Azure deploy. `verify-staff-ask-luna-api.js` 99/99 PASS.

**8.8.3 HOSTED ASK LUNA DATE-QUERY PROOF -- PASS (2026-06-03):** Deployed `b7c74c8` → image `wh-staff-api:b7c74c8-stage883-ask-luna-date-queries` (ACR run `cbu`), revision `wh-staging-staff-api--0000033` (Healthy, 100% traffic). Preflight: clean tree at `b7c74c8`; `verify-staff-ask-luna-api.js` 80/80 PASS. Hosted Luna tab + session API: 8 new date queries (`check_ins.on_date`/`check_ins.count`/`check_outs.on_date`/`check_outs.count`) + regressions (`payments.balance_due` 4 rows, `rooms_or_beds_need_cleaning` 0); add-on questions (`yoga`/`wetsuit`) → `unsupported_intent`. All `read_only:true` / `no_write_performed:true` / `sends_whatsapp:false`. No graph.facebook.com / n8n / Stripe from Luna session. Doc: [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md) 8.8.3 section.

**8.8.2 ASK LUNA ARRIVAL/DEPARTURE DATE QUERIES -- PASS (2026-06-03):** `POST /staff/ask-luna` extended with date phrase resolver (today/tonight/tomorrow/ISO/named month-day/weekday) and read-only intents `check_ins.on_date`, `check_ins.count`, `check_outs.on_date`, `check_outs.count` (+ existing `departures_today`, `rooming.arrivals`). Structured `bookings` + `booking_beds` only. Add-on questions (yoga/meals/lessons/rentals) return `unsupported_intent`. No DB writes/WhatsApp/n8n/Stripe/Azure deploy. `verify-staff-ask-luna-api.js` PASS.

**8.8.1 LUNA MVP OPERATING REQUIREMENTS -- PASS (2026-06-03):** Docs-only capture of Ty's post-demo (8.7.27) requirements. **UI freeze:** booking drawer + Bed Calendar good enough. **Guest Luna MVP:** full autonomous journey inquiry→confirmation (dry-run engine proven; live **NO_GO**). **Staff Ask Luna:** 15 priority question families (payments, yoga/meals, lessons, rentals, housekeeping, arrivals/departures); add-on questions require structured records not chat logs. **Manual ops priority:** (1) create booking ✓, (2) move, (3) cancel, (4) operator block/release. Live WhatsApp remains **NO_GO**. Doc: [STAGE-8.8.1-MVP-OPERATING-REQUIREMENTS.md](STAGE-8.8.1-MVP-OPERATING-REQUIREMENTS.md).

**8.7.27 STAGING DEMO-READY CONFIRMATION -- PASS (2026-06-03):** Final demo pass on `wh-staging-staff-api--0000032` (`b2a3b9f`). Nav, Today tiles, Inbox filters, Bed Calendar polish (8.7.23–8.7.25), golden booking drawer, Luna ×3, Tour Operator skeleton all PASS. No WhatsApp/n8n activation/live send from session. **DEMO-READY** for Ale/Cami shadow demo. Doc: [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md) 8.7.27 section.

**8.7.26 HOSTED BED CALENDAR FINAL POLISH PROOF -- PASS (2026-06-03):** Image `wh-staff-api:b2a3b9f-stage8726-bed-calendar-final-polish` deployed to `wh-staging-staff-api` revision `--0000032` (ACR run `cbt`, Healthy, 100% traffic). Preflight: `b2a3b9f`; `verify-staff-bed-calendar-ui.js` 391/391 PASS. Hosted: Bed Calendar auto-loads Next 30 days (`2026-06-03`–`2026-07-03`); **Today chip absent**; This week / Next 30 days / Jul–Aug + Load button; Selected Stay `.bk-compact-grid` with check-in/check-out/nights only (no Room/Bed rows); bed chips show `DEMO-R1 / DEMO-R1-B1`. Fetches: read-only staff routes + `GET /staff/bed-calendar` in Bed Calendar proof — no graph.facebook.com / n8n URLs / api.stripe.com; no write routes from UI session. Doc: [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md) 8.7.26 section. **Deploys 8.7.23–8.7.25 batch.**

**8.7.25 SELECTED STAY — REMOVE REDUNDANT ROOM FIELD -- PASS (2026-06-03):** UI-only — removed visible `bc-sel-room` row from Selected Stay (bed chips show room/bed); kept check-in/check-out/nights; `bcSelectedBeds` + quote/create `selected_bed_codes` unchanged. `verify-staff-bed-calendar-ui.js` 391/391 PASS (+8). No backend/n8n/WhatsApp/Stripe/Azure. **Deployed in 8.7.26** (`--0000032`).

**8.7.24 SELECTED STAY — REMOVE REDUNDANT BED FIELD -- PASS (2026-06-03):** UI-only — removed visible `bc-sel-bed` row from Selected Stay (bed chips show selected beds); kept check-in/check-out/nights/room; `bcSelectedBeds` + quote/create `selected_bed_codes` unchanged. `verify-staff-bed-calendar-ui.js` 383/383 PASS (+7). No backend/n8n/WhatsApp/Stripe/Azure. **Deployed in 8.7.26** (`--0000032`).

**8.7.24 HOSTED BED CALENDAR POLISH PROOF -- PASS (2026-06-03):** Image `wh-staff-api:1b3f822-stage8724-bed-calendar-polish` deployed to `wh-staging-staff-api` revision `--0000031` (ACR run `cbs`, Healthy, 100% traffic). Preflight: `1b3f822`; `verify-staff-bed-calendar-ui.js` 376/376 PASS. Hosted: Bed Calendar tab auto-loads Next 30 days (`2026-06-03`–`2026-07-03`); **Today chip absent**; This week / Next 30 days / Jul–Aug chips + Load button present; empty-cell select opens manual panel; Selected Stay `.bk-compact-grid` left-aligned; check-in/check-out/nights/room populate; bed chips show. Fetches: `/staff/bed-calendar` only in Bed Calendar proof — no graph.facebook.com / n8n URLs / api.stripe.com; no write routes from UI session. Doc: [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md) 8.7.24 section. *(Bed field row still on staging until next redeploy.)*

**8.7.23 BED CALENDAR RANGE + SELECTED STAY POLISH -- PASS (2026-06-03):** UI-only — removed Bed Calendar Today range chip; kept This week / Next 30 days / Jul–Aug; auto-load Next 30 days unchanged. Selected Stay section left-aligned via `.bk-compact-grid` (matches Guest/Payment/Add-ons). `verify-staff-bed-calendar-ui.js` PASS (+10). No backend/n8n/WhatsApp/Stripe/Azure. **Deployed in 8.7.24** (`--0000031`).

**8.7.22 FINAL FULL STAGING DEMO REHEARSAL -- PASS (2026-06-03):** Full demo script run on `wh-staging-staff-api--0000030` after 8.7.20/8.7.21 parse fix + UI cleanup batch. Console clean; Today/Inbox/Bed Calendar/Luna/Tour Operator all PASS; golden booking drawer + confirmation draft PASS; no WhatsApp/n8n/Stripe from session. Doc: [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md) 8.7.22 section.

**8.7.21 HOSTED STAFF PORTAL PARSE FIX PROOF -- PASS (2026-06-03):** Image `wh-staff-api:6790bef-stage8721-portal-parse-fix` deployed to `wh-staging-staff-api` revision `--0000030` (ACR run `cbr`, Healthy, 100% traffic). Preflight: `6790bef`; verifiers 64/64 + 366/366 PASS. Hosted: no SyntaxError; globals `switchToTab`/`switchToTabOnly`/`alAsk` all `function`; Today tiles + nav + Ask Luna PASS (`POST /staff/ask-luna` -> 4 rows). Bed Calendar auto-load, compact manual form, simplified Tour Operator unchanged. No WhatsApp/n8n/Stripe from session. Doc: [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md) 8.7.21 section.

**8.7.20 FIX STAFF PORTAL SCRIPT PARSE ERROR -- PASS (2026-06-03):** P0 UI-only — missing `}` in `renderBedCalendar()` (8.7.17) broke embedded browser script (`Unexpected token ')'`); Today tiles, nav tabs, Ask Luna failed to bind. Brace restored; verifiers now parse-check embedded UI script (`vm.Script`, stub server interpolations). `verify-staff-query-ui.js` 64/64; `verify-staff-bed-calendar-ui.js` 366/366. Globals: `switchToTab`, `switchToTabOnly`, `alAsk`. No backend/n8n/WhatsApp/Stripe/Azure. **Deployed in 8.7.21** (`--0000030`). Doc: [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md) 8.7.20 section.

**8.7.19 HOSTED TOUR OPERATOR + MANUAL FORM CLEANUP PROOF -- PASS (2026-06-03):** Image `wh-staff-api:a4f14b8-stage8719-operator-manual-form-cleanup` deployed to `wh-staging-staff-api` revision `--0000029` (ACR run `cbq`, Healthy, 100% traffic). Preflight: `a4f14b8`; `verify-staff-bed-calendar-ui.js` 364/364 PASS. Hosted: 8.7.17 Tour Operator forms simplified; 8.7.18 Guest/Payment compact left-aligned; room type Shared+Private only. No WhatsApp/n8n/Stripe/operator create-release fetch. Doc: [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md) 8.7.19 section.

**8.7.18 ALIGN MANUAL BOOKING GUEST + PAYMENT SECTIONS -- PASS (2026-06-03):** UI-only — Guest/Payment use `.bk-compact-grid` left-aligned like add-ons; guest fields compact; Double room type removed (Shared/Private only); quote payload unchanged via `bk-room-type`. `verify-staff-bed-calendar-ui.js` 364/364 PASS. No backend/n8n/WhatsApp/Stripe/Azure. **Not deployed.**

**8.7.17 SIMPLIFY TOUR OPERATOR FORMS -- PASS (2026-06-03):** UI-only skeleton cleanup — block form: start/end dates + room dropdown (from loaded Bed Calendar rooms); removed Nights/Beds/Block type/Est guest count/visible defaults (`TO_OP_BLOCK_DEFAULTS` internal). Room release: operator block dropdown (placeholder), read-only block dates, editable release dates, display-only nights, room dropdown; removed beds/release type/defaults. Buttons disabled; no create/release fetch. `verify-staff-bed-calendar-ui.js` 354/354 PASS. No backend/n8n/WhatsApp/Stripe/Azure. **Not deployed.**

**8.7.16 HOSTED MANUAL BOOKING ADD-ONS LAYOUT PROOF -- PASS (2026-06-03):** Image `wh-staff-api:acb2bd0-stage8716-manual-addons-layout` deployed to `wh-staging-staff-api` revision `--0000028` (ACR run `cbp`, Healthy, 100% traffic). Preflight: `acb2bd0`; `verify-staff-bed-calendar-ui.js` 350/350 PASS. Hosted: Create Manual Booking panel — `.bk-notes-block` compact left-aligned; add-ons qty-only (no checkboxes), default 0, unit labels (days/lessons/classes/meals) beside inputs; meals on-site note; quote €80 → €170 with wetsuit/surf/yoga qty; meals qty 10 does not change quote. No WhatsApp/n8n/Stripe from session. Doc: [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md) 8.7.16 section.

**8.7.15 CLEAN MANUAL BOOKING NOTES + ADD-ONS LAYOUT -- PASS (2026-06-03):** UI-only — manual booking notes stacked left (`.bk-notes-block`); add-ons qty-only (no checkboxes), default 0, qty > 0 = selected; compact left-aligned grid with visible unit labels; `buildAddOns()` via `aoQtyInput`; **Meals** visual-only (not sent/priced). `verify-staff-bed-calendar-ui.js` PASS. No backend/n8n/WhatsApp/Stripe/Azure. **Not deployed.**

**8.7.14 HOSTED INBOX NEEDS HUMAN FILTER PROOF -- PASS (2026-06-03):** Image `wh-staff-api:3a431c0-stage8714-inbox-filter` deployed to `wh-staging-staff-api` revision `--0000027` (ACR run `cbn`, Healthy, 100% traffic). Preflight: `3a431c0`; `verify-staff-conversation-ui.js` 82/82 slice PASS (+3 known pre-existing monolith failures). Hosted: Inbox filter chips **All conversations** / **Needs human**; Today Needs Human → Inbox two-column + needs-human filter (1/3 convs); All → 3 convs; no `hq-list`/`hq-right`/`subtab-handoffs`; auto-select detail; no `/staff/handoffs` UI fetch. No WhatsApp/n8n/Stripe. Doc: [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md) 8.7.14 section.

**8.7.13 NEEDS HUMAN AS INBOX FILTER -- PASS (2026-06-03):** UI-only — removed separate Needs Human sub-page; Inbox filter chips **All conversations** / **Needs human**; Today Needs Human tile → `switchToTab('conversations','handoffs')` → `setInboxFilter('needs-human')`; same `inbox-two-col` layout; auto-select top conversation; empty state “No conversations need staff review right now.” No `/staff/handoffs` fetch from UI. `verify-staff-conversation-ui.js` PASS (+8 checks). No backend/n8n/WhatsApp/Stripe/Azure. Proven on staging in 8.7.14. Image `wh-staff-api:039afdf-stage8712-ui-cleanup` deployed to `wh-staging-staff-api` revision `--0000026` (ACR run `cbm`, Healthy, 100% traffic). Preflight: clean tree at `039afdf`; `verify-staff-query-ui.js` 60/60 PASS; `verify-staff-bed-calendar-ui.js` 328/328 PASS. Hosted on `staff-staging.lunafrontdesk.com`: nav Today→Inbox→Bed Calendar→Luna→Tour Operator→Developer Tools (Luna tab no bot emoji); Luna panel hero **Luna**; `POST /staff/ask-luna` → `payments.balance_due` / 4 rows; golden booking drawer `.ctx-pay-box` 340px contained payment card + truth fields + confirmation draft; manual form `#bk-ao-meals` + on-site note (visual-only). Fetches: `/staff/bed-calendar`, `/staff/bookings/.../context`, `/staff/ask-luna` only — no stripe.com / graph.facebook.com / n8n. Doc: [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md) 8.7.12 section.

**8.7.11 CLEAN PAYMENT + ADD-ONS LAYOUT -- PASS (2026-06-03):** UI-only — booking drawer Payment section contained in compact left `.ctx-pay-box` (no full-width green stretch); manual booking add-ons compact grid left-aligned; **Meals** qty input added (visual-only / not priced in quote — not sent via `buildAddOns()`). Luna confirmation draft unchanged; no send button. `verify-staff-bed-calendar-ui.js` PASS (+16 checks). No backend/n8n/WhatsApp/Stripe/Azure. Proven on staging in 8.7.12.

**8.7.9 HOSTED BED CALENDAR UX PROOF -- PASS (2026-06-03):** Image `wh-staff-api:d50da7e-stage879-bed-calendar-ux` deployed to `wh-staging-staff-api` revision `--0000025` (ACR run `cbk`, Healthy, 100% traffic). Preflight: `d50da7e`; `verify-staff-bed-calendar-ui.js` 312/312 PASS. Hosted: auto-load Next 30 days on tab open; Load button retained; cell toggle deselect; booking click hides manual panel + shows drawer. No WhatsApp/n8n/Stripe. Doc: [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md). Next: client demo using 8.7.2 script.

**8.7.8 BED CALENDAR LOAD + SELECTION UX -- PASS (2026-06-03):** Auto-load Next 30 days on first Bed Calendar tab open; booking click clears manual booking panel; selected empty cells toggle off. `verify-staff-bed-calendar-ui.js` 312/312 PASS. No backend/n8n/WhatsApp/Stripe/Azure. Proven on staging in 8.7.9.

**8.7.7 HOSTED BOOKING DRAWER CLEANUP PROOF -- PASS (2026-06-03):** Image `wh-staff-api:b223cea-stage877-drawer-cleanup` deployed to `wh-staging-staff-api` revision `--0000024` (ACR run `cbj`, Healthy, 100% traffic). Preflight: `b223cea`; `verify-staff-bed-calendar-ui.js` 303/303 PASS. Hosted golden booking `MB-WOLFHO-20260801-4f10c3`: no Guest/Stay headings; no duplicate bed rows; header status + nights pill; compact payment grid; Luna confirmation draft panel; no send button. Context fetch only — no WhatsApp/n8n/Stripe. Doc: [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md). Next: client demo using 8.7.2 script.

**8.7.6 CLEAN BOOKING DRAWER LAYOUT -- PASS (2026-06-03):** UI-only drawer cleanup — removed Guest/Stay headings; deduped bed assignment rows; nights + status pill in header; compact payment grid; Luna confirmation draft preserved; no send button. `verify-staff-bed-calendar-ui.js` 303/303 PASS. No backend/n8n/WhatsApp/Stripe/Azure. Proven on staging in 8.7.7.

**8.7.5 HOSTED STAFF PORTAL CLICK-HANDLER PROOF -- PASS (2026-06-03):** Image `wh-staff-api:fdb1e36-stage875-click-handlers` deployed to `wh-staging-staff-api` revision `--0000023` (ACR run `cbh`, Healthy, 100% traffic). Preflight: `fdb1e36`; `verify-staff-query-ui.js` 55/55 PASS. Hosted: no `alAsk`/`switchToTab`/`switchToTabOnly` console errors; Today tiles + Ask Luna button PASS (`POST /staff/ask-luna` -> `payments.balance_due` / 4 rows). No WhatsApp/n8n activation/Stripe/live send. Doc: [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md). Next: client demo using 8.7.2 script.

**8.7.4 FIX STAFF PORTAL CLICK HANDLERS -- PASS (2026-06-03):** `window.alAsk`, `window.switchToTab`, `window.switchToTabOnly` exposed from page IIFE (fixes 8.7.3 demo blockers: Ask Luna button, Today tiles, inline tab onclick). Nav tabs still use addEventListener. `verify-staff-query-ui.js` PASS (+section 7c). No backend/n8n/WhatsApp/Stripe/Azure. Proven on staging in 8.7.5.

**8.7.3 STAGING DEMO REHEARSAL -- PASS WITH UI BLOCKER (2026-06-03):** Ran 8.7.2 script on `staff-staging.lunafrontdesk.com`. Login + golden booking drawer PASS (deposit paid, €100/€150, confirmation draft, 2684#). Ask Luna API PASS (3 questions via session). **Ask Luna Ask button BLOCKED** — `alAsk` not exposed on `window` (IIFE); onclick silent. n8n dry-run workflows inactive. No WhatsApp/Stripe/n8n calls. Rehearsal notes appended to [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md). Next: fix `window.alAsk` before client demo.

**8.7.2 STAGING DEMO SCRIPT -- PASS (2026-06-03):** Docs-only runbook for Ale/Cami shadow demo on `staff-staging.lunafrontdesk.com`. Golden booking `MB-WOLFHO-20260801-4f10c3` (payment truth + confirmation draft). Core: login -> Bed Calendar drawer -> Ask Luna (3 questions). Optional: manual booking if flags on; n8n inactive exec summaries (Guest Luna exec #5, Staff Ask Luna exec #3). **Keep** Luna test bookings; no purge. Do-not-show: live WhatsApp, operator/move/cancel writes, confirmation send. Doc: [STAGE-8.7.2-STAGING-DEMO-SCRIPT.md](STAGE-8.7.2-STAGING-DEMO-SCRIPT.md). Next: run demo or gated live micro-test (8.6.8 GO).

**8.7.1 MVP READINESS GAP REVIEW -- PASS (2026-06-03):** Docs-only checklist: demo-ready vs dry-run-ready vs live-pilot blockers across Staff Portal, Guest Luna, Staff Ask Luna. Staff Portal manual booking/quote/Stripe/webhook/confirmation draft drawer/Ask Luna **demo-ready** on staging. Guest Luna shared-engine path **dry-run only** (inactive workflow; Main unmigrated). Staff Ask Luna portal + dry-run WhatsApp + allowlist + ops intents proven; live send **NO_GO**. Blockers: WhatsApp GO, real phones, confirmation send policy, demo data cleanup, pricing REQUIRED_FROM_STAFF gaps, calendar operator writes (8.3p+). **Recommend: stay dry-run + clean demo flow.** Doc: [STAGE-8.7.1-MVP-READINESS-GAP-REVIEW.md](STAGE-8.7.1-MVP-READINESS-GAP-REVIEW.md). Next: 8.7.2 demo runbook (optional) or gated live micro-test after 8.6.8 GO.

**8.6.10 AZURE STAGING DEPLOY — ASK LUNA DEPARTURES + CLEANING HOSTED PROOF -- PASS (2026-06-03):** Image `wh-staff-api:e0b809c-stage8610-cleaning-departures` pushed to `whstagingacr.azurecr.io`; deployed to `wh-staging-staff-api` revision `--0000019` (Succeeded). Preflight: clean tree at `e0b809c`; `verify-staff-ask-luna-api.js` 51/51 PASS. Hosted proof on `https://staff-staging.lunafrontdesk.com`: POST `/staff/ask-luna` (staff_portal session) `Who leaves today` → 200/`departures_today`/`read_only:true`/`no_write_performed:true`/`sends_whatsapp:false`/`staff_access:session`/`row_count:0`; POST (staff_portal) `Which rooms need cleaning` → 200/`rooms_or_beds_need_cleaning`/same safety fields; POST (staff_whatsapp allowlisted `+34999000999`) `Who leaves today` → 200/`departures_today`/`staff_access:allowlisted_phone`/`sends_whatsapp:false`. No `graph.facebook.com`, no n8n, no Stripe in responses. No n8n import/activation. No WhatsApp sent. Next: 8.6.11+ live gated WhatsApp send (after 8.6.8 GO).

**8.6.9 ASK LUNA DEPARTURES + CLEANING INTENTS -- PASS (2026-06-03):** `POST /staff/ask-luna` extended with read-only `departures_today` (`who leaves today`) and `rooms_or_beds_need_cleaning` (`which rooms/beds need cleaning`) intents. Structured SQL from `bookings` + `booking_beds` only (no chat logs). NL: `Who leaves today?` / `Which rooms/beds need cleaning?`. Response keeps `read_only:true`, `no_write_performed:true`, `sends_whatsapp:false`. No DB writes, WhatsApp, n8n, Stripe, Azure. `verify-staff-ask-luna-api.js` PASS. Next: 8.6.10 hosted deploy proof (done).

**8.6.8 STAFF ASK LUNA LIVE WHATSAPP READINESS CHECKLIST -- DONE (2026-06-03):** Short go/no-go checklist added before enabling live staff WhatsApp replies. Docs only — no code, no n8n edits, no activation, no sends. **Live send decision: NO_GO** until owner sign-off on every gate below. Baseline from Stages 8.6.1–8.6.7: dry-run workflow imported inactive (`stage863AskLuna01`); manual exec #3 proved `payments.balance_due` / `reply_draft` / `whatsapp_sent:false`. Next: 8.6.9 departures+cleaning intents (done).

**8.6.7 RE-IMPORT FIXED STAFF ASK LUNA DRY-RUN + MANUAL EXECUTION -- PASS (2026-06-03):** Stage 8.6.6 guard-fixed workflow re-imported into staging n8n inactive (`stage863AskLuna01`, `active:false`, 11 nodes). Manual execution #3 success (~13s) with pinned payload: allowlisted `+34999000999`, `who still owes money`, `wolfhouse-somo`, `whatsapp`. **No temp IF bypass.** `Set - DryRun Mode Flags` sets `dry_run:true` / `live_send_enabled:false`; `IF - DryRun Guard` passes on workflow JSON; `POST /staff/ask-luna` -> `payments.balance_due`; `reply_draft` generated; `whatsapp_sent:false`; no `graph.facebook.com`; workflow remains inactive. No activation. No live WhatsApp. No Staff API/Stripe/Azure changes. Next: 8.6.8 readiness checklist (done).

**8.6.5 HOSTED INACTIVE STAFF ASK LUNA DRY-RUN PROOF -- PASS (2026-06-03):** `n8n/Wolfhouse Staff Ask Luna - WhatsApp Dry Run.json` imported into staging n8n inactive (`stage863AskLuna01`, `active:false`). Manual execution #2 success with pinned payload: allowlisted `+34999000999`, `who still owes money`, `wolfhouse-somo`, `staff_whatsapp`. `POST /staff/ask-luna` -> `payments.balance_due`; `reply_draft` generated; `whatsapp_sent:false`; no `graph.facebook.com`. Workflow left inactive; nodes restored to repo JSON after proof. Staging gap: `N8N_BLOCK_ENV_ACCESS_IN_NODE` blocks `$env.WHATSAPP_DRY_RUN` IF guard (exec #1 `dry_run_guard_blocked`; proof used temporary staging IF bypass). No activation. No live WhatsApp. No Staff API/Stripe changes. Next: 8.6.6 guard fix (done) + 8.6.7 re-import proof (done).

**8.6.4 AZURE STAGING DEPLOY -- PASS (2026-06-03):** image wh-staff-api:1f9e21e-stage864-ask-luna pushed to whstagingacr.azurecr.io; deployed to wh-staging-staff-api revision --0000018 (Succeeded). Hosted proof: /staff/login->200; /staff/ui->200 (Ask Luna tab+al-input+al-btn+alAsk present, no graph.facebook.com, no api.stripe.com); POST /staff/ask-luna (staff_portal session)->200/payments.balance_due/read_only:true/no_write_performed:true/sends_whatsapp:false/staff_access:session; POST /staff/ask-luna (staff_whatsapp allowlisted +34999000999)->200/staff_access:allowlisted_phone/sends_whatsapp:false; unlisted phone->403. No n8n import/activation. No Stripe. No WhatsApp sent. staff_whatsapp_enabled:true in config for staging test. Next: 8.6.5 hosted inactive dry-run proof (done).

**8.6.3 STAFF ASK LUNA WHATSAPP DRY-RUN WORKFLOW -- PASS (2026-06-03):** New inactive n8n workflow Wolfhouse Staff Ask Luna - WhatsApp Dry Run.json (active:false, 10 nodes). WHATSAPP_DRY_RUN guard IF node. Code - Parse Staff Message (from/text/client_slug/channel). HTTP - Staff Ask Luna: POST /staff/ask-luna {client_slug, question, staff_phone, source:staff_whatsapp}; no X-Luna-Bot-Token (phone allowlist auth); neverError+fullResponse so 403 flows to branch. IF - API Authorized: true->Code - Format DryRun Answer->Respond (intent/answer/rows/reply_draft, whatsapp_sent:false, dry_run:true, live_send_blocked:true); false->Set - Log Unauthorized->Respond (not enabled message, whatsapp_sent:false). unsupported_intent: appends suggestions to reply_draft, no send. No graph.facebook.com in any node params. No Stripe. No DB writes. Not imported, not activated. verify-staff-ask-luna-whatsapp-dry-run.js 40/40 PASS (new). verify-staff-ask-luna-api.js 48/48 PASS unchanged. Static proof only. Next: 8.6.4 staff WhatsApp live gated send (requires explicit go/no-go + real phone numbers in allowlist config).

**8.6.2 STAFF PORTAL ASK LUNA TEXT BOX -- PASS (2026-06-03):** New "Ask Luna" tab in Staff Portal nav (between Tour Operator and Developer Tools). Compact hero panel (title, subtitle, examples). Text input (`al-input`) + Ask button (`al-btn`, Enter key supported). `alAsk()` POSTs to `/staff/ask-luna` with `{client_slug, question, source:"staff_portal"}` using existing session auth. `alRenderResult()` renders: intent badge, answer text, row_count, compact rows table (up to 20 rows), unsupported_intent message + full suggestion list. `alShowError()`/`alSetLoading()` loading/error states. CSS: al-* styles consistent with existing UI tokens. No WhatsApp, no n8n, no Stripe, no DB writes. `verify-staff-query-ui.js` 43/43 PASS (section 7b ? 14 new Ask Luna checks). `verify-staff-ask-luna-api.js` 48/48 PASS unchanged. Local proof: `who still owes money`?200/payments.balance_due/1 row/real guest data from DB; `what is the weather today`?unsupported_intent+full suggestion list; 0 DB writes, 0 WhatsApp, 0 n8n, 0 Stripe, 0 Azure. Next: 8.6.3 n8n staff WhatsApp dry-run route, 8.6.4 staff WhatsApp live gated send.

**8.6.1 STAFF ASK LUNA ENDPOINT -- PASS (2026-06-03):** POST /staff/ask-luna added to staff-query-api.js. Session auth (staff_portal) or allowlisted staff phone (staff_whatsapp). Loads wolfhouse-somo.staff-whatsapp-allowlist.json lazily; checks staff_whatsapp_enabled + phone in active staff_numbers. Natural-language -> intent resolver: who owes (payments.balance_due), payment links (payments.waiting), arrivals (rooming.arrivals), needs human (handoffs.open), urgent handoffs, deposit, confirmation, holds, unassigned, add-ons. Direct registry key passthrough. Unsupported intents (departures_today, rooms_need_cleaning) return unsupported_intent + suggestion. WhatsApp-friendly formatAnswer. Response: success/intent/answer/rows/row_count/read_only:true/no_write_performed:true/sends_whatsapp:false. No INSERT/UPDATE/DELETE. No Stripe. No WhatsApp send. No n8n. verify-staff-ask-luna-api.js 48/48 PASS. Local proof: unknown phone->403/phone_not_allowlisted; allowlisted +34999000999->200/payments.balance_due/1 guest owes; staff_portal dev->200/handoffs.open; unsupported->unsupported_intent+suggestions; departures_today->unsupported_intent+hint. 0 DB writes. Next slices: 8.6.2 Staff Portal Ask Luna text box, 8.6.3 n8n staff WhatsApp dry-run route, 8.6.4 staff WhatsApp live gated send.

## Stage 8.6.8 — Staff Ask Luna live WhatsApp go/no-go checklist

**Purpose:** Gate before enabling live WhatsApp replies to allowlisted staff numbers. **Current decision: NO_GO** (checklist defined; live send not approved).

**Workflow:** `n8n/Wolfhouse Staff Ask Luna - WhatsApp Dry Run.json` · staging id `stage863AskLuna01` · allowlist `config/clients/wolfhouse-somo.staff-whatsapp-allowlist.json`

| # | Gate | Requirement | Baseline (2026-06-03) | Before GO |
|---|------|-------------|----------------------|-----------|
| 1 | Workflow imported inactive | Staging n8n has dry-run workflow; `active:false` | **PASS** — imported; exec #3 proved inactive after run | Reconfirm `active:false` until GO |
| 2 | Live send disabled | No outbound WhatsApp; `whatsapp_sent:false` on all paths | **PASS** — dry-run only; no send node | Confirm still disabled |
| 3 | One test number first | Only **one** approved staff phone for first live pilot | **PARTIAL** — `+34999000999` is sole pilot candidate; `+34999000998` must stay off until #999 proven | Owner approves **only** `+34999000999`; no real staff mobiles yet |
| 4 | `staff_whatsapp_enabled` staging-only | `true` only for staging test; production stays `false` until separate GO | **PASS** — config note + staging proofs use fake `+34999…` numbers | Reconfirm prod config `false` |
| 5 | Dry-run vs live-send decision | Document flag semantics before any send | **PASS** — see decision box below | Owner reads + signs |
| 6 | No Meta send until GO | No `graph.facebook.com` send node enabled/wired | **PASS** — absent from workflow JSON + exec proofs | Send node stays out until GO |
| 7 | Smoke question | Staff sends: **"who still owes money"** | **PASS** — used in manual exec #2/#3 | Same question for first live reply |
| 8 | Expected API answer | `POST /staff/ask-luna` → `intent:payments.balance_due`, `read_only:true`, `no_write_performed:true`, `sends_whatsapp:false`, `answer` lists guest(s) with balance (e.g. `N guest(s) still owe a balance: Name (CODE) — balance €X`), `row_count≥0` | **PASS** — exec #3 + hosted 8.6.4 proof | Re-run against staging before GO |
| 9 | Rollback plan | If live misbehaves: deactivate workflow + restore dry-run | **PASS** — documented below | Team knows steps |

**Dry-run vs live-send decision (Gate 5):**

| Mode | `Set - DryRun Mode Flags` | `IF - DryRun Guard` | WhatsApp send |
|------|---------------------------|---------------------|---------------|
| **Current (dry-run)** | `dry_run:true`, `live_send_enabled:false` | Passes on `$json.dry_run` | None — logs `reply_draft`, `whatsapp_sent:false` |
| **Live (future, 8.6.9+)** | Requires explicit flip to `live_send_enabled:true` + owner GO | Must still guard against accidental send | Add `graph.facebook.com` send node **only after GO** |

Staging n8n may still set container env `WHATSAPP_DRY_RUN=true`; this staff workflow **does not** read `$env` (Stage 8.6.6). Live-send safety is workflow JSON flags + activation gate, not env alone.

**Rollback (Gate 9):**

1. **Deactivate workflow** — set `active:false` in n8n (or unpublish); stop inbound staff WhatsApp webhook route.
2. **Restore dry-run flags** — `Set - DryRun Mode Flags`: `dry_run:true`, `live_send_enabled:false`.
3. **Disable send path** — remove or disconnect any `graph.facebook.com` send node; verify executions show `whatsapp_sent:false`.
4. **Optional config rollback** — set `staff_whatsapp_enabled:false` in allowlist JSON if staff phone auth must be cut immediately.

**Sign-off:** Ty / Ale / Cami — record GO or NO_GO with date before Stage 8.6.9 live send work.

# Wolfhouse Booking Assistant ? Product Roadmap

**Product:** AI booking operations for WhatsApp-first experience businesses ? **beachhead:** Wolfhouse (surf house / surf camp). Simpler label: *AI front desk for WhatsApp-heavy experience operators.*

**Product-level roadmap (15 pillars):** [`PRODUCT-MASTER-ROADMAP.md`](PRODUCT-MASTER-ROADMAP.md) ? **Engineering snapshot:** [`PROJECT-STATE.md`](PROJECT-STATE.md) ? **Architecture:** [`ARCHITECTURE-NORTH-STAR.md`](ARCHITECTURE-NORTH-STAR.md) ? **Stripe isolated gates:** [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md)

> **This file is the stage-level / engineering roadmap.** For the **product-level view** ? the full 15-pillar product vision (Guest Assistant, SoT DB, Staff Brain, Dashboard, Rooming UI, Add-ons, Messaging Bridge, Multi-Client Config, Onboarding, PMS, AI Intent, Analytics, Production Hardening, Multi-Client Admin, Productization) mapped to these stages ? see [`PRODUCT-MASTER-ROADMAP.md`](PRODUCT-MASTER-ROADMAP.md).

---

## Evolution order (do not skip)

```text
1. Correct and safe      ? Stage 3  (engineering gates + exit criteria)
   Safety rails          ? Stage 3.5 (seatbelts before live/shadow mode)
   Knowledge + guardrails ? Stage 3x (specs, client config, golden tests)
   Shadow / co-pilot     ? Stage 3y (staff-approved replies, real guest data)
2. Reliable              ? Stage 4
3. Clean                 ? Stage 5
4. Beautiful             ? Stage 6  (Staff / Admin Layer + Staff Operations Assistant)
5. Scalable              ? Stage 7
```

Stage 3 is **not** about making the bot beautiful or fully productized. It is about proving the bot does **not** make dangerous mistakes.

**Stage 3.5 is not full Stage 4 observability.** It is the minimum seatbelts required before serious runtime or live/shadow operation ? error capture, idempotency checks, overlap guards, basic execution logging.

**Stage 3y (Shadow/Co-pilot)** bridges dry-run proof and autonomous live operation. The bot reads real messages and drafts responses; staff approve and send manually. No autonomous payment/confirmation/cancellation/rooming without explicit staff approval. This reduces the dry-run ? real-guest cliff and generates real golden-message data.

---

## Architecture direction (long-term)

**Do not keep expanding n8n with more and more business logic forever.**

| Layer | Role |
|-------|------|
| **n8n** | Orchestrates ? webhooks, WhatsApp, Stripe callbacks, notifications, simple integration steps |
| **Backend / code** | Decides ? routing, required fields, package logic, safety guards, handoff rules |
| **Postgres** | Remembers ? bookings, payments, conversations, beds, audit trail |
| **Client config** | Controls ? packages, pricing, room rules, policies per property (Wolfhouse = client #1) |
| **Staff UI + Staff Assistant** | Manages ? holds, payments, assignments, takeover; answers operational queries; approves risky bot actions (Stage 6+) |

The current **n8n-heavy** implementation is acceptable for **proving behavior** in Stage 3. Future stages migrate decision logic into code/config modules; n8n calls the decision engine instead of owning the business brain.

**Target module layout (Stage 5):**

```text
src/booking-assistant/
  # --- shared spine (client- AND vertical-agnostic; never rebuilt per vertical) ---
  routeMessage.ts
  extractBookingDetails.ts
  requiredFields.ts
  safetyGuards.ts
  handoffRules.ts
  duplicateProtection.ts
  bookingContext.ts
  clientConfig.ts
  payments.ts              # Stripe link + webhook truth + confirmation (vertical-agnostic)
  # --- vertical plugin seam (the ONLY part that differs per business type) ---
  inventory/
    InventoryProvider.ts   # interface: findAvailability / hold / fulfill
    lodging.ts             # beds-in-rooms + rooming (Wolfhouse / hostels)
    slots.ts               # lesson/tour time-slot capacity (surf/kite schools, tours)
    rentals.ts             # item ? time-window ? quantity ? size (surf/bike/SUP shops)
  catalog/
    offerings.ts           # generic priced offering (packages | lessons | rental SKUs | departures)
    packageDecision.ts     # explain / recommend / quote ? driven by config, not hardcoded names
```

**Example future config shape (not implemented yet):**

```text
client_config.packages
client_config.room_rules
client_config.payment_rules
client_config.handoff_rules
client_config.required_fields
```

Build **Wolfhouse as client #1**, not as the only client the system can ever serve.

**Spine vs plugin (portability principle):** everything above the `inventory/` and `catalog/` folders is the **shared spine** and must contain **no surf-house-specific nouns** (no `bed`, `room`, `malibu`, `surfweek`). Anything vertical-specific lives behind the `InventoryProvider` interface or in `client_config`. A new vertical = new config + (at most) one new inventory provider ? see [? Engine portability](#engine-portability--adding-a-new-vertical-surf-shop--lessons).

---

## Client category / market positioning

### Product category

**Primary:** AI booking operations for WhatsApp-first experience businesses.

**Simpler language:** AI front desk for WhatsApp-heavy experience operators.

This is **not** framed as a generic chatbot. It is an operations layer that handles guest questions, package/rental/lesson explanation, availability and detail collection, payment links, payment truth, confirmations, customer memory, staff handoff, and operational status.

### Beachhead

**Wolfhouse** ? surf houses / surf camps (client #1, `wolfhouse-somo`).

Hard first use case: combines accommodation, packages, rooming, payments, confirmations, WhatsApp, and staff operations in one property.

### Adjacent categories (same core pattern)

Guests ask on WhatsApp ? business explains options ? checks availability ? collects details ? sends payment/deposit link ? confirms ? staff handle changes and handoffs.

| Adjacent vertical | Typical scope (often simpler than surf house) |
|------------------|-----------------------------------------------|
| Surf schools | Lessons, levels, schedules |
| Surf shops | Rentals, retail-adjacent booking |
| Kite schools ? dive shops | Lessons, certifications, slots |
| Yoga retreats ? small retreat operators | Packages, dates, capacity |
| Hostels with activities | Beds + activity add-ons |
| Tour operators | Departures, group size, deposits |
| Rental businesses | Lessons, rentals, inventory, time slots, sizes ? surf shop / bike / e-bike / kayak / SUP / campervan patterns |

A **surf shop or lesson-rental** operator is likely a simpler config profile than Wolfhouse: fewer rooming rules, more slot/inventory semantics, still the same payment + confirmation + handoff spine.

### Competitive note

AI/WhatsApp tools already exist for hotels, hospitality, and tour operators. The opportunity is a **focused, configurable, operations-heavy** assistant for **small experience businesses** that live in WhatsApp and run **messy** packages, rentals, lessons, and deposits ? not clean hotel-only PMS flows.

### Roadmap implication

| Build now | Defer |
|-----------|--------|
| Wolfhouse as client #1 with full safety proofs | Multi-client SaaS platform |
| `client_config` specs that generalize | Client onboarding UI, billing, settings editor |
| Engine shaped for lessons/rentals/rooming via config | Hardcoding ?surf house only? in shared workflows |

**Config dimensions per client** (see ?3x.11 in [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)): packages ? lesson types ? rental inventory ? rooming rules (if applicable) ? pricing ? deposit rules ? cancellation policy ? handoff rules ? staff notifications ? customer memory policy.

---

## Engine portability ? adding a new vertical (surf shop / lessons)

**Goal:** when Wolfhouse is done, standing up a second vertical (surf-shop **rentals**, surf/kite-school **lessons**, tour **departures**) is a **config + inventory-plugin** exercise ? **not** a rewrite. This section defines the seam so that promise is real instead of aspirational.

### What is SHARED ? built once, reused by every vertical

| Shared spine capability | Where |
|-------------------------|-------|
| WhatsApp inbound/outbound I/O | n8n orchestration |
| Message routing / intent (`routeMessage`) | spine |
| Required-field gating per action (`requiredFields`) | spine + `client_config` |
| Payment link ? **Stripe webhook truth** ? confirmation (`payments`) | spine (proven 3d.x) |
| Handoff triggers (`handoffRules`) | spine + `client_config.handoff` |
| LLM safety (low-confidence ? handoff; never act on LLM alone) | spine + `client_config.llm_safety` |
| Duplicate / idempotency protection | spine (Stage 3.5) |
| Conversation / session state, customer memory + privacy | spine + Postgres |
| Error capture, golden-message runner | Stage 3.5 / 4 |

These **must not** be reimplemented per client. If a "new vertical" task touches these, the seam has leaked.

### What is VERTICAL-SPECIFIC ? plugged in, never forked

| Vertical concern | How it varies | Mechanism |
|------------------|---------------|-----------|
| The bookable resource + availability | bed-nights vs lesson slots vs rental items vs departure seats | `InventoryProvider` implementation |
| Catalog of offerings | packages vs lesson types vs rental SKUs vs departures | `catalog/offerings` + `client_config` |
| Fulfillment / assignment | rooming is **lodging-only**; most verticals skip it | capability flag, not core path |
| Required fields per booking type | dorm gender vs board size vs surf level | `client_config.required_fields` |
| Vocabulary / tone | surf-house terms vs shop terms | `client_config.language_tone` |

### The one abstraction that unlocks all of it: `InventoryProvider`

All verticals reduce to the same three-call contract ? `findAvailability(request)` ? `hold(unit, window)` ? `fulfill(booking)`:

| Vertical | Unit | Availability dimension | Special attribute | Rooming? |
|----------|------|------------------------|-------------------|----------|
| Surf house / hostel | bed | date-range overlap | gender / couple | **yes** (`lodging`) |
| Surf / kite / dive school | lesson slot | time + slot capacity | skill level | no (`slots`) |
| Surf / bike / SUP shop | rental item | time-window ? quantity | size / fit | no (`rentals`) |
| Tour operator | departure seat | departure-date capacity | group size | no (`slots`) |

The spine calls the interface and never knows which provider it is.

### Portability gate ? a vertical is "config-only ready" when:

- [ ] No surf-house nouns (`bed`, `room`, `matrimonial`, `surfweek`, `malibu`/`uluwatu`/`waimea`) appear in the shared spine ? only in `client_config` / providers.
- [ ] Rooming/assignment is behind a **capability flag**, not assumed.
- [ ] Catalog is generic `offerings`, not a hardcoded package enum.
- [ ] Inventory/availability is behind `InventoryProvider`; lodging is just one impl.
- [ ] `client_config` is split into **engine config** (spine) + **vertical config** (catalog/inventory/capabilities).
- [ ] Golden-message suite is parameterized by `client_id` (Wolfhouse fixtures don't hardcode the engine's behavior).

### Cheapest validation ? do this on paper during Stage 3x.3 (safe, docs-only)

Before any Stage 5 extraction, draft **sample configs for a second and third vertical** and run them against the schema to surface every leak:

- `config/clients/surf-shop-rental.sample.json` (rentals: items, sizes, time windows, deposits)
- `config/clients/surf-school.sample.json` (lessons: levels, slots, instructors)

Each gap found ("this field has no home," "this rule assumes beds") becomes a line item in the **Stage 5 extraction backlog**. If both samples fit the schema with only a new `InventoryProvider`, the backbone is portable; if not, you've found the surf-house assumptions cheaply, on paper, before writing engine code.

### Stage placement

| Work | Stage | Safe before runtime? |
|------|-------|----------------------|
| Spine/plugin seam **design** + sample vertical configs (paper test) | now / **3x.3** | yes (docs/config only) |
| Split `client_config` into engine vs vertical schema | 3x.3 ? Stage 5 | yes (config) |
| Extract spine modules; implement `InventoryProvider` (lodging first) | **Stage 5** | build stage |
| Second `InventoryProvider` (`slots` / `rentals`) + 2nd client live | **Stage 7** | scale stage |

**Do not** build multi-vertical infra early. **Do** lock the seam now so Stage 5 cleanup produces portable modules instead of a tidied-up surf-house monolith.

### Deploy config (the onboarding contract)

Every client-specific value (prices, seasons, gate code, phone numbers, packages, room map, policies) lives in **one per-client deploy config** + a gitignored secret file ? never hardcoded in code/workflows. A new client = fill the template, not rewrite logic. Template: [`config/clients/_deploy-config.template.json`](../config/clients/_deploy-config.template.json) ? Guide: [`DEPLOYMENT-CONFIG.md`](DEPLOYMENT-CONFIG.md). Wolfhouse's `wolfhouse-somo.baseline.json` is the worked example (`vertical: lodging_surf_house`).

---

## Legacy phase map (reference)

Older docs use **Phase 0?3d** for engineering milestones. They map to stages as follows:

| Legacy | Stage |
|--------|--------|
| Phase 0?2 local (frozen) | Foundation + Stripe/Main/Send Confirmation contracts |
| Phase 3b (frozen) | Stage 3 ? bed-ops / manual / operator paths |
| Phase 3c?3g | Stage 3 ? Main + Postgres + stub E2E |
| Phase 3d.x | Stage 3 ? isolated real Stripe payment / webhook / confirmation gates |
| Phase 3e | Stage 3 ? rooming/reassign E2E ? |
| Stage 3.5 | Safety rails ? idempotency, error capture, overlap guards |
| Stage 3x | Bot knowledge + safety guardrails (specs, not n8n sprawl) |
| Stage 3y | Shadow / co-pilot ? staff-approved mode before autonomous |
| Azure / multi-client | Stage 7 (Scalable), not before Reliability + Clean |

---

## Stage 3 ? Correct and safe

### Purpose

Prove dangerous core workflows safely before cleanup, staff UI, or multi-client productization.

### What Stage 3 is not

- Not optimizing for guest-facing polish or marketing copy quality
- Not building the full staff product UI
- Not Azure/production cutover
- Not adding dozens of new n8n IF branches for business rules (that belongs in Stage 3x **specs** and Stage 5 **code**)

### Dangerous mistakes Stage 3 must prevent

| Risk | Guard |
|------|--------|
| Wrong booking selected | Conversation `current_hold_booking_id`, resolver, terminal-status blocks |
| Wrong payment link | Real CPS on correct hold; stub vs real env separation |
| Wrong confirmation | Send Confirmation gates; dry-run first; schedule disabled in tests |
| Wrong room assignment | Bed-ops forks; **hosted reassign URL** in Main fork (`3e.2` remap) ? see [`PHASE-3e-ROOMING-REASSIGN-PLAN.md`](PHASE-3e-ROOMING-REASSIGN-PLAN.md) |
| Duplicate payment / session / event | Idempotency checks; single webhook per event id |
| Accidental live Stripe / WhatsApp | Test keys; `WHATSAPP_DRY_RUN`; activation boundaries |
| Background workflow firing | Inactive workflows + schedule `disabled` in test windows |

### Complete or in progress (engineering)

| Area | Status | Notes |
|------|--------|--------|
| `booking_flow` hold creation | **Proven** | PG hold + Airtable backfill in Main fork (3c.e) |
| `payment_details_provided` route | **Proven** | Resolver + Ensure (3c.g stub E2E) |
| Real Stripe checkout link (Main-integrated) | **Proven** | 3d.7b ? `WH-260528-5369`, stop at checkout URL |
| Isolated Create Payment Session | **Proven** | 3d.4 |
| Stripe Webhook Handler payment truth | **Proven** (isolated) | 3d.5b on `WH-260528-1493` |
| Send Confirmation (dry-run) | **Proven** (isolated) | 3d.6e |
| Pay + webhook on Main-created session | **Proven** | 3d.8b organic Stripe on `WH-260528-5369` |
| Integrated Send Confirmation (dry-run) | **Proven** | 3d.9b exec **1077** on same booking |
| Rooming / reassign E2E | **Proven** | **3e.4 PASS** ? `WH-260528-5322`, beds R3-B1/R3-B2 |

**Not proven in Stage 3:** real WhatsApp send; Send Confirmation schedule-poll; single-window E2E; full package intelligence.

**Freeze:** [`PHASE-3c-3d-FREEZE.md`](PHASE-3c-3d-FREEZE.md) ? formal 3c+3d checkpoint before Phase 3e.3+.

**Detail:** [`PROJECT-STATE.md`](PROJECT-STATE.md) ? [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md)

### Stage 3 exit criteria

Stage 3 is **complete only when all of the following are met** (or explicitly deferred with documented safe fallback):

**Core behavior proven:**
- [ ] `booking_flow` hold creation (PG + Airtable backfill) ?
- [ ] `payment_details_provided` route + Ensure ?
- [ ] Real Stripe checkout link (Main-integrated) ?
- [ ] Isolated Create Payment Session ?
- [ ] Stripe Webhook Handler payment truth ?
- [ ] Send Confirmation (dry-run) ?
- [ ] Integrated pay + webhook + confirmation ?
- [ ] Rooming / reassign E2E ?

**Safety invariants proven:**
- [ ] No Main direct writes to `payments` / `payment_events` ? (static proof)
- [ ] No payment/confirmation path writes `booking_beds` ? (static proof)
- [ ] Hosted/prod URLs removed from all local test paths ? (3e.2)
- [ ] Terminal evidence bookings not reused without reset (policy established)

**Guards verified or explicitly deferred:**
- [x] Wrong-booking guard tested for dangerous actions (rooming, payment, cancel) ? **3e.5 CLOSED** (L1+L2 PASS; L3 deferred ? Airtable-coupled runtime deferred to Postgres source-of-truth cutover; see ?15.6??15.7)
- [x] Duplicate / idempotency protections verified at Stage 3 bar ? **3e.6 CLOSED** (I1 schema PASS ? I4 runtime PASS ? I6 invariant PASS; I2/I3/I5 deferred: I2 ? manual-pay gate ? I3 ? Stage 3.5 ? I5 ? Postgres cutover)
- [ ] All dangerous actions have handoff / fail-safe behavior when required business rule is missing ? *3x.7?3x.8 spec done; implementation pending*

**Acceptable deferrals (do not block Stage 3 exit if documented):**
- Real WhatsApp send ? dry-run mode (`WHATSAPP_DRY_RUN=true`) is sufficient; shadow mode (Stage 3y) covers real send
- Send Confirmation schedule-poll ? schedule `disabled=true` gate is sufficient for Stage 3; verify in Stage 3y
- Single-window integrated E2E ? isolated gate chains are sufficient for Stage 3

**Acceptance metric gates:**
- 0 double bookings in all runtime test gates
- 0 wrong-booking dangerous actions in test gates
- 0 payment truth updates outside Stripe Webhook Handler
- 0 confirmations without payment truth
- 0 real WhatsApp sends in dry-run test gates
- 100% dangerous-action routes have handoff/fail-safe when required business logic is missing

---

## Stage 3.5 ? Safety Rails Before Reliability

**Purpose:** Pull forward the minimum safety plumbing required to safely run more runtime gates and prepare for live/shadow mode. This is not full Stage 4 observability ? it is seatbelts.

**When to do Stage 3.5:** After Stage 3 exit criteria are met, before Stage 3y (shadow/co-pilot) or live guest operation.

### Minimum safety requirements (Stage 3.5)

| Item | Why |
|------|-----|
| `automation_errors` capture/write path | Know when bot fails silently |
| Standard workflow error handler pattern | Consistent safe fallback across all n8n workflows |
| Idempotency: inbound WhatsApp message id | No duplicate booking from retry/double-delivery |
| Idempotency: Stripe event id | No duplicate `payment_events` row |
| Idempotency: payment-link reuse | No duplicate checkout session without explicit guard |
| Idempotency: Send Confirmation | Cannot confirm twice (`confirmation_sent_at` + flag) |
| Idempotency: rooming/reassign | Cannot double-assign or double-delete beds |
| Double-booking guard / DB overlap check | `booking_beds` overlap detection query; reject or alert before insert |
| Stuck booking detection (basic) | Bookings in `payment_pending` > N hours with no event; holds expired but not released |
| Workflow active-state safety check | Automated assertion: only expected workflows active before dangerous test or runtime |
| Schedule disabled/enabled safety check | Send Confirmation schedule `disabled=true` verified before any payment/confirmation test |
| Minimum execution logging | For each execution: `resolved_route`, confidence, selected booking id, dangerous action taken (or no-op reason) |
| Golden-runner stub | Even a fixture-file runner (`test:golden-messages`) blocks regression in CI before Stage 4 |

**Stage 3.5 does not include:** full monitoring dashboards, Azure deploy, Staff UI, broad n8n ? backend refactor.

**Full sub-phase spec:** [`PHASE-3.5-SAFETY-RAILS-PLAN.md`](PHASE-3.5-SAFETY-RAILS-PLAN.md) ? 3.5a?3.5g with entry/exit criteria, work-type classification, and first implementation step.

**Key schema finding:** `automation_errors` and `workflow_events` tables exist in migration 001 but are not yet wired into any n8n workflow. Stage 3.5b is a pure wire-in task.

---

## Stage 3y ? Shadow / Co-pilot Pilot

**Purpose:** Bridge the gap between isolated dry-run proof and autonomous live guest operation. Reduces the dry-run ? real-guest cliff; generates real labeled data; builds Ale/Cami trust in the system.

**Full plan:** [`PHASE-3y-SHADOW-COPILOT-PLAN.md`](PHASE-3y-SHADOW-COPILOT-PLAN.md) ? entry criteria, operating modes A?D, allowed/forbidden actions, staff approval workflow, infrastructure requirements, 15-test matrix (Y-T1?Y-T15), exit criteria.

### How shadow/co-pilot mode works

| Step | Who acts |
|------|----------|
| Real guest message arrives (or pasted in offline shadow) | n8n / Main reads it |
| Bot resolves route + drafts response | Bot (automated) |
| Bot suggests safe action (if any) | Bot outputs draft; **no autonomous send** |
| Staff reviews draft | Ale / Cami |
| Staff approves and sends | **Staff (manual)** |
| Staff edit logged as labeled example | System records correction (interim: offline log) |

### Operating modes (ascending risk ? gate each separately)

| Mode | Description | Gate |
|------|-------------|------|
| **A ? Offline shadow** | Pasted/copied messages; local n8n; no live connection | ? Ready to start (no new infra) |
| **B ? Real inbound, no sends** | Real WhatsApp inbound; `DRY_RUN=true` enforced | Separate explicit approval required |
| **C ? Staff-approved draft queue** | Bot writes draft to review queue; staff approves and sends manually | Mode B stable + review UI |
| **D ? Staff-approved action proposals** | Bot proposes dangerous action; staff clicks approve | Stage 6 Staff UI + all 3x complete |

### What is and is not allowed in Stage 3y

| Allowed | Not allowed without explicit approval |
|---------|--------------------------------------|
| Bot reads / classifies message text | Autonomous WhatsApp reply |
| Bot resolves route and flags uncertainty | Autonomous payment link creation |
| Bot drafts response for staff review | Autonomous booking confirmation |
| Bot identifies missing required fields | Autonomous cancellation or room reassign |
| Bot logs decision to `workflow_events` | Payment truth writes |
| Staff-approved sends (manual copy-paste) | Any dangerous action without per-action gate |

### Why Stage 3y before Stage 4

- Avoids big-bang flip from dry-run to fully autonomous
- Creates real labeled guest-message data from actual interactions
- Staff corrections become labeled training examples for Stage 4
- Ale/Cami can see and trust bot behavior before handing over
- "AI drafts, staff approves" is a distinct, sellable product tier

---

## Stage 3x ? Bot knowledge + safety guardrails

**Mini-phase before fully entering Stage 4 (Reliable).**

**Master spec:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)  
**Owner questionnaire:** [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md)

### Purpose

Define the business knowledge and decision rules the bot needs to act safely, ask smart follow-up questions, and avoid dangerous guesses.

**Important:** Stage 3x delivers **specs, fixtures, and configurable rules** ? not a huge expansion of n8n IF nodes. Implementation belongs in code modules (Stage 5) fed by client config.

| Sub-phase | Status |
|-----------|--------|
| **3x.1** Full roadmap ?3x.1?3x.11 + exit criteria + 35 golden rows | **Done** (2026-05-28 retry) |
| **3x.1b** Customer memory layered model (?3x.5) | **Done** (2026-05-28) |
| **3x.2b** Minimum Business Logic Baseline + Stage 4 entry gate | **Done** (2026-05-29) |
| **3x.2c** Applied owner P1 answers ? baseline v0.2 + handoff/add-on plans | **Done** (2026-05-29) |
| **3x.2d** Working prices + policies ? baseline v0.3 (provisional pricing) | **Done** (2026-05-29) |
| **3x.2** Ale/Cami **confirm** provisional prices + fill gaps ? confirmed config | In progress |
| **3x.3** WhatsApp mining + golden fixtures + customer extract | Planned |
| **3x.4** Golden runner + Stage 4 reliability hooks | Planned |

**Stage 3x includes:** required-field map ? package decision flow ? Wolfhouse knowledge collection ? **WhatsApp history mining** ? **customer memory migration** ? golden message tests ? dangerous-action gates ? human handoff ([`STAFF-HANDOFF-PLAN.md`](STAFF-HANDOFF-PLAN.md)) ? during-stay add-ons ([`DURING-STAY-ADDONS-PLAN.md`](DURING-STAY-ADDONS-PLAN.md)) ? wrong-booking protection ? duplicate protection ? client-config architecture ? **exit criteria** ([`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)).

### Summary index (detail in master spec)

### 3x.1 ? Required field map

Define required fields **before** each action:

| Action | Required before proceed |
|--------|-------------------------|
| Create booking hold | Dates, guest count, contact phone, package or accommodation intent, availability OK |
| Send payment link | Hold exists, guest name + email, promoted payment state, deposit rule known |
| Confirm booking | Payment truth (`deposit_paid` / paid), `send_confirmation` gate, not terminal |
| Cancel booking | Booking id/code, policy window, staff approval if ambiguous |
| Room / bed assignment | Confirmed or approved hold, guest count, gender/couple/friend rules |
| Package quote | Package code, dates, guest count, season |
| Package booking | Quote inputs + package-specific required fields |
| Date change | Booking id, new dates, availability, policy |

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ?3x.1](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x1--required-field-map) + fixture tables keyed by `resolved_route`.

### 3x.2 ? Package explanation + package decision flow

The bot must explain package differences clearly.

**Define per package:**

- Name, inclusions, exclusions
- Price or price logic (season, nights, per person)
- Deposit rules, minimum nights
- Lesson schedule, rental rules, meals, transfers
- Cancellation/refund policy
- Who the package is best for

**Bot behavior rules:**

| Guest signal | Bot behavior |
|--------------|--------------|
| ?What packages do you have?? | Briefly explain all packages |
| Wants to book, package missing | Ask: accommodation only vs surf package |
| Unsure | Recommend by goal: cheapest ? shared accommodation; beginner ? lesson package; full arrange ? full surf; already surfs ? accommodation + rentals |
| Price question | Do **not** quote exact price unless dates, guest count, package, and price source are known |
| Still uncertain | Follow-up question or staff handoff |

### 3x.3 ? Wolfhouse knowledge collection

Operational gaps only (not public website facts). Questionnaire for Ale/Cami:

**Deliverable:** [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md)

### 3x.4 ? WhatsApp history mining plan

Redacted Cami/Ale guest threads ? **dual outputs:** (A) anonymized bot knowledge + (B) structured customer memory (see ?3x.5).

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ?3x.4](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x4--whatsapp-history-mining-plan); redacted samples under `docs/knowledge/whatsapp-samples/` (not in git until anonymized).

### 3x.5 ? Customer memory + WhatsApp history migration

Layered model: temporary raw import ? structured customer facts (PG, `client_id`-scoped) ? anonymized fixtures. Proposed tables: `customers`, `customer_booking_history`, `conversation_summaries`, `customer_preferences`, `customer_notes`, `privacy_requests` (future).

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ?3x.5](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x5--customer-memory--whatsapp-history-migration). Owner questions: [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md) ? Customer memory.

### LLM safety requirements (across Stage 3x + Stage 4)

The bot must never act on LLM output alone for dangerous actions. The following are required:

| Requirement | Stage |
|-------------|-------|
| Low confidence ? human handoff (not silent no-op) | 3x.8 spec ? 3.5 impl |
| LLM/API error ? handoff or logged safe fallback | 3.5 |
| Parsing uncertainty ? clarification question, not action | 3x.8 spec ? 3.5 impl |
| `resolved_route`, confidence, selected booking, and action logged per execution | 3.5 |
| Golden-message suite used as prompt regression evaluation | 3x.6 ? 4 |
| Multilingual behavior tested: English / Spanish / Italian | 3x.6 |
| Bot never marks `paid` / `cancelled` / `confirmed` based only on LLM interpretation | 3x.7 gate ? proven in 3d.5b (webhook owns truth) |

### Stage 3x exit criteria

Documented in master spec ? planning complete when ?3x.1?3x.11 + exit checklist exist; full golden fixture set may complete in 3x.3.

### 3x.6 ? Golden message tests

**30?50** realistic guest messages with expected:

- `resolved_route`
- Missing fields
- Safe action (or explicit no-op)
- Clarification question text (pattern, not exact LLM wording)
- Handoff behavior

**Categories to include:**

- Booking request ? package questions ? payment-link request ? ?I paid?
- Cancellation ? room preference ? couple/friends/gender rooming ? date changes
- Surfboard/wetsuit rental ? breakfast/transfer ? unclear / low-confidence messages

**Deliverable:** `docs/fixtures/golden-messages/` + runner stub (Stage 4+). Schema + samples in master spec ?3x.6.

### 3x.7 ? Dangerous action gates

Strict proof required before:

| Action | Proof |
|--------|--------|
| Send payment link | Hold + Ensure + CPS contract; no terminal booking |
| Confirm booking | Webhook payment truth + Send Confirmation eligibility |
| Cancel booking | Booking status + policy |
| Change room/bed | Assignment rules + capacity |
| Change dates | Availability + policy |
| Mark payment-related states | Webhook or authorized staff only |

### 3x.8 ? Human handoff rules

Bot must stop guessing and alert staff when:

- Low route confidence
- Conflicting dates or guest count
- Multiple active holds for same conversation
- Guest says they paid but no payment record
- Refund / dispute / cancellation ambiguity
- Angry guest / complaint
- Medical / emergency / legal issues
- Rooming / reassign uncertainty

**Deliverable:** `handoffRules` spec ? later `client_config.handoff_rules`.

### 3x.9 ? Wrong-booking protection

Formalize (align with existing resolver + PG):

- `conversation.current_hold_booking_id` wins over phone-only fallback
- Terminal bookings (`confirmed`, `cancelled`, etc.) cannot be modified by guest path
- Old holds must not be selected because phone matches alone
- Active booking must match conversation context and latest intent

### 3x.10 ? Duplicate protection

Verify and document:

| Scenario | Expected |
|----------|----------|
| Same WhatsApp message id | No duplicate booking |
| Repeated payment-link request | No duplicate checkout session without idempotency |
| Same Stripe event id | No duplicate `payment_events` row |
| Confirmation | Cannot send twice (`confirmation_sent_at`, flags) |

### 3x.11 ? Client-config architecture plan

Same assistant engine, different **client config** per property.

| Config category | Examples |
|-----------------|----------|
| `packages` | Codes, seasons, inclusions |
| `room_types` | Shared, private, gender rules |
| `bed/room_rules` | Couples, friends, operator blocks |
| `pricing` | Rules, deposits, rounding |
| `deposit/payment_rules` | Deposit cents, deadlines |
| `cancellation_policy` | Windows, refund tiers |
| `hold_expiry` | TTL, reminders |
| `language/tone` | Default language, formality |
| `handoff_rules` | Triggers, staff notify |
| `integrations` | Stripe, WhatsApp, webhooks |
| `staff_notification_rules` | Channels, severity |
| `customer_memory_policy` | Retention, allowed fields, returning-guest rules |

Wolfhouse = `client_slug: wolfhouse-somo`. Future surf houses add new config rows, not forked workflows.

---

## Source-of-truth cutover ? Airtable ? Postgres

This is a **first-class roadmap event**, not a scattered implementation detail. Airtable is the current operational source of truth for staff. Postgres is the engineering source of truth for the bot. Cutover must happen deliberately.

### Cutover phases

| Phase | Description | Gate |
|-------|-------------|------|
| **Current** | Airtable = staff SoT; Postgres = bot SoT; dual-write in progress | Active |
| **Read-only compare** | Run both reads; log discrepancies; do not act on mismatch | Before any cutover |
| **`DATA_SOURCE` flag** | Config-driven: `airtable` \| `postgres` per path; allows per-path rollout | Stage 4 |
| **Soak period** | Postgres-primary writes; Airtable as backup read; monitor for divergence | Stage 4?5 |
| **Airtable dependency removal** | Only after staff UI or equivalent replacement exists | Stage 6+ |
| **Backup policy** | Full Airtable export + PG dump before each cutover step | Required |
| **Rollback plan** | Revert `DATA_SOURCE` flag; restore from backup; documented runbook | Required |

**Do not remove Airtable dependency** until:
1. Staff UI (Stage 6) or equivalent is live for all Airtable use cases it currently covers
2. PG data has passed a soak period without divergence
3. Backup and rollback procedure is documented and tested

---

## Privacy / GDPR gate before customer memory

**No Layer-2 structured customer memory with personal data until all of the following exist:**

| Requirement | Status |
|-------------|--------|
| Documented purpose for each stored personal field | Planned (3x.2) |
| Retention policy per field type | Planned (3x.2) |
| Staff-only note handling (no guest-facing access to staff notes) | Planned |
| Delete / export / correction procedure documented | Planned |
| Marketing opt-in separated from booking support data | Planned |
| Raw WhatsApp exports kept off-repo / in `data/private/` (gitignored) | **Done** (`84fa45f`) |
| Only reviewed/sanitized fixtures in repo | Policy established |

**This gate applies before 3x.3 customer extract is written to PG.** Planning (3x.2) may proceed; PG insert of personal data requires privacy gate first.

---

## Stage 4 ? Reliable

**Status (2026-05-30): CLOSE WITH DEFERRALS.** Autonomous Booking Dry-Run complete ? all 14 scenarios PASS (commit `6cd9a21`). Evidence: `test-payloads/stage4/autonomous-dry-run/README.md`. Live WhatsApp, live holds, live Stripe, and live confirmation writes remain deferred. Structured add-on records and staff ops assistant deferred to Stages 5?6.

### Purpose

Make the working system **dependable and observable** after Stage 3 behavior is proven and Stage 3x rules are specified.

### Entry gate (defined in baseline config + ?3x.2b)

Gate definition: [`config/clients/wolfhouse-somo.baseline.json`](../config/clients/wolfhouse-somo.baseline.json) (`stage4_entry_gate`) and [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ?3x.2b/?3x.2c](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x2c--applied-owner-answers-2026-05-29).

**Reduced after 3x.2c** (payment-link auto-send, hold expiry, confirmation content, conditional cancel/date-change, rooming auto-assign + operator-room logic all confirmed). **Remaining owner blockers:** deposit amount/scope ? non-7-night pricing math ? cancellation/refund windows & % ? add-on service prices/scheduling (if in Stage 4 scope) ? real WhatsApp send gate or Stage 3y shadow ? final handoff channel. **Not blockers:** perfect tone ? full customer memory ? marketing opt-in ? exact add-on automation.

**Additional entry requirement:** Autonomous booking dry-run pass ? bot completes full booking flow (inbound message ? route ? availability ? hold ? payment-link ? Stripe webhook ? confirmation) without errors in all-stubbed mode, proving readiness before real sends or live operation are enabled.

### Includes

- **Autonomous booking dry-run** (first Stage 4 milestone): full booking flow end-to-end ? inbound message ? route ? availability ? hold ? payment-link ? Stripe webhook ? confirmation ? with all live side effects stubbed at the infrastructure boundary. Proves the bot completes the booking correctly before real sends or live operation are enabled. This is the regression anchor: once green, enabling real WhatsApp send or live operation is a config change, not a behavior change.
- Better error handling and safe retries (where idempotent)
- Stuck booking detection
- Monitoring, alerts, execution dashboards
- Clearer structured logs
- Health checks (n8n, Postgres, Redis, webhooks)
- Rollback tools and fixture cleanup
- Duplicate protection checks (automated)
- Active workflow safety checks; schedule safety checks
- Runbooks for common failures (payment stuck, webhook miss, confirmation not sent)

### Staff visibility (minimum for safety)

May begin here if needed before full Stage 6 UI:

- Stuck bookings queue
- Payment status view
- Human handoff queue
- Pending confirmations
- Failed workflow executions
- **Staff query assistant** (read-only ops Q&A: "who has a surfboard today?", "who arrives today?", "which rooms need cleaning and by when?") gated by an **approved-staff allowlist** (`staff_directory`; portal = Stage 6) ? [`STAFF-QUERY-ASSISTANT-PLAN.md`](STAFF-QUERY-ASSISTANT-PLAN.md)

### Add-on structured records (Stage 4 design requirement)

Add-on dry-run tests (e.g. A9 ? lessons, yoga, rentals) must do more than verify the guest-facing price quote is correct. They must also prove the system can **represent add-on requests as structured, staff-queryable records**. This is the data foundation that makes Stage 6 staff queries possible.

Each add-on request that passes through the bot should be representable as a record with at minimum:
- Guest / booking reference
- Add-on type (lesson, wetsuit, board, yoga, dinner)
- Quantity / number of days
- Requested date(s)
- Payment status (pending / paid)
- Fulfillment status (not redeemed / redeemed ? staff-managed)
- A flag indicating whether staff scheduling / manual tracking applies (e.g. lessons require a manual slot assignment)

**Stage 4 does not require full add-on automation.** It requires that when the bot processes an add-on request, the output can be persisted in a shape that is queryable by staff. If no structured add-on record is written yet, the design must identify where it would be written and what the schema looks like ? so Stage 5 does not have to invent it from scratch.

---

## Stage 5 ? Clean

**Status (2026-05-31): CLOSE WITH DEFERRALS ? source-of-truth cleanup complete (5.1?5.8b); engine extraction / portability scope deferred.** All staff-queryable data tables are schema-stubbed and query helpers are proven. Migrations 007 (add-ons) and 008 (staff handoffs) are ready to apply. Live operation, engine extraction, and staff UI remain deferred (Stage 6). Detail: [`PHASE-5-SOURCE-OF-TRUTH-CLEANUP.md`](PHASE-5-SOURCE-OF-TRUTH-CLEANUP.md).

### Purpose

Simplify implementation after behavior is proven and reliability checks exist.

### Safety-critical early extractions (pull forward to Stage 3.5 / 4 only if needed)

Do **not** do broad Stage 5 refactor before Stage 3 / 3.5 safety gates. However, pull forward **only** these safety-critical items when required:

- Wrong-booking guard (if not proven in Stage 3 negative tests)
- Dangerous-action gate checks (missing required business rule ? handoff)
- Duplicate / idempotency checks (if Stage 3.5 requires them in code)
- Bed-assignment overlap / dedup logic (if DB constraint is insufficient)
- `client_config` loading skeleton (if Stage 3x requires it for golden tests)

### Includes

- Move decision logic out of n8n into `src/booking-assistant/` (n8n becomes I/O only).
- **Extract along the portability seam** ([? Engine portability](#engine-portability--adding-a-new-vertical-surf-shop--lessons)): shared spine vs `inventory/` + `catalog/` plugins ? do **not** produce a tidied-up surf-house monolith.
- Implement `InventoryProvider` with **lodging** as the first concrete provider; keep the interface generic enough for `slots` / `rentals`.
- Split `client_config` into **engine config** (spine) + **vertical config** (catalog / inventory / capabilities); rooming behind a capability flag.
- Replace serialized-into-n8n Code nodes (e.g. the resolver) with calls to the extracted, version-checked modules.

**Target:** n8n calls backend decision engine; Postgres writes go through shared SQL/modules; n8n performs WhatsApp/Stripe/Airtable I/O.

**Portability acceptance for Stage 5:** the Wolfhouse spine compiles and passes golden tests with **zero surf-house nouns** outside `inventory/lodging.*` and `client_config`. (Verify against the portability gate checklist.)

### Staff-queryable operational data (Stage 5 requirement)

Source-of-truth cleanup must explicitly produce the structured Postgres records that power Stage 6 staff queries. The data design goal is: **staff questions are answered from reliable structured records, not guessed from chat logs or Airtable exports.**

The following tables/models must be designed (and at minimum stubbed in schema) during Stage 5, before the Stage 6 staff assistant is built:

| Table / model | Answers the question |
|---|---|
| `add_on_orders` | Which guests have requested add-ons? What is the payment status per order? |
| `add_on_items` | Line-item detail per order (type, qty, days, dates, price) |
| `lesson_requests` | Who has lessons today / tomorrow? What slot? (staff assigns; bot records request) |
| `rental_requests` | Who requested a board / wetsuit? For how many days? Pickup status? |
| `yoga_requests` | Who paid for yoga? For which date? (redeemed on-site by staff) |
| `staff_handoffs` / `staff_tasks` | Which conversations need a human reply? Why was it handed off? Current state? |
| `payment_balances` (view or table) | Who still owes money? Who paid deposit but not full balance? |

These are **not new features** ? they are the structured forms of data the bot already collects. The goal of Stage 5 is to ensure that data lands in Postgres in a queryable shape instead of only in Airtable or serialized chat session state.

**Design gate for Stage 5:** before beginning Stage 6 staff UI work, verify that a staff member can ask each of the following questions and get a correct answer from Postgres without touching Airtable or reading raw WhatsApp messages:

- "Who paid for yoga today?"
- "Who has lessons tomorrow?"
- "Who still owes money?"
- "Who requested a board?"
- "Which bookings need a human reply?"
- "Show today's arrivals and departures."
- "Who paid deposit but not full balance?"
- "Which guests requested rooming preferences?"

---

## Stage 6 ? Beautiful (Staff / Admin Layer)

**Status: CLOSED WITH DEFERRALS** (2026-05-31) ? All exit criteria MET. 6.0?6.9 DONE: 35-intent registry, CLI runner, batch reports, CLI write action, HTTP API, browser UI, smoke test, token-gated write endpoint. Production auth/TLS/live-ops deferred to Stage 7. See [`PHASE-6-STAFF-ASSISTANT-PLAN.md`](PHASE-6-STAFF-ASSISTANT-PLAN.md).

**Implementation slices:** 6.1 registry DONE ? 6.2 CLI runner DONE ? 6.3 handoffs DONE ? 6.4a/b/c/d batch reports DONE ? 6.5a/b CLI write action DONE ? 6.6 HTTP API DONE ? 6.7 intent smoke DONE ? 6.8 read-only UI DONE ? 6.9 token-gated write endpoint DONE.

### Purpose

Excellent staff and owner experience. This is where the **two-sided product** becomes visible: the guest-facing assistant (already built) and the **staff-facing operations assistant** (built here).

### Two sides of the product

| Side | Who uses it | What it does |
|------|------------|--------------|
| **Guest assistant** | Guests on WhatsApp | Bookings, questions, payments, confirmations, add-ons, rooming, handoff |
| **Staff assistant / admin** | Ale, Cami, operators | Operational queries, action review/approval, conversation takeover, status dashboards |

### Staff Operations Assistant

Staff can ask operational questions and get answers from **structured Postgres records** (not chat logs or guesses). All queries are read-only, gated by `staff_directory` approved numbers.

**Example questions the staff assistant must answer:**

- "Who paid for yoga today?"
- "Who has lessons tomorrow?"
- "Who still owes money?"
- "Who requested a board?"
- "Which conversations need a human reply?"
- "Show today's arrivals and departures."
- "Who paid deposit but not full balance?"
- "Which guests requested rooming preferences?"

**Design constraint:** these questions are answered from the structured records built in Stage 5 (`lesson_requests`, `add_on_orders`, `staff_handoffs`, `payment_balances`, etc.). The assistant maps natural-language questions to fixed safe parameterized intents ? it never generates arbitrary SQL.

### Staff Approval Controls

Staff can review, approve, and act on bot proposals without going directly into n8n or Airtable:

- View bot draft reply before it is sent
- Approve or reject risky bot action proposals (payment, cancellation, room reassign)
- Take over a conversation from the bot
- View payment / hold / rooming / add-on status per booking
- Mark add-on as redeemed (voucher fulfilled on site)
- Release or block operator rooms

### Staff UI

- Calendar / bed grid, guest list, booking detail
- Payment status, pending holds, confirmation queue
- Conversation history, human takeover
- Manual booking / edit / cancel tools
- Room/bed assignment UI
- Alerts for stuck workflows
- Owner dashboard

Airtable may remain a **bridge** during transition; long-term goal is a proper staff UI, not Airtable as daily ops surface.

**Airtable cutover prerequisite:** the staff UI (or equivalent) must cover all use cases Airtable currently serves before Airtable is removed as a dependency ? see the Source-of-truth cutover table above.

---

## Stage 7 ? Scalable


**8.5.1 LUNA BOT SHARED ENGINE INTEGRATION MAP -- PASS (2026-06-02):** Planning/static mapping only. No code, no DB writes, no Azure deploy, no WhatsApp sends, no n8n activation. Static inspection of bot n8n workflow JSONs (Main, Create Payment Session, Stripe Webhook Handler). Key findings: bot creates Airtable Hold (not Postgres booking), calls Stripe directly from n8n using Airtable amounts + STRIPE_DEFAULT_DEPOSIT_CENTS=20000 fallback -- completely bypasses calculateWolfhouseQuote() and draft payments row; no payment_id in Stripe metadata. 6 large gaps, 1 medium, 2 small. No bot parser/session files in scripts/ -- all bot logic in n8n JSON. Integration map: [STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md](STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md). No bot wiring implemented. No WhatsApp sends. No n8n activation. Shared engine integration map complete. Next: 8.5.2 static verifier.


**8.5.19 HOSTED LUNA CONFIRMATION DRAFT DRAWER PROOF -- PASS (2026-06-03):** Image `wh-staff-api:4872768-stage8519-confirmation-drawer` deployed to `wh-staging-staff-api` revision `--0000022` (ACR run `cbg`, Healthy, 100% traffic). Preflight: clean tree at `4872768`; `verify-staff-bed-calendar-ui.js` 294/294 PASS. Hosted drawer proof on `MB-WOLFHO-20260801-4f10c3`: panel **Luna confirmation draft ready** with booking_code, guest_name, Deposit paid, €100.00 paid, €150.00 balance, DEMO-R1, gate `2684#`, `sends_whatsapp:false`, `whatsapp_dry_run:true`. No send button. Network: `/staff/bookings/.../context` only — no stripe.com, no n8n, no graph.facebook.com. n8n `stage8510SharedDryRun01` inactive. No WhatsApp sent. Next: optional live Luna confirmation send (separate gate).

**8.5.18 SHOW LUNA CONFIRMATION DRAFT IN BOOKING DRAWER -- PASS (2026-06-03):** Staff Portal drawer shows read-only Luna confirmation draft panel when `bookings.metadata.confirmation_draft` exists. Booking context API loads metadata + exposes `confirmation_draft`. Panel: booking_code, guest_name, payment_status, amounts, room, gate_code, sends_whatsapp:false, whatsapp_dry_run:true. No send button. No WhatsApp/n8n/Stripe from drawer. `verify-staff-bed-calendar-ui.js` 294/294 PASS. Next: optional hosted drawer proof on staging (future).

**8.5.17 HOSTED PERSISTED CONFIRMATION_DRAFT PROOF -- PASS (2026-06-03):** Image `wh-staff-api:bdc2b3f-stage8517-persist-confirmation-draft` deployed to `wh-staging-staff-api` revision `--0000021` (ACR run `cbf`, Healthy). Signed webhook on `MB-WOLFHO-20260801-4f10c3` → 200; `confirmation_draft` in response **and** `bookings.metadata.confirmation_draft` persisted (`deposit_paid`, 10000/15000 cents, `DEMO-R1`, gate `2684#`, `sends_whatsapp:false`, `whatsapp_dry_run:true`). `confirmation_sent_at` null. n8n inactive. No WhatsApp. Next: optional Staff Portal read of metadata draft (future).

**8.5.16 PERSIST LUNA CONFIRMATION_DRAFT IN BOOKINGS.METADATA -- PASS (2026-06-03):** Stripe webhook persists `confirmation_draft` to `bookings.metadata.confirmation_draft` in the same transaction as payment truth when status becomes `deposit_paid` or `paid`. Draft built once; same fields as 8.5.14 response; still returned in webhook JSON. No `confirmation_sent_at`. No WhatsApp. No n8n. `verify-staff-stripe-webhook-api.js` 76/76 PASS. Next: optional hosted proof on staging (future).

**8.5.15 HOSTED LUNA CONFIRMATION_DRAFT WEBHOOK PROOF -- PASS (2026-06-03):** Image `wh-staff-api:d3929b2-stage8515-confirmation-draft` deployed to `wh-staging-staff-api` revision `--0000020` (ACR run `cbe`, 100% traffic, Healthy). Signed `checkout.session.completed` on Luna booking `MB-WOLFHO-20260815-4d37a0` → 200 with `confirmation_draft`: `deposit_paid`, `amount_paid_cents:10000`, `balance_due_cents:40000`, `room_number:DEMO-R1`, `gate_code:2684#`, `sends_whatsapp:false`, `whatsapp_dry_run:true`. `no_whatsapp/no_n8n/no_confirmation_sent:true`. `confirmation_sent_at` unchanged. n8n `stage8510SharedDryRun01` inactive. No WhatsApp sent. Next: optional live Luna confirmation send (separate gate).

**8.5.14 LUNA PAYMENT CONFIRMATION DRAFT -- PASS (2026-06-03):** Stripe webhook success response extended with `confirmation_draft` when `payment_status` becomes `deposit_paid` or `paid`. Draft includes booking_code, guest_name, paid/deposit status, amount_paid_cents, balance_due_cents, room_number (primary_room_code), address/gate_code from client baseline config (gate `2684#` when configured). `sends_whatsapp:false`, `whatsapp_dry_run:true`. No WhatsApp send. No n8n call. No `confirmation_sent_at` write. Payment truth logic unchanged. `verify-staff-stripe-webhook-api.js` 69/69 PASS. Next: optional hosted proof on Luna booking `MB-WOLFHO-20260822-3a4d1a` (future).

**8.5.13 LUNA-CREATED BOOKING WEBHOOK TRUTH PROOF -- PASS (2026-06-03):** Luna dry-run booking `MB-WOLFHO-20260822-3a4d1a` (Stage 8.5.12 n8n exec #5; `source:bot_stage855`; phone `+34999000123`) proven through signed `checkout.session.completed` → `POST https://staff-staging.lunafrontdesk.com/staff/stripe/webhook` (HMAC-valid; no SKIP_VERIFY). Payment: `payment_id:a90d9cf6-5a8d-4741-94db-8e461796590f`; session `cs_test_a122Kv5a...`. Webhook **200**: `deposit_paid`, `amount_paid_cents:10000`, `booking_balance_due_cents:40000`, `no_whatsapp:true`, `no_n8n:true`, `no_confirmation_sent:true`. DB: `payments.status=paid`, `amount_paid_cents=10000`, `paid_at` set; `bookings.payment_status=deposit_paid`, `balance_due_cents=40000`. Staff Portal drawer: **Deposit paid ✓** banner; Total €500 / Paid €100 / Balance €400; paid_at + Stripe IDs visible. No WhatsApp. No n8n activation. No live guest message. Extends 8.4.13 manual-booking webhook proof to Luna bot path. Test booking left on staging. Next: optional live Luna path (future).

**8.5.12 STAGING-SAFE LUNA DRY-RUN RE-IMPORT + HOSTED PROOF -- PASS (2026-06-03):** Stage 8.5.11 repo workflow re-imported into staging n8n **without import-time patches** (`stage8510SharedDryRun01`, `active:false`, 17 nodes). Header Auth credential `Luna Bot Internal Token (staging)` created/bound (`stage8512LunaBotTok01`; header `X-Luna-Bot-Token`; value from Key Vault `luna-bot-internal-token`). Manual execution #5 success (~2s) with pinned payload (`+34999000123`, Test Guest, 2026-08-22→2026-08-27, 2 guests, malibu/shared/deposit). **No temp IF bypass. No `$env` patches.** `Set - DryRun Mode Flags` → `$json.dry_run` guard pass → full bot chain → `reply_draft`; `booking_code:MB-WOLFHO-20260822-3a4d1a`; `checkout_url` via Staff API; `whatsapp_sent:false`. No `graph.facebook.com`; no `api.stripe.com`. Workflow inactive. Test booking left on staging (disposable). Next: optional live Luna path (future).

**8.5.11 LUNA SHARED-ENGINE DRY-RUN STAGING-SAFE REPO FIX -- PASS (2026-06-03):** Repo workflow `n8n/Wolfhouse Booking Assistant - Main - Shared Engine Dry Run.json` updated for clean staging import without manual `$env` patches. Added `Set - DryRun Mode Flags` (`dry_run:true`, `live_send_enabled:false`); `IF - DryRun Guard` checks `$json.dry_run` (no `$env` in IF expressions). Four bot HTTP nodes use Header Auth credential placeholder `Luna Bot Internal Token (staging)` — bind `X-Luna-Bot-Token` at import, never hardcoded. `active:false`; all branches `whatsapp_sent:false`; no `graph.facebook.com`; no `api.stripe.com`. `verify-luna-n8n-bot-shared-engine-dry-run.js` updated. Static verifier PASS. Not re-imported/activated in this slice. Next: optional 8.5.12 re-import + manual execution without import-time patches.

**8.5.10 HOSTED LUNA SHARED-ENGINE DRY-RUN EXECUTION -- PASS (2026-06-03):** `n8n/Wolfhouse Booking Assistant - Main - Shared Engine Dry Run.json` imported into staging n8n inactive (`stage8510SharedDryRun01`, `active:false`, 17 nodes). Manual execution #4 success (~15s) with fake guest payload (`+34999000123`, Test Guest, 2026-08-15→2026-08-20, 2 guests, malibu/shared/deposit). Full chain: booking-preview → availability-check → booking-create → Stripe link → draft reply. `booking_code:MB-WOLFHO-20260815-4d37a0`; `checkout_url` via Staff API (not direct Stripe); `reply_draft` generated; `whatsapp_sent:false`. No `graph.facebook.com`; no `api.stripe.com`; no `STRIPE_DEFAULT_DEPOSIT_CENTS` env usage. Test booking left on staging (disposable). Staging import applied guard/token patches for `$env` block. Workflow remains inactive. No activation. No live WhatsApp. Next: 8.5.11 repo guard fix for shared-engine dry-run (optional, like 8.6.6).

**8.5.9 LUNA N8N DRY-RUN AVAILABILITY WIRING -- PASS (2026-06-03):** Updated inactive dry-run workflow Wolfhouse Booking Assistant - Main - Shared Engine Dry Run.json (Stage 8.5.9). 16 nodes: added HTTP - Bot Availability Check node calling POST /staff/bot/availability-check (Stage 8.5.8) before HTTP - Bot Booking Create. Added IF - Has Enough Beds branch: true path proceeds to booking-create with real selected_bed_codes from availability response; false path drafts "I'm checking with the team" reply (no booking, no Stripe, no WhatsApp). selected_bed_codes now sourced from availability-check JSON output — DEMO-R1-B1 placeholder REMOVED. Happy path: booking-preview -> availability-check -> booking-create (real beds) -> Stripe-link -> draft payment reply. WHATSAPP_DRY_RUN guard retained. No api.stripe.com. No STRIPE_DEFAULT_DEPOSIT_CENTS. No graph.facebook.com. verify-luna-n8n-bot-shared-engine-dry-run.js 41/41 PASS. Next: 8.5.10 hosted dry-run execution (done).s.

**8.5.8 BOT AVAILABILITY CHECK ENDPOINT -- PASS (2026-06-03):** POST /staff/bot/availability-check added. requireBotAuth. SELECT-only: getBedCalendarRoomsQuery (beds+rooms) + getBedCalendarBlocksQuery (half-open overlap, excludes cancelled/expired). Room-type filter with room_type_filter_not_strict warning. First-fit selection: selected_bed_codes = first N available for guest_count. Returns has_enough_beds, available_count, available_beds, blockers (not_enough_available_beds), next_action (ready_for_bot_create / ask_staff_or_alternate_dates). All safety fields: preview_only:true, no_write_performed:true, creates_booking/payment/stripe_link/sends_whatsapp:false. No INSERT/UPDATE/DELETE. verify-staff-bot-availability-api.js 39/39 PASS. Local proof: guest_count=2->selected_bed_codes[2]+ready_for_bot_create; guest_count=999->not_enough+ask_staff; 0 DB writes. Next: update n8n dry-run workflow to call this endpoint before bot create.

**8.5.7 LUNA N8N DRY-RUN SHARED ENGINE WIRING -- PASS (2026-06-02):** Inactive dry-run workflow fork `Wolfhouse Booking Assistant - Main - Shared Engine Dry Run.json` created (active:false, NOT imported into live n8n). 12 nodes: WHATSAPP_DRY_RUN guard -> Code - Parse Booking Fields -> HTTP - Bot Booking Preview -> IF missing/ready -> (missing: log draft reply, no send) OR (ready: HTTP - Bot Booking Create -> HTTP - Bot Stripe Link -> Code - Draft Payment Link Reply -> respond). X-Luna-Bot-Token from $env.LUNA_BOT_INTERNAL_TOKEN; never hardcoded. No graph.facebook.com nodes. No api.stripe.com calls. STRIPE_DEFAULT_DEPOSIT_CENTS NOT used as env ref. deposit_required_cents (Airtable) NOT used. Draft payment-link reply from checkout_url returned by Staff API (not n8n Stripe). Original workflow untouched. GAP: selected_bed_codes not in live bot session state -- staging placeholder DEMO-R1-B1; auto-assignment is Stage 8.5.8. verify-luna-n8n-bot-shared-engine-dry-run.js 31/31 PASS. Next: 8.5.8 bed availability query.

**8.6 STAFF ASK LUNA VIA WHATSAPP ALLOWLISTED STAFF PHONES -- ROADMAP ENTRY:** Staff can ask Luna operational questions directly via WhatsApp from allowlisted numbers. Staff phone allowlist in Staff Portal/settings controls access. Staff API owns query intent + helper logic. n8n is WhatsApp pipe only. Staff Portal Ask Luna box optional/secondary. First queries: arrivals/departures, who owes money, deposit/full paid, checkout links pending, beds needing cleaning, needs-human. Later: yoga payments, lessons, board/wetsuit, unpaid add-ons. No guest message leakage. Docs: PRODUCT-MASTER-ROADMAP.md Pillar 3. Implementation: Stage 8.6 (not started).

**8.5.6 AZURE STAGING DEPLOY + HOSTED BOT PROOF -- PASS (2026-06-02):** image `wh-staff-api:dec785c-stage855-bot-engine` built + pushed to ACR `whstagingacr`. Deployed to `wh-staging-staff-api` revision `--0000017`. LUNA_BOT_INTERNAL_TOKEN generated (40-char hex) + stored in KV + wired as env secret. BOT_BOOKING_ENABLED=true, STRIPE_LINKS_ENABLED=true, WHATSAPP_DRY_RUN=true confirmed. STAFF_AUTH_REQUIRED=true, STRIPE_WEBHOOK_SKIP_VERIFY=false unchanged. Hosted proof A: booking-preview ? 200 + preview_only:true + no_write_performed:true + auth_mode:bot_token + total_cents:25000. Hosted proof B: bot booking create (DEMO-R1-B1) ? 201 + booking_code:MB-WOLFHO-20260801-4f10c3 + payment_id:ec4938e8 + creates_stripe_link:false + sends_whatsapp:false. Hosted proof C: bot Stripe link ? 200 + checkout_url:https://checkout.stripe.com/c/pay/cs_test_... + payment_status:checkout_created + no_payment_truth_recorded:true. Safety: wrong token?401, bot token on /staff/ui?302, bot token on /staff/manual-bookings/create?401, payments.amount_paid_cents=0, Stripe test mode. No WhatsApp. No email. No n8n. Test booking left on staging. All 6 verifiers PASS. Next: 8.5.7 n8n dry-run wiring.

**8.5.5 LUNA BOT STRIPE LINK ENDPOINT -- PASS (2026-06-02):** POST /staff/bot/payments/:payment_id/create-stripe-link added. BOT_PAYMENT_STRIPE_LINK_RE regex. requireBotAuth. BOT_BOOKING_ENABLED+STRIPE_LINKS_ENABLED gates (no STAFF_ACTIONS_ENABLED for bot path). Reuses same Stripe SDK + UPDATE payments SQL as 8.4.9. Amount from payments.amount_due_cents. Returns checkout_url, payment_status:checkout_created, next_action:draft_payment_link_reply, sends_whatsapp:false, whatsapp_dry_run:true, no_payment_truth_recorded:true. Does NOT mark paid. Idempotent. verify-staff-bot-stripe-link-api.js 56/56 PASS. All verifiers PASS. Local proof: 200+Stripe checkout URL; DB checkout_created+amount_paid_cents=0; test cleaned up. Next: 8.5.6 Azure deploy.

**8.5.4 LUNA BOT BOOKING CREATE ENDPOINT -- PASS (2026-06-02):** POST /staff/bot/bookings/create added to scripts/staff-query-api.js. BOT_BOOKING_ENABLED=false default (403 when false). requireBotAuth + operator role for SQL helper. Reuses buildManualBookingCreateSql + calculateWolfhouseQuote + shared transaction path. Writes bookings+booking_beds+quote_snapshot+draft payments row. selected_bed_codes required (auto-assign next slice). Returns booking_id, booking_code, payment_id, payment_status:draft, next_action:create_stripe_link, creates_stripe_link:false, sends_whatsapp:false, whatsapp_dry_run:true. No Stripe API calls. No WhatsApp. No n8n. verify-staff-bot-booking-create-api.js 54/54 PASS. All other verifiers PASS. Local proof: 201 + booking_code + payment_id + auth_mode:bot_token + quote.total_cents:45000. Next: 8.5.5 create Stripe link from bot payment_id.

**8.5.3 LUNA BOT INTERNAL TOKEN AUTH -- PASS (2026-06-02):** requireBotAuth() added to scripts/staff-query-api.js; separate from requireAuth -- normal staff auth unchanged; supports X-Luna-Bot-Token header + Authorization Bearer header + session cookie fallback; constant-time timingSafeEqual comparison; token path disabled when LUNA_BOT_INTERNAL_TOKEN empty (safe default); wrong token -> 401; auth_mode:bot_token in response; scoped exclusively to /staff/bot/* routes; LUNA_BOT_INTERNAL_TOKEN from process.env only; verify-staff-bot-booking-preview-api.js 65/65 PASS (12 new checks); all other verifiers PASS; no DB writes; no Stripe; no WhatsApp; no n8n activation. Next: 8.5.4 bot create booking/payment link dry-run.

**8.5.2 LUNA BOT BOOKING PREVIEW ENDPOINT -- PASS (2026-06-02):** POST /staff/bot/booking-preview added to scripts/staff-query-api.js. No DB writes, no Stripe, no WhatsApp, no n8n. Calls calculateWolfhouseQuote() with Luna-parsed booking fields. Returns missing_fields, next_action (ask_missing_fields/ready_for_create_dry_run/staff_review_required), reply_draft text, quote snapshot, availability.status=not_checked. All safety fields: preview_only:true, no_write_performed:true, creates_booking:false, sends_whatsapp:false. Auth: requireAuth('viewer'), not gated on MANUAL_BOOKING_ENABLED/STAFF_ACTIONS_ENABLED. scripts/verify-staff-bot-booking-preview-api.js 53/53 PASS. Local proof: missing-fields->ask_missing_fields; complete Malibu 5-night->ready_for_create_dry_run+total_cents=45000. n8n auth gap documented (n8n will need staff session token in later slice). Next: 8.5.3 bot creates booking via shared engine, dry-run only.

**8.4.13 AZURE STAGING BATCH DEPLOY + E2E PROOF ? PASS (2026-06-02):** Manual booking/payment MVP chain proven on hosted Azure staging. Image `9e5502f-stage8412-manual-booking-mvp` deployed; revision `--0000014` at 100% traffic; flags `STAFF_ACTIONS_ENABLED=true`, `MANUAL_BOOKING_ENABLED=true`, `STRIPE_LINKS_ENABLED=true`, `WHATSAPP_DRY_RUN=true`; KV: `stripe-secret-key` updated, `stripe-webhook-secret` = `whsec_QF79KU...` (Stripe endpoint `we_1TdxY1G36q`); E2E proof: login ? booking `MB-WOLFHO-20260705-30e9d3` (?299/?200 deposit) ? Stripe link `cs_test_a1Mzhctx5` ? signed webhook `checkout.session.completed` (HMAC-valid, no SKIP_VERIFY) ? 200 deposit_paid ? DB paid/paid_at/pi_id set ? drawer shows ? Deposit paid banner + amounts + paid_at + Stripe IDs. 6/6 DB assertions PASS. No SKIP_VERIFY. WhatsApp NOT sent. n8n untouched. Stripe is payment truth. KV secrets redacted in docs. **Next phase: Luna bot uses the same booking/pricing/payment engine.**

**8.4.12 SHOW PAYMENT TRUTH IN BOOKING DRAWER DONE (2026-06-02):** `getBookingPaymentsQuery` now returns `payment_kind`, `currency`, `checkout_url`, `stripe_checkout_session_id` (4 missing fields); `renderBookingContextDrawer` payment section fully rewritten: green banner for deposit_paid/paid; booking totals; per-payment card (green=paid, blue=checkout_created); `pmtStatusLabel()` + `bkPayLabel()` helpers; `paid_at` display; "? waiting for Stripe webhook" when checkout_created; truncated session/intent IDs; checkout_url copy button; "No payment record yet" fallback; read-only only, no writes, no Stripe/WhatsApp/n8n; `verify-staff-bed-calendar-ui.js` 283/283 PASS (23 new checks 219a?220e); DB+webhook proof PASS.

**8.4.11 STRIPE WEBHOOK PAYMENT TRUTH DONE (2026-06-02):** `POST /staff/stripe/webhook` added; `handleStripeWebhook()` handler; `readBodyRaw()` for HMAC body; `STRIPE_WEBHOOK_SECRET`+`STRIPE_WEBHOOK_SKIP_VERIFY` constants; no session auth (identity via Stripe HMAC); `STRIPE_WEBHOOK_SKIP_VERIFY=true` for local fixture testing; `checkout.session.completed` ? payment truth; others ignored 200; payment matched by `metadata.payment_id` ? fallback `stripe_checkout_session_id`; idempotency: already-paid ? 200 idempotent:true, no double-count; `payments`: `status=paid`, `amount_paid_cents`, `paid_at=NOW()`, `stripe_payment_intent_id`, event metadata; `bookings`: `amount_paid_cents`, `balance_due_cents`, `payment_status` (deposit_paid/paid/waiting_payment); `BEGIN/COMMIT/ROLLBACK` atomic; booking.status NOT confirmed; no WhatsApp/email/n8n/confirmation; safety flags in response; `verify-staff-stripe-webhook-api.js` 60/60 PASS; all prior verifiers PASS; local fixture proof: checkout_created?paid, 20000?, deposit_paid, idempotent PASS, ignore PASS. Next: 8.4.12 show paid status in booking drawer.

**8.4.10 STAFF PORTAL CREATE/COPY STRIPE LINK DONE (2026-06-02):** `BC_STRIPE_LINKS` flag embedded server-side; `bcLastPaymentId` state; `payment_id` now returned in create response (RETURNING id); `renderCreateResult` shows payment_id+draft status+"Create Stripe Payment Link" button (gated by `BC_STRIPE_LINKS+BC_STAFF_ACTIONS+payment_id`, disabled when flags off); `runCreateStripeLink()` POSTs to `/staff/payments/:id/create-stripe-link` (never Stripe directly); `renderStripeLinkResult()` shows checkout_url+session_id+"Copy Payment Link" button+webhook-not-paid warning; `navigator.clipboard` copy with `prompt()` fallback; idempotent: re-click returns existing URL; booking drawer Payment section ready for checkout_url when query updated; `bcClearSelection` resets `bcLastPaymentId`; no WhatsApp/email/n8n; no amount_paid update; no booking confirmed; 260/260 bed-calendar-ui PASS (23 new); all verifiers 475/475 PASS; local proof: cs_test session, payment=checkout_created, amount_paid=0, booking unchanged; test data cleaned.

**8.4.9 CREATE STRIPE LINK FROM DRAFT PAYMENT DONE (2026-06-02):** `POST /staff/payments/:payment_id/create-stripe-link`; gated `STAFF_ACTIONS_ENABLED+STRIPE_LINKS_ENABLED` (both default false); `stripe` npm installed; infra/.env loaded as fallback; Stripe Checkout Session (mode=payment, eur, amount from payment.amount_due_cents, metadata includes payment_id/booking_id/source=staff_portal_manual_booking); payment.status?`checkout_created`; stores session_id+checkout_url+expires_at; no amount_paid_cents update; no booking confirmed; no WhatsApp; no n8n; idempotency: already checkout_created ? return existing URL; local proof: cs_test session created, payment=checkout_created, booking=confirmed+payment_status=not_requested unchanged; `verify-staff-stripe-payment-link-api.js` 55/55 PASS; all verifiers 452/452 PASS. Next: 8.4.10 send link to guest.

**Status: IN PROGRESS** (2026-06-02) ? 7.0?7.7 DESIGN DONE ? **7.2b+7.2c+7.3b+7.3c+7.3d+7.3e+7.3f+7.7a?d+7.7f?7.7j+7.7k1?k8 DONE**. **8.0+8.1+8.2+8.5+8.6+8.3 plan+8.3a-8.3k+8.3x+8.3y DONE**. **8.4.1 WOLFHOUSE PRICING/PAYMENT CONFIG PLAN DONE (2026-06-02, docs)**. **8.4.2 WOLFHOUSE PRICING CONFIG FIXTURE DONE (2026-06-02)**: `config/clients/wolfhouse-somo.pricing.json`; `verify-wolfhouse-pricing-config.js` 63/63 PASS; all package prices in cents; deposit scope=per_booking confirmed; August priority=10; REQUIRED_FROM_STAFF gaps documented. **8.4.3 WOLFHOUSE QUOTE CALCULATOR DONE (2026-06-02)**: `scripts/lib/wolfhouse-quote-calculator.js` pure JS; `verify-wolfhouse-quote-calculator.js` 77/77 PASS; Formula B per-night ceil5 (weekly?7 rounded up to ?5/night ? nights ? guests); all 3 packages ? 3 seasons ? 7-night flat + proration + supplement + add-ons + blockers; no DB/API/Stripe/UI; flags unchanged. **8.4.4 WOLFHOUSE QUOTE PREVIEW ENDPOINT DONE (2026-06-02)**: `POST /staff/quote-preview` in `staff-query-api.js`; auth-gated (viewer+); no DB; calls `calculateWolfhouseQuote()`; `verify-staff-quote-preview-api.js` 33/33 PASS; local proof PASS (Malibu 7n=24900?/dep=20000?, Malibu 4n=16000?/dep=10000?); `MANUAL_BOOKING_ENABLED=false`, `STAFF_ACTIONS_ENABLED=false` unchanged. **8.4.8 CREATE MANUAL BOOKING + QUOTE + DRAFT PAYMENT DONE (2026-06-02)**: booking-first flow; calculateWolfhouseQuote() server-side; quote_snapshot in metadata; draft payment record (payment_kind from payment_choice, amount_due=payment_link_amount_cents); UI gated by flags; flags=false?403; proof: 81300? booking created+cleaned; 397/397; no Stripe/migration. **8.4.7 ADD-ONS SELECTOR DONE (2026-06-02)**: compact add-ons section (wetsuit/soft-top/hard-board rentals, combos, surf lessons, yoga); buildAddOns() payload builder; bcInitAddOns() checkbox wiring; combos suppress individual rentals; bcClearSelection resets all add-ons; local proof: wetsuit 3d + 2 lessons=32400?, combo 4d=30900?; 222/222 PASS; no DB writes. **8.4.6 ROOM TYPE SELECTOR DONE (2026-06-02)**: `bk-room-type` select (shared/private/double) in manual booking form; `runQuotePreview` reads selected room type; private/double triggers +?10/person/night supplement; reset clears to shared; local proof shared=24900? no supplement, private=31900? room_supplement item; `verify-staff-bed-calendar-ui.js` 201/201 PASS; no DB writes; Create disabled. **8.4.5 QUOTE PREVIEW UI + FORM CLEANUP DONE (2026-06-02)**: manual booking form wired to `POST /staff/quote-preview`; package ? `<select>` dropdown (malibu/uluwatu/waimea/package_none/manual_override); language field removed; multi-bed selection (bcSelectedBeds array, shared date range, per-bed highlighting, auto guest count); detail panel closes on new selection; Calculate Quote button + itemized display (line items, totals, deposit, payment link, balance, formula summary, warnings); Create Manual Booking stays disabled; booking drawer deduplicates assignment rows; `verify-staff-bed-calendar-ui.js` 194/194 PASS; no DB writes, no Stripe; flags unchanged. (malibu/uluwatu/waimea seeded seasonal weekly prices, per-person scope, +?10 pppn double/private, ?200/?100 deposits, 1h hold, add-ons, refund/automation rules); REQUIRED_FROM_STAFF gaps (deposit scope, group/discount, retreat, operator, add-on charge timing, multi-week); quote input/output contracts; payment-record/invoice model mapped to bookings/payments/workflow_events/staff_handoffs; quote-snapshot storage (v1 metadata ? v2 quote_snapshots); override+confidence/handoff rules; 12-slice ladder; hard gate before MANUAL_BOOKING_ENABLED. No code/endpoint/automation; flags stay false. **8.4 RE-SCOPED ? PLAN/GATE CHECKPOINT (2026-06-02)**: manual booking creation split into gated slices with a **pricing/payment engine as a hard prerequisite** (1 engine plan ? 2 quote calculator ? 3 quote preview ? 4 create-from-quote-snapshot+payment records ? 5 Stripe payment-link/invoice ? 6 Stripe webhook truth ? 7 UI enablement). A provisional `POST /staff/manual-bookings/create` stub exists DISABLED-by-default (`MANUAL_BOOKING_ENABLED=false` ? 403) and UNWIRED from the UI; Create button stays disabled; no Stripe/invoice/payment-link/WhatsApp/n8n. Verifiers: `verify-staff-manual-booking-create-api` 41/41, `verify-staff-bed-calendar-ui` 167/167, `verify-staff-manual-booking-preview-api` PASS. Doc: [`STAGE-8.4-MANUAL-BOOKING-CREATION.md`](STAGE-8.4-MANUAL-BOOKING-CREATION.md). `STAFF_ACTIONS_ENABLED=false`; `MANUAL_BOOKING_ENABLED=false`. **8.3k ROLLBACK PROOF DONE (2026-06-02)**: staff-manual-booking-rollback-sql.js; 10 blockers; CASCADE delete; 52/52 static PASS; 59/59 runtime PASS; delta=0. All blockers proven (confirm, role, code/id mismatch, unsafe_payment, booking_not_found). No API. No UI. No Azure. STAFF_ACTIONS_ENABLED=false. **8.3l PREVIEW UI WIRED (2026-06-02)**: Preview Conflicts button enabled on cell selection; bc-preview-result panel; valid/blocked/warning/error states; POST only to /staff/manual-bookings/preview (preview_only=true, creates_booking=false, no_write_performed=true); Create Manual Booking stays disabled; 122/122 verify-staff-bed-calendar-ui PASS; bd.capacity schema bug fixed in preview query; Azure proof pending. **8.3q TOUR OPERATOR SKELETON (2026-06-02)**: bc-op-panel; operator/stay/defaults/notes; Source=Operator, Payment=Not requested, Booking=Operator Blocked; Stripe+n8n disabled; prefills from cell selection; Create+Preview buttons disabled; 142/142 verifier PASS. No API. No DB writes. No Azure. **8.3v AZURE DEPLOY (8.3u) (2026-06-02)**: image wh-staff-api:ea2437d-8x3v-ui-corrections; revision --0000013 (100% traffic, Healthy); /staff/login 200; STAGING+SHADOW MODE+STAFF ACTIONS DISABLED badges; Write actions DISABLED; Tour Operator tab+panels confirmed in source; demo chip absent; td.dataset.date fix present; STAFF_ACTIONS_ENABLED=false; WHATSAPP_DRY_RUN=true; n8n untouched; no DB writes. **8.3r OPERATOR ROOM RELEASE SKELETON (2026-06-02)**: bc-rr-panel; release-dates/release-scope/defaults/notes; release type (selected_beds/whole_room/selected_dates); Guest messaging+Stripe+n8n disabled; prefills from cell selection; Release Dates+Preview Release disabled; 162/162 verifier PASS. No API. No DB writes. No Azure. **8.3v AZURE DEPLOY (8.3u) (2026-06-02)**: image wh-staff-api:ea2437d-8x3v-ui-corrections; revision --0000013 (100% traffic, Healthy); /staff/login 200; STAGING+SHADOW MODE+STAFF ACTIONS DISABLED badges; Write actions DISABLED; Tour Operator tab+panels confirmed in source; demo chip absent; td.dataset.date fix present; STAFF_ACTIONS_ENABLED=false; WHATSAPP_DRY_RUN=true; n8n untouched; no DB writes. **8.3s BATCH AZURE DEPLOY (2026-06-02)**: image wh-staff-api:1894036-8x3s-batch; revision --0000012 (100% traffic, Healthy); /staff/login 200; auth-guard active; STAGING badge + STAFF ACTIONS DISABLED badge visible; Write actions DISABLED in logs; STAFF_ACTIONS_ENABLED=false; WHATSAPP_DRY_RUN=true; MANUAL_BOOKING_ENABLED=false; n8n untouched; no DB writes; no operator blocks; no room releases. **8.3j SCHEMA-ALIGNMENT FIX (2026-06-02)**: Fixed 3 schema mismatches + 2 enum casts in `buildManualBookingCreateSql()`. P1: `language` removed from bookings INSERT ? stored in `metadata` JSONB. P2: `inserted_payment` uses `status`/`payment_kind`/`amount_due_cents`/`currency` (no `provider`/`amount_cents`/`payment_status`). P3: `audit_written` uses `workflow_name`+`message` (no `event_type`). Also: `$16::booking_status`, `$17::payment_status` enum casts; `$5::text IS NOT NULL`. `verify-staff-manual-booking-create-sql.js` **47/47 PASS** (7 new schema checks). Fixture proof (`stage8.3i-manual-booking-create-proof.js`) updated ? no patching: **65/65 PASS**, delta=0. Helper is now production-schema-compatible. No API route. No UI. No Azure. `STAFF_ACTIONS_ENABLED=false`. `MANUAL_BOOKING_ENABLED=false`. **8.3y NEEDS HUMAN + DETAIL CLEANUP + AZURE DEPLOY (2026-06-02)**: Needs Human tab converted to same two-column conv-card layout as Inbox (filtered to `needs_human`/open handoff); `loadConvDetail(convId, targetEl)` refactored to support both panels; `handoffLabel()` reused in `renderHandoffQueue()`; Booking sidebar above Bot state; `Pending`/`Last reply` removed from Bot state; check-in/check-out combined as `Stay` row with `fmtDateOnly()`; "Messages" h3 removed from thread section; `.hq-table`/`hq-tbody` removed. `verify-staff-conversation-ui.js` **77/77 PASS**. No API changes. No DB writes. `STAFF_ACTIONS_ENABLED=false`. Azure deploy pending. **8.3x INBOX WHATSAPP-STYLE LAYOUT (2026-06-02)**: Inbox two-column, `handoffLabel()`, "Message thread" count removed, raw stage removed, "Back to inbox" removed. 66/66 PASS. Azure image `4e02763-8x3x-inbox` deployed. `staff-query-api.js` ? Inbox converted to persistent two-column layout (left = conv-card list; right = detail panel, always visible, empty-state default); `handoffLabel(code)` maps 11 raw codes to friendly labels (`date_change_requested`?"Date change request", etc.); `renderInbox()` uses `.conv-card` divs (guest name, phone, priority pill, handoff label); "Message thread ? N messages" title removed; raw "Stage:" removed from detail header; "Back to inbox" removed; `inbox-table`/`inbox-tbody` removed. `verify-staff-conversation-ui.js` 66/66 PASS. No API changes. No DB writes. `STAFF_ACTIONS_ENABLED=false`. **Azure DONE (2026-06-02): image `4e02763-8x3x-inbox` (build cb9) deployed, revision `wh-staging-staff-api--0000010` Healthy. Container exec proof: `inbox-two-col`=3, `conv-card`=15, `handoffLabel`=3 FOUND; `inbox-tbody`=0, "Back to inbox"=0 ABSENT. Login 200. Safety flags: `STAFF_ACTIONS_ENABLED=false`, `WHATSAPP_DRY_RUN=true`, `STAFF_AUTH_REQUIRED=true`. n8n untouched. Manual login UI proof pending Ty creds.** **8.3i MANUAL BOOKING FIXTURE WRITE PROOF (2026-06-02)**: `scripts/fixtures/stage8.3i-manual-booking-create-proof.js` ? proves `buildManualBookingCreateSql()` CTE logic; 9 cases (happy-path, idempotency, overlap conflict, touching boundary, invalid payment, confirm=false, role insufficient, invalid dates, client not found); all BEGIN/ROLLBACK; final delta=0; 3 schema mismatches documented+patched (P1 `language` col; P2 payment INSERT cols; P3 `event_type`?`workflow_name`+`message`); graceful SKIP when DB offline; `node --check` PASS; `proof:stage8.3i-manual-booking-create` in `package.json`. No API route. No UI. No Azure. `STAFF_ACTIONS_ENABLED=false`. `MANUAL_BOOKING_ENABLED=false`. **8.3h MANUAL BOOKING PREVIEW ENDPOINT (2026-06-02)**: `POST /staff/manual-bookings/preview` ? auth-gated (operator+), SELECT-only queries, calls `previewManualBookingAvailability()`, returns preview_only/creates_booking/no_write_performed safety fields + full availability output, file-only audit, does NOT require STAFF_ACTIONS_ENABLED. `scripts/lib/staff-manual-booking-preview-queries.js`: SELECT-only SQL builders (beds, assignments, client). `verify-staff-manual-booking-preview-api.js` 48/48 PASS. Proof fixture 31/31 PASS. No DB writes. No booking creation. `STAFF_ACTIONS_ENABLED=false`. **8.3g MANUAL BOOKING AVAILABILITY PREVIEW HELPER (2026-06-02)**: `scripts/lib/staff-manual-booking-availability.js` ? pure JS; `previewManualBookingAvailability()`; half-open overlap (existing_start < proposed_check_out AND existing_end > proposed_check_in); cancelled/expired exclusion; 7 blockers; 5 warnings (same_day, next_day, long_stay, protected_room, operator_room); structured output with is_valid/has_conflict/blockers/warnings/availability_by_bed/summary. `verify-staff-manual-booking-availability.js` 52/52 PASS. No DB. No API. No writes. `STAFF_ACTIONS_ENABLED=false`. **8.3f MANUAL BOOKING SQL STATIC PROOF (2026-06-02)**: `scripts/lib/staff-manual-booking-create-sql.js` ? 15-CTE chain, 14 blockers (`MANUAL_BOOKING_BLOCK_CODES`), half-open overlap + defense-in-depth, idempotency via `metadata` JSONB, audit_payload + rollback_payload, `confirmation_sent_at=NULL`. `verify-staff-manual-booking-create-sql.js` 40/40 PASS. NOT wired. No API route. No DB execution. `STAFF_ACTIONS_ENABLED=false`. Manual booking writes NOT implemented. **8.3e MANUAL BOOKING WRITE GATE PLAN (2026-06-02, docs-only)**: `docs/STAGE-8.3E-MANUAL-BOOKING-WRITE-GATE-PLAN.md` ? hard blockers, warning/second-confirm cases, audit/rollback/idempotency requirements, revised contiguous numbering (manual booking 8.3e?8.3o; move/cancel/operator 8.3p?8.3w), staging gates, sign-off table. Pilot NO_GO; writes NOT implemented. **8.3d MANUAL BOOKING PREVIEW (2026-06-02)**: full form skeleton (Selected Stay pre-filled, Guest, Payment w/ deposit, Notes, Avail placeholder, Safety notice, disabled Create+Conflicts), 105 verifier checks PASS. No writes. **8.3a BED CALENDAR READ-ONLY CLEANUP (2026-06-02)**: date `type="date"` inputs, 5 shortcut chips (Today/Week/30d/Jul?Aug/Demo), always-visible 7-status color legend, inline A/D markers moved to tooltip, operator+manual block colors, cleaner room/bed labels (code primary, label subtitle), taller 28px blocks, free-bed count in summary strip, `bcSetRange()` helper; 56 verifier checks PASS; all other verifiers PASS; local proof PASS; Azure proof pending. **8.3q TOUR OPERATOR SKELETON (2026-06-02)**: bc-op-panel; operator/stay/defaults/notes; Source=Operator, Payment=Not requested, Booking=Operator Blocked; Stripe+n8n disabled; prefills from cell selection; Create+Preview buttons disabled; 142/142 verifier PASS. No API. No DB writes. No Azure. **8.3v AZURE DEPLOY (8.3u) (2026-06-02)**: image wh-staff-api:ea2437d-8x3v-ui-corrections; revision --0000013 (100% traffic, Healthy); /staff/login 200; STAGING+SHADOW MODE+STAFF ACTIONS DISABLED badges; Write actions DISABLED; Tour Operator tab+panels confirmed in source; demo chip absent; td.dataset.date fix present; STAFF_ACTIONS_ENABLED=false; WHATSAPP_DRY_RUN=true; n8n untouched; no DB writes. **8.3r OPERATOR ROOM RELEASE SKELETON (2026-06-02)**: bc-rr-panel; release-dates/release-scope/defaults/notes; release type (selected_beds/whole_room/selected_dates); Guest messaging+Stripe+n8n disabled; prefills from cell selection; Release Dates+Preview Release disabled; 162/162 verifier PASS. No API. No DB writes. No Azure. **8.3v AZURE DEPLOY (8.3u) (2026-06-02)**: image wh-staff-api:ea2437d-8x3v-ui-corrections; revision --0000013 (100% traffic, Healthy); /staff/login 200; STAGING+SHADOW MODE+STAFF ACTIONS DISABLED badges; Write actions DISABLED; Tour Operator tab+panels confirmed in source; demo chip absent; td.dataset.date fix present; STAFF_ACTIONS_ENABLED=false; WHATSAPP_DRY_RUN=true; n8n untouched; no DB writes. **8.3u OPERATIONS UI CORRECTION (2026-06-02)**: Tour Operator tab added; bc-op-panel+bc-rr-panel moved from Bed Calendar to tour-operator tab; forms use date dropdowns; bcHandleCellClick td.dataset bug fixed; Demo Range chip removed; booking drawer: code-only title, Room/Beds merged into Stay; 164/164 verifier PASS. No API. No DB writes. No Azure. **8.3v AZURE DEPLOY (8.3u) (2026-06-02)**: image wh-staff-api:ea2437d-8x3v-ui-corrections; revision --0000013 (100% traffic, Healthy); /staff/login 200; STAGING+SHADOW MODE+STAFF ACTIONS DISABLED badges; Write actions DISABLED; Tour Operator tab+panels confirmed in source; demo chip absent; td.dataset.date fix present; STAFF_ACTIONS_ENABLED=false; WHATSAPP_DRY_RUN=true; n8n untouched; no DB writes. **8.3s BATCH AZURE DEPLOY (2026-06-02)**: image wh-staff-api:1894036-8x3s-batch; revision --0000012 (100% traffic, Healthy); /staff/login 200; auth-guard active; STAGING badge + STAFF ACTIONS DISABLED badge visible; Write actions DISABLED in logs; STAFF_ACTIONS_ENABLED=false; WHATSAPP_DRY_RUN=true; MANUAL_BOOKING_ENABLED=false; n8n untouched; no DB writes; no operator blocks; no room releases. **8.3 STAFF PORTAL BED CALENDAR OPERATIONS PLAN (2026-06-02)**: [`STAGE-8.3-STAFF-PORTAL-BED-CALENDAR-OPERATIONS-PLAN.md`](STAGE-8.3-STAFF-PORTAL-BED-CALENDAR-OPERATIONS-PLAN.md) ? bed calendar becomes the operations workspace; product language "Staff Portal" (not "Cami dashboard"); sub-slices 8.3a?8.3o (read-only cleanup, drawer cleanup, cell selection, manual booking ladder, move preview, cancel/date-change design, tour operator booking, operator room release, dashboard extras); read-only 8.3a/8.3b = only demo prerequisites; all writes future + gated; backend bases exist (manual-entry, reassignment 7.7k1?k8, operator-room-release split). Pilot NO_GO. **8.6 DEMO DATA SEEDED (2026-06-02)**: 18 rows across 3 convs/7 msgs/3 bookings/2 booking_beds/1 handoff/2 payments + 2 demo rooms + 4 demo beds; proof 28/28 PASS; `STAFF_ACTIONS_ENABLED=false`, `WHATSAPP_DRY_RUN=true` confirmed; demo data intentionally retained for Ale/Cami walkthrough. **7.3f CUSTOM DOMAIN + TLS DONE (2026-06-02)**: `staff-staging.lunafrontdesk.com` bound to Azure Container App with Azure managed cert (`SniEnabled`); all smoke tests PASS on clean HTTPS URL. **7.3e LOGIN PAGE + LOGOUT FIX + COMPANY WORDING (2026-06-02)**: `GET /staff/login` serves Luna Front Desk branded form; `browserLoginRedirect()` for `/staff/ui`; logout fixed (`window.doLogout`); "Client" ? "Company" UI labels; deployed to Azure (revision 0000003). **7.3d AZURE STAGING DEPLOYED + LOGIN PROVEN (2026-06-01)**: Staff API + n8n live over Azure HTTPS; Ty owner login confirmed; `/staff/intents` total=35; 11 workflows imported `active=false`; safety flags confirmed. Calendar editing NOT wired. **7.7m DONE (design only)**: manual booking creation plan. **Stage 8 PLANNING STARTED (2026-06-02)**: [`STAGE-8-CLIENT-READY-STAGING-ROADMAP.md`](STAGE-8-CLIENT-READY-STAGING-ROADMAP.md) ? make Luna Front Desk show-ready for Ale/Cami as a polished shadow-mode staging demo while keeping all live gates closed; 8 pillars, slices 8.0?8.13, 14-item ready-to-show checklist; **8.0 roadmap + 8.1 UX cleanup plan DONE** (default landing "Today / Needs Attention"; sidebar nav; Query Tools ? admin/dev-only; Luna design tokens ? [`STAGE-8.1-DASHBOARD-UX-CLEANUP-PLAN.md`](STAGE-8.1-DASHBOARD-UX-CLEANUP-PLAN.md)). Pilot decision remains NO_GO. Next: Stage 8.2 (dashboard visual polish implementation).?# Wolfhouse Booking Assistant ? Product Roadmap

**Product:** AI booking operations for WhatsApp-first experience businesses ? **beachhead:** Wolfhouse (surf house / surf camp). Simpler label: *AI front desk for WhatsApp-heavy experience operators.*

**Product-level roadmap (15 pillars):** [`PRODUCT-MASTER-ROADMAP.md`](PRODUCT-MASTER-ROADMAP.md) ? **Engineering snapshot:** [`PROJECT-STATE.md`](PROJECT-STATE.md) ? **Architecture:** [`ARCHITECTURE-NORTH-STAR.md`](ARCHITECTURE-NORTH-STAR.md) ? **Stripe isolated gates:** [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md)

> **This file is the stage-level / engineering roadmap.** For the **product-level view** ? the full 15-pillar product vision (Guest Assistant, SoT DB, Staff Brain, Dashboard, Rooming UI, Add-ons, Messaging Bridge, Multi-Client Config, Onboarding, PMS, AI Intent, Analytics, Production Hardening, Multi-Client Admin, Productization) mapped to these stages ? see [`PRODUCT-MASTER-ROADMAP.md`](PRODUCT-MASTER-ROADMAP.md).

---

## Evolution order (do not skip)

```text
1. Correct and safe      ? Stage 3  (engineering gates + exit criteria)
   Safety rails          ? Stage 3.5 (seatbelts before live/shadow mode)
   Knowledge + guardrails ? Stage 3x (specs, client config, golden tests)
   Shadow / co-pilot     ? Stage 3y (staff-approved replies, real guest data)
2. Reliable              ? Stage 4
3. Clean                 ? Stage 5
4. Beautiful             ? Stage 6  (Staff / Admin Layer + Staff Operations Assistant)
5. Scalable              ? Stage 7
```

Stage 3 is **not** about making the bot beautiful or fully productized. It is about proving the bot does **not** make dangerous mistakes.

**Stage 3.5 is not full Stage 4 observability.** It is the minimum seatbelts required before serious runtime or live/shadow operation ? error capture, idempotency checks, overlap guards, basic execution logging.

**Stage 3y (Shadow/Co-pilot)** bridges dry-run proof and autonomous live operation. The bot reads real messages and drafts responses; staff approve and send manually. No autonomous payment/confirmation/cancellation/rooming without explicit staff approval. This reduces the dry-run ? real-guest cliff and generates real golden-message data.

---

## Architecture direction (long-term)

**Do not keep expanding n8n with more and more business logic forever.**

| Layer | Role |
|-------|------|
| **n8n** | Orchestrates ? webhooks, WhatsApp, Stripe callbacks, notifications, simple integration steps |
| **Backend / code** | Decides ? routing, required fields, package logic, safety guards, handoff rules |
| **Postgres** | Remembers ? bookings, payments, conversations, beds, audit trail |
| **Client config** | Controls ? packages, pricing, room rules, policies per property (Wolfhouse = client #1) |
| **Staff UI + Staff Assistant** | Manages ? holds, payments, assignments, takeover; answers operational queries; approves risky bot actions (Stage 6+) |

The current **n8n-heavy** implementation is acceptable for **proving behavior** in Stage 3. Future stages migrate decision logic into code/config modules; n8n calls the decision engine instead of owning the business brain.

**Target module layout (Stage 5):**

```text
src/booking-assistant/
  # --- shared spine (client- AND vertical-agnostic; never rebuilt per vertical) ---
  routeMessage.ts
  extractBookingDetails.ts
  requiredFields.ts
  safetyGuards.ts
  handoffRules.ts
  duplicateProtection.ts
  bookingContext.ts
  clientConfig.ts
  payments.ts              # Stripe link + webhook truth + confirmation (vertical-agnostic)
  # --- vertical plugin seam (the ONLY part that differs per business type) ---
  inventory/
    InventoryProvider.ts   # interface: findAvailability / hold / fulfill
    lodging.ts             # beds-in-rooms + rooming (Wolfhouse / hostels)
    slots.ts               # lesson/tour time-slot capacity (surf/kite schools, tours)
    rentals.ts             # item ? time-window ? quantity ? size (surf/bike/SUP shops)
  catalog/
    offerings.ts           # generic priced offering (packages | lessons | rental SKUs | departures)
    packageDecision.ts     # explain / recommend / quote ? driven by config, not hardcoded names
```

**Example future config shape (not implemented yet):**

```text
client_config.packages
client_config.room_rules
client_config.payment_rules
client_config.handoff_rules
client_config.required_fields
```

Build **Wolfhouse as client #1**, not as the only client the system can ever serve.

**Spine vs plugin (portability principle):** everything above the `inventory/` and `catalog/` folders is the **shared spine** and must contain **no surf-house-specific nouns** (no `bed`, `room`, `malibu`, `surfweek`). Anything vertical-specific lives behind the `InventoryProvider` interface or in `client_config`. A new vertical = new config + (at most) one new inventory provider ? see [? Engine portability](#engine-portability--adding-a-new-vertical-surf-shop--lessons).

---

## Client category / market positioning

### Product category

**Primary:** AI booking operations for WhatsApp-first experience businesses.

**Simpler language:** AI front desk for WhatsApp-heavy experience operators.

This is **not** framed as a generic chatbot. It is an operations layer that handles guest questions, package/rental/lesson explanation, availability and detail collection, payment links, payment truth, confirmations, customer memory, staff handoff, and operational status.

### Beachhead

**Wolfhouse** ? surf houses / surf camps (client #1, `wolfhouse-somo`).

Hard first use case: combines accommodation, packages, rooming, payments, confirmations, WhatsApp, and staff operations in one property.

### Adjacent categories (same core pattern)

Guests ask on WhatsApp ? business explains options ? checks availability ? collects details ? sends payment/deposit link ? confirms ? staff handle changes and handoffs.

| Adjacent vertical | Typical scope (often simpler than surf house) |
|------------------|-----------------------------------------------|
| Surf schools | Lessons, levels, schedules |
| Surf shops | Rentals, retail-adjacent booking |
| Kite schools ? dive shops | Lessons, certifications, slots |
| Yoga retreats ? small retreat operators | Packages, dates, capacity |
| Hostels with activities | Beds + activity add-ons |
| Tour operators | Departures, group size, deposits |
| Rental businesses | Lessons, rentals, inventory, time slots, sizes ? surf shop / bike / e-bike / kayak / SUP / campervan patterns |

A **surf shop or lesson-rental** operator is likely a simpler config profile than Wolfhouse: fewer rooming rules, more slot/inventory semantics, still the same payment + confirmation + handoff spine.

### Competitive note

AI/WhatsApp tools already exist for hotels, hospitality, and tour operators. The opportunity is a **focused, configurable, operations-heavy** assistant for **small experience businesses** that live in WhatsApp and run **messy** packages, rentals, lessons, and deposits ? not clean hotel-only PMS flows.

### Roadmap implication

| Build now | Defer |
|-----------|--------|
| Wolfhouse as client #1 with full safety proofs | Multi-client SaaS platform |
| `client_config` specs that generalize | Client onboarding UI, billing, settings editor |
| Engine shaped for lessons/rentals/rooming via config | Hardcoding ?surf house only? in shared workflows |

**Config dimensions per client** (see ?3x.11 in [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)): packages ? lesson types ? rental inventory ? rooming rules (if applicable) ? pricing ? deposit rules ? cancellation policy ? handoff rules ? staff notifications ? customer memory policy.

---

## Engine portability ? adding a new vertical (surf shop / lessons)

**Goal:** when Wolfhouse is done, standing up a second vertical (surf-shop **rentals**, surf/kite-school **lessons**, tour **departures**) is a **config + inventory-plugin** exercise ? **not** a rewrite. This section defines the seam so that promise is real instead of aspirational.

### What is SHARED ? built once, reused by every vertical

| Shared spine capability | Where |
|-------------------------|-------|
| WhatsApp inbound/outbound I/O | n8n orchestration |
| Message routing / intent (`routeMessage`) | spine |
| Required-field gating per action (`requiredFields`) | spine + `client_config` |
| Payment link ? **Stripe webhook truth** ? confirmation (`payments`) | spine (proven 3d.x) |
| Handoff triggers (`handoffRules`) | spine + `client_config.handoff` |
| LLM safety (low-confidence ? handoff; never act on LLM alone) | spine + `client_config.llm_safety` |
| Duplicate / idempotency protection | spine (Stage 3.5) |
| Conversation / session state, customer memory + privacy | spine + Postgres |
| Error capture, golden-message runner | Stage 3.5 / 4 |

These **must not** be reimplemented per client. If a "new vertical" task touches these, the seam has leaked.

### What is VERTICAL-SPECIFIC ? plugged in, never forked

| Vertical concern | How it varies | Mechanism |
|------------------|---------------|-----------|
| The bookable resource + availability | bed-nights vs lesson slots vs rental items vs departure seats | `InventoryProvider` implementation |
| Catalog of offerings | packages vs lesson types vs rental SKUs vs departures | `catalog/offerings` + `client_config` |
| Fulfillment / assignment | rooming is **lodging-only**; most verticals skip it | capability flag, not core path |
| Required fields per booking type | dorm gender vs board size vs surf level | `client_config.required_fields` |
| Vocabulary / tone | surf-house terms vs shop terms | `client_config.language_tone` |

### The one abstraction that unlocks all of it: `InventoryProvider`

All verticals reduce to the same three-call contract ? `findAvailability(request)` ? `hold(unit, window)` ? `fulfill(booking)`:

| Vertical | Unit | Availability dimension | Special attribute | Rooming? |
|----------|------|------------------------|-------------------|----------|
| Surf house / hostel | bed | date-range overlap | gender / couple | **yes** (`lodging`) |
| Surf / kite / dive school | lesson slot | time + slot capacity | skill level | no (`slots`) |
| Surf / bike / SUP shop | rental item | time-window ? quantity | size / fit | no (`rentals`) |
| Tour operator | departure seat | departure-date capacity | group size | no (`slots`) |

The spine calls the interface and never knows which provider it is.

### Portability gate ? a vertical is "config-only ready" when:

- [ ] No surf-house nouns (`bed`, `room`, `matrimonial`, `surfweek`, `malibu`/`uluwatu`/`waimea`) appear in the shared spine ? only in `client_config` / providers.
- [ ] Rooming/assignment is behind a **capability flag**, not assumed.
- [ ] Catalog is generic `offerings`, not a hardcoded package enum.
- [ ] Inventory/availability is behind `InventoryProvider`; lodging is just one impl.
- [ ] `client_config` is split into **engine config** (spine) + **vertical config** (catalog/inventory/capabilities).
- [ ] Golden-message suite is parameterized by `client_id` (Wolfhouse fixtures don't hardcode the engine's behavior).

### Cheapest validation ? do this on paper during Stage 3x.3 (safe, docs-only)

Before any Stage 5 extraction, draft **sample configs for a second and third vertical** and run them against the schema to surface every leak:

- `config/clients/surf-shop-rental.sample.json` (rentals: items, sizes, time windows, deposits)
- `config/clients/surf-school.sample.json` (lessons: levels, slots, instructors)

Each gap found ("this field has no home," "this rule assumes beds") becomes a line item in the **Stage 5 extraction backlog**. If both samples fit the schema with only a new `InventoryProvider`, the backbone is portable; if not, you've found the surf-house assumptions cheaply, on paper, before writing engine code.

### Stage placement

| Work | Stage | Safe before runtime? |
|------|-------|----------------------|
| Spine/plugin seam **design** + sample vertical configs (paper test) | now / **3x.3** | yes (docs/config only) |
| Split `client_config` into engine vs vertical schema | 3x.3 ? Stage 5 | yes (config) |
| Extract spine modules; implement `InventoryProvider` (lodging first) | **Stage 5** | build stage |
| Second `InventoryProvider` (`slots` / `rentals`) + 2nd client live | **Stage 7** | scale stage |

**Do not** build multi-vertical infra early. **Do** lock the seam now so Stage 5 cleanup produces portable modules instead of a tidied-up surf-house monolith.

### Deploy config (the onboarding contract)

Every client-specific value (prices, seasons, gate code, phone numbers, packages, room map, policies) lives in **one per-client deploy config** + a gitignored secret file ? never hardcoded in code/workflows. A new client = fill the template, not rewrite logic. Template: [`config/clients/_deploy-config.template.json`](../config/clients/_deploy-config.template.json) ? Guide: [`DEPLOYMENT-CONFIG.md`](DEPLOYMENT-CONFIG.md). Wolfhouse's `wolfhouse-somo.baseline.json` is the worked example (`vertical: lodging_surf_house`).

---

## Legacy phase map (reference)

Older docs use **Phase 0?3d** for engineering milestones. They map to stages as follows:

| Legacy | Stage |
|--------|--------|
| Phase 0?2 local (frozen) | Foundation + Stripe/Main/Send Confirmation contracts |
| Phase 3b (frozen) | Stage 3 ? bed-ops / manual / operator paths |
| Phase 3c?3g | Stage 3 ? Main + Postgres + stub E2E |
| Phase 3d.x | Stage 3 ? isolated real Stripe payment / webhook / confirmation gates |
| Phase 3e | Stage 3 ? rooming/reassign E2E ? |
| Stage 3.5 | Safety rails ? idempotency, error capture, overlap guards |
| Stage 3x | Bot knowledge + safety guardrails (specs, not n8n sprawl) |
| Stage 3y | Shadow / co-pilot ? staff-approved mode before autonomous |
| Azure / multi-client | Stage 7 (Scalable), not before Reliability + Clean |

---

## Stage 3 ? Correct and safe

### Purpose

Prove dangerous core workflows safely before cleanup, staff UI, or multi-client productization.

### What Stage 3 is not

- Not optimizing for guest-facing polish or marketing copy quality
- Not building the full staff product UI
- Not Azure/production cutover
- Not adding dozens of new n8n IF branches for business rules (that belongs in Stage 3x **specs** and Stage 5 **code**)

### Dangerous mistakes Stage 3 must prevent

| Risk | Guard |
|------|--------|
| Wrong booking selected | Conversation `current_hold_booking_id`, resolver, terminal-status blocks |
| Wrong payment link | Real CPS on correct hold; stub vs real env separation |
| Wrong confirmation | Send Confirmation gates; dry-run first; schedule disabled in tests |
| Wrong room assignment | Bed-ops forks; **hosted reassign URL** in Main fork (`3e.2` remap) ? see [`PHASE-3e-ROOMING-REASSIGN-PLAN.md`](PHASE-3e-ROOMING-REASSIGN-PLAN.md) |
| Duplicate payment / session / event | Idempotency checks; single webhook per event id |
| Accidental live Stripe / WhatsApp | Test keys; `WHATSAPP_DRY_RUN`; activation boundaries |
| Background workflow firing | Inactive workflows + schedule `disabled` in test windows |

### Complete or in progress (engineering)

| Area | Status | Notes |
|------|--------|--------|
| `booking_flow` hold creation | **Proven** | PG hold + Airtable backfill in Main fork (3c.e) |
| `payment_details_provided` route | **Proven** | Resolver + Ensure (3c.g stub E2E) |
| Real Stripe checkout link (Main-integrated) | **Proven** | 3d.7b ? `WH-260528-5369`, stop at checkout URL |
| Isolated Create Payment Session | **Proven** | 3d.4 |
| Stripe Webhook Handler payment truth | **Proven** (isolated) | 3d.5b on `WH-260528-1493` |
| Send Confirmation (dry-run) | **Proven** (isolated) | 3d.6e |
| Pay + webhook on Main-created session | **Proven** | 3d.8b organic Stripe on `WH-260528-5369` |
| Integrated Send Confirmation (dry-run) | **Proven** | 3d.9b exec **1077** on same booking |
| Rooming / reassign E2E | **Proven** | **3e.4 PASS** ? `WH-260528-5322`, beds R3-B1/R3-B2 |

**Not proven in Stage 3:** real WhatsApp send; Send Confirmation schedule-poll; single-window E2E; full package intelligence.

**Freeze:** [`PHASE-3c-3d-FREEZE.md`](PHASE-3c-3d-FREEZE.md) ? formal 3c+3d checkpoint before Phase 3e.3+.

**Detail:** [`PROJECT-STATE.md`](PROJECT-STATE.md) ? [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md)

### Stage 3 exit criteria

Stage 3 is **complete only when all of the following are met** (or explicitly deferred with documented safe fallback):

**Core behavior proven:**
- [ ] `booking_flow` hold creation (PG + Airtable backfill) ?
- [ ] `payment_details_provided` route + Ensure ?
- [ ] Real Stripe checkout link (Main-integrated) ?
- [ ] Isolated Create Payment Session ?
- [ ] Stripe Webhook Handler payment truth ?
- [ ] Send Confirmation (dry-run) ?
- [ ] Integrated pay + webhook + confirmation ?
- [ ] Rooming / reassign E2E ?

**Safety invariants proven:**
- [ ] No Main direct writes to `payments` / `payment_events` ? (static proof)
- [ ] No payment/confirmation path writes `booking_beds` ? (static proof)
- [ ] Hosted/prod URLs removed from all local test paths ? (3e.2)
- [ ] Terminal evidence bookings not reused without reset (policy established)

**Guards verified or explicitly deferred:**
- [x] Wrong-booking guard tested for dangerous actions (rooming, payment, cancel) ? **3e.5 CLOSED** (L1+L2 PASS; L3 deferred ? Airtable-coupled runtime deferred to Postgres source-of-truth cutover; see ?15.6??15.7)
- [x] Duplicate / idempotency protections verified at Stage 3 bar ? **3e.6 CLOSED** (I1 schema PASS ? I4 runtime PASS ? I6 invariant PASS; I2/I3/I5 deferred: I2 ? manual-pay gate ? I3 ? Stage 3.5 ? I5 ? Postgres cutover)
- [ ] All dangerous actions have handoff / fail-safe behavior when required business rule is missing ? *3x.7?3x.8 spec done; implementation pending*

**Acceptable deferrals (do not block Stage 3 exit if documented):**
- Real WhatsApp send ? dry-run mode (`WHATSAPP_DRY_RUN=true`) is sufficient; shadow mode (Stage 3y) covers real send
- Send Confirmation schedule-poll ? schedule `disabled=true` gate is sufficient for Stage 3; verify in Stage 3y
- Single-window integrated E2E ? isolated gate chains are sufficient for Stage 3

**Acceptance metric gates:**
- 0 double bookings in all runtime test gates
- 0 wrong-booking dangerous actions in test gates
- 0 payment truth updates outside Stripe Webhook Handler
- 0 confirmations without payment truth
- 0 real WhatsApp sends in dry-run test gates
- 100% dangerous-action routes have handoff/fail-safe when required business logic is missing

---

## Stage 3.5 ? Safety Rails Before Reliability

**Purpose:** Pull forward the minimum safety plumbing required to safely run more runtime gates and prepare for live/shadow mode. This is not full Stage 4 observability ? it is seatbelts.

**When to do Stage 3.5:** After Stage 3 exit criteria are met, before Stage 3y (shadow/co-pilot) or live guest operation.

### Minimum safety requirements (Stage 3.5)

| Item | Why |
|------|-----|
| `automation_errors` capture/write path | Know when bot fails silently |
| Standard workflow error handler pattern | Consistent safe fallback across all n8n workflows |
| Idempotency: inbound WhatsApp message id | No duplicate booking from retry/double-delivery |
| Idempotency: Stripe event id | No duplicate `payment_events` row |
| Idempotency: payment-link reuse | No duplicate checkout session without explicit guard |
| Idempotency: Send Confirmation | Cannot confirm twice (`confirmation_sent_at` + flag) |
| Idempotency: rooming/reassign | Cannot double-assign or double-delete beds |
| Double-booking guard / DB overlap check | `booking_beds` overlap detection query; reject or alert before insert |
| Stuck booking detection (basic) | Bookings in `payment_pending` > N hours with no event; holds expired but not released |
| Workflow active-state safety check | Automated assertion: only expected workflows active before dangerous test or runtime |
| Schedule disabled/enabled safety check | Send Confirmation schedule `disabled=true` verified before any payment/confirmation test |
| Minimum execution logging | For each execution: `resolved_route`, confidence, selected booking id, dangerous action taken (or no-op reason) |
| Golden-runner stub | Even a fixture-file runner (`test:golden-messages`) blocks regression in CI before Stage 4 |

**Stage 3.5 does not include:** full monitoring dashboards, Azure deploy, Staff UI, broad n8n ? backend refactor.

**Full sub-phase spec:** [`PHASE-3.5-SAFETY-RAILS-PLAN.md`](PHASE-3.5-SAFETY-RAILS-PLAN.md) ? 3.5a?3.5g with entry/exit criteria, work-type classification, and first implementation step.

**Key schema finding:** `automation_errors` and `workflow_events` tables exist in migration 001 but are not yet wired into any n8n workflow. Stage 3.5b is a pure wire-in task.

---

## Stage 3y ? Shadow / Co-pilot Pilot

**Purpose:** Bridge the gap between isolated dry-run proof and autonomous live guest operation. Reduces the dry-run ? real-guest cliff; generates real labeled data; builds Ale/Cami trust in the system.

**Full plan:** [`PHASE-3y-SHADOW-COPILOT-PLAN.md`](PHASE-3y-SHADOW-COPILOT-PLAN.md) ? entry criteria, operating modes A?D, allowed/forbidden actions, staff approval workflow, infrastructure requirements, 15-test matrix (Y-T1?Y-T15), exit criteria.

### How shadow/co-pilot mode works

| Step | Who acts |
|------|----------|
| Real guest message arrives (or pasted in offline shadow) | n8n / Main reads it |
| Bot resolves route + drafts response | Bot (automated) |
| Bot suggests safe action (if any) | Bot outputs draft; **no autonomous send** |
| Staff reviews draft | Ale / Cami |
| Staff approves and sends | **Staff (manual)** |
| Staff edit logged as labeled example | System records correction (interim: offline log) |

### Operating modes (ascending risk ? gate each separately)

| Mode | Description | Gate |
|------|-------------|------|
| **A ? Offline shadow** | Pasted/copied messages; local n8n; no live connection | ? Ready to start (no new infra) |
| **B ? Real inbound, no sends** | Real WhatsApp inbound; `DRY_RUN=true` enforced | Separate explicit approval required |
| **C ? Staff-approved draft queue** | Bot writes draft to review queue; staff approves and sends manually | Mode B stable + review UI |
| **D ? Staff-approved action proposals** | Bot proposes dangerous action; staff clicks approve | Stage 6 Staff UI + all 3x complete |

### What is and is not allowed in Stage 3y

| Allowed | Not allowed without explicit approval |
|---------|--------------------------------------|
| Bot reads / classifies message text | Autonomous WhatsApp reply |
| Bot resolves route and flags uncertainty | Autonomous payment link creation |
| Bot drafts response for staff review | Autonomous booking confirmation |
| Bot identifies missing required fields | Autonomous cancellation or room reassign |
| Bot logs decision to `workflow_events` | Payment truth writes |
| Staff-approved sends (manual copy-paste) | Any dangerous action without per-action gate |

### Why Stage 3y before Stage 4

- Avoids big-bang flip from dry-run to fully autonomous
- Creates real labeled guest-message data from actual interactions
- Staff corrections become labeled training examples for Stage 4
- Ale/Cami can see and trust bot behavior before handing over
- "AI drafts, staff approves" is a distinct, sellable product tier

---

## Stage 3x ? Bot knowledge + safety guardrails

**Mini-phase before fully entering Stage 4 (Reliable).**

**Master spec:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)  
**Owner questionnaire:** [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md)

### Purpose

Define the business knowledge and decision rules the bot needs to act safely, ask smart follow-up questions, and avoid dangerous guesses.

**Important:** Stage 3x delivers **specs, fixtures, and configurable rules** ? not a huge expansion of n8n IF nodes. Implementation belongs in code modules (Stage 5) fed by client config.

| Sub-phase | Status |
|-----------|--------|
| **3x.1** Full roadmap ?3x.1?3x.11 + exit criteria + 35 golden rows | **Done** (2026-05-28 retry) |
| **3x.1b** Customer memory layered model (?3x.5) | **Done** (2026-05-28) |
| **3x.2b** Minimum Business Logic Baseline + Stage 4 entry gate | **Done** (2026-05-29) |
| **3x.2c** Applied owner P1 answers ? baseline v0.2 + handoff/add-on plans | **Done** (2026-05-29) |
| **3x.2d** Working prices + policies ? baseline v0.3 (provisional pricing) | **Done** (2026-05-29) |
| **3x.2** Ale/Cami **confirm** provisional prices + fill gaps ? confirmed config | In progress |
| **3x.3** WhatsApp mining + golden fixtures + customer extract | Planned |
| **3x.4** Golden runner + Stage 4 reliability hooks | Planned |

**Stage 3x includes:** required-field map ? package decision flow ? Wolfhouse knowledge collection ? **WhatsApp history mining** ? **customer memory migration** ? golden message tests ? dangerous-action gates ? human handoff ([`STAFF-HANDOFF-PLAN.md`](STAFF-HANDOFF-PLAN.md)) ? during-stay add-ons ([`DURING-STAY-ADDONS-PLAN.md`](DURING-STAY-ADDONS-PLAN.md)) ? wrong-booking protection ? duplicate protection ? client-config architecture ? **exit criteria** ([`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)).

### Summary index (detail in master spec)

### 3x.1 ? Required field map

Define required fields **before** each action:

| Action | Required before proceed |
|--------|-------------------------|
| Create booking hold | Dates, guest count, contact phone, package or accommodation intent, availability OK |
| Send payment link | Hold exists, guest name + email, promoted payment state, deposit rule known |
| Confirm booking | Payment truth (`deposit_paid` / paid), `send_confirmation` gate, not terminal |
| Cancel booking | Booking id/code, policy window, staff approval if ambiguous |
| Room / bed assignment | Confirmed or approved hold, guest count, gender/couple/friend rules |
| Package quote | Package code, dates, guest count, season |
| Package booking | Quote inputs + package-specific required fields |
| Date change | Booking id, new dates, availability, policy |

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ?3x.1](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x1--required-field-map) + fixture tables keyed by `resolved_route`.

### 3x.2 ? Package explanation + package decision flow

The bot must explain package differences clearly.

**Define per package:**

- Name, inclusions, exclusions
- Price or price logic (season, nights, per person)
- Deposit rules, minimum nights
- Lesson schedule, rental rules, meals, transfers
- Cancellation/refund policy
- Who the package is best for

**Bot behavior rules:**

| Guest signal | Bot behavior |
|--------------|--------------|
| ?What packages do you have?? | Briefly explain all packages |
| Wants to book, package missing | Ask: accommodation only vs surf package |
| Unsure | Recommend by goal: cheapest ? shared accommodation; beginner ? lesson package; full arrange ? full surf; already surfs ? accommodation + rentals |
| Price question | Do **not** quote exact price unless dates, guest count, package, and price source are known |
| Still uncertain | Follow-up question or staff handoff |

### 3x.3 ? Wolfhouse knowledge collection

Operational gaps only (not public website facts). Questionnaire for Ale/Cami:

**Deliverable:** [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md)

### 3x.4 ? WhatsApp history mining plan

Redacted Cami/Ale guest threads ? **dual outputs:** (A) anonymized bot knowledge + (B) structured customer memory (see ?3x.5).

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ?3x.4](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x4--whatsapp-history-mining-plan); redacted samples under `docs/knowledge/whatsapp-samples/` (not in git until anonymized).

### 3x.5 ? Customer memory + WhatsApp history migration

Layered model: temporary raw import ? structured customer facts (PG, `client_id`-scoped) ? anonymized fixtures. Proposed tables: `customers`, `customer_booking_history`, `conversation_summaries`, `customer_preferences`, `customer_notes`, `privacy_requests` (future).

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ?3x.5](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x5--customer-memory--whatsapp-history-migration). Owner questions: [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md) ? Customer memory.

### LLM safety requirements (across Stage 3x + Stage 4)

The bot must never act on LLM output alone for dangerous actions. The following are required:

| Requirement | Stage |
|-------------|-------|
| Low confidence ? human handoff (not silent no-op) | 3x.8 spec ? 3.5 impl |
| LLM/API error ? handoff or logged safe fallback | 3.5 |
| Parsing uncertainty ? clarification question, not action | 3x.8 spec ? 3.5 impl |
| `resolved_route`, confidence, selected booking, and action logged per execution | 3.5 |
| Golden-message suite used as prompt regression evaluation | 3x.6 ? 4 |
| Multilingual behavior tested: English / Spanish / Italian | 3x.6 |
| Bot never marks `paid` / `cancelled` / `confirmed` based only on LLM interpretation | 3x.7 gate ? proven in 3d.5b (webhook owns truth) |

### Stage 3x exit criteria

Documented in master spec ? planning complete when ?3x.1?3x.11 + exit checklist exist; full golden fixture set may complete in 3x.3.

### 3x.6 ? Golden message tests

**30?50** realistic guest messages with expected:

- `resolved_route`
- Missing fields
- Safe action (or explicit no-op)
- Clarification question text (pattern, not exact LLM wording)
- Handoff behavior

**Categories to include:**

- Booking request ? package questions ? payment-link request ? ?I paid?
- Cancellation ? room preference ? couple/friends/gender rooming ? date changes
- Surfboard/wetsuit rental ? breakfast/transfer ? unclear / low-confidence messages

**Deliverable:** `docs/fixtures/golden-messages/` + runner stub (Stage 4+). Schema + samples in master spec ?3x.6.

### 3x.7 ? Dangerous action gates

Strict proof required before:

| Action | Proof |
|--------|--------|
| Send payment link | Hold + Ensure + CPS contract; no terminal booking |
| Confirm booking | Webhook payment truth + Send Confirmation eligibility |
| Cancel booking | Booking status + policy |
| Change room/bed | Assignment rules + capacity |
| Change dates | Availability + policy |
| Mark payment-related states | Webhook or authorized staff only |

### 3x.8 ? Human handoff rules

Bot must stop guessing and alert staff when:

- Low route confidence
- Conflicting dates or guest count
- Multiple active holds for same conversation
- Guest says they paid but no payment record
- Refund / dispute / cancellation ambiguity
- Angry guest / complaint
- Medical / emergency / legal issues
- Rooming / reassign uncertainty

**Deliverable:** `handoffRules` spec ? later `client_config.handoff_rules`.

### 3x.9 ? Wrong-booking protection

Formalize (align with existing resolver + PG):

- `conversation.current_hold_booking_id` wins over phone-only fallback
- Terminal bookings (`confirmed`, `cancelled`, etc.) cannot be modified by guest path
- Old holds must not be selected because phone matches alone
- Active booking must match conversation context and latest intent

### 3x.10 ? Duplicate protection

Verify and document:

| Scenario | Expected |
|----------|----------|
| Same WhatsApp message id | No duplicate booking |
| Repeated payment-link request | No duplicate checkout session without idempotency |
| Same Stripe event id | No duplicate `payment_events` row |
| Confirmation | Cannot send twice (`confirmation_sent_at`, flags) |

### 3x.11 ? Client-config architecture plan

Same assistant engine, different **client config** per property.

| Config category | Examples |
|-----------------|----------|
| `packages` | Codes, seasons, inclusions |
| `room_types` | Shared, private, gender rules |
| `bed/room_rules` | Couples, friends, operator blocks |
| `pricing` | Rules, deposits, rounding |
| `deposit/payment_rules` | Deposit cents, deadlines |
| `cancellation_policy` | Windows, refund tiers |
| `hold_expiry` | TTL, reminders |
| `language/tone` | Default language, formality |
| `handoff_rules` | Triggers, staff notify |
| `integrations` | Stripe, WhatsApp, webhooks |
| `staff_notification_rules` | Channels, severity |
| `customer_memory_policy` | Retention, allowed fields, returning-guest rules |

Wolfhouse = `client_slug: wolfhouse-somo`. Future surf houses add new config rows, not forked workflows.

---

## Source-of-truth cutover ? Airtable ? Postgres

This is a **first-class roadmap event**, not a scattered implementation detail. Airtable is the current operational source of truth for staff. Postgres is the engineering source of truth for the bot. Cutover must happen deliberately.

### Cutover phases

| Phase | Description | Gate |
|-------|-------------|------|
| **Current** | Airtable = staff SoT; Postgres = bot SoT; dual-write in progress | Active |
| **Read-only compare** | Run both reads; log discrepancies; do not act on mismatch | Before any cutover |
| **`DATA_SOURCE` flag** | Config-driven: `airtable` \| `postgres` per path; allows per-path rollout | Stage 4 |
| **Soak period** | Postgres-primary writes; Airtable as backup read; monitor for divergence | Stage 4?5 |
| **Airtable dependency removal** | Only after staff UI or equivalent replacement exists | Stage 6+ |
| **Backup policy** | Full Airtable export + PG dump before each cutover step | Required |
| **Rollback plan** | Revert `DATA_SOURCE` flag; restore from backup; documented runbook | Required |

**Do not remove Airtable dependency** until:
1. Staff UI (Stage 6) or equivalent is live for all Airtable use cases it currently covers
2. PG data has passed a soak period without divergence
3. Backup and rollback procedure is documented and tested

---

## Privacy / GDPR gate before customer memory

**No Layer-2 structured customer memory with personal data until all of the following exist:**

| Requirement | Status |
|-------------|--------|
| Documented purpose for each stored personal field | Planned (3x.2) |
| Retention policy per field type | Planned (3x.2) |
| Staff-only note handling (no guest-facing access to staff notes) | Planned |
| Delete / export / correction procedure documented | Planned |
| Marketing opt-in separated from booking support data | Planned |
| Raw WhatsApp exports kept off-repo / in `data/private/` (gitignored) | **Done** (`84fa45f`) |
| Only reviewed/sanitized fixtures in repo | Policy established |

**This gate applies before 3x.3 customer extract is written to PG.** Planning (3x.2) may proceed; PG insert of personal data requires privacy gate first.

---

## Stage 4 ? Reliable

**Status (2026-05-30): CLOSE WITH DEFERRALS.** Autonomous Booking Dry-Run complete ? all 14 scenarios PASS (commit `6cd9a21`). Evidence: `test-payloads/stage4/autonomous-dry-run/README.md`. Live WhatsApp, live holds, live Stripe, and live confirmation writes remain deferred. Structured add-on records and staff ops assistant deferred to Stages 5?6.

### Purpose

Make the working system **dependable and observable** after Stage 3 behavior is proven and Stage 3x rules are specified.

### Entry gate (defined in baseline config + ?3x.2b)

Gate definition: [`config/clients/wolfhouse-somo.baseline.json`](../config/clients/wolfhouse-somo.baseline.json) (`stage4_entry_gate`) and [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ?3x.2b/?3x.2c](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x2c--applied-owner-answers-2026-05-29).

**Reduced after 3x.2c** (payment-link auto-send, hold expiry, confirmation content, conditional cancel/date-change, rooming auto-assign + operator-room logic all confirmed). **Remaining owner blockers:** deposit amount/scope ? non-7-night pricing math ? cancellation/refund windows & % ? add-on service prices/scheduling (if in Stage 4 scope) ? real WhatsApp send gate or Stage 3y shadow ? final handoff channel. **Not blockers:** perfect tone ? full customer memory ? marketing opt-in ? exact add-on automation.

**Additional entry requirement:** Autonomous booking dry-run pass ? bot completes full booking flow (inbound message ? route ? availability ? hold ? payment-link ? Stripe webhook ? confirmation) without errors in all-stubbed mode, proving readiness before real sends or live operation are enabled.

### Includes

- **Autonomous booking dry-run** (first Stage 4 milestone): full booking flow end-to-end ? inbound message ? route ? availability ? hold ? payment-link ? Stripe webhook ? confirmation ? with all live side effects stubbed at the infrastructure boundary. Proves the bot completes the booking correctly before real sends or live operation are enabled. This is the regression anchor: once green, enabling real WhatsApp send or live operation is a config change, not a behavior change.
- Better error handling and safe retries (where idempotent)
- Stuck booking detection
- Monitoring, alerts, execution dashboards
- Clearer structured logs
- Health checks (n8n, Postgres, Redis, webhooks)
- Rollback tools and fixture cleanup
- Duplicate protection checks (automated)
- Active workflow safety checks; schedule safety checks
- Runbooks for common failures (payment stuck, webhook miss, confirmation not sent)

### Staff visibility (minimum for safety)

May begin here if needed before full Stage 6 UI:

- Stuck bookings queue
- Payment status view
- Human handoff queue
- Pending confirmations
- Failed workflow executions
- **Staff query assistant** (read-only ops Q&A: "who has a surfboard today?", "who arrives today?", "which rooms need cleaning and by when?") gated by an **approved-staff allowlist** (`staff_directory`; portal = Stage 6) ? [`STAFF-QUERY-ASSISTANT-PLAN.md`](STAFF-QUERY-ASSISTANT-PLAN.md)

### Add-on structured records (Stage 4 design requirement)

Add-on dry-run tests (e.g. A9 ? lessons, yoga, rentals) must do more than verify the guest-facing price quote is correct. They must also prove the system can **represent add-on requests as structured, staff-queryable records**. This is the data foundation that makes Stage 6 staff queries possible.

Each add-on request that passes through the bot should be representable as a record with at minimum:
- Guest / booking reference
- Add-on type (lesson, wetsuit, board, yoga, dinner)
- Quantity / number of days
- Requested date(s)
- Payment status (pending / paid)
- Fulfillment status (not redeemed / redeemed ? staff-managed)
- A flag indicating whether staff scheduling / manual tracking applies (e.g. lessons require a manual slot assignment)

**Stage 4 does not require full add-on automation.** It requires that when the bot processes an add-on request, the output can be persisted in a shape that is queryable by staff. If no structured add-on record is written yet, the design must identify where it would be written and what the schema looks like ? so Stage 5 does not have to invent it from scratch.

---

## Stage 5 ? Clean

**Status (2026-05-31): CLOSE WITH DEFERRALS ? source-of-truth cleanup complete (5.1?5.8b); engine extraction / portability scope deferred.** All staff-queryable data tables are schema-stubbed and query helpers are proven. Migrations 007 (add-ons) and 008 (staff handoffs) are ready to apply. Live operation, engine extraction, and staff UI remain deferred (Stage 6). Detail: [`PHASE-5-SOURCE-OF-TRUTH-CLEANUP.md`](PHASE-5-SOURCE-OF-TRUTH-CLEANUP.md).

### Purpose

Simplify implementation after behavior is proven and reliability checks exist.

### Safety-critical early extractions (pull forward to Stage 3.5 / 4 only if needed)

Do **not** do broad Stage 5 refactor before Stage 3 / 3.5 safety gates. However, pull forward **only** these safety-critical items when required:

- Wrong-booking guard (if not proven in Stage 3 negative tests)
- Dangerous-action gate checks (missing required business rule ? handoff)
- Duplicate / idempotency checks (if Stage 3.5 requires them in code)
- Bed-assignment overlap / dedup logic (if DB constraint is insufficient)
- `client_config` loading skeleton (if Stage 3x requires it for golden tests)

### Includes

- Move decision logic out of n8n into `src/booking-assistant/` (n8n becomes I/O only).
- **Extract along the portability seam** ([? Engine portability](#engine-portability--adding-a-new-vertical-surf-shop--lessons)): shared spine vs `inventory/` + `catalog/` plugins ? do **not** produce a tidied-up surf-house monolith.
- Implement `InventoryProvider` with **lodging** as the first concrete provider; keep the interface generic enough for `slots` / `rentals`.
- Split `client_config` into **engine config** (spine) + **vertical config** (catalog / inventory / capabilities); rooming behind a capability flag.
- Replace serialized-into-n8n Code nodes (e.g. the resolver) with calls to the extracted, version-checked modules.

**Target:** n8n calls backend decision engine; Postgres writes go through shared SQL/modules; n8n performs WhatsApp/Stripe/Airtable I/O.

**Portability acceptance for Stage 5:** the Wolfhouse spine compiles and passes golden tests with **zero surf-house nouns** outside `inventory/lodging.*` and `client_config`. (Verify against the portability gate checklist.)

### Staff-queryable operational data (Stage 5 requirement)

Source-of-truth cleanup must explicitly produce the structured Postgres records that power Stage 6 staff queries. The data design goal is: **staff questions are answered from reliable structured records, not guessed from chat logs or Airtable exports.**

The following tables/models must be designed (and at minimum stubbed in schema) during Stage 5, before the Stage 6 staff assistant is built:

| Table / model | Answers the question |
|---|---|
| `add_on_orders` | Which guests have requested add-ons? What is the payment status per order? |
| `add_on_items` | Line-item detail per order (type, qty, days, dates, price) |
| `lesson_requests` | Who has lessons today / tomorrow? What slot? (staff assigns; bot records request) |
| `rental_requests` | Who requested a board / wetsuit? For how many days? Pickup status? |
| `yoga_requests` | Who paid for yoga? For which date? (redeemed on-site by staff) |
| `staff_handoffs` / `staff_tasks` | Which conversations need a human reply? Why was it handed off? Current state? |
| `payment_balances` (view or table) | Who still owes money? Who paid deposit but not full balance? |

These are **not new features** ? they are the structured forms of data the bot already collects. The goal of Stage 5 is to ensure that data lands in Postgres in a queryable shape instead of only in Airtable or serialized chat session state.

**Design gate for Stage 5:** before beginning Stage 6 staff UI work, verify that a staff member can ask each of the following questions and get a correct answer from Postgres without touching Airtable or reading raw WhatsApp messages:

- "Who paid for yoga today?"
- "Who has lessons tomorrow?"
- "Who still owes money?"
- "Who requested a board?"
- "Which bookings need a human reply?"
- "Show today's arrivals and departures."
- "Who paid deposit but not full balance?"
- "Which guests requested rooming preferences?"

---

## Stage 6 ? Beautiful (Staff / Admin Layer)

**Status: CLOSED WITH DEFERRALS** (2026-05-31) ? All exit criteria MET. 6.0?6.9 DONE: 35-intent registry, CLI runner, batch reports, CLI write action, HTTP API, browser UI, smoke test, token-gated write endpoint. Production auth/TLS/live-ops deferred to Stage 7. See [`PHASE-6-STAFF-ASSISTANT-PLAN.md`](PHASE-6-STAFF-ASSISTANT-PLAN.md).

**Implementation slices:** 6.1 registry DONE ? 6.2 CLI runner DONE ? 6.3 handoffs DONE ? 6.4a/b/c/d batch reports DONE ? 6.5a/b CLI write action DONE ? 6.6 HTTP API DONE ? 6.7 intent smoke DONE ? 6.8 read-only UI DONE ? 6.9 token-gated write endpoint DONE.

### Purpose

Excellent staff and owner experience. This is where the **two-sided product** becomes visible: the guest-facing assistant (already built) and the **staff-facing operations assistant** (built here).

### Two sides of the product

| Side | Who uses it | What it does |
|------|------------|--------------|
| **Guest assistant** | Guests on WhatsApp | Bookings, questions, payments, confirmations, add-ons, rooming, handoff |
| **Staff assistant / admin** | Ale, Cami, operators | Operational queries, action review/approval, conversation takeover, status dashboards |

### Staff Operations Assistant

Staff can ask operational questions and get answers from **structured Postgres records** (not chat logs or guesses). All queries are read-only, gated by `staff_directory` approved numbers.

**Example questions the staff assistant must answer:**

- "Who paid for yoga today?"
- "Who has lessons tomorrow?"
- "Who still owes money?"
- "Who requested a board?"
- "Which conversations need a human reply?"
- "Show today's arrivals and departures."
- "Who paid deposit but not full balance?"
- "Which guests requested rooming preferences?"

**Design constraint:** these questions are answered from the structured records built in Stage 5 (`lesson_requests`, `add_on_orders`, `staff_handoffs`, `payment_balances`, etc.). The assistant maps natural-language questions to fixed safe parameterized intents ? it never generates arbitrary SQL.

### Staff Approval Controls

Staff can review, approve, and act on bot proposals without going directly into n8n or Airtable:

- View bot draft reply before it is sent
- Approve or reject risky bot action proposals (payment, cancellation, room reassign)
- Take over a conversation from the bot
- View payment / hold / rooming / add-on status per booking
- Mark add-on as redeemed (voucher fulfilled on site)
- Release or block operator rooms

### Staff UI

- Calendar / bed grid, guest list, booking detail
- Payment status, pending holds, confirmation queue
- Conversation history, human takeover
- Manual booking / edit / cancel tools
- Room/bed assignment UI
- Alerts for stuck workflows
- Owner dashboard

Airtable may remain a **bridge** during transition; long-term goal is a proper staff UI, not Airtable as daily ops surface.

**Airtable cutover prerequisite:** the staff UI (or equivalent) must cover all use cases Airtable currently serves before Airtable is removed as a dependency ? see the Source-of-truth cutover table above.

---

## Stage 7 ? Scalable

**Status: PLANNING CLOSED / IMPLEMENTATION STARTED** (2026-05-31) ? 7.0?7.6 DESIGN DONE. **7.2b+7.2c+7.3b DONE**: migration 009, auth middleware scaffold, Azure IaC scaffold (infra/azure/staging/ Bicep, 11 resource types, safety defaults, KV secret refs, runbook, 57-check verifier PASS). No Azure resources created. Next: 7.3c DNS/TLS or Cami dashboard.?# Wolfhouse Booking Assistant ? Product Roadmap

**Product:** AI booking operations for WhatsApp-first experience businesses ? **beachhead:** Wolfhouse (surf house / surf camp). Simpler label: *AI front desk for WhatsApp-heavy experience operators.*

**Product-level roadmap (15 pillars):** [`PRODUCT-MASTER-ROADMAP.md`](PRODUCT-MASTER-ROADMAP.md) ? **Engineering snapshot:** [`PROJECT-STATE.md`](PROJECT-STATE.md) ? **Architecture:** [`ARCHITECTURE-NORTH-STAR.md`](ARCHITECTURE-NORTH-STAR.md) ? **Stripe isolated gates:** [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md)

> **This file is the stage-level / engineering roadmap.** For the **product-level view** ? the full 15-pillar product vision (Guest Assistant, SoT DB, Staff Brain, Dashboard, Rooming UI, Add-ons, Messaging Bridge, Multi-Client Config, Onboarding, PMS, AI Intent, Analytics, Production Hardening, Multi-Client Admin, Productization) mapped to these stages ? see [`PRODUCT-MASTER-ROADMAP.md`](PRODUCT-MASTER-ROADMAP.md).

---

## Evolution order (do not skip)

```text
1. Correct and safe      ? Stage 3  (engineering gates + exit criteria)
   Safety rails          ? Stage 3.5 (seatbelts before live/shadow mode)
   Knowledge + guardrails ? Stage 3x (specs, client config, golden tests)
   Shadow / co-pilot     ? Stage 3y (staff-approved replies, real guest data)
2. Reliable              ? Stage 4
3. Clean                 ? Stage 5
4. Beautiful             ? Stage 6  (Staff / Admin Layer + Staff Operations Assistant)
5. Scalable              ? Stage 7
```

Stage 3 is **not** about making the bot beautiful or fully productized. It is about proving the bot does **not** make dangerous mistakes.

**Stage 3.5 is not full Stage 4 observability.** It is the minimum seatbelts required before serious runtime or live/shadow operation ? error capture, idempotency checks, overlap guards, basic execution logging.

**Stage 3y (Shadow/Co-pilot)** bridges dry-run proof and autonomous live operation. The bot reads real messages and drafts responses; staff approve and send manually. No autonomous payment/confirmation/cancellation/rooming without explicit staff approval. This reduces the dry-run ? real-guest cliff and generates real golden-message data.

---

## Architecture direction (long-term)

**Do not keep expanding n8n with more and more business logic forever.**

| Layer | Role |
|-------|------|
| **n8n** | Orchestrates ? webhooks, WhatsApp, Stripe callbacks, notifications, simple integration steps |
| **Backend / code** | Decides ? routing, required fields, package logic, safety guards, handoff rules |
| **Postgres** | Remembers ? bookings, payments, conversations, beds, audit trail |
| **Client config** | Controls ? packages, pricing, room rules, policies per property (Wolfhouse = client #1) |
| **Staff UI + Staff Assistant** | Manages ? holds, payments, assignments, takeover; answers operational queries; approves risky bot actions (Stage 6+) |

The current **n8n-heavy** implementation is acceptable for **proving behavior** in Stage 3. Future stages migrate decision logic into code/config modules; n8n calls the decision engine instead of owning the business brain.

**Target module layout (Stage 5):**

```text
src/booking-assistant/
  # --- shared spine (client- AND vertical-agnostic; never rebuilt per vertical) ---
  routeMessage.ts
  extractBookingDetails.ts
  requiredFields.ts
  safetyGuards.ts
  handoffRules.ts
  duplicateProtection.ts
  bookingContext.ts
  clientConfig.ts
  payments.ts              # Stripe link + webhook truth + confirmation (vertical-agnostic)
  # --- vertical plugin seam (the ONLY part that differs per business type) ---
  inventory/
    InventoryProvider.ts   # interface: findAvailability / hold / fulfill
    lodging.ts             # beds-in-rooms + rooming (Wolfhouse / hostels)
    slots.ts               # lesson/tour time-slot capacity (surf/kite schools, tours)
    rentals.ts             # item ? time-window ? quantity ? size (surf/bike/SUP shops)
  catalog/
    offerings.ts           # generic priced offering (packages | lessons | rental SKUs | departures)
    packageDecision.ts     # explain / recommend / quote ? driven by config, not hardcoded names
```

**Example future config shape (not implemented yet):**

```text
client_config.packages
client_config.room_rules
client_config.payment_rules
client_config.handoff_rules
client_config.required_fields
```

Build **Wolfhouse as client #1**, not as the only client the system can ever serve.

**Spine vs plugin (portability principle):** everything above the `inventory/` and `catalog/` folders is the **shared spine** and must contain **no surf-house-specific nouns** (no `bed`, `room`, `malibu`, `surfweek`). Anything vertical-specific lives behind the `InventoryProvider` interface or in `client_config`. A new vertical = new config + (at most) one new inventory provider ? see [? Engine portability](#engine-portability--adding-a-new-vertical-surf-shop--lessons).

---

## Client category / market positioning

### Product category

**Primary:** AI booking operations for WhatsApp-first experience businesses.

**Simpler language:** AI front desk for WhatsApp-heavy experience operators.

This is **not** framed as a generic chatbot. It is an operations layer that handles guest questions, package/rental/lesson explanation, availability and detail collection, payment links, payment truth, confirmations, customer memory, staff handoff, and operational status.

### Beachhead

**Wolfhouse** ? surf houses / surf camps (client #1, `wolfhouse-somo`).

Hard first use case: combines accommodation, packages, rooming, payments, confirmations, WhatsApp, and staff operations in one property.

### Adjacent categories (same core pattern)

Guests ask on WhatsApp ? business explains options ? checks availability ? collects details ? sends payment/deposit link ? confirms ? staff handle changes and handoffs.

| Adjacent vertical | Typical scope (often simpler than surf house) |
|------------------|-----------------------------------------------|
| Surf schools | Lessons, levels, schedules |
| Surf shops | Rentals, retail-adjacent booking |
| Kite schools ? dive shops | Lessons, certifications, slots |
| Yoga retreats ? small retreat operators | Packages, dates, capacity |
| Hostels with activities | Beds + activity add-ons |
| Tour operators | Departures, group size, deposits |
| Rental businesses | Lessons, rentals, inventory, time slots, sizes ? surf shop / bike / e-bike / kayak / SUP / campervan patterns |

A **surf shop or lesson-rental** operator is likely a simpler config profile than Wolfhouse: fewer rooming rules, more slot/inventory semantics, still the same payment + confirmation + handoff spine.

### Competitive note

AI/WhatsApp tools already exist for hotels, hospitality, and tour operators. The opportunity is a **focused, configurable, operations-heavy** assistant for **small experience businesses** that live in WhatsApp and run **messy** packages, rentals, lessons, and deposits ? not clean hotel-only PMS flows.

### Roadmap implication

| Build now | Defer |
|-----------|--------|
| Wolfhouse as client #1 with full safety proofs | Multi-client SaaS platform |
| `client_config` specs that generalize | Client onboarding UI, billing, settings editor |
| Engine shaped for lessons/rentals/rooming via config | Hardcoding ?surf house only? in shared workflows |

**Config dimensions per client** (see ?3x.11 in [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)): packages ? lesson types ? rental inventory ? rooming rules (if applicable) ? pricing ? deposit rules ? cancellation policy ? handoff rules ? staff notifications ? customer memory policy.

---

## Engine portability ? adding a new vertical (surf shop / lessons)

**Goal:** when Wolfhouse is done, standing up a second vertical (surf-shop **rentals**, surf/kite-school **lessons**, tour **departures**) is a **config + inventory-plugin** exercise ? **not** a rewrite. This section defines the seam so that promise is real instead of aspirational.

### What is SHARED ? built once, reused by every vertical

| Shared spine capability | Where |
|-------------------------|-------|
| WhatsApp inbound/outbound I/O | n8n orchestration |
| Message routing / intent (`routeMessage`) | spine |
| Required-field gating per action (`requiredFields`) | spine + `client_config` |
| Payment link ? **Stripe webhook truth** ? confirmation (`payments`) | spine (proven 3d.x) |
| Handoff triggers (`handoffRules`) | spine + `client_config.handoff` |
| LLM safety (low-confidence ? handoff; never act on LLM alone) | spine + `client_config.llm_safety` |
| Duplicate / idempotency protection | spine (Stage 3.5) |
| Conversation / session state, customer memory + privacy | spine + Postgres |
| Error capture, golden-message runner | Stage 3.5 / 4 |

These **must not** be reimplemented per client. If a "new vertical" task touches these, the seam has leaked.

### What is VERTICAL-SPECIFIC ? plugged in, never forked

| Vertical concern | How it varies | Mechanism |
|------------------|---------------|-----------|
| The bookable resource + availability | bed-nights vs lesson slots vs rental items vs departure seats | `InventoryProvider` implementation |
| Catalog of offerings | packages vs lesson types vs rental SKUs vs departures | `catalog/offerings` + `client_config` |
| Fulfillment / assignment | rooming is **lodging-only**; most verticals skip it | capability flag, not core path |
| Required fields per booking type | dorm gender vs board size vs surf level | `client_config.required_fields` |
| Vocabulary / tone | surf-house terms vs shop terms | `client_config.language_tone` |

### The one abstraction that unlocks all of it: `InventoryProvider`

All verticals reduce to the same three-call contract ? `findAvailability(request)` ? `hold(unit, window)` ? `fulfill(booking)`:

| Vertical | Unit | Availability dimension | Special attribute | Rooming? |
|----------|------|------------------------|-------------------|----------|
| Surf house / hostel | bed | date-range overlap | gender / couple | **yes** (`lodging`) |
| Surf / kite / dive school | lesson slot | time + slot capacity | skill level | no (`slots`) |
| Surf / bike / SUP shop | rental item | time-window ? quantity | size / fit | no (`rentals`) |
| Tour operator | departure seat | departure-date capacity | group size | no (`slots`) |

The spine calls the interface and never knows which provider it is.

### Portability gate ? a vertical is "config-only ready" when:

- [ ] No surf-house nouns (`bed`, `room`, `matrimonial`, `surfweek`, `malibu`/`uluwatu`/`waimea`) appear in the shared spine ? only in `client_config` / providers.
- [ ] Rooming/assignment is behind a **capability flag**, not assumed.
- [ ] Catalog is generic `offerings`, not a hardcoded package enum.
- [ ] Inventory/availability is behind `InventoryProvider`; lodging is just one impl.
- [ ] `client_config` is split into **engine config** (spine) + **vertical config** (catalog/inventory/capabilities).
- [ ] Golden-message suite is parameterized by `client_id` (Wolfhouse fixtures don't hardcode the engine's behavior).

### Cheapest validation ? do this on paper during Stage 3x.3 (safe, docs-only)

Before any Stage 5 extraction, draft **sample configs for a second and third vertical** and run them against the schema to surface every leak:

- `config/clients/surf-shop-rental.sample.json` (rentals: items, sizes, time windows, deposits)
- `config/clients/surf-school.sample.json` (lessons: levels, slots, instructors)

Each gap found ("this field has no home," "this rule assumes beds") becomes a line item in the **Stage 5 extraction backlog**. If both samples fit the schema with only a new `InventoryProvider`, the backbone is portable; if not, you've found the surf-house assumptions cheaply, on paper, before writing engine code.

### Stage placement

| Work | Stage | Safe before runtime? |
|------|-------|----------------------|
| Spine/plugin seam **design** + sample vertical configs (paper test) | now / **3x.3** | yes (docs/config only) |
| Split `client_config` into engine vs vertical schema | 3x.3 ? Stage 5 | yes (config) |
| Extract spine modules; implement `InventoryProvider` (lodging first) | **Stage 5** | build stage |
| Second `InventoryProvider` (`slots` / `rentals`) + 2nd client live | **Stage 7** | scale stage |

**Do not** build multi-vertical infra early. **Do** lock the seam now so Stage 5 cleanup produces portable modules instead of a tidied-up surf-house monolith.

### Deploy config (the onboarding contract)

Every client-specific value (prices, seasons, gate code, phone numbers, packages, room map, policies) lives in **one per-client deploy config** + a gitignored secret file ? never hardcoded in code/workflows. A new client = fill the template, not rewrite logic. Template: [`config/clients/_deploy-config.template.json`](../config/clients/_deploy-config.template.json) ? Guide: [`DEPLOYMENT-CONFIG.md`](DEPLOYMENT-CONFIG.md). Wolfhouse's `wolfhouse-somo.baseline.json` is the worked example (`vertical: lodging_surf_house`).

---

## Legacy phase map (reference)

Older docs use **Phase 0?3d** for engineering milestones. They map to stages as follows:

| Legacy | Stage |
|--------|--------|
| Phase 0?2 local (frozen) | Foundation + Stripe/Main/Send Confirmation contracts |
| Phase 3b (frozen) | Stage 3 ? bed-ops / manual / operator paths |
| Phase 3c?3g | Stage 3 ? Main + Postgres + stub E2E |
| Phase 3d.x | Stage 3 ? isolated real Stripe payment / webhook / confirmation gates |
| Phase 3e | Stage 3 ? rooming/reassign E2E ? |
| Stage 3.5 | Safety rails ? idempotency, error capture, overlap guards |
| Stage 3x | Bot knowledge + safety guardrails (specs, not n8n sprawl) |
| Stage 3y | Shadow / co-pilot ? staff-approved mode before autonomous |
| Azure / multi-client | Stage 7 (Scalable), not before Reliability + Clean |

---

## Stage 3 ? Correct and safe

### Purpose

Prove dangerous core workflows safely before cleanup, staff UI, or multi-client productization.

### What Stage 3 is not

- Not optimizing for guest-facing polish or marketing copy quality
- Not building the full staff product UI
- Not Azure/production cutover
- Not adding dozens of new n8n IF branches for business rules (that belongs in Stage 3x **specs** and Stage 5 **code**)

### Dangerous mistakes Stage 3 must prevent

| Risk | Guard |
|------|--------|
| Wrong booking selected | Conversation `current_hold_booking_id`, resolver, terminal-status blocks |
| Wrong payment link | Real CPS on correct hold; stub vs real env separation |
| Wrong confirmation | Send Confirmation gates; dry-run first; schedule disabled in tests |
| Wrong room assignment | Bed-ops forks; **hosted reassign URL** in Main fork (`3e.2` remap) ? see [`PHASE-3e-ROOMING-REASSIGN-PLAN.md`](PHASE-3e-ROOMING-REASSIGN-PLAN.md) |
| Duplicate payment / session / event | Idempotency checks; single webhook per event id |
| Accidental live Stripe / WhatsApp | Test keys; `WHATSAPP_DRY_RUN`; activation boundaries |
| Background workflow firing | Inactive workflows + schedule `disabled` in test windows |

### Complete or in progress (engineering)

| Area | Status | Notes |
|------|--------|--------|
| `booking_flow` hold creation | **Proven** | PG hold + Airtable backfill in Main fork (3c.e) |
| `payment_details_provided` route | **Proven** | Resolver + Ensure (3c.g stub E2E) |
| Real Stripe checkout link (Main-integrated) | **Proven** | 3d.7b ? `WH-260528-5369`, stop at checkout URL |
| Isolated Create Payment Session | **Proven** | 3d.4 |
| Stripe Webhook Handler payment truth | **Proven** (isolated) | 3d.5b on `WH-260528-1493` |
| Send Confirmation (dry-run) | **Proven** (isolated) | 3d.6e |
| Pay + webhook on Main-created session | **Proven** | 3d.8b organic Stripe on `WH-260528-5369` |
| Integrated Send Confirmation (dry-run) | **Proven** | 3d.9b exec **1077** on same booking |
| Rooming / reassign E2E | **Proven** | **3e.4 PASS** ? `WH-260528-5322`, beds R3-B1/R3-B2 |

**Not proven in Stage 3:** real WhatsApp send; Send Confirmation schedule-poll; single-window E2E; full package intelligence.

**Freeze:** [`PHASE-3c-3d-FREEZE.md`](PHASE-3c-3d-FREEZE.md) ? formal 3c+3d checkpoint before Phase 3e.3+.

**Detail:** [`PROJECT-STATE.md`](PROJECT-STATE.md) ? [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md)

### Stage 3 exit criteria

Stage 3 is **complete only when all of the following are met** (or explicitly deferred with documented safe fallback):

**Core behavior proven:**
- [ ] `booking_flow` hold creation (PG + Airtable backfill) ?
- [ ] `payment_details_provided` route + Ensure ?
- [ ] Real Stripe checkout link (Main-integrated) ?
- [ ] Isolated Create Payment Session ?
- [ ] Stripe Webhook Handler payment truth ?
- [ ] Send Confirmation (dry-run) ?
- [ ] Integrated pay + webhook + confirmation ?
- [ ] Rooming / reassign E2E ?

**Safety invariants proven:**
- [ ] No Main direct writes to `payments` / `payment_events` ? (static proof)
- [ ] No payment/confirmation path writes `booking_beds` ? (static proof)
- [ ] Hosted/prod URLs removed from all local test paths ? (3e.2)
- [ ] Terminal evidence bookings not reused without reset (policy established)

**Guards verified or explicitly deferred:**
- [x] Wrong-booking guard tested for dangerous actions (rooming, payment, cancel) ? **3e.5 CLOSED** (L1+L2 PASS; L3 deferred ? Airtable-coupled runtime deferred to Postgres source-of-truth cutover; see ?15.6??15.7)
- [x] Duplicate / idempotency protections verified at Stage 3 bar ? **3e.6 CLOSED** (I1 schema PASS ? I4 runtime PASS ? I6 invariant PASS; I2/I3/I5 deferred: I2 ? manual-pay gate ? I3 ? Stage 3.5 ? I5 ? Postgres cutover)
- [ ] All dangerous actions have handoff / fail-safe behavior when required business rule is missing ? *3x.7?3x.8 spec done; implementation pending*

**Acceptable deferrals (do not block Stage 3 exit if documented):**
- Real WhatsApp send ? dry-run mode (`WHATSAPP_DRY_RUN=true`) is sufficient; shadow mode (Stage 3y) covers real send
- Send Confirmation schedule-poll ? schedule `disabled=true` gate is sufficient for Stage 3; verify in Stage 3y
- Single-window integrated E2E ? isolated gate chains are sufficient for Stage 3

**Acceptance metric gates:**
- 0 double bookings in all runtime test gates
- 0 wrong-booking dangerous actions in test gates
- 0 payment truth updates outside Stripe Webhook Handler
- 0 confirmations without payment truth
- 0 real WhatsApp sends in dry-run test gates
- 100% dangerous-action routes have handoff/fail-safe when required business logic is missing

---

## Stage 3.5 ? Safety Rails Before Reliability

**Purpose:** Pull forward the minimum safety plumbing required to safely run more runtime gates and prepare for live/shadow mode. This is not full Stage 4 observability ? it is seatbelts.

**When to do Stage 3.5:** After Stage 3 exit criteria are met, before Stage 3y (shadow/co-pilot) or live guest operation.

### Minimum safety requirements (Stage 3.5)

| Item | Why |
|------|-----|
| `automation_errors` capture/write path | Know when bot fails silently |
| Standard workflow error handler pattern | Consistent safe fallback across all n8n workflows |
| Idempotency: inbound WhatsApp message id | No duplicate booking from retry/double-delivery |
| Idempotency: Stripe event id | No duplicate `payment_events` row |
| Idempotency: payment-link reuse | No duplicate checkout session without explicit guard |
| Idempotency: Send Confirmation | Cannot confirm twice (`confirmation_sent_at` + flag) |
| Idempotency: rooming/reassign | Cannot double-assign or double-delete beds |
| Double-booking guard / DB overlap check | `booking_beds` overlap detection query; reject or alert before insert |
| Stuck booking detection (basic) | Bookings in `payment_pending` > N hours with no event; holds expired but not released |
| Workflow active-state safety check | Automated assertion: only expected workflows active before dangerous test or runtime |
| Schedule disabled/enabled safety check | Send Confirmation schedule `disabled=true` verified before any payment/confirmation test |
| Minimum execution logging | For each execution: `resolved_route`, confidence, selected booking id, dangerous action taken (or no-op reason) |
| Golden-runner stub | Even a fixture-file runner (`test:golden-messages`) blocks regression in CI before Stage 4 |

**Stage 3.5 does not include:** full monitoring dashboards, Azure deploy, Staff UI, broad n8n ? backend refactor.

**Full sub-phase spec:** [`PHASE-3.5-SAFETY-RAILS-PLAN.md`](PHASE-3.5-SAFETY-RAILS-PLAN.md) ? 3.5a?3.5g with entry/exit criteria, work-type classification, and first implementation step.

**Key schema finding:** `automation_errors` and `workflow_events` tables exist in migration 001 but are not yet wired into any n8n workflow. Stage 3.5b is a pure wire-in task.

---

## Stage 3y ? Shadow / Co-pilot Pilot

**Purpose:** Bridge the gap between isolated dry-run proof and autonomous live guest operation. Reduces the dry-run ? real-guest cliff; generates real labeled data; builds Ale/Cami trust in the system.

**Full plan:** [`PHASE-3y-SHADOW-COPILOT-PLAN.md`](PHASE-3y-SHADOW-COPILOT-PLAN.md) ? entry criteria, operating modes A?D, allowed/forbidden actions, staff approval workflow, infrastructure requirements, 15-test matrix (Y-T1?Y-T15), exit criteria.

### How shadow/co-pilot mode works

| Step | Who acts |
|------|----------|
| Real guest message arrives (or pasted in offline shadow) | n8n / Main reads it |
| Bot resolves route + drafts response | Bot (automated) |
| Bot suggests safe action (if any) | Bot outputs draft; **no autonomous send** |
| Staff reviews draft | Ale / Cami |
| Staff approves and sends | **Staff (manual)** |
| Staff edit logged as labeled example | System records correction (interim: offline log) |

### Operating modes (ascending risk ? gate each separately)

| Mode | Description | Gate |
|------|-------------|------|
| **A ? Offline shadow** | Pasted/copied messages; local n8n; no live connection | ? Ready to start (no new infra) |
| **B ? Real inbound, no sends** | Real WhatsApp inbound; `DRY_RUN=true` enforced | Separate explicit approval required |
| **C ? Staff-approved draft queue** | Bot writes draft to review queue; staff approves and sends manually | Mode B stable + review UI |
| **D ? Staff-approved action proposals** | Bot proposes dangerous action; staff clicks approve | Stage 6 Staff UI + all 3x complete |

### What is and is not allowed in Stage 3y

| Allowed | Not allowed without explicit approval |
|---------|--------------------------------------|
| Bot reads / classifies message text | Autonomous WhatsApp reply |
| Bot resolves route and flags uncertainty | Autonomous payment link creation |
| Bot drafts response for staff review | Autonomous booking confirmation |
| Bot identifies missing required fields | Autonomous cancellation or room reassign |
| Bot logs decision to `workflow_events` | Payment truth writes |
| Staff-approved sends (manual copy-paste) | Any dangerous action without per-action gate |

### Why Stage 3y before Stage 4

- Avoids big-bang flip from dry-run to fully autonomous
- Creates real labeled guest-message data from actual interactions
- Staff corrections become labeled training examples for Stage 4
- Ale/Cami can see and trust bot behavior before handing over
- "AI drafts, staff approves" is a distinct, sellable product tier

---

## Stage 3x ? Bot knowledge + safety guardrails

**Mini-phase before fully entering Stage 4 (Reliable).**

**Master spec:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)  
**Owner questionnaire:** [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md)

### Purpose

Define the business knowledge and decision rules the bot needs to act safely, ask smart follow-up questions, and avoid dangerous guesses.

**Important:** Stage 3x delivers **specs, fixtures, and configurable rules** ? not a huge expansion of n8n IF nodes. Implementation belongs in code modules (Stage 5) fed by client config.

| Sub-phase | Status |
|-----------|--------|
| **3x.1** Full roadmap ?3x.1?3x.11 + exit criteria + 35 golden rows | **Done** (2026-05-28 retry) |
| **3x.1b** Customer memory layered model (?3x.5) | **Done** (2026-05-28) |
| **3x.2b** Minimum Business Logic Baseline + Stage 4 entry gate | **Done** (2026-05-29) |
| **3x.2c** Applied owner P1 answers ? baseline v0.2 + handoff/add-on plans | **Done** (2026-05-29) |
| **3x.2d** Working prices + policies ? baseline v0.3 (provisional pricing) | **Done** (2026-05-29) |
| **3x.2** Ale/Cami **confirm** provisional prices + fill gaps ? confirmed config | In progress |
| **3x.3** WhatsApp mining + golden fixtures + customer extract | Planned |
| **3x.4** Golden runner + Stage 4 reliability hooks | Planned |

**Stage 3x includes:** required-field map ? package decision flow ? Wolfhouse knowledge collection ? **WhatsApp history mining** ? **customer memory migration** ? golden message tests ? dangerous-action gates ? human handoff ([`STAFF-HANDOFF-PLAN.md`](STAFF-HANDOFF-PLAN.md)) ? during-stay add-ons ([`DURING-STAY-ADDONS-PLAN.md`](DURING-STAY-ADDONS-PLAN.md)) ? wrong-booking protection ? duplicate protection ? client-config architecture ? **exit criteria** ([`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md)).

### Summary index (detail in master spec)

### 3x.1 ? Required field map

Define required fields **before** each action:

| Action | Required before proceed |
|--------|-------------------------|
| Create booking hold | Dates, guest count, contact phone, package or accommodation intent, availability OK |
| Send payment link | Hold exists, guest name + email, promoted payment state, deposit rule known |
| Confirm booking | Payment truth (`deposit_paid` / paid), `send_confirmation` gate, not terminal |
| Cancel booking | Booking id/code, policy window, staff approval if ambiguous |
| Room / bed assignment | Confirmed or approved hold, guest count, gender/couple/friend rules |
| Package quote | Package code, dates, guest count, season |
| Package booking | Quote inputs + package-specific required fields |
| Date change | Booking id, new dates, availability, policy |

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ?3x.1](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x1--required-field-map) + fixture tables keyed by `resolved_route`.

### 3x.2 ? Package explanation + package decision flow

The bot must explain package differences clearly.

**Define per package:**

- Name, inclusions, exclusions
- Price or price logic (season, nights, per person)
- Deposit rules, minimum nights
- Lesson schedule, rental rules, meals, transfers
- Cancellation/refund policy
- Who the package is best for

**Bot behavior rules:**

| Guest signal | Bot behavior |
|--------------|--------------|
| ?What packages do you have?? | Briefly explain all packages |
| Wants to book, package missing | Ask: accommodation only vs surf package |
| Unsure | Recommend by goal: cheapest ? shared accommodation; beginner ? lesson package; full arrange ? full surf; already surfs ? accommodation + rentals |
| Price question | Do **not** quote exact price unless dates, guest count, package, and price source are known |
| Still uncertain | Follow-up question or staff handoff |

### 3x.3 ? Wolfhouse knowledge collection

Operational gaps only (not public website facts). Questionnaire for Ale/Cami:

**Deliverable:** [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md)

### 3x.4 ? WhatsApp history mining plan

Redacted Cami/Ale guest threads ? **dual outputs:** (A) anonymized bot knowledge + (B) structured customer memory (see ?3x.5).

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ?3x.4](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x4--whatsapp-history-mining-plan); redacted samples under `docs/knowledge/whatsapp-samples/` (not in git until anonymized).

### 3x.5 ? Customer memory + WhatsApp history migration

Layered model: temporary raw import ? structured customer facts (PG, `client_id`-scoped) ? anonymized fixtures. Proposed tables: `customers`, `customer_booking_history`, `conversation_summaries`, `customer_preferences`, `customer_notes`, `privacy_requests` (future).

**Deliverable:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ?3x.5](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x5--customer-memory--whatsapp-history-migration). Owner questions: [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md) ? Customer memory.

### LLM safety requirements (across Stage 3x + Stage 4)

The bot must never act on LLM output alone for dangerous actions. The following are required:

| Requirement | Stage |
|-------------|-------|
| Low confidence ? human handoff (not silent no-op) | 3x.8 spec ? 3.5 impl |
| LLM/API error ? handoff or logged safe fallback | 3.5 |
| Parsing uncertainty ? clarification question, not action | 3x.8 spec ? 3.5 impl |
| `resolved_route`, confidence, selected booking, and action logged per execution | 3.5 |
| Golden-message suite used as prompt regression evaluation | 3x.6 ? 4 |
| Multilingual behavior tested: English / Spanish / Italian | 3x.6 |
| Bot never marks `paid` / `cancelled` / `confirmed` based only on LLM interpretation | 3x.7 gate ? proven in 3d.5b (webhook owns truth) |

### Stage 3x exit criteria

Documented in master spec ? planning complete when ?3x.1?3x.11 + exit checklist exist; full golden fixture set may complete in 3x.3.

### 3x.6 ? Golden message tests

**30?50** realistic guest messages with expected:

- `resolved_route`
- Missing fields
- Safe action (or explicit no-op)
- Clarification question text (pattern, not exact LLM wording)
- Handoff behavior

**Categories to include:**

- Booking request ? package questions ? payment-link request ? ?I paid?
- Cancellation ? room preference ? couple/friends/gender rooming ? date changes
- Surfboard/wetsuit rental ? breakfast/transfer ? unclear / low-confidence messages

**Deliverable:** `docs/fixtures/golden-messages/` + runner stub (Stage 4+). Schema + samples in master spec ?3x.6.

### 3x.7 ? Dangerous action gates

Strict proof required before:

| Action | Proof |
|--------|--------|
| Send payment link | Hold + Ensure + CPS contract; no terminal booking |
| Confirm booking | Webhook payment truth + Send Confirmation eligibility |
| Cancel booking | Booking status + policy |
| Change room/bed | Assignment rules + capacity |
| Change dates | Availability + policy |
| Mark payment-related states | Webhook or authorized staff only |

### 3x.8 ? Human handoff rules

Bot must stop guessing and alert staff when:

- Low route confidence
- Conflicting dates or guest count
- Multiple active holds for same conversation
- Guest says they paid but no payment record
- Refund / dispute / cancellation ambiguity
- Angry guest / complaint
- Medical / emergency / legal issues
- Rooming / reassign uncertainty

**Deliverable:** `handoffRules` spec ? later `client_config.handoff_rules`.

### 3x.9 ? Wrong-booking protection

Formalize (align with existing resolver + PG):

- `conversation.current_hold_booking_id` wins over phone-only fallback
- Terminal bookings (`confirmed`, `cancelled`, etc.) cannot be modified by guest path
- Old holds must not be selected because phone matches alone
- Active booking must match conversation context and latest intent

### 3x.10 ? Duplicate protection

Verify and document:

| Scenario | Expected |
|----------|----------|
| Same WhatsApp message id | No duplicate booking |
| Repeated payment-link request | No duplicate checkout session without idempotency |
| Same Stripe event id | No duplicate `payment_events` row |
| Confirmation | Cannot send twice (`confirmation_sent_at`, flags) |

### 3x.11 ? Client-config architecture plan

Same assistant engine, different **client config** per property.

| Config category | Examples |
|-----------------|----------|
| `packages` | Codes, seasons, inclusions |
| `room_types` | Shared, private, gender rules |
| `bed/room_rules` | Couples, friends, operator blocks |
| `pricing` | Rules, deposits, rounding |
| `deposit/payment_rules` | Deposit cents, deadlines |
| `cancellation_policy` | Windows, refund tiers |
| `hold_expiry` | TTL, reminders |
| `language/tone` | Default language, formality |
| `handoff_rules` | Triggers, staff notify |
| `integrations` | Stripe, WhatsApp, webhooks |
| `staff_notification_rules` | Channels, severity |
| `customer_memory_policy` | Retention, allowed fields, returning-guest rules |

Wolfhouse = `client_slug: wolfhouse-somo`. Future surf houses add new config rows, not forked workflows.

---

## Source-of-truth cutover ? Airtable ? Postgres

This is a **first-class roadmap event**, not a scattered implementation detail. Airtable is the current operational source of truth for staff. Postgres is the engineering source of truth for the bot. Cutover must happen deliberately.

### Cutover phases

| Phase | Description | Gate |
|-------|-------------|------|
| **Current** | Airtable = staff SoT; Postgres = bot SoT; dual-write in progress | Active |
| **Read-only compare** | Run both reads; log discrepancies; do not act on mismatch | Before any cutover |
| **`DATA_SOURCE` flag** | Config-driven: `airtable` \| `postgres` per path; allows per-path rollout | Stage 4 |
| **Soak period** | Postgres-primary writes; Airtable as backup read; monitor for divergence | Stage 4?5 |
| **Airtable dependency removal** | Only after staff UI or equivalent replacement exists | Stage 6+ |
| **Backup policy** | Full Airtable export + PG dump before each cutover step | Required |
| **Rollback plan** | Revert `DATA_SOURCE` flag; restore from backup; documented runbook | Required |

**Do not remove Airtable dependency** until:
1. Staff UI (Stage 6) or equivalent is live for all Airtable use cases it currently covers
2. PG data has passed a soak period without divergence
3. Backup and rollback procedure is documented and tested

---

## Privacy / GDPR gate before customer memory

**No Layer-2 structured customer memory with personal data until all of the following exist:**

| Requirement | Status |
|-------------|--------|
| Documented purpose for each stored personal field | Planned (3x.2) |
| Retention policy per field type | Planned (3x.2) |
| Staff-only note handling (no guest-facing access to staff notes) | Planned |
| Delete / export / correction procedure documented | Planned |
| Marketing opt-in separated from booking support data | Planned |
| Raw WhatsApp exports kept off-repo / in `data/private/` (gitignored) | **Done** (`84fa45f`) |
| Only reviewed/sanitized fixtures in repo | Policy established |

**This gate applies before 3x.3 customer extract is written to PG.** Planning (3x.2) may proceed; PG insert of personal data requires privacy gate first.

---

## Stage 4 ? Reliable

**Status (2026-05-30): CLOSE WITH DEFERRALS.** Autonomous Booking Dry-Run complete ? all 14 scenarios PASS (commit `6cd9a21`). Evidence: `test-payloads/stage4/autonomous-dry-run/README.md`. Live WhatsApp, live holds, live Stripe, and live confirmation writes remain deferred. Structured add-on records and staff ops assistant deferred to Stages 5?6.

### Purpose

Make the working system **dependable and observable** after Stage 3 behavior is proven and Stage 3x rules are specified.

### Entry gate (defined in baseline config + ?3x.2b)

Gate definition: [`config/clients/wolfhouse-somo.baseline.json`](../config/clients/wolfhouse-somo.baseline.json) (`stage4_entry_gate`) and [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` ?3x.2b/?3x.2c](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x2c--applied-owner-answers-2026-05-29).

**Reduced after 3x.2c** (payment-link auto-send, hold expiry, confirmation content, conditional cancel/date-change, rooming auto-assign + operator-room logic all confirmed). **Remaining owner blockers:** deposit amount/scope ? non-7-night pricing math ? cancellation/refund windows & % ? add-on service prices/scheduling (if in Stage 4 scope) ? real WhatsApp send gate or Stage 3y shadow ? final handoff channel. **Not blockers:** perfect tone ? full customer memory ? marketing opt-in ? exact add-on automation.

**Additional entry requirement:** Autonomous booking dry-run pass ? bot completes full booking flow (inbound message ? route ? availability ? hold ? payment-link ? Stripe webhook ? confirmation) without errors in all-stubbed mode, proving readiness before real sends or live operation are enabled.

### Includes

- **Autonomous booking dry-run** (first Stage 4 milestone): full booking flow end-to-end ? inbound message ? route ? availability ? hold ? payment-link ? Stripe webhook ? confirmation ? with all live side effects stubbed at the infrastructure boundary. Proves the bot completes the booking correctly before real sends or live operation are enabled. This is the regression anchor: once green, enabling real WhatsApp send or live operation is a config change, not a behavior change.
- Better error handling and safe retries (where idempotent)
- Stuck booking detection
- Monitoring, alerts, execution dashboards
- Clearer structured logs
- Health checks (n8n, Postgres, Redis, webhooks)
- Rollback tools and fixture cleanup
- Duplicate protection checks (automated)
- Active workflow safety checks; schedule safety checks
- Runbooks for common failures (payment stuck, webhook miss, confirmation not sent)

### Staff visibility (minimum for safety)

May begin here if needed before full Stage 6 UI:

- Stuck bookings queue
- Payment status view
- Human handoff queue
- Pending confirmations
- Failed workflow executions
- **Staff query assistant** (read-only ops Q&A: "who has a surfboard today?", "who arrives today?", "which rooms need cleaning and by when?") gated by an **approved-staff allowlist** (`staff_directory`; portal = Stage 6) ? [`STAFF-QUERY-ASSISTANT-PLAN.md`](STAFF-QUERY-ASSISTANT-PLAN.md)

### Add-on structured records (Stage 4 design requirement)

Add-on dry-run tests (e.g. A9 ? lessons, yoga, rentals) must do more than verify the guest-facing price quote is correct. They must also prove the system can **represent add-on requests as structured, staff-queryable records**. This is the data foundation that makes Stage 6 staff queries possible.

Each add-on request that passes through the bot should be representable as a record with at minimum:
- Guest / booking reference
- Add-on type (lesson, wetsuit, board, yoga, dinner)
- Quantity / number of days
- Requested date(s)
- Payment status (pending / paid)
- Fulfillment status (not redeemed / redeemed ? staff-managed)
- A flag indicating whether staff scheduling / manual tracking applies (e.g. lessons require a manual slot assignment)

**Stage 4 does not require full add-on automation.** It requires that when the bot processes an add-on request, the output can be persisted in a shape that is queryable by staff. If no structured add-on record is written yet, the design must identify where it would be written and what the schema looks like ? so Stage 5 does not have to invent it from scratch.

---

## Stage 5 ? Clean

**Status (2026-05-31): CLOSE WITH DEFERRALS ? source-of-truth cleanup complete (5.1?5.8b); engine extraction / portability scope deferred.** All staff-queryable data tables are schema-stubbed and query helpers are proven. Migrations 007 (add-ons) and 008 (staff handoffs) are ready to apply. Live operation, engine extraction, and staff UI remain deferred (Stage 6). Detail: [`PHASE-5-SOURCE-OF-TRUTH-CLEANUP.md`](PHASE-5-SOURCE-OF-TRUTH-CLEANUP.md).

### Purpose

Simplify implementation after behavior is proven and reliability checks exist.

### Safety-critical early extractions (pull forward to Stage 3.5 / 4 only if needed)

Do **not** do broad Stage 5 refactor before Stage 3 / 3.5 safety gates. However, pull forward **only** these safety-critical items when required:

- Wrong-booking guard (if not proven in Stage 3 negative tests)
- Dangerous-action gate checks (missing required business rule ? handoff)
- Duplicate / idempotency checks (if Stage 3.5 requires them in code)
- Bed-assignment overlap / dedup logic (if DB constraint is insufficient)
- `client_config` loading skeleton (if Stage 3x requires it for golden tests)

### Includes

- Move decision logic out of n8n into `src/booking-assistant/` (n8n becomes I/O only).
- **Extract along the portability seam** ([? Engine portability](#engine-portability--adding-a-new-vertical-surf-shop--lessons)): shared spine vs `inventory/` + `catalog/` plugins ? do **not** produce a tidied-up surf-house monolith.
- Implement `InventoryProvider` with **lodging** as the first concrete provider; keep the interface generic enough for `slots` / `rentals`.
- Split `client_config` into **engine config** (spine) + **vertical config** (catalog / inventory / capabilities); rooming behind a capability flag.
- Replace serialized-into-n8n Code nodes (e.g. the resolver) with calls to the extracted, version-checked modules.

**Target:** n8n calls backend decision engine; Postgres writes go through shared SQL/modules; n8n performs WhatsApp/Stripe/Airtable I/O.

**Portability acceptance for Stage 5:** the Wolfhouse spine compiles and passes golden tests with **zero surf-house nouns** outside `inventory/lodging.*` and `client_config`. (Verify against the portability gate checklist.)

### Staff-queryable operational data (Stage 5 requirement)

Source-of-truth cleanup must explicitly produce the structured Postgres records that power Stage 6 staff queries. The data design goal is: **staff questions are answered from reliable structured records, not guessed from chat logs or Airtable exports.**

The following tables/models must be designed (and at minimum stubbed in schema) during Stage 5, before the Stage 6 staff assistant is built:

| Table / model | Answers the question |
|---|---|
| `add_on_orders` | Which guests have requested add-ons? What is the payment status per order? |
| `add_on_items` | Line-item detail per order (type, qty, days, dates, price) |
| `lesson_requests` | Who has lessons today / tomorrow? What slot? (staff assigns; bot records request) |
| `rental_requests` | Who requested a board / wetsuit? For how many days? Pickup status? |
| `yoga_requests` | Who paid for yoga? For which date? (redeemed on-site by staff) |
| `staff_handoffs` / `staff_tasks` | Which conversations need a human reply? Why was it handed off? Current state? |
| `payment_balances` (view or table) | Who still owes money? Who paid deposit but not full balance? |

These are **not new features** ? they are the structured forms of data the bot already collects. The goal of Stage 5 is to ensure that data lands in Postgres in a queryable shape instead of only in Airtable or serialized chat session state.

**Design gate for Stage 5:** before beginning Stage 6 staff UI work, verify that a staff member can ask each of the following questions and get a correct answer from Postgres without touching Airtable or reading raw WhatsApp messages:

- "Who paid for yoga today?"
- "Who has lessons tomorrow?"
- "Who still owes money?"
- "Who requested a board?"
- "Which bookings need a human reply?"
- "Show today's arrivals and departures."
- "Who paid deposit but not full balance?"
- "Which guests requested rooming preferences?"

---

## Stage 6 ? Beautiful (Staff / Admin Layer)

**Status: CLOSED WITH DEFERRALS** (2026-05-31) ? All exit criteria MET. 6.0?6.9 DONE: 35-intent registry, CLI runner, batch reports, CLI write action, HTTP API, browser UI, smoke test, token-gated write endpoint. Production auth/TLS/live-ops deferred to Stage 7. See [`PHASE-6-STAFF-ASSISTANT-PLAN.md`](PHASE-6-STAFF-ASSISTANT-PLAN.md).

**Implementation slices:** 6.1 registry DONE ? 6.2 CLI runner DONE ? 6.3 handoffs DONE ? 6.4a/b/c/d batch reports DONE ? 6.5a/b CLI write action DONE ? 6.6 HTTP API DONE ? 6.7 intent smoke DONE ? 6.8 read-only UI DONE ? 6.9 token-gated write endpoint DONE.

### Purpose

Excellent staff and owner experience. This is where the **two-sided product** becomes visible: the guest-facing assistant (already built) and the **staff-facing operations assistant** (built here).

### Two sides of the product

| Side | Who uses it | What it does |
|------|------------|--------------|
| **Guest assistant** | Guests on WhatsApp | Bookings, questions, payments, confirmations, add-ons, rooming, handoff |
| **Staff assistant / admin** | Ale, Cami, operators | Operational queries, action review/approval, conversation takeover, status dashboards |

### Staff Operations Assistant

Staff can ask operational questions and get answers from **structured Postgres records** (not chat logs or guesses). All queries are read-only, gated by `staff_directory` approved numbers.

**Example questions the staff assistant must answer:**

- "Who paid for yoga today?"
- "Who has lessons tomorrow?"
- "Who still owes money?"
- "Who requested a board?"
- "Which conversations need a human reply?"
- "Show today's arrivals and departures."
- "Who paid deposit but not full balance?"
- "Which guests requested rooming preferences?"

**Design constraint:** these questions are answered from the structured records built in Stage 5 (`lesson_requests`, `add_on_orders`, `staff_handoffs`, `payment_balances`, etc.). The assistant maps natural-language questions to fixed safe parameterized intents ? it never generates arbitrary SQL.

### Staff Approval Controls

Staff can review, approve, and act on bot proposals without going directly into n8n or Airtable:

- View bot draft reply before it is sent
- Approve or reject risky bot action proposals (payment, cancellation, room reassign)
- Take over a conversation from the bot
- View payment / hold / rooming / add-on status per booking
- Mark add-on as redeemed (voucher fulfilled on site)
- Release or block operator rooms

### Staff UI

- Calendar / bed grid, guest list, booking detail
- Payment status, pending holds, confirmation queue
- Conversation history, human takeover
- Manual booking / edit / cancel tools
- Room/bed assignment UI
- Alerts for stuck workflows
- Owner dashboard

Airtable may remain a **bridge** during transition; long-term goal is a proper staff UI, not Airtable as daily ops surface.

**Airtable cutover prerequisite:** the staff UI (or equivalent) must cover all use cases Airtable currently serves before Airtable is removed as a dependency ? see the Source-of-truth cutover table above.

---

## Stage 7 ? Scalable

**Status: PLANNING CLOSED / IMPLEMENTATION STARTED** (2026-05-31) ? 7.0?7.6 DESIGN DONE. **7.2b+7.2c DONE**: migration 009 + auth middleware scaffold (login/logout/session/role checks) applied to local/dev. Staging/prod NOT secure. Next: 7.3b Azure scaffold or Cami dashboard plan: [`PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md`](PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md), [`PHASE-7.1-ENV-SECRETS-INVENTORY.md`](PHASE-7.1-ENV-SECRETS-INVENTORY.md), [`PHASE-7.2-AUTH-STAFF-ACCOUNTS-PLAN.md`](PHASE-7.2-AUTH-STAFF-ACCOUNTS-PLAN.md), [`PHASE-7.3-STAGING-DEPLOYMENT-TLS-PLAN.md`](PHASE-7.3-STAGING-DEPLOYMENT-TLS-PLAN.md). Production hardening + pilot deployment defined (environments, auth, TLS, monitoring, backups, rollback, Airtable cutover gate, live WhatsApp/Stripe gates, pilot soak, go/no-go). 7.3 recommends Azure Container Apps (aligned with [`azure-n8n-hosting-plan.md`](azure-n8n-hosting-plan.md)). No implementation; live operation NOT approved.

### Purpose

Repeatable platform for multiple clients, plus production hardening and a controlled Wolfhouse pilot.

### Includes

- Multi-client config onboarding
- Client-specific room/package rules (config-driven)
- Isolated data per `client_id`
- Reusable deployment process (see [`azure-n8n-hosting-plan.md`](azure-n8n-hosting-plan.md) when approved)
- Billing/subscription model (product)
- Support tools, backup/restore, per-client monitoring
- Migration path away from Airtable
- Templates for surf houses, retreats, hostels, camps

### Adding the second vertical (surf shop / lessons)

By Stage 7 this should be a **checklist, not a project** ? provided the Stage 5 portability seam holds:

1. Start from the paper-tested sample config (`config/clients/surf-shop-rental.sample.json` / `surf-school.sample.json` drafted in 3x.3) ? promote to a real client config.
2. Fill the **vertical config** (catalog/offerings, inventory model, capabilities) and **engine config** (payment, handoff, llm, privacy) ? reuse the Wolfhouse engine defaults.
3. Implement or reuse the matching `InventoryProvider` (`rentals` / `slots`); **no new workflows** if lodging was the only thing forked before.
4. Add `client_id`-scoped data; seed inventory/offerings.
5. Run the **`client_id`-parameterized golden suite** for the new vertical before any live/shadow operation.
6. Onboard via Stage 3y **shadow/co-pilot mode** first (staff-approved), exactly as Wolfhouse did ? never straight to autonomous.

**If step 3 requires touching the shared spine, that is a portability regression** ? fix the seam, don't fork the workflow.

**Guiding principle:** Build Wolfhouse first; structure everything as **client #1**, not the only client.

---

## What to read next

| Role | Doc |
|------|-----|
| Product vision (15 pillars) | [`PRODUCT-MASTER-ROADMAP.md`](PRODUCT-MASTER-ROADMAP.md) |
| Engineer (today) | [`PROJECT-STATE.md`](PROJECT-STATE.md) |
| Stage 3x spec | [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md`](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md) |
| Owner / non-engineer | [`PROJECT-ROADMAP.md`](PROJECT-ROADMAP.md) |
| Agent rules | [`../CURSOR.md`](../CURSOR.md) |
| Stripe test gates | [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md) |


