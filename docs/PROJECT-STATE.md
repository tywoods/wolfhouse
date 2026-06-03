# Wolfhouse ? Project State

**Last updated:** 2026-06-03 (**Stage 8.5.12 DONE -- staging-safe Luna dry-run re-import + hosted proof**): Stage 8.5.11 repo workflow re-imported into staging n8n **without import-time patches** (`stage8510SharedDryRun01`, `active:false`, 17 nodes). Header Auth credential `Luna Bot Internal Token (staging)` created/bound (`stage8512LunaBotTok01`, header `X-Luna-Bot-Token`, value from Key Vault). Manual execution **#5** (mode:manual) **success** (~2s) with pinned payload: `+34999000123` / Test Guest / `test@example.test` / check_in 2026-08-22 / check_out 2026-08-27 (5 nights) / guest_count 2 / malibu / shared / deposit / `luna_whatsapp`. **No temp IF bypass. No `$env` patches.** `Set - DryRun Mode Flags` -> `dry_run:true` / `live_send_enabled:false`; `IF - DryRun Guard` passed on `$json.dry_run`; full chain: booking-preview -> availability-check -> booking-create -> Stripe link -> draft reply. `booking_code:MB-WOLFHO-20260822-3a4d1a`; `checkout_url` via Staff API; `reply_draft` generated; `whatsapp_sent:false`. No `graph.facebook.com`; no `api.stripe.com`. Workflow remains **inactive**. Test booking **left on staging** (disposable; payment checkout_created, not paid). Prior: **Stage 8.5.11 DONE -- Luna shared-engine dry-run staging-safe repo fix**: Repo workflow `n8n/Wolfhouse Booking Assistant - Main - Shared Engine Dry Run.json` updated for clean staging import without manual `$env` patches. Added `Set - DryRun Mode Flags` (`dry_run:true`, `live_send_enabled:false`); `IF - DryRun Guard` checks `$json.dry_run` (no `$env` in IF expressions). Four bot HTTP nodes use Header Auth credential placeholder `Luna Bot Internal Token (staging)` ? bind `X-Luna-Bot-Token` at import from Key Vault, never hardcoded. `active:false`; all branches `whatsapp_sent:false`; no `graph.facebook.com`; no `api.stripe.com`. `verify-luna-n8n-bot-shared-engine-dry-run.js` 47/47 PASS. Not re-imported/activated in this slice. Next: optional re-import + manual execution without import-time patches. Prior: **Stage 8.5.10 DONE -- hosted Luna shared-engine dry-run execution**: `n8n/Wolfhouse Booking Assistant - Main - Shared Engine Dry Run.json` imported into staging n8n **inactive** (`workflowId: stage8510SharedDryRun01`, `active:false`, 17 nodes). Manual execution #4 (mode:manual) **success** (~15s) with pinned payload: `+34999000123` / Test Guest / `test@example.test` / check_in 2026-08-15 / check_out 2026-08-20 (5 nights) / guest_count 2 / malibu / shared / deposit / `luna_whatsapp`. Happy path: `Set - DryRun Mode Flags` ? booking-preview ? availability-check ? booking-create ? Stripe link ? draft payment reply. Staff API chain proven: `/staff/bot/booking-preview` (quote) ? `/staff/bot/availability-check` (`selected_bed_codes`, `has_enough_beds:true`) ? `/staff/bot/bookings/create` (`booking_code:MB-WOLFHO-20260815-4d37a0`, `payment_id`) ? `/staff/bot/payments/:id/create-stripe-link` (`checkout_url`, `payment_status:checkout_created`). `reply_draft` generated; `whatsapp_sent:false`; no `graph.facebook.com`; no `api.stripe.com`; `STRIPE_DEFAULT_DEPOSIT_CENTS` not used as env. Workflow remains **inactive**. Test booking **left on staging** (disposable; payment checkout_created, not paid). **Staging import note:** guard fix (`Set - DryRun Mode Flags` + `$json.dry_run`) and bot token injection applied at import because repo JSON still references `$env` and staging n8n blocks env in expressions. No workflow activation. No live WhatsApp. No Staff API/Stripe/Azure code changes. Prior: **Stage 8.6.10 DONE -- Azure staging deploy + hosted Ask Luna departures/cleaning proof**: image `wh-staff-api:e0b809c-stage8610-cleaning-departures` pushed to `whstagingacr.azurecr.io`; deployed to `wh-staging-staff-api` revision `--0000019` (Succeeded). Preflight: clean tree at `e0b809c`; `verify-staff-ask-luna-api.js` 51/51 PASS. Hosted proofs on `https://staff-staging.lunafrontdesk.com`: POST `/staff/ask-luna` (staff_portal) `Who leaves today` ? 200/`departures_today`/`read_only:true`/`no_write_performed:true`/`sends_whatsapp:false`/`staff_access:session`/`row_count:0`; POST (staff_portal) `Which rooms need cleaning` ? 200/`rooms_or_beds_need_cleaning`/same safety fields; POST (staff_whatsapp allowlisted `+34999000999`) ? 200/`departures_today`/`staff_access:allowlisted_phone`/`sends_whatsapp:false`. No `graph.facebook.com`, no n8n, no Stripe. No n8n import/activation. No WhatsApp sent. Next: 8.6.11+ live gated WhatsApp send (after 8.6.8 GO). Prior: **Stage 8.6.9 DONE -- Ask Luna departures + cleaning intents**: `POST /staff/ask-luna` extended with read-only `departures_today` and `rooms_or_beds_need_cleaning`. NL: `Who leaves today?` / `Which rooms/beds need cleaning?`. SQL from structured `bookings` + `booking_beds` where `check_out = today` (cleaning = assigned beds turning over on departure day); no conversation/chat logs. Response: `read_only:true`, `no_write_performed:true`, `sends_whatsapp:false`. No DB writes, WhatsApp, n8n, Stripe, Azure. `verify-staff-ask-luna-api.js` PASS. Prior: **Stage 8.6.8 DONE -- Staff Ask Luna live WhatsApp readiness checklist**: go/no-go checklist added to ROADMAP (§ Stage 8.6.8). Docs only ? no code, n8n edits, activation, or sends. **Live send: NO_GO** until owner sign-off. Gates cover: workflow imported inactive (`stage863AskLuna01`); live send disabled; one test number first (`+34999000999` only); `staff_whatsapp_enabled:true` staging-test only; `dry_run`/`live_send_enabled` decision documented (workflow JSON flags, not `$env`); no `graph.facebook.com` until GO; smoke question `who still owes money`; expected `/staff/ask-luna` ? `payments.balance_due` + balance answer; rollback = deactivate workflow + restore `dry_run:true` / `live_send_enabled:false`. Baseline mostly PASS from 8.6.1?8.6.7; Gate 3 PARTIAL until owner picks single pilot number. Next: 8.6.9 live gated send (after explicit GO). Prior: **Stage 8.6.7 DONE -- re-import fixed Staff Ask Luna dry-run + manual execution**: updated `Wolfhouse Staff Ask Luna - WhatsApp Dry Run.json` (Stage 8.6.6 guard fix) re-imported into staging n8n **inactive** (`stage863AskLuna01`, `active:false`, 11 nodes, `Set - DryRun Mode Flags`, no `$env.WHATSAPP_DRY_RUN`). Manual execution #3 (mode:manual) **success** (~13s) with pinned payload: `+34999000999` / `who still owes money` / `wolfhouse-somo` / `whatsapp`. **No temp IF bypass.** `Set - DryRun Mode Flags` -> `dry_run:true` / `live_send_enabled:false`; `IF - DryRun Guard` passed on `$json.dry_run`; `POST /staff/ask-luna` -> `payments.balance_due`; `reply_draft` generated; `whatsapp_sent:false`; no `graph.facebook.com`; no `dry_run_guard_blocked`. Workflow remains **inactive**. No activation. No live WhatsApp. No Staff API/Stripe/Azure changes. Prior: **Stage 8.6.5 DONE -- hosted inactive Staff Ask Luna dry-run proof**: `Wolfhouse Staff Ask Luna - WhatsApp Dry Run.json` imported into staging n8n as **inactive** (`workflowId: stage863AskLuna01`, `active:false`). Manual execution #2 (mode:manual) **success** (~16s) with pinned webhook payload: allowlisted `+34999000999`, question `who still owes money`, `client_slug:wolfhouse-somo`, `source:staff_whatsapp`. Happy path proven: `HTTP - Staff Ask Luna` called `POST https://staff-staging.lunafrontdesk.com/staff/ask-luna` -> `intent:payments.balance_due` / `reply_draft` generated / `whatsapp_sent:false` / `dry_run:true` / `live_send_blocked:true`; no `graph.facebook.com` in execution data or node params. Workflow left **inactive** after proof; node graph restored to match repo JSON. **Staging gap noted:** `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` blocks `$env.WHATSAPP_DRY_RUN` in IF guard ? execution #1 hit `dry_run_guard_blocked`; proof run used temporary staging-only IF bypass then restored. No workflow activation. No live WhatsApp send. No Staff API edits. No Stripe. Prior: **Stage 8.6.4 DONE -- Azure staging deploy**: image wh-staff-api:1f9e21e-stage864-ask-luna pushed to whstagingacr.azurecr.io; deployed to wh-staging-staff-api revision --0000018 (provisioningState:Succeeded). Hosted proofs: /staff/login->200; /staff/ui->200 (170234 chars, Ask Luna tab+al-input+al-btn+alAsk+source:staff_portal all present, no graph.facebook.com, no api.stripe.com); POST /staff/ask-luna (source:staff_portal, session auth)->200/payments.balance_due/read_only:true/no_write_performed:true/sends_whatsapp:false/staff_access:session/row_count:1; POST /staff/ask-luna (source:staff_whatsapp, allowlisted +34999000999)->200/payments.balance_due/staff_access:allowlisted_phone/sends_whatsapp:false; POST /staff/ask-luna (unlisted phone)->403; staff_whatsapp_enabled:true in config (staging test); no n8n imported/activated; no Stripe calls; no WhatsApp sent. Prior: **Stage 8.6.3 DONE -- Staff Ask Luna WhatsApp dry-run workflow**: New inactive n8n workflow Wolfhouse Staff Ask Luna - WhatsApp Dry Run.json (active:false, 10 nodes). WHATSAPP_DRY_RUN guard. Code - Parse Staff Message (from/text/client_slug). HTTP - Staff Ask Luna (POST /staff/ask-luna, source:staff_whatsapp, staff_phone from inbound, no X-Luna-Bot-Token, neverError+fullResponse). IF - API Authorized: true->Code - Format DryRun Answer->Respond (intent/answer/reply_draft, whatsapp_sent:false, dry_run:true, live_send_blocked:true); false->Set - Log Unauthorized (not enabled draft)->Respond. unsupported_intent logged with suggestions. No graph.facebook.com in node params. No Stripe. No DB writes. Not imported/activated. verify-staff-ask-luna-whatsapp-dry-run.js 40/40 PASS (new). verify-staff-ask-luna-api.js 48/48 PASS unchanged. 0 DB writes. Prior: **Stage 8.6.2 DONE -- Staff Portal Ask Luna text box**: New "Ask Luna" tab in Staff Portal nav; compact hero panel with title/subtitle; text input (`al-input`) + Ask button (`al-btn`) with Enter key support; `alAsk()` POSTs to `/staff/ask-luna` with `source:"staff_portal"` via session auth; `alRenderResult()` displays intent badge, answer text, row_count, compact rows table (first 20), unsupported_intent suggestions; `alShowError()`/`alSetLoading()` for error/loading states; no WhatsApp/n8n/Stripe/DB writes; `verify-staff-query-ui.js` 43/43 PASS (14 new Ask Luna checks in section 7b); `verify-staff-ask-luna-api.js` 48/48 PASS unchanged; local proof: `who still owes money`?payments.balance_due/1 row/real guest data; `what is the weather today`?unsupported_intent+full suggestion list; 0 DB writes. Prior: **Stage 8.6.1 DONE -- Staff Ask Luna endpoint**: POST /staff/ask-luna added; session auth (staff_portal) OR allowlisted phone auth (staff_whatsapp via wolfhouse-somo.staff-whatsapp-allowlist.json); natural-language intent resolver (14 keyword patterns + direct registry key passthrough); unsupported intents: departures_today + rooms_need_cleaning return unsupported_intent + suggestion list; WhatsApp-friendly formatAnswer per intent; all registry intents accessible (35 total); response: read_only:true/no_write_performed:true/sends_whatsapp:false; no INSERT/UPDATE/DELETE; no Stripe; no n8n; no WhatsApp send; verify-staff-ask-luna-api.js 48/48 PASS; local proof: unknown phone->403, allowlisted +34999000999->200/payments.balance_due, staff_portal->200/handoffs.open, unsupported->unsupported_intent, departures_today->unsupported_hint; 0 DB writes. Prior: **Last updated:** 2026-06-03 (**Stage 8.5.9 DONE -- n8n dry-run wired to availability-check**: Updated inactive dry-run workflow Wolfhouse Booking Assistant - Main - Shared Engine Dry Run.json (16 nodes, active:false). Added HTTP - Bot Availability Check node (POST /staff/bot/availability-check) before HTTP - Bot Booking Create. Added IF - Has Enough Beds branch: true path proceeds to booking-create with selected_bed_codes from availability response; false path drafts 'I''m checking with the team' reply, no booking/Stripe/WhatsApp. selected_bed_codes now from \HTTP - Bot Availability Check.first().json.selected_bed_codes -- DEMO-R1-B1 placeholder REMOVED. Code - Parse Booking Fields cleaned: no placeholder, gender_preference forwarded. Happy path: booking-preview -> availability-check -> booking-create (real beds) -> Stripe-link -> draft payment reply. WHATSAPP_DRY_RUN guard retained. No api.stripe.com. No STRIPE_DEFAULT_DEPOSIT_CENTS. No graph.facebook.com. active:false -- not imported/activated. No Azure deploy. No DB writes. verify-luna-n8n-bot-shared-engine-dry-run.js 41/41 PASS. Prior: **Last updated:** 2026-06-03 (**Stage 8.5.8 DONE -- bot availability check endpoint**: POST /staff/bot/availability-check added to staff-query-api.js; requireBotAuth; SELECT-only using getBedCalendarRoomsQuery+getBedCalendarBlocksQuery (half-open overlap, excludes cancelled/expired); room_type filter with room_type_filter_not_strict warning; first-fit selected_bed_codes for guest_count; has_enough_beds/available_count/available_beds/blockers/warnings/next_action; all safety fields preview_only:true + no_write_performed:true + creates_booking/payment/stripe_link/sends_whatsapp:false; verify-staff-bot-availability-api.js 39/39 PASS; local proof: guest_count=2 -> selected_bed_codes length=2 + ready_for_bot_create; guest_count=999 -> not_enough_available_beds + ask_staff_or_alternate_dates; 0 DB writes. n8n dry-run workflow update (next slice). Prior: **Last updated:** 2026-06-02 (**Stage 8.5.7 DONE -- Luna n8n dry-run shared engine wiring**: inactive fork `Wolfhouse Booking Assistant - Main - Shared Engine Dry Run.json` (active:false); WHATSAPP_DRY_RUN guard; three bot endpoints wired (booking-preview, bookings/create, payments/:id/create-stripe-link); X-Luna-Bot-Token from env, never hardcoded; no WhatsApp sends; no api.stripe.com; STRIPE_DEFAULT_DEPOSIT_CENTS NOT used as env ref; deposit_required_cents NOT used; draft payment-link reply from checkout_url via Staff API; original workflow untouched; GAP: selected_bed_codes not in live session state -- DEMO-R1-B1 placeholder, Stage 8.5.8 auto-assign next; verify-luna-n8n-bot-shared-engine-dry-run.js 31/31 PASS; Stage 8.6 Staff Ask Luna via WhatsApp allowlisted staff phones added to PRODUCT-MASTER-ROADMAP.md Pillar 3. Prior: **Last updated:** 2026-06-02 (**Stage 8.5.6 DONE -- Azure staging deploy + hosted bot proof**: image `wh-staff-api:dec785c-stage855-bot-engine` pushed to ACR; deployed to `wh-staging-staff-api` revision `--0000017`; `LUNA_BOT_INTERNAL_TOKEN` generated (40-char hex) + stored in KV + wired as env secret; `BOT_BOOKING_ENABLED=true`, `STRIPE_LINKS_ENABLED=true`, `WHATSAPP_DRY_RUN=true` confirmed; `STAFF_AUTH_REQUIRED=true`, `STRIPE_WEBHOOK_SKIP_VERIFY=false` unchanged; hosted proof A: preview ? 200 + preview_only:true + no_write_performed:true + auth_mode:bot_token + quote.total_cents:25000; hosted proof B: create booking (DEMO-R1-B1) ? 201 + booking_code:MB-WOLFHO-20260801-4f10c3 + payment_id:ec4938e8 + creates_stripe_link:false + sends_whatsapp:false + whatsapp_dry_run:true; hosted proof C: Stripe link ? 200 + checkout_url:https://checkout.stripe.com/c/pay/cs_test_... + payment_status:checkout_created + no_payment_truth_recorded:true + sends_whatsapp:false; safety: wrong token?401, bot token on /staff/ui?302 (not opened), bot token on /staff/manual-bookings/create?401, payments.amount_paid_cents=0, Stripe test mode only; no WhatsApp, no email, no n8n, no workflow activated; test booking MB-WOLFHO-20260801-4f10c3 left on staging (disposable); all 6 verifiers PASS at HEAD dec785c. Prior: **Stage 8.5.5 DONE -- Luna bot Stripe link endpoint**: POST /staff/bot/payments/:payment_id/create-stripe-link added to scripts/staff-query-api.js; BOT_PAYMENT_STRIPE_LINK_RE regex; gates on BOT_BOOKING_ENABLED+STRIPE_LINKS_ENABLED (no STAFF_ACTIONS_ENABLED required); requireBotAuth; reuses same Stripe SDK + UPDATE payments SQL as Stage 8.4.9; source metadata 'bot_stage855'; amount from payments.amount_due_cents (never from body); returns checkout_url+stripe_checkout_session_id+payment_status:checkout_created+next_action:draft_payment_link_reply+sends_whatsapp:false+whatsapp_dry_run:true+no_payment_truth_recorded:true+auth_mode; does NOT mark paid; amount_paid_cents=0; bookings.payment_status unchanged; idempotent; no WhatsApp; no n8n; verify-staff-bot-stripe-link-api.js 56/56 PASS; all other verifiers PASS; local proof: 200+checkout_url; DB checkout_created+amount_paid_cents=0; test booking cleaned up. Prior: **Last updated:** 2026-06-02 (**Stage 8.5.4 DONE) -- Luna bot booking create endpoint**: POST /staff/bot/bookings/create added to scripts/staff-query-api.js; BOT_BOOKING_ENABLED=false default, 403 when false; requireBotAuth token auth; bot token actor uses operator role so buildManualBookingCreateSql role check passes; reuses shared SQL helper + calculateWolfhouseQuote() + BEGIN/COMMIT/ROLLBACK transaction; writes bookings+booking_beds+quote_snapshot+draft payments row; selected_bed_codes required (auto-assign next slice); idempotency key with bot- prefix; returns booking_id, booking_code, payment_id, payment_status:draft, next_action:create_stripe_link, creates_stripe_link:false, sends_whatsapp:false, whatsapp_dry_run:true; no Stripe API calls; no WhatsApp; no n8n; verify-staff-bot-booking-create-api.js 54/54 PASS; all other verifiers PASS; local proof: wrong token->401; BOT_BOOKING_ENABLED=false->403; correct token+enabled+2 beds->201+booking_code+payment_id+next_action:create_stripe_link; test booking cleaned up. Prior: **Last updated:** 2026-06-02 (**Stage 8.5.3 DONE) -- Luna bot internal token auth**: equireBotAuth() added to scripts/staff-query-api.js; separate from equireAuth -- normal staff auth unchanged; supports X-Luna-Bot-Token header + Authorization: Bearer header + session cookie fallback; constant-time comparison via crypto.timingSafeEqual; token path disabled when LUNA_BOT_INTERNAL_TOKEN empty (safe default); wrong token -> 401; uth_mode:bot_token in response; scoped exclusively to /staff/bot/* routes -- /staff/ui, /staff/manual-bookings/create, /staff/stripe/webhook unaffected; LUNA_BOT_INTERNAL_TOKEN from process.env only, not hardcoded; erify-staff-bot-booking-preview-api.js 65/65 PASS (12 new P-series checks); erify-wolfhouse-quote-calculator.js 77/77 PASS; erify-staff-quote-preview-api.js 33/33 PASS; local proof: no token->401; wrong token->401; correct X-Luna-Bot-Token->200+bot_token; Bearer->200+bot_token; /staff/ui->302 login; no DB writes; no Stripe; no WhatsApp; no n8n. Prior: **Last updated:** 2026-06-02 (**Stage 8.5.2 DONE) -- Luna bot booking preview endpoint**: POST /staff/bot/booking-preview added to scripts/staff-query-api.js; no DB writes, no Stripe, no WhatsApp, no n8n; calls calculateWolfhouseQuote() with Luna-parsed fields; detects missing required fields (check_in/check_out/guest_count/package_code/room_type/guest_name/phone/payment_choice); returns missing_fields, next_action (ask_missing_fields/ready_for_create_dry_run/staff_review_required), reply_draft, quote snapshot, availability.status=not_checked; all safety fields preview_only/no_write_performed/creates_booking/creates_payment/creates_stripe_link/sends_whatsapp=false; auth: requireAuth('viewer'); scripts/verify-staff-bot-booking-preview-api.js 53/53 PASS; verify-wolfhouse-quote-calculator.js 77/77 PASS; verify-staff-quote-preview-api.js 33/33 PASS; local proof: missing-fields->ask_missing_fields; Malibu 5n 2 guests->ready_for_create_dry_run+total_cents=45000+deposit=10000; node --check PASS; n8n auth gap documented; no DB writes. Prior: **Stage 8.5.1 DONE ? Luna bot shared engine integration map**: planning/static mapping only; no code; no DB writes; no Azure deploy; no WhatsApp sends; no n8n activation. Static inspection of `n8n/Wolfhouse Booking Assistant  - Main.json`, `n8n/phase2/Wolfhouse - Create Payment Session.json`, `n8n/phase2/Wolfhouse - Stripe Webhook Handler.json`. Key findings: bot currently creates Airtable Hold (not Postgres booking), calls Stripe directly from n8n using Airtable amounts + `STRIPE_DEFAULT_DEPOSIT_CENTS` fallback ? completely bypasses `calculateWolfhouseQuote()` and the shared `payments` row; no `payment_id` in Stripe metadata; 6 large gaps, 1 medium, 2 small identified. No standalone bot parser/session files in `scripts/` ? all bot logic in n8n JSON nodes; session state in Airtable. Integration map complete: [`STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md`](STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md). Smallest next slice: 8.5.2 static verifier of bot payment nodes. Prior: **Stage 8.4.13 DONE ? Azure staging batch deploy + E2E proof**: image `9e5502f-stage8412-manual-booking-mvp` deployed to `wh-staging-staff-api` revision `--0000014` (100% traffic); flags `STAFF_ACTIONS_ENABLED=true`, `MANUAL_BOOKING_ENABLED=true`, `STRIPE_LINKS_ENABLED=true`, `WHATSAPP_DRY_RUN=true` set; test users seeded (`stage7.2c-auth-seed.sql`); KV updated with valid `stripe-secret-key` + `stripe-webhook-secret` (`whsec_QF79KU...`); Stripe test webhook endpoint `we_1TdxY1G36qRefvdPmdvzA0Tm` created for staging URL; E2E: login ? 7-night booking `MB-WOLFHO-20260705-30e9d3` (total=?299, deposit=?200) ? Stripe link `cs_test_a1Mzhctx5` (pm_status=checkout_created) ? signed `checkout.session.completed` webhook fired (HMAC-valid, no SKIP_VERIFY) ? 200 `{"success":true,"payment_status":"deposit_paid","amount_paid_cents":20000}` ? DB: pm_status=paid, pm_paid=20000, paid_at set, bk_payment_status=deposit_paid, balance_due=9900 ? drawer: green "? Deposit paid ?" banner, Total ?299, Paid ?200, Balance ?99, paid_at "2 Jun 2026 21:08", session/intent IDs + checkout URL with copy button ? all 6 assertions PASS. WhatsApp NOT sent; n8n untouched; no confirmation triggered; Stripe test mode only; KV secrets redacted in docs. Next phase: Luna bot uses the same booking/pricing/payment engine. Prior: **Stage 8.4.12 DONE ? Show Stripe payment truth in booking drawer**: `getBookingPaymentsQuery` updated to return `payment_kind`, `currency`, `checkout_url`, `stripe_checkout_session_id` (4 missing fields added); `renderBookingContextDrawer` payment section fully rewritten: green banner for deposit_paid/paid booking statuses; booking totals (total/deposit/paid/balance); per-payment-row card with color-coded border (green=paid, blue=checkout_created); `pmtStatusLabel()` and `bkPayLabel()` helpers for human labels (Draft payment / Checkout link created / Paid ? / Deposit paid ? / Paid in full ? etc.); `payment_kind` label; `paid_at` formatted timestamp; "? waiting for Stripe webhook" banner; truncated session/intent IDs; checkout_url copy button via `bcCopyUrl()`; "No payment record yet" fallback; no Stripe calls, no WhatsApp, no n8n, no DB writes from UI; `verify-staff-bed-calendar-ui.js` 283/283 PASS (23 new checks); DB proof: before=checkout_created+paid_at=null, after webhook=paid+amount_paid=20000+paid_at set+bk_deposit_paid. Prior: **Stage 8.4.11 DONE ? Stripe webhook payment truth**: `POST /staff/stripe/webhook` added to `scripts/staff-query-api.js`; `handleStripeWebhook()` handler; `readBodyRaw()` for Stripe HMAC body; `STRIPE_WEBHOOK_SECRET`+`STRIPE_WEBHOOK_SKIP_VERIFY` env constants; route not session-authed (Stripe identity via HMAC); skip flag for local fixture testing; supports `checkout.session.completed` only ? others 200 ignored:true; payment matched by `metadata.payment_id` ? fallback `stripe_checkout_session_id`; idempotency: already-paid ? 200 idempotent:true, no double-count; payment truth: `status=paid`, `amount_paid_cents`, `paid_at=NOW()`, `stripe_payment_intent_id`, event metadata; booking update: `amount_paid_cents`, `balance_due_cents`, `payment_status` (deposit_paid/paid/waiting_payment); atomic `BEGIN/COMMIT/ROLLBACK`; booking.status NOT changed to confirmed; no WhatsApp, no email, no n8n, no confirmation; `no_whatsapp/no_email/no_n8n/no_confirmation_sent:true` in response; `scripts/verify-staff-stripe-webhook-api.js` 60/60 PASS; local fixture proof: checkout_created?paid, amount_paid=20000?, bk_payment_status=deposit_paid, idempotent repeat PASS, ignore unsupported event PASS. Prior: **Stage 8.4.10 DONE ? Staff Portal create/copy Stripe payment link**: UI: `BC_STRIPE_LINKS` flag embedded server-side; `bcLastPaymentId` state variable; after manual booking create, result panel shows `payment_id`+payment status draft + "Create Stripe Payment Link" button (enabled iff `BC_STRIPE_LINKS+BC_STAFF_ACTIONS+payment_id`); `runCreateStripeLink()` POSTs to `/staff/payments/:id/create-stripe-link` (Staff API, never direct Stripe); `renderStripeLinkResult()` displays checkout_url + "Copy Payment Link" button + webhook warning; clipboard copy via `navigator.clipboard`; idempotent: re-click returns existing URL; booking drawer Payment section shows checkout_url+copy if present; backend: `payment_id` now returned in manual booking create response (RETURNING id added to UPDATE payments); `BC_STRIPE_LINKS=false` ? button disabled/greyed + guidance text; `BC_STRIPE_LINKS=true` ? button enabled; no WhatsApp, no email, no n8n; no amount_paid_cents update; no booking confirmed; 260/260 bed-calendar-ui PASS (23 new checks); all verifiers 475/475 PASS; local proof: session cs_test_a1ShoG?, payment.status=checkout_created, amount_paid=0, booking unchanged; test data cleaned. Prior: **Stage 8.4.9 DONE ? Create Stripe link from draft payment**: `POST /staff/payments/:payment_id/create-stripe-link` added behind `STAFF_ACTIONS_ENABLED+STRIPE_LINKS_ENABLED` (both default false); stripe npm installed; infra/.env loaded as fallback; idempotency check (already checkout_created ? return existing URL); Stripe Checkout Session created in test mode (mode=payment, eur, amount from payments.amount_due_cents, metadata: client_slug/booking_id/payment_id/source=staff_portal_manual_booking); payment.status ? checkout_created; stripe_checkout_session_id+checkout_url+expires_at stored; no amount_paid_cents update; no booking.payment_status update; no confirmation send; no WhatsApp; no n8n; flags=false?403; no key?503; local proof: cs_test_a1XIP?, payment.status=checkout_created, booking.status=confirmed+payment_status=not_requested unchanged, amount_paid_cents=0; 55/55 new verifier PASS; all prior verifiers 452 total PASS. Prior: **Stage 8.4.8 DONE ? Create manual booking with quote + draft payment**: booking-first flow behind flags; calculateWolfhouseQuote() server-side; amounts never from client; quote_snapshot in metadata; draft payment record (status=draft, payment_kind from payment_choice, amount_due=payment_link_amount_cents); UI button gated by BC_STAFF_ACTIONS+BC_MANUAL_BOOKING+bcLastQuote; flags=false?403; local proof 81300? booking created+cleaned; 397/397 checks; no Stripe/migration. Prior: **Stage 8.4.7 DONE ? Add-ons selector**: compact add-ons section in manual booking form; checkboxes for wetsuit/soft-top/hard-board rentals + combos + surf lessons (qty) + yoga (qty); `buildAddOns()` builds payload; combos suppress individual rentals; `bcInitAddOns()` wires checkbox?qty enable/disable; reset clears all; local proof: wetsuit 3d + 2 lessons ? total=32400? (wetsuit_rental=1500, surf_lesson_multi=6000); combo 4d ? 30900? (wetsuit_soft_top_combo=6000); 222/222 PASS; no DB writes. Prior: **Stage 8.4.6 DONE ? Room type selector**: `bk-room-type` select (shared/private/double) added to manual booking form; `runQuotePreview` reads selected room type; private/double includes +?10/person/night supplement line item; reset clears to shared; local proof: shared total=24900?, private total=31900? (room_supplement line item); `verify-staff-bed-calendar-ui.js` 201/201 PASS; no DB writes. Prior: **Stage 8.4.5 DONE ? Quote preview UI + form cleanup**: manual booking form wired to `POST /staff/quote-preview`; package is now a `<select>` dropdown (malibu/uluwatu/waimea/package_none/manual_override); language field removed; multi-bed selection (bcSelectedBeds array, shared date range, per-bed cell highlighting, auto guest count); booking detail panel closes on new selection; "Calculate Quote" button enabled when beds+dates+package+payment_choice present, calls `/staff/quote-preview`, displays itemized line items (per-night/proration, room supplement, add-ons, subtotal, total, deposit, payment link amount, balance, formula summary, warnings); "Create Manual Booking" stays disabled; booking drawer deduplicates assignment rows; `scripts/verify-staff-bed-calendar-ui.js` 194/194 PASS. No DB writes, no Stripe, no booking creation. `MANUAL_BOOKING_ENABLED=false`, `STAFF_ACTIONS_ENABLED=false` unchanged. Local proof: Malibu 7n total=24900? deposit=20000?; Malibu 4n total=16000? deposit=10000?. Prior: **Stage 8.4.4 DONE ? Wolfhouse quote preview endpoint**: `POST /staff/quote-preview` added to `scripts/staff-query-api.js`; `scripts/verify-staff-quote-preview-api.js` 33/33 PASS. Auth-gated (viewer+), no DB reads/writes, no Stripe, calls `calculateWolfhouseQuote()`. Returns `preview_only:true`, `no_write_performed:true`, `creates_booking/payment/stripe_link:false`. Local proof PASS: Malibu 7n total=24900? deposit=20000?, Malibu 4n total=16000? deposit=10000?. `MANUAL_BOOKING_ENABLED=false`, `STAFF_ACTIONS_ENABLED=false` unchanged. Prior: **Stage 8.4.3 DONE** ? `scripts/lib/wolfhouse-quote-calculator.js` 77/77 PASS. Prior: **Stage 8.4.2 DONE** ? `config/clients/wolfhouse-somo.pricing.json` 63/63 PASS. Prior: **Stage 8.4.1 DONE** ? Wolfhouse pricing/payment config plan Manual booking creation split into gated slices; a pricing/payment engine is now a hard prerequisite. A provisional `POST /staff/manual-bookings/create` stub exists DISABLED-by-default ? `MANUAL_BOOKING_ENABLED=false` ? 403 ? and is NOT wired to the UI; Create button stays disabled. No Stripe/invoice/payment-link/WhatsApp/n8n. Flags unchanged: `STAFF_ACTIONS_ENABLED=false`, `MANUAL_BOOKING_ENABLED=false`. Verifiers: create-api 41/41, bed-calendar-ui 167/167, preview-api PASS. Doc: STAGE-8.4-MANUAL-BOOKING-CREATION.md. Prior: **Stage 8.3v DONE** ??? Azure deploy of 8.3u UI corrections. Image: wh-staff-api:ea2437d-8x3v-ui-corrections (ACR cbc). Revision: --0000013 (100% traffic, Healthy, Write actions DISABLED). Smoke: /staff/login 200; auth-guard active; STAGING+SHADOW MODE+STAFF ACTIONS DISABLED badges confirmed. Source: Tour Operator tab (data-tab=tour-operator), to-op-panel, to-rr-panel present; demo chip absent; bc-op-panel absent from Bed Cal; td.dataset.date fix present. STAFF_ACTIONS_ENABLED=false; MANUAL_BOOKING_ENABLED=false; WHATSAPP_DRY_RUN=true; n8n untouched; no DB writes.)
<!-- prior 7.7: Stage 7.7 amendment ? inline staff reply made explicit hard requirement ? DONE (11b09ce) -->
<!-- prior 7.3b: Azure IaC scaffold PASS ? Bicep + parameters + runbook in infra/azure/staging/; 57-check verifier PASS; no Azure resources. prior 7.3c: deployment preflight PASS ? scaffold validated, what-if ready, Phase A?M plan, 26-check verifier PASS; no Azure resources. prior 7.3d: Azure staging deployed + login proven ? Staff API + n8n live, Ty login confirmed, 11 workflows imported inactive, safety flags confirmed. prior 7.2c: auth middleware scaffold PASS. -->
<!-- prior 7.6: pilot readiness go/no-go checklist DONE (was 79 gates, now 81 with F-section expansion, 11 sections, 5 phases, NO_GO). -->
<!-- prior 7.5: monitoring + alerting plan DONE (7 categories; P0?P3 model; Azure Monitor + email; 10 runbooks; 8 health checks). -->
<!-- prior 7.4: backup/restore + rollback plan DONE (app/n8n DB policy; restore drill; 9 migration rollbacks; emergency toggles; incident runbook). -->
<!-- prior 7.3: staging deployment + TLS design DONE (Azure Container Apps, Key Vault, HTTPS topology). prior 7.2: auth/staff-accounts design DONE (email/password + session cookies, viewer/operator/admin matrix). -->
<!-- prior 7.2: **Stage 7.2 auth/staff-accounts design DONE** ? production auth model designed: per-user staff accounts (email/password + secure session cookies) for staging/pilot; operator token confirmed local/dev only; viewer/operator/admin roles + permission matrix; session/CSRF model; migration 009 schema designed (not created); go/no-go hard blocks; Wolfhouse pilot staff model (Cami admin+operator, Ale admin+owner). Doc: [PHASE-7.2-AUTH-STAFF-ACCOUNTS-PLAN.md](PHASE-7.2-AUTH-STAFF-ACCOUNTS-PLAN.md). No implementation; auth NOT built; staging/prod NOT secure.) -->
**HEAD (expected):** `f7813d3` (Stage 6 closeout) ? pending commit (Stage 7.0 planning)

**Roadmap:** [ROADMAP.md](ROADMAP.md) (stages 3?7, 3x guardrails) ? **Architecture:** [ARCHITECTURE-NORTH-STAR.md](ARCHITECTURE-NORTH-STAR.md) ? **Agent:** [CURSOR.md](../CURSOR.md)

**Quality bar:** Stage 3 ? CLOSED. Stage 3.5 ? CLOSED (d08c64e). Stage 3y ? Mode A gate 5 all 10 PASS (Y-X13 decision: fbd6fbc). **Stage 4 ? Autonomous Booking Dry-Run runtime gate 2 PASS (2026-05-30):** A1 all 3 turns executed. T1: route=booking_flow, hold stub pg_ok=true, draft captured. T2: route=payment_or_confirm_intent (conf=0.95), asked for name/email. T3: route=payment_details_provided, IF Booking ID Ready TRUE, Ensure Booking stub executed, CPS dry-run fired, checkout_url=https://checkout.stripe.test/dry-run/dry-ensure, draft reply includes URL. No DB mutations across all 3 turns (bookings/payments/payment_events/booking_beds all unchanged). payment_link_stub RUNTIME PROVEN.

---

## Product

**Wolfhouse Booking Assistant** ? client #1 (**beachhead**) for the broader product category: **AI booking operations for WhatsApp-first experience businesses** (AI front desk for WhatsApp-heavy experience operators).

**Wolfhouse scope today:** surf house ? availability, holds, Stripe, confirmations, bed assignment, reassign, cancel, manual entries, operator room release.

**Product direction:** Same engine + `client_config` should eventually serve adjacent verticals (surf schools, rental shops, tour operators, etc.) without re-architecting ? see [ROADMAP.md ? Client category](ROADMAP.md#client-category--market-positioning).

**Quality bar today:** Stage 3 ? correct and safe. See [ROADMAP.md ? Stage 3](ROADMAP.md#stage-3--correct-and-safe).

**Architecture direction:** n8n orchestrates; backend/code decides; Postgres remembers; client config controls; staff UI manages (later). Do not grow business logic indefinitely inside n8n ? Stage 3x defines specs; Stage 5 migrates logic to `src/booking-assistant/`.

**Staff operations ? explicit roadmap requirement (added 2026-05-30):** The product has two sides: (1) the guest-facing WhatsApp assistant (built in Stages 3?4) and (2) a staff-facing operations assistant + admin layer (Stage 6). Stage 4/5 must preserve data in structured Postgres records so Stage 6 staff queries are answered from reliable source-of-truth, not chat logs. Key tables needed before Stage 6: `add_on_orders`, `add_on_items`, `lesson_requests`, `rental_requests`, `yoga_requests`, `staff_handoffs`, and a `payment_balances` view. Stage 6 is not started. No implementation performed for the staff assistant layer. Detail: [ROADMAP.md Stage 6](ROADMAP.md#stage-6--beautiful-staff--admin-layer) ? [ROADMAP.md Stage 5 staff-queryable data](ROADMAP.md#staff-queryable-operational-data-stage-5-requirement).

---

## Stage snapshot (product roadmap)

| Stage | Status | Notes |
|-------|--------|--------|
| **3** Correct and safe | **CLOSED ? local safety bar** (2026-05-29) | 3e.5 wrong-booking CLOSED (L1+L2, L3 deferred); 3e.6 idempotency CLOSED (I1+I4+I6 PASS; I2/I3/I5 deferred to Stage 3.5/cutover). Caveats: real WhatsApp, Airtable-coupled L3, Stripe/payment gates remain deferred. |
| **3.5** Safety rails | **CLOSED ? minimum safety bar MET (d08c64e)** | [PHASE-3.5-SAFETY-RAILS-PLAN.md](PHASE-3.5-SAFETY-RAILS-PLAN.md). 3.5a ACCEPTED. 3.5b Gap 2 runtime PASS (exec 1089). 3.5e success-path logging runtime PASS. 3.5c/I3 runtime PASS (execs 1093/1094). 3.5d D1+D2+D3 L2 PASS + wire-in static PASS; D8 runtime BLOCKED/deferred (Airtable-coupled upstream). 3.5f I3 PASS + I2/I5 deferred with written reason. 3.5g closeout G1?G13 DONE. Deferrals: D6/D8/D9/I2/I5 runtime ? Airtable cutover; Gap 1/Gap 3 runtime ? Stage 4; 3.5d.8b PG-only trigger path ? NOT REQUIRED before Stage 3y. **Next: Stage 3.5 closeout commit (user approves), then Stage 3y shadow/co-pilot planning.** |
| **3x** Bot knowledge + guardrails | **3x.1 planning complete (docs)** | Master spec [STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md); execution 3x.2?3x.4 pending |
| **3y** Shadow / co-pilot | **MODE A GATE 5 ALL 10 PASS ? closeout decision made (2026-05-30)** | [PHASE-3y-SHADOW-COPILOT-PLAN.md](PHASE-3y-SHADOW-COPILOT-PLAN.md). All 10 payloads offline-safe PASS. 69 dry-run gates, zero mutations. Y-X13 decision: proceed to Stage 4. Mode B/C/D deferred (non-blocking parallel work). Next: Stage 4 Autonomous Booking Dry-Run. |
| **4** Reliable | **CLOSE WITH DEFERRALS ? Autonomous Booking Dry-Run complete (2026-05-30, commit 6cd9a21)** | All 14 runtime scenarios PASS (A1?A10, A9, IT-1/2/3, DE-1). Full dry-run booking path, payment webhook sim, confirmation draft, closed-month guard, multi-turn PG state, add-on pricing, multilingual baseline proven. Protected tables ?=0 across all gates. **Deferrals:** real WhatsApp, live holds/Stripe/confirmation writes, structured add-on DB records (Stage 5), staff assistant (Stage 6), Airtable cutover, extensive multilingual polish. **Next: Stage 5 ? source-of-truth cleanup + pilot readiness.** |

| **5** Clean | **CLOSE WITH DEFERRALS** (`ae545a2`, 2026-05-31). SoT cleanup track (5.1?5.8b): all staff-queryable schemas stubbed; **migrations 007+008 applied to local/dev DB**; fixture smoke 26/26 PASS; `hostel_id?client_id` bugfix in reconciliation query. **Stage 5.9b PASS**: Luna staff handoff write path wired; `Postgres - Open Staff Handoff` proved; idempotency confirmed (de6c3c0). | Targeted SoT cleanup for Wolfhouse pilot readiness. Plan: [PHASE-5-SOURCE-OF-TRUTH-CLEANUP.md](PHASE-5-SOURCE-OF-TRUTH-CLEANUP.md). |
| **6** Beautiful | **CLOSED WITH DEFERRALS** (2026-05-31). 6.0 plan DONE ? 6.1 registry DONE ? 6.2 CLI runner DONE ? 6.3 handoffs DONE ? 6.4a payments DONE ? 6.4b rooming DONE ? 6.4c addons DONE ? **6.4d digest DONE** ? 6.4d digest DONE ? **6.5a proposal DONE** ? **6.5b confirmed write DONE** ? **6.7 smoke PASS** ? **6.6 HTTP API DONE** ? **6.8 UI DONE**. All exit criteria MET. Production auth/TLS/live-ops deferred to Stage 7. Local/dev only. | Staff/admin assistant. Plan: [PHASE-6-STAFF-ASSISTANT-PLAN.md](PHASE-6-STAFF-ASSISTANT-PLAN.md). |
| **7** Scalable | **IN PROGRESS** (2026-06-02) ? 7.0?7.7 DESIGN DONE. **7.2b/c DONE** ? **7.3b DONE** ? **7.3c PREFLIGHT PASS** ? **7.3d AZURE STAGING DEPLOYED + LOGIN PROVEN (2026-06-01)** ? **7.3e LOGIN PAGE + LOGOUT FIX + COMPANY WORDING (2026-06-02)** ? **7.3f CUSTOM DOMAIN + TLS DONE (2026-06-02)** ? **7.7a?d + 7.7f?7.7j DONE** ? **7.7k1?k8 DONE**. **7.3f**: `staff-staging.lunafrontdesk.com` bound; Azure managed cert; smoke PASS on clean URL. Calendar editing NOT approved. Next: Stage 8.0 client-ready staging roadmap (DONE) ? 8.1 dashboard UX cleanup plan. Plan: [PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md](PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md). | Multi-client + Azure when approved |
| **8** Client-ready staging | **IN PROGRESS ? 8.0/8.1/8.2/8.5/8.6 + 8.3 plan DONE (2026-06-02)**. 8.6: 18 demo rows seeded (proof 28/28 PASS). 8.3: Staff Portal bed calendar operations plan (sub-slices 8.3a?8.3o); read-only cleanup (a) + drawer cleanup (b) = only demo prerequisites; manual booking / move / cancel / operator block / operator release = future gated writes for spreadsheet replacement. `STAFF_ACTIONS_ENABLED=false`, `WHATSAPP_DRY_RUN=true`. | [STAGE-8-CLIENT-READY-STAGING-ROADMAP.md](STAGE-8-CLIENT-READY-STAGING-ROADMAP.md) ? [STAGE-8.3-STAFF-PORTAL-BED-CALENDAR-OPERATIONS-PLAN.md](STAGE-8.3-STAFF-PORTAL-BED-CALENDAR-OPERATIONS-PLAN.md). Next: 8.3a bed calendar read-only cleanup impl. Pilot NO_GO. | Show-to-client only after ?5 checklist passes |

---

## Environments

| Environment | Role | Rule |
|-------------|------|------|
| **Hosted prototype** | Airtable + n8n Cloud (`tywoods.app.n8n.cloud`) | **Do not change** while building here |
| **This repo (local)** | Postgres + Docker n8n + generated `n8n/phase2/` forks | All new implementation; dummy data OK |

---

## Completed major phases

### Phase 2 local (frozen)

Stripe test path, Main (local Stripe) fork, Send Confirmation (local), Booking Flow Router hardening. Signed off ? [`PHASE-2-FREEZE.md`](PHASE-2-FREEZE.md).

### Phase 3b (frozen)

| Area | Sign-off | Key commit (examples) |
|------|----------|------------------------|
| Cancel / Assign / Reassign | 2026-05-26 | 3b.1?3b.3 runbooks |
| Manual Entries local fork | 2026-05-27 | `8aa74b9` |
| Operator Room Release MVP | 2026-05-27 | `de26bd4` |

Details: [`PHASE-3b-FREEZE.md`](PHASE-3b-FREEZE.md).

### Phase 3c + 3d (frozen)

Formal checkpoint: **[`PHASE-3c-3d-FREEZE.md`](PHASE-3c-3d-FREEZE.md)** ? 3c stub path + 3d real Stripe / webhook / Send Confirmation dry-run. **Do not** reuse evidence bookings without reset. Phase **3e.3+** rooming work continues after freeze commit.

### Phase 3c (closed scope) ? Main / Postgres local + stub

| Substep | Status | Commit (if applicable) |
|---------|--------|-------------------------|
| **3c** proposal | Done | `2cd7ede` |
| **3c.a** Main workflow inventory | Done | `0b4bd8e` |
| **3c.b** PG availability report (SELECT-only) | Done | `32315db` |
| **3c.c.1** Hold read-only plan | Done | `1a8ebba` |
| **3c.c.2** Active-hold guard fixture | Done | `0741a9f` |
| **3c.c.3** Hold execute CLI | Done | `50294d3` |
| **3c.c.4** Ensure Booking promote CLI | Done | `8abfd4d` |
| **3c.d** Conversation / `current_hold` plan | **Proposal done** ? [`PHASE-3c-d-PROPOSAL.md`](PHASE-3c-d-PROPOSAL.md) | docs only |
| **3c.e.1** Build target map + neutralize + `--verify-targets` | **Done** (uncommitted) | ? |
| **3c.e.2** Ensure promote SQL in Main fork | Done | `c89890a` |
| **3c.e.3** PG availability gate in Main fork | Done | `5bdd465` |
| **3c.e.4** PG hold + AT backfill in Main fork | Done | `881ab1b` |
| **3c.e.5** PG conversation upsert | **Done** (uncommitted) | ? |
| **3c.f** Payment / confirmation contract checks | **Review complete (3c.f.4)** ? local-stub payment-details path signed off; real Stripe path still pending | [`PHASE-3c-f.md`](PHASE-3c-f.md) |
| **3c.g** E2E local Main tests | **3c.g.2l success** ? fresh E2E `booking_flow -> payment_details_provided` local stub path proven | [`PHASE-3c-g.md`](PHASE-3c-g.md) |

**Phase 3c local Main+PG+stub scope is complete.** The proven boundary is: fresh `booking_flow` hold creation and fresh `payment_details_provided` promotion/link-update path with local stub callback and no forbidden side effects.

Runbooks: [`PHASE-3c-PROPOSAL.md`](PHASE-3c-PROPOSAL.md), [`PHASE-3c-a.md`](PHASE-3c-a.md), [`PHASE-3c-b.md`](PHASE-3c-b.md), [`PHASE-3c-c.md`](PHASE-3c-c.md), [`PHASE-3c-f.md`](PHASE-3c-f.md), [`PHASE-3c-g.md`](PHASE-3c-g.md).

### 3c.f latest runtime evidence (3c.f.3af)

- Main execution `1009` succeeded on `payment_details_provided`.
- Stub execution `1010` succeeded; checkout URL returned from `example.test`.
- Ensure resolved target booking idempotently (`action=refreshed`) for `WH-260528-1493`.
- No legacy Create Payment Session execution, no Stripe call, no `payments`/`payment_events` writes, no `booking_beds` writes.
- Booking remained safe: `payment_pending/waiting_payment`, `send_confirmation=false`, `confirmation_sent_at=NULL`.
- Queue-mode callback URL requirement: use `http://n8n:5678/webhook/create-payment-session-stub-local` (worker-reachable), not `localhost`/`127.0.0.1`.

### 3c.f.4 sign-off posture

- **Go:** continue 3c.g runtime coverage and broader local integration tests.
- **No-go (still pending):** real Stripe production path and real Stripe webhook-confirmation chain.
- Key residuals tracked in [`PHASE-3c-f.md`](PHASE-3c-f.md):
  - queue-mode callback URL dependency (`http://n8n:5678/...`);
  - Airtable still in payment path;
  - hosted reassign URL ? **remapped** in 3e.2 (`8dfa450`);
  - prepare-context blank `booking_code` mitigated by Ensure Airtable-record fallback.

### 3c.g.2l fresh E2E evidence (latest)

- POST #2 runtime success with Main execution `1036` and stub execution `1037`.
- Resolver route correctness: `resolved_route=payment_details_provided`, override decision `R2F_PAYMENT_DETAILS_PRIORITY_ON_CONTACT_AND_LINK_FROM_HANDOFF`.
- Correct hold selection and update:
  - Search Hold selected fresh Airtable record `rec4VXB7Rf1VxDr0C` (not old `recIP3DFb0nCx8gBh`).
  - Ensure promoted target booking `WH-260528-9437` to `payment_pending/waiting_payment`.
  - Stub returned `https://example.test/...` checkout URL and payment link write targeted fresh record only.
- Safety maintained:
  - no legacy Create Payment Session execution;
  - no Stripe call;
  - `payments/payment_events` unchanged globally (`23/3`) and unchanged for target booking (`0/0`);
  - no `booking_beds` writes;
  - no Send Confirmation side effect;
  - Main/stub/legacy workflows returned inactive.

### Phase 3d (in progress) ? isolated Stripe path + integrated Main?pay?webhook?dry-run confirm complete

| Substep | Status | Notes |
|---------|--------|-------|
| **3d.1** Isolated Stripe planning gate | Done | [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md) |
| **3d.2** Stripe contract static checker | Done | `npm run db:report:stripe-contract` |
| **3d.3** Direct CPS test plan | Done | docs-only |
| **3d.4a** Preflight blockers cleared | Done | deactivate webhook/confirmation; CPS target `esuDIT96iPT63OaQ`; local cancel URL |
| **3d.4b** `.env.example` local cancel URL | Done | `fb6ceb9` |
| **3d.4** Direct isolated Create Payment Session | **PASS** | execution **1050**; booking `WH-260528-1493`; `cs_test_...` session; no webhook/confirmation/Main side effects |
| **3d.5** Stripe Webhook Handler isolated plan | Done | [`PHASE-3d-STRIPE-ISOLATED-PLAN.md`](PHASE-3d-STRIPE-ISOLATED-PLAN.md) ?3d.5 |
| **3d.5a** Webhook preflight + schedule isolation | **Done** | read-only checks; n8n DB schedule disable (local only) ? ?3d.5a |
| **3d.5b** Isolated webhook runtime | **PASS** | execution **1058**; `evt_test_phase3d5b_001`; booking `WH-260528-1493` payment truth; no confirmation/WhatsApp |
| **3d.6a** Send Confirmation preflight | **Done** | read-only; Option B direct webhook |
| **3d.6b** Send Confirmation runtime (1st) | Safe / functional FAIL | exec **1059**; Airtable Conversation 0 rows stopped chain |
| **3d.6c** Postgres credential / SQL verify | **Done** | no runtime; credential name alignment |
| **3d.6d** Airtable-empty fallback patch | **Done** | `324c104`; `alwaysOutputData` on Conversation + Booking Beds |
| **3d.6e** Send Confirmation runtime retry | **PASS** | exec **1061**; dry-run WhatsApp ? `confirmed`; schedule still disabled |
| **3d.7a** Main-integrated preflight + real CPS env | **Done** | `N8N_CREATE_PAYMENT_SESSION_URL` ? real CPS; container recreate; static reports PASS |
| **3d.7b** (1st) Main two-POST E2E (real CPS) | **FAIL** (safe) | exec **1062**; typing indicator #131009 on phase test wamid; no data mutations |
| **3d.7c** Main typing guard for phase test wamids | **Done** | `e620822`; regex `^wamid\.PHASE[0-9A-Z]+` |
| **3d.7b** (retry) Main two-POST E2E (real CPS) | **PASS** | Main **1063**/**1064**; CPS **1065**; booking `WH-260528-5369`; stop at checkout URL |
| **3d.8a** Pay + webhook preflight | **Done** | read-only; session open; Option B plan |
| **3d.8b-pay** Manual Stripe Checkout pay | **PASS** | session complete/paid; `pi_3Tc9egG36qRefvdP0oNvU2VT` |
| **3d.8b-webhook (crafted POST)** | **Not run** | hard stop ? DB already post-webhook |
| **3d.8b** Paid Checkout + webhook truth | **PASS** | organic Stripe delivery; execs **1066?1076**; `evt_1Tc9eh?`; not `evt_test_phase3d8b_001` |
| **3d.9a** Integrated Send Confirmation preflight | **Done** | read-only; `WH-260528-5369` eligible |
| **3d.9b** Integrated Send Confirmation dry-run | **PASS** | exec **1077**; webhook + `booking_id` filter; schedule disabled |

**3d.4 evidence (summary):** Direct POST to `create-payment-session` with only `esuDIT96iPT63OaQ` active. Booking `33ac2766-537c-4b95-85d4-91c01c862beb` moved `waiting_payment` ? `payment_link_sent`; one `payments` row created (`10ad0f21-0aa4-42c9-9adb-571a82f91698`); global `payment_events` unchanged; `send_confirmation` false; not confirmed; `booking_beds` 0.

**3d.5a (summary):** `db:report:stripe-contract` + `--verify-targets` PASS. `active=false` on Send Confirmation did **not** stop 3?min schedule (1055?1057). Fix: schedule node `disabled=true` in n8n DB.

**3d.5b evidence (summary):** One POST to `stripe-webhook` with only `KZUQvwR6SPWpvaZ5` active (`STRIPE_WEBHOOK_SKIP_VERIFY=true`). Payment `10ad0f21-?` ? `paid`; `payment_events` 3?4; booking `payment_link_sent`?`deposit_paid`; `send_confirmation` true; `status` still `payment_pending`; `confirmation_sent_at` NULL. Send Confirmation max exec **1057**; Main **1036**; CPS **1050**; `booking_beds` 0.

**3d.6 evidence (summary):** One POST to `send-confirmation-local` with only `gxivKRJexzTCw9x6` active after **publish + n8n restart** (`WHATSAPP_DRY_RUN=true`). Exec **1061**: 0 Airtable conversation/bed rows continued via 3d.6d patch; `whatsapp_sent=true`, `dry_run=true`; booking `WH-260528-1493` ? `confirmed`, `send_confirmation=false`, `confirmation_sent_at` set; `payment_status` stayed `deposit_paid`; global `payment_events` **4**; `booking_beds` **0**; webhook/Main/CPS max execs unchanged. **Do not** reuse this booking for another isolated gate without reset.

**3d.7b evidence (summary):** Fresh two-POST E2E via `booking-assistant` with only Main `RBfGNtVgrAkvhBHJ` + real CPS `esuDIT96iPT63OaQ` active; phone `+353399990330`; wamids `PHASE3D7B.001` / `.002`. POST #1 exec **1063**: hold `WH-260528-5369`, conversation + Airtable `recJLWBVonS7UEG3t`, no payment writes. POST #2 exec **1064** + CPS **1065**: `payment_pending` / `payment_link_sent`; Stripe `cs_test_a1izqISOeaPkavMYxmDJmJJHLxKunHC0CKi1HpQ5U4G8feWqnvVj6wps6O`; payment `389a5fdd-daa7-4bc1-a5e0-2bf105a5f471`; `payments` 24?25; `payment_events` unchanged; not confirmed; webhook/Send Confirmation/stub did not run.

**3d.8b evidence (summary):** User manually paid Main-created Checkout (full URL with `#` fragment). Stripe session **complete/paid**; `payment_intent=pi_3Tc9egG36qRefvdP0oNvU2VT`. **Organic** Stripe webhook delivery updated PG (~19:31:48?19:31:51 UTC): Webhook Handler execs **1066?1076** (burst; max **1076**); one `payment_events` row `evt_1Tc9ehG36qRefvdPg9mXYrcr`; payment `389a5fdd-?` ? **paid** (20000 cents); global `payment_events` 4?5; booking `deposit_paid`, `send_confirmation=true`, not confirmed, `booking_beds=0`. Crafted `evt_test_phase3d8b_001` **not sent** (correct hard stop). Send Confirmation max **1061**; Main **1064**; CPS **1065**. **Operational note:** future pay-only windows must either include webhook delivery in scope or disable Stripe forward to local `stripe-webhook`. **Do not** pay again or POST crafted event.

**3d.9b evidence (summary):** One POST to `send-confirmation-local` with only `gxivKRJexzTCw9x6` active after **publish + n8n restart** (`WHATSAPP_DRY_RUN=true`); schedule **`disabled: true`**. Exec **1077**: full chain through dry-run WhatsApp ? Mark Confirmed; `whatsapp_sent=true`, `dry_run=true`, `to=+353399990330`; Airtable Conversation/Beds `alwaysOutputData` with 0 beds; booking `WH-260528-5369` ? **`confirmed`**, `send_confirmation=false`, `confirmation_sent_at` set; `payment_status` stayed `deposit_paid`; global `payment_events` **5**; target **1**; `booking_beds` **0**; Webhook/Main/CPS/stub max execs unchanged. **Do not** reuse this booking without reset.

**Integrated chain on `WH-260528-5369` ? PROVEN (dry-run confirmation):**

| Gate | Execution / delivery | Booking state after |
|------|----------------------|---------------------|
| 3d.7b Main + CPS | **1063** / **1064** / **1065** | `payment_link_sent` |
| 3d.8b Pay + webhook | manual pay + organic Stripe | `deposit_paid`, `send_confirmation=true` |
| 3d.9b Send Confirmation | webhook exec **1077** | **`confirmed`**, dry-run WhatsApp only |

**Isolated Stripe chain on `WH-260528-1493`:**

| Gate | Execution | Booking state after |
|------|-----------|---------------------|
| 3d.4 CPS | 1050 | `payment_link_sent`, payment `checkout_created` |
| 3d.5b Webhook | 1058 | `deposit_paid`, `send_confirmation=true`, not confirmed |
| **3d.6 Send Confirmation** | **1061** | **`confirmed`**, `confirmation_sent_at` set, dry-run WhatsApp |

**Local gate state (after 3d.6):**

| Workflow | Id | Active | Notes |
|----------|-----|--------|--------|
| Stripe Webhook Handler | `KZUQvwR6SPWpvaZ5` | false | |
| Send Confirmation (local) | `gxivKRJexzTCw9x6` | false | schedule **disabled**; unpublished after 3d.6e |
| Create Payment Session | `esuDIT96iPT63OaQ` | false | |
| CPS stub | `whCreatePaymentStubLocal01` | false | |
| Main (local Stripe) | `RBfGNtVgrAkvhBHJ` | false | |
| Stripe Checkout Success | `kipSFRdsnXfTPLUc` | false | |

**3d.6 signed off (dry-run):** isolated Send Confirmation via direct webhook + `booking_id` filter. **Not** signed off: real WhatsApp send, schedule-poll trigger mode, integrated Main?Stripe?webhook?confirmation in one run.

**3d.7 signed off (payment-link only):** Main-integrated `booking_flow` ? `payment_details_provided` ? real CPS; stop at Stripe test checkout URL.

**3d.8 signed off (pay + webhook truth):** Manual Checkout pay + **organic** Stripe webhook on `WH-260528-5369` (not crafted skip-verify POST).

**3d.9 signed off (integrated dry-run confirmation):** Send Confirmation on `WH-260528-5369` after 3d.8b ? direct webhook + `booking_id` filter; `WHATSAPP_DRY_RUN=true`; exec **1077**. Completes integrated chain **3d.7b ? 3d.8b ? 3d.9b** (separate windows). **Not** signed off: real WhatsApp send; schedule-poll mode; single-window E2E.

**Integrated Stripe + confirmation dry-run chain:** **PROVEN** on `WH-260528-5369` (Main real CPS ? manual pay ? organic webhook ? dry-run confirm).

**Disposable bookings (do not reuse without reset):**

| Booking | Phone | Terminal / notes |
|---------|-------|------------------|
| `WH-260528-1493` | `+353399990329` | `confirmed` after 3d.6 ? full **isolated** chain |
| `WH-260528-5369` | `+353399990330` | `confirmed` after 3d.9b ? full **integrated** dry-run chain |
| `WH-260528-9437` | (3c.g) | stub path `waiting_payment` |

Remaining exclusions (still separate):
- Real WhatsApp send (`WHATSAPP_DRY_RUN` was true for 3d.6 and 3d.9b)
- Send Confirmation **schedule poll** mode (schedule node still disabled)
- Single-window integrated E2E (all steps in one run)
- Rooming/reassign E2E ? **3e.4 complete** (3e.4b retry PASS `WH-260528-5322`, beds R3-B1/R3-B2) ? see [`PHASE-3e-ROOMING-REASSIGN-PLAN.md`](PHASE-3e-ROOMING-REASSIGN-PLAN.md) ?13.7
- **3e.5 negative/wrong-booking guard tests CLOSED for Stage 3:** L1 static/unit PASS (25/25 resolver), L2 fixture+report PASS (T1?T3, T5?T7), Gate A preflight PASS. L3 runtime (Gates B/C) BLOCKED before activation ? current local forks perform booking lookup via Airtable before Postgres operations; PG-only fixtures are not faithful. No workflows activated, no POSTs made, no data mutated for B/C. L3 deferred to Postgres source-of-truth cutover. See ?15.6??15.7.
- Airtable-removal/cleanup-refactor work

---

## Phase 3c.c deliverables (hold + ensure)

### Hold path

| Artifact | Purpose |
|----------|---------|
| `scripts/lib/main-booking-hold-pg-sql.js` | Guards + hold upsert SQL |
| `scripts/lib/main-booking-hold-plan.js` | Read-only plan |
| `scripts/report-main-hold-plan.js` | `db:report:main-hold-plan` |
| `scripts/main-booking-hold-postgres.js` | `db:main-hold:postgres` (dry-run default; `--execute`) |
| Fixtures `main-hold-3cc-*` | Active-hold guard, exec cleanup |

Hold execute: `status=hold`, `payment_status=not_requested`, no `booking_beds`, no payments.

### Ensure Booking promote (3c.c.4)

| Artifact | Purpose |
|----------|---------|
| `scripts/lib/main-ensure-booking-pg-sql.js` | Promote / insert / block SQL |
| `scripts/lib/main-ensure-booking-plan.js` | Read-only plan |
| `scripts/report-main-ensure-booking-plan.js` | `db:report:main-ensure-booking-plan` |
| `scripts/main-ensure-booking-postgres.js` | `db:main-ensure-booking:postgres` |
| Fixtures `main-ensure-3cc-promote-*` | Blocked confirmed row, cleanup |

Verified on `8abfd4d`: hold ? promote same `booking_id`; idempotent refresh; missing code inserts; confirmed blocked (exit 2); no beds/payments; cleanup `WH-3C-PROMOTE-*`.

**Workflow wiring deferred to 3c.e** ? shared SQL exists; `build-main-local-stripe.js` and generated Main JSON not updated yet.

### Availability (3c.b)

`scripts/lib/main-availability-pg-sql.js`, `scripts/report-main-availability.js` ? `db:report:main-availability` (SELECT-only).

---

## Main workflow context (do not run casually)

| Item | Detail |
|------|--------|
| Target fork | `n8n/phase2/Wolfhouse Booking Assistant - Main (local Stripe).json` |
| Build script | `scripts/build-main-local-stripe.js` |
| Hosted export (read-only) | `n8n/Wolfhouse Booking Assistant - Main.json` |
| Scale | ~189 nodes, ~64 Airtable, **1** Postgres node today |
| Risks | Rooming E2E not run; activate bed-ops only in gated 3e.4 window |

**Do not run Main locally** until `--verify-targets` passes and testing is explicitly approved.

**3c.e.1:** `node scripts/build-main-local-stripe.js --verify-targets` ? runbook [`PHASE-3c-e.md`](PHASE-3c-e.md). Regenerate sets `active=false` and test Airtable base on fork.

**Ensure gap (why 3c.c.4 existed):** Old Ensure only INSERTs when missing; after 3c.c.3 a PG `hold` row would be returned unchanged. Promote SQL fixes that before 3c.e wires it into the fork.

---

## Stage 3x (bot knowledge + guardrails)

| Sub-phase | Status | Artifact |
|-----------|--------|----------|
| **3x.1** Full planning roadmap | **Done** | [STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md) ?3x.1?3x.11 + exit criteria |
| **3x.1b** Customer memory + WhatsApp migration | **Done** | Same doc ?3x.5; three-layer model *(no import/DB yet)* |
| **3x.2b** Minimum Business Logic Baseline + Stage 4 entry gate | **Done** (2026-05-29) | [config/clients/wolfhouse-somo.baseline.json](../config/clients/wolfhouse-somo.baseline.json) |
| **3x.2c** Applied owner/user P1 answers ? baseline v0.2 + handoff/add-on plans | **Done** (2026-05-29) | baseline v0.2 ? [STAFF-HANDOFF-PLAN.md](STAFF-HANDOFF-PLAN.md) ? [DURING-STAY-ADDONS-PLAN.md](DURING-STAY-ADDONS-PLAN.md) ? [STAFF-QUERY-ASSISTANT-PLAN.md](STAFF-QUERY-ASSISTANT-PLAN.md) |
| **3x.2d** Working prices + policies ? baseline v0.3 (PROVISIONAL pricing) | **Done** (2026-05-29) | deposit ?200 ? 2026 package table ? proration ? derived add-ons ? check-in/out ? WhatsApp handoff ? `pricing_policy` guard |
| **3x.2** Ale/Cami **confirm** provisional prices + fill gaps ? confirmed config | In progress | [knowledge/wolfhouse-somo-gaps.md](knowledge/wolfhouse-somo-gaps.md) ? remaining items |
| **3x.3** WhatsApp mining + golden + customer extract | Planned | Layer 1 off-repo; Layer 2/3 outputs; staff review queue |
| **3x.4** Golden runner (Stage 4 prep) | Planned | 	est:golden-messages stub |

**In scope for Stage 3x:** WhatsApp history mining ? customer memory migration planning ? client-config architecture ? privacy/safety boundaries ? golden messages ? dangerous-action gates.

**Integrated chain (terminal evidence):** `WH-260528-5369` ? do **not** reuse without reset.

---

## Preferred next step

**Stage 3d (engineering):** Integrated pay + webhook + dry-run confirmation **complete** on `WH-260528-5369` (terminal; do not reuse).

**Immediate (Stage 3x execution):**
- **3x.2c done** ? applied owner P1 answers to baseline v0.2 (payment-link auto-send, 60-min hold, auto-confirm content, conditional cancel/date-change, rooming auto-assign + operator-room logic). Created [`STAFF-HANDOFF-PLAN.md`](STAFF-HANDOFF-PLAN.md) and [`DURING-STAY-ADDONS-PLAN.md`](DURING-STAY-ADDONS-PLAN.md).
- **3x.2** ? Ale/Cami complete remaining P1 in [`knowledge/wolfhouse-somo-gaps.md`](knowledge/wolfhouse-somo-gaps.md) (deposit amount/scope, non-7-night pricing, cancel/refund windows, add-on prices, handoff channel); then promote provisional ? confirmed and draft `config/clients/wolfhouse-somo.json`.
- **3x.3** ? Redacted WhatsApp mining (?3x.4 + ?3x.5): Layer 3 fixtures + Layer 2 customer extract (owner-approved fields only).

**Stage 3 residual ? CLOSED (2026-05-29):**
- **3e.5 wrong-booking guard:** L1 static/unit PASS (25/25 resolver) ? L2 fixture+report PASS (T1?T3, T5?T7) ? L3 runtime deferred ? current local forks have Airtable-coupled hold/reassign lookup; PG-only fixtures are not faithful. See ?15.6??15.7.
- **3e.6 idempotency:** I1 schema PASS (`idx_messages_whatsapp_client` confirmed) ? **I4 runtime PASS** (Send Confirmation dry-run, exec 1087 confirmed; exec 1088 no-op; `confirmation_sent_at` unchanged) ? I6 invariant PASS (payments/payment_events/booking_beds at baseline throughout). See [`PHASE-3e-IDEMPOTENCY-PLAN.md`](PHASE-3e-IDEMPOTENCY-PLAN.md).
- **Deferred (not blocked):** I2 ? manual-pay gate ? I3 ? Stage 3.5/manual-pay gate (structural schema guard proven; runtime needs `payments` write) ? I5 ? Postgres cutover. Airtable-coupled L3 runtime (T2, T5) ? post-cutover.
- **Caveats remaining:** real WhatsApp send (dry-run only) ? schedule-poll mode ? single-window integrated E2E ? Stripe/payment idempotency (I2, I3).

**Stage 3.5 ? CLOSED (d08c64e).** Minimum safety bar MET. G1?G13 DONE. Deferrals documented.

**Stage 3y planning ? STARTED (2026-05-29).** Plan doc: [`PHASE-3y-SHADOW-COPILOT-PLAN.md`](PHASE-3y-SHADOW-COPILOT-PLAN.md). Entry criteria Y-E1?Y-E13 defined. 4 operating modes (A?D) with gates. 15-test matrix (Y-T1?Y-T15). Exit criteria (Y-X1?Y-X13) defined.

**Stage 3y Mode A runtime gate 1 ? BLOCKED (2026-05-29).** Activated Main `RBfGNtVgrAkvhBHJ` only (had to unpublish a stale-active `Stripe Checkout Success` first), POSTed Y-T1. Two blockers found: (1) flat payload nests under `input.body` so `Normalize` test path (`input.phone`) misses it ? stops at `IF - Ignore Non Guest Message`; (2) Meta-envelope payload reaches `Send Typing Indicator`, which makes a real `graph.facebook.com` call NOT gated by `WHATSAPP_DRY_RUN` and errors 400 before routing. Route/draft unreachable offline. **No DB mutations, all protected counts at baseline, no other workflow executed, all workflows inactive after gate.** Y-T2/Y-T5/Y-T6/Y-T9 not run (same blocker). See `docs/PHASE-3y-SHADOW-COPILOT-PLAN.md ?Mode A runtime gate`.

**Stage 3y Mode A offline-safety fix ? IMPLEMENTED / NOT RUNTIME TESTED (2026-05-29).** `scripts/build-main-local-stripe.js` updated: `applyLocalTypingIndicatorBypass()` now checks `$env.WHATSAPP_DRY_RUN`; when `true`, IF false branch is taken ? `Send Typing Indicator` skipped ? workflow continues to `Create Inbound Message`. Local Main regenerated; `--verify-targets` hard safety checks PASS; `workflow.active=false`; hosted file unchanged. All five Mode A payload files converted to Meta-envelope shape. No runtime run; static verification only.

**Stage 3y Mode A runtime gate 2 ? BLOCKED (2026-05-29, critical).** Typing guard worked. Y-T1 (exec 1097) exposed 3 critical violations: real WhatsApp send (Send WhatsApp Reply1 returned real wamid), Airtable writes (inbound+outbound+conv records), Postgres booking hold created (bookings 41?42). Root cause: `WHATSAPP_DRY_RUN` gated only the typing indicator ? all 17 send nodes, Airtable writes, and hold creation were ungated. **Hard-stopped after Y-T1.** Main deactivated; Postgres test rows deleted; all protected counts restored to baseline. See `docs/PHASE-3y-SHADOW-COPILOT-PLAN.md ?Mode A runtime gate 2`.

**Stage 3y Mode A runtime gate 3 ? PASS (2026-05-29).** `applyShadowModeDryRunGates(workflow)` in `scripts/build-main-local-stripe.js`. 67 `IF - DRY RUN?` gates added: 16 WA sends + 47 Airtable writes + 4 PG+read nodes (including `Search Messages - Recent Conversation` for new-conversation path). 211 expression patches across all node types (`.isExecuted` ternary). Stub pass-through connections added. Enhanced runner `scripts/run-stage3y-mode-a.js` with 90s queue-mode poll. Generated workflow: 336 nodes, `active=false`, `phase3y-shadow-safe` tag. All 5 tests PASS ? zero protected mutations.

**Immediate next step (choose one):**
- **A:** Wire the `Postgres - Open Staff Handoff` n8n node (Stage 5.9 write-stub) ? runtime gate for the first bot handoff write.
- **B:** Stage 6 planning ? map proven staff queries to staff-assistant API design.
- **C:** Stage 5 engine extraction ? extract decision logic from n8n Code nodes into `src/booking-assistant/`.

**Parallel: Stage 3x completion.**
- 3x.2: Ale/Cami confirm provisional prices ? promoted config from v0.3 to confirmed.
- 3x.3: Ale/Cami provide redacted WhatsApp samples ? enriches Mode A test messages.

**Not next:** Mode B/C/D without separate gate; Stage 5 backend migration; Stage 6 staff UI; Azure (Stage 7); Airtable cutover without staff UI; autonomous live replies without per-action staff approval.

---

**Stage 4 Autonomous Booking Dry-Run ? runtime gate 2 PASS (2026-05-30).** A1 turn 2 (exec 1149, 52s): route=payment_or_confirm_intent, conf=0.95, draft="Great! Let's get you booked in. ?? I just need a couple of quick details: 1. What's your full name? 2. What's your email address?" WA stubbed. A1 turn 3 (exec 1150, 50s): route=payment_details_provided, conf=0.95. IF - Booking ID Ready ? TRUE ?. Code - DRY RUN Stub (Postgres - Ensure Booking In Postgres) ? executed (booking_id="dry-run-ensure-fallback", stub_type="ensure_booking_stub") ?. Code - Call Create Payment Session ? dry-run branch fired, checkout_url="https://checkout.stripe.test/dry-run/dry-ensure", session_id="cs_test_dryrun_dry-ensure" ?. Draft reply includes checkout_url ?. WA send stubbed (no graph.facebook.com) ?. All protected table counts unchanged across T1+T2+T3: bookings=41, payments=25, payment_events=5, booking_beds=15. Only Main exec count increased (1147?1150). payment_link_stub RUNTIME PROVEN. NOTE: booking_id in ensure stub is "dry-run-ensure-fallback" (expected ? T3 doesn't replay T1 hold creation; in a real multi-session the booking_id would come from the persisted hold). IF - Payment Link Safe For Reply went FALSE (checkout domain is stripe.test not stripe.com ? stub URL doesn't pass real URL safety check), but assembled reply still appended checkout_url correctly.

**Stage 4 gate 3 plan (2026-05-30):** Stripe webhook simulation + Send Confirmation dry-run. Recommended approach: Option D ? fixture-scoped disposable booking row. Steps: (1) Insert fixture `bookings`+`payments` rows (DRY-STAGE4-FX-A1-001) with matching session_id; (2) POST simulated `checkout.session.completed` to Stripe Webhook Handler (STRIPE_WEBHOOK_SKIP_VERIFY=true); (3) POST to Send Confirmation with fixture booking_id (WHATSAPP_DRY_RUN=true, LLM runs, draft captured); (4) verify confirmation text includes address/gate_code/room_number and excludes bed_number; (5) delete fixture rows. Also needed: dry-run gate on `Postgres - Mark Booking Confirmed` in `build-send-confirmation-local.js` to prevent real booking state mutation during dry-run.

**Stage 4 gate 3 scaffold COMPLETE (2026-05-30):** (1) `scripts/fixtures/stage4-a1-payment-sim-up.sql` ? fixture `bookings`+`payments` INSERT for DRY-STAGE4-FX-A1-001, session_id `cs_test_dryrun_dry-ensure`. (2) `scripts/fixtures/stage4-a1-payment-sim-down.sql` ? idempotent DELETE of all fixture rows + payment_events + workflow_events. (3) `test-payloads/stage4/autonomous-dry-run/a1-stripe-sim.json` ? simulated `checkout.session.completed` payload with `_gate3_runner_patch` note for client_id. (4) `scripts/build-send-confirmation-local.js` ? `IF - DRY RUN? (Mark Confirmed)` gate added; stub returns shaped `{ booking_id, status: confirmed, dry_run: true, stub_type: mark_confirmed_stub }` without bookings write; live path preserved; all error/observability nodes preserved; 27 nodes total verified. (5) `n8n/phase2/Wolfhouse - Send Confirmation (local).json` ? regenerated; all 12 gate/wiring checks PASS. Next: Gate 3 runtime preflight ? seed fixture, activate Stripe Webhook Handler + Send Confirmation, run simulated payment + confirmation, capture draft text, teardown fixture.

**Stage 4 gate 3 PARTIAL PASS (2026-05-30):** Sub-gate A (Stripe webhook simulation): PASS ? HTTP 200, exec 1151 success (16s), payment_events +1 fixture-scoped (`evt_dry_run_a1_stage4_001`, `processed=true`), `payments.status=paid`, `amount_paid_cents=20000`, `bookings.payment_status=deposit_paid`, `send_confirmation=true`, `booking_beds` unchanged. Stripe webhook handler deactivated. Sub-gate B (Send Confirmation): PARTIAL ? exec 1152 success (18s), LLM draft generated (claude-sonnet-4-6), WhatsApp send dry-run fired (`whatsapp_sent: true, dry_run: true`), no real graph.facebook.com call. BUT: `IF - DRY RUN? (Mark Confirmed)` gate did NOT fire ? the n8n DB workflow (`gxivKRJexzTCw9x6`) still has the OLD Send Confirmation version (gate only in JSON file, never imported into n8n). As a result, `Postgres - Mark Booking Confirmed` executed and the fixture booking was marked `status=confirmed`, `confirmation_sent_at` set (fixture-scoped only ? acceptable per approved fixture write). Gate code `2684#` absent from draft (Airtable returns empty for test phone ? LLM has no gate code context). All counts restored after teardown: bookings=41, payments=25, payment_events=5, booking_beds=15, automation_errors=0, workflow_events=24 ? all MATCH baseline. Required fix before gate 3 full PASS: import new Send Confirmation local JSON (with dry-run gate) into n8n DB workflow entry `gxivKRJexzTCw9x6`. Fix enum bug in fixture SQL (`unpaid` ? `not_requested`). Investigate gate code delivery to LLM (pass from config vs Airtable path).

**Stage 4 gate 3 static fixes COMPLETE (2026-05-30):** (1) `scripts/build-send-confirmation-local.js` ? added `--import-inactive` support (same `docker cp` + `n8n import:workflow` pattern as Main/Assign/Reassign build scripts); added `id: 'gxivKRJexzTCw9x6'` to workflow object for n8n import; added `ARRIVAL` constants read from `wolfhouse-somo.baseline.json` (`gate_code: 2684#`, `check_in_time: 15:00`, `check_out_time: 11:00`); `Code - Format Booking For LLM` now passes `Gate Code`, `Check In Time`, `Check Out Time`, `Property Address` (null until owner confirms) to LLM. (2) Re-generated `n8n/phase2/Wolfhouse - Send Confirmation (local).json` and imported inactive into n8n DB `gxivKRJexzTCw9x6` ? verified in DB: 27 nodes, active=false, `IF - DRY RUN? (Mark Confirmed)` + stub present, gate wiring correct, gate code present. Next: Gate 3 confirmation re-run (sub-gate B only ? re-seed fixture, activate Send Confirmation only, capture draft with gate code).

**Stage 4 gate 3 FULL PASS (2026-05-30, re-run):** Sub-gate B re-run (exec 1153, success, ~11s). Fixture seeded directly in confirmation-eligible state (payment_status=deposit_paid, send_confirmation=true). `IF - DRY RUN? (Mark Confirmed)` fired TRUE branch ?. `Code - DRY RUN Stub (Mark Booking Confirmed)` executed ? returned `status=confirmed, dry_run=true, stub_type=mark_confirmed_stub` ?. `Postgres - Mark Booking Confirmed` NOT executed ?. WhatsApp dry-run: `whatsapp_sent: true, dry_run: true`, no real graph.facebook.com call ?. Fixture booking remained `status=payment_pending` after run ?. Confirmation draft includes gate code `2684#`, check-in `15:00`, check-out `11:00`, booking confirmed language, no bed number ?. Teardown: bookings=41, payments=25, payment_events=5, booking_beds=15, automation_errors=0, workflow_events=24 ? all MATCH baseline ?. All workflows inactive at end ?. **payment_confirmation_path RUNTIME PROVEN. mark_confirmed_dry_run_gate RUNTIME PROVEN. Gate 3 FULL PASS. Next: run A2?A10 scenarios.**

**Stage 4 A2?A10 planning (2026-05-30):** Planning table added to `test-payloads/stage4/autonomous-dry-run/README.md`. Recommended next runtime batch: **Gate 4 Batch 1 ? A5 + A6 + A7 + A8 + A10** (all single-turn, no new stubs, zero new infrastructure required). A2/A3/A4 deferred: multi-turn conversation state risk ? `PG_CONV_STUB` stubs the conversation upsert so T2 of those scenarios sees no T1 context for new phones. Must resolve before running: options are (a) remove `Postgres - Upsert Conversation Hold` from stub scope, (b) pre-seed fixture conversation records. A9 deferred: addon payment link path not confirmed in Main workflow. Batch 1 can start immediately once approved.

**Stage 4 multi-turn state static analysis (2026-05-30):** Inspected `Postgres - Upsert Conversation Hold` and `Search Conversation` (Airtable). **Safety verdict: SAFE** ? node writes ONLY to the `conversations` table; does not touch bookings (write), payments, payment_events, booking_beds, Airtable, Stripe, or WhatsApp. **Static fix decision: DO NOT REMOVE THE GATE** ? (1) stub booking_codes (WH-DRYA2-0001 etc.) don't exist in DB ? real SQL returns `pg_ok=false` ? flow breaks; (2) root cause is Airtable-based: `Search Conversation` is an Airtable read; all Airtable conversation write nodes are stubbed; T2 still reads empty Airtable regardless of Postgres write. **Fix path for A2/A3/A4**: Add `Search Conversation (PG)` Postgres read node to Main workflow + provide fixture hold bookings. Separate planning task. All static verifications pass: build --verify-targets OK, payment-contract OK, rooming-contract OK, runner syntax OK. **Gate 4 Batch 1 (A5/A6/A7/A8/A10) can proceed without any changes.**

---

## Must not touch (without explicit approval)

| Area | Reason |
|------|--------|
| Hosted n8n exports / cloud instance | Production prototype |
| `payments`, `payment_events` | Stripe webhook owns truth |
| Stripe Webhook Handler, Send Confirmation | Phase 2 frozen contracts |
| `build-main-local-stripe.js` / Main JSON | **3c.e** scope |
| Workflow activation, webhooks, live Postgres/Airtable/Sheets writes | Test gates |
| Azure deploy, DNS, production URLs | After 3c + reliability + cleanup |
| Starting 3c.f, 3c.g, or Phase 4 cutover | Sequencing |

Safe without extra approval: docs-only, read-only reports, reversible fixtures, SELECT-only SQL, dry-run CLIs (default), commits after verified tests when user asks.

---

## Why Azure / staff UI is not next

Deployment and multi-client scale are **Stage 7**. Staff product UI is **Stage 6**. Immediate priority is finishing **Stage 3** safe proofs, then **Stage 3x** specs, then **Stage 4** reliability. See [ROADMAP.md](ROADMAP.md) and [ARCHITECTURE-NORTH-STAR.md](ARCHITECTURE-NORTH-STAR.md).

---

## Quick commands

```powershell
cd C:\Users\tywoo\Desktop\WH
git log -1 --oneline
git status --short

# When host npm unavailable:
docker compose --env-file infra/.env -f infra/docker-compose.local.yml --profile tools run --rm wolfhouse-tools npm run db:report:main-hold-plan -- --help
```

Fixture SQL (example):

```powershell
Get-Content scripts/fixtures/main-ensure-3cc-promote-cleanup-down.sql | docker compose -f infra/docker-compose.local.yml exec -T wolfhouse-postgres psql -U wolfhouse -d wolfhouse
```

---

## Bookmark index

| Need | Doc |
|------|-----|
| Product vision (15 pillars) | [PRODUCT-MASTER-ROADMAP.md](PRODUCT-MASTER-ROADMAP.md) |
| Product roadmap (stages) | [ROADMAP.md](ROADMAP.md) |
| North star | [ARCHITECTURE-NORTH-STAR.md](ARCHITECTURE-NORTH-STAR.md) |
| This snapshot | PROJECT-STATE.md |
| Cursor agent | [CURSOR.md](../CURSOR.md) |
| Owner summary | [PROJECT-ROADMAP.md](PROJECT-ROADMAP.md) |
| Stripe gates | [PHASE-3d-STRIPE-ISOLATED-PLAN.md](PHASE-3d-STRIPE-ISOLATED-PLAN.md) |
| Stage 3x spec | [STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md) |
| Owner knowledge gaps | [knowledge/wolfhouse-somo-gaps.md](knowledge/wolfhouse-somo-gaps.md) |
| 3c proposal | [PHASE-3c-PROPOSAL.md](PHASE-3c-PROPOSAL.md) |
| Regression | [regression-test-plan.md](regression-test-plan.md) |
| Azure (later) | [azure-n8n-hosting-plan.md](azure-n8n-hosting-plan.md) |

**Stage 4 Gate 4 Batch 1 PARTIAL PASS (2026-05-30):** Execs 1154-1158, Main only (RBfGNtVgrAkvhBHJ). A6 PASS (route=payment_completed_claim, safe clarification no confirmation). A7 PASS (route=human_handoff conf=0.99, empathetic handoff draft, no cancel action). A8 PASS (route=booking_flow conf=0.95, rooming preference recorded as private in session_state, booking_beds ?=0, no bed assignment). A10 PASS (route=booking_flow, language=es detected, full Spanish reply, hold stub fired). A5 PARTIAL ? safety OK (hold stub, no real send, no mutations, no graph.facebook.com), behavioral gap: bot booked January 2027 dates without checking closed_months config (?december, january, february? from wolfhouse-somo.baseline.json). Root cause: closed_months not injected into LLM context. Required fix: add Code - Check Closed Month node or inject config into system prompt. Protected counts all match baseline. All workflows inactive after run.

**Stage 4 A5 closed-month guard plan (2026-05-30):** Insertion point confirmed: after Determine Missing Fields, before IF - Ready For Availability (both check_in and check_out are resolved at this point). Recommended approach: Option C ? deterministic Code node (Code - Check Closed Month) + LLM context injection. New nodes: (1) Code - Check Closed Month ? parse ISO dates, extract month names, compare against CLOSED_MONTHS literal injected by build script at build time, output closed_month_detected, closed_month_name, suggested_open_months; (2) IF - Closed Month? ? routes true?Reply - Closed Month, false?existing IF-Ready-For-Availability; (3) Reply - Closed Month ? LLM node with closed_months + language context, wired to IF-DRY-RUN? (Create Outbound Message). Build script: new pplyClosedMonthGuard(workflow, closedMonths) function, loads closed_months from wolfhouse-somo.baseline.json. Static verifier: assert node exists when closed_months.length > 0. A5 runner assertion: closed_month_detected=true, Reply-Closed-Month executed, hold stub NOT fired, no price quote. Also flagged: multilingual testing batch needed ? Italian (~65% usage) must be primary acceptance language; plan Italian booking/missing-fields/payment + German booking + Spanish control + English control after A5 guard fix.

**Stage 4 A5 closed-month guard RUNTIME PASS (2026-05-30, exec 1159):** A5 (January 15?22, Malibu, 2 guests). Activation: DB active=true + docker restart n8n-main + 8s webhook registration wait. HTTP 200 received. Execution 1159: status=success. Route=booking_flow, conf=0.95, language=en. Guard execution path: Webhook2???Determine Missing Fields?Code - Check Closed Month?IF - Closed Month??Reply - Closed Month?IF - DRY RUN? (Create Outbound Message)?Code - DRY RUN Stub (Create Outbound Message)???Code - DRY RUN Stub (Create or update Conversation). **Guard outputs:** closed_month_detected=true, closed_month_name="january", closed_months_hit=["january"], suggested_open_months="march, april, may, june, july, august, september, october, november". **IF-Closed Month? branch0 (true): fired (1 item). branch1 (false): not fired.** Draft: "Hi! Thanks for reaching out ?? Unfortunately, Wolfhouse is closed during January, so we can't accommodate your stay for those dates. However, we'd love to host you in our open season! We're running from March through November. Would any of those months work for you?" No hold, no availability, no payment-link nodes executed. bookings/payments/payment_events/booking_beds all ?=0. All workflows inactive after run. 15/15 validation checks PASS. **A5 FULL PASS.**

**Stage 4 A2/A3/A4 multi-turn state fix PLANNED (2026-05-30):** Root cause confirmed: `Merge Session State` reads `$('Search Conversation').first().json` (Airtable) for old session state. All Airtable write nodes are stubbed. T2 for fresh test phones always starts with `session = {}`. Removing `PG_CONV_STUB` does not fix this and breaks the flow (stub booking_codes not in bookings table). Selected fix: **Option A ? PG conversation read node**. New node `Code - Search Conversation (PG)` reads from Postgres `conversations` table by phone; `Merge Session State` uses PG session as fallback when Airtable session is empty. Runner seeds `conversations` rows between turns via direct SQL (no booking validation). Teardown deletes test phone rows after run. `Postgres - Upsert Conversation Hold` remains stubbed. Protected tables (bookings/payments/payment_events/booking_beds) remain ?=0. `conversations` is allowed state for multi-turn tests. Key constraint: `conversationHoldHint` only triggers on 'WH-' prefix hold codes; hold stubs use 'DRY-STAGE4-' prefix ? routing still works because LLM has session context for pricing. Implementation batch: (1) `applyPGConversationRead` in build script, (2) modify `Merge Session State`, (3) update verifier, (4) update runner with `seedConversationState` + teardown, (5) static verify + import inactive, (6) runtime A2 first.

**Stage 4 A2/A3/A4 PG conversation read fallback IMPLEMENTED (2026-05-30):** `applyPGConversationRead(workflow)` added. New node `Postgres - Search Conversation (PG)` wired: `Parser Node ? Postgres - Search Conversation (PG) ? Merge Session State`. `Merge Session State` jsCode updated: Airtable session first; PG fallback when AT session empty (`atSession || pgSessionRaw || '{}'`). `verifyPGConversationRead` asserts: node present, correct wiring, read-only query, `alwaysOutputData=true`. Runner: `seedConversationState` + `teardownConversationState` + `PG_CONVERSATION_SEED_PLANS` for A2/A3/A4. Report fields: `pg_conversation_state_required`, `planned_pg_conversation_seed`, `planned_pg_conversation_cleanup`, `allowed_state_table_deltas`, `protected_no_mutation_tables`. Static verification: shadow OK, closed-month OK, PG conv read OK, payment contract OK, rooming contract OK, runner syntax OK. n8n DB: active=false, 347 nodes, `Postgres - Search Conversation (PG)` present. **Next: A2 targeted multi-turn runtime proof.**

**Stage 5.9b Luna staff handoff write path WIRED + RUNTIME PASS (2026-05-31):** `Postgres - Open Staff Handoff` node wired in Main workflow after both `Update Conversation - Human Handoff` (real) and `Code - DRY RUN Stub (Update Conversation - Human Handoff)` (dry-run). SQL uses NOT EXISTS guard for phone+reason_code+active-status dedup. Execution 1247 (A7 cancellation+refund, fixture phone +34600000180): `staff_handoffs` row created (`reason_code=unclear_request`, `status=open`, `priority=normal`). `getOpenHandoffsQuery()` returned fixture row. Idempotency: second POST with same phone+reason created 0 new rows. Protected counts all ?=0 (bookings=41, payments=25, payment_events=5, booking_beds=15). All handoff/conversation fixture rows cleaned up post-gate. `conversation_id` is NULL in handoff row (human-handoff path fires before conversation hold established ? expected). Main deactivated + unpublished after gate. All static checks green: `--verify-targets`, handoff/payment query verifiers, contracts.




