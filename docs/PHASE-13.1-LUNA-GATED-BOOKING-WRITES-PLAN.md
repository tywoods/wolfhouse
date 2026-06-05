# Phase 13.1 — Luna Gated Guest Booking Write Path Plan

**Status:** PASS — docs + static plan verifier (Phase 13a). **No write implementation in this slice.**  
**Parent:** Phase 13 — Luna guest booking live writes (gated)  
**Prior:** Phase 12 Luna dry-run foundation (closeout `a5dbb7a`+), Phase 11 Ask Luna read-only ops  
**Next:** Phase 13b — write-eligibility checkpoint (read-only); Phase 13c — first gated booking create bridge

**Non-negotiables (13a):** No runtime write path. No DB writes. No booking creation. No payment rows. No Stripe links. No WhatsApp. No n8n activation. No migrations. No deploy.

**Architecture (unchanged):**

- Staff API is the brain; n8n is message pipe only.
- Luna bot and Staff Portal share the same booking/pricing/payment engine.
- Flow: **booking first → server quote → draft payment → Stripe link → webhook is payment truth**.
- Payment links **never** mark paid; webhook marks paid.
- Live WhatsApp remains **NO_GO** unless explicitly approved (Stage 7.8 gate).

---

## 1. Dry-run outputs required before any write gate

`POST /staff/bot/booking-dry-run` / `runLunaGuestBookingDryRun()` must produce a coherent plan. The following fields are **write prerequisites** — not optional nice-to-haves.

| Prerequisite | Dry-run location | Write gate rule |
|--------------|------------------|-----------------|
| **Guest identity** | `guest_phone`, `phone` (resolved `guest_phone → phone → from`), `guest_name`, optional `email`, `conversation_id` | `guest_name` + resolved phone required; phone must not appear in `booking_preview.missing_fields` |
| **Check-in / check-out** | `booking_preview` field values; `availability.check_in` / `check_out` | Valid `YYYY-MM-DD`; `check_out > check_in` |
| **Guest count** | `booking_preview.quote` inputs | `guest_count >= 1` |
| **Package / room** | `package_code`, `room_type` | `package_code` set; not `manual_override` |
| **Quote / invoice total** | `booking_preview.quote` (`success`, `total_cents`, `deposit_required_cents`, `payment_link_amount_cents`, `balance_due_cents`) | `quote.success === true`; amounts **never** trusted from client on write — re-quoted server-side at create |
| **Deposit / full choice** | `payment_choice` (`deposit` \| `full`) | Required before `would_create_booking_after_approval`; may plan `ask_deposit_or_full_payment` until set |
| **Availability result** | `availability` (`has_enough_beds`, `selected_bed_codes`, `blockers`, `warnings`) | When `pg` present: `has_enough_beds === true` and `selected_bed_codes.length >= guest_count`. **Bot create requires `selected_bed_codes`** (Stage 8.5.4) |
| **Planned actions** | `planned_actions[]` | Must include `would_create_booking_after_approval` (and optionally `would_create_payment_link_after_approval` only after booking exists) |
| **Reply draft** | `reply_draft` | Present for guest-facing copy; write slice does not send it |
| **Automation gate** | `gate` (`bot_paused`, `live_send_blocked`, `can_continue_guest_automation`) | `can_continue_guest_automation === true`; `bot_paused === false` |

**Safety flags must remain on dry-run response:**

`dry_run: true`, `preview_only: true`, `no_write_performed: true`, `creates_booking: false`, `creates_payment: false`, `creates_stripe_link: false`, `sends_whatsapp: false`, `calls_n8n: false`.

---

## 2. Explicit approvals before each write class

| Action | Who approves | Mechanism today | Gap |
|--------|--------------|-----------------|-----|
| **Create booking** | Owner/ops + caller | `BOT_BOOKING_ENABLED=true` + request `confirm: true` + `requireBotAuth` | No per-conversation staff-approval API |
| **Create draft payment row** | Same as booking | Created **inside** `POST /staff/bot/bookings/create` transaction — not a separate bot step | No standalone bot payment-draft route |
| **Generate Stripe payment link** | Owner/ops | `BOT_BOOKING_ENABLED=true` **and** `STRIPE_LINKS_ENABLED=true` on `POST /staff/bot/payments/:id/create-stripe-link` | Separate env flip from booking create |
| **Send payment link message** | Owner + Stage 7.8 | `WHATSAPP_DRY_RUN !== 'false'` blocks n8n sends; `gate.live_send_blocked` when paused | **No `WHATSAPP_LIVE_SENDS_ENABLED` env** — uses `WHATSAPP_DRY_RUN` + pause gate + n8n IF guards |
| **Any WhatsApp live reply** | Owner (Stage 7.8) | `WHATSAPP_DRY_RUN=false` + inactive→active n8n workflow + owner sign-off | Operational gate, not Staff API route |

**Operational owner approval (not yet a programmatic API):** flipping env flags on staging Container App, Stage 7.8 go/no-go checklist, explicit decision to activate n8n workflow.

**Caller intent approval (exists):** `confirm: true` on write bodies; `idempotency_key` on writes.

---

## 3. Existing Staff API write endpoints to reuse

Do **not** fork booking/pricing logic. Luna guest writes should delegate to these anchors:

| Step | Route | Handler | Notes |
|------|-------|---------|-------|
| Booking + beds + quote_snapshot + draft payment | `POST /staff/bot/bookings/create` | `handleBotBookingCreate` | Stage 8.5.4. `BOT_BOOKING_ENABLED` gate. Returns `payment_id`. No Stripe, no WhatsApp |
| Stripe Checkout link (bot) | `POST /staff/bot/payments/:payment_id/create-stripe-link` | `handleBotPaymentCreateStripeLink` | `BOT_BOOKING_ENABLED` + `STRIPE_LINKS_ENABLED`. Sets `checkout_created`; **does not mark paid** |
| Payment truth | `POST /staff/stripe/webhook` | `handleStripeWebhook` | Stripe ingress only; **never** callable from Luna agent |
| Staff portal parity (not Luna guest path) | `POST /staff/manual-bookings/create` | `handleManualBookingCreate` | `MANUAL_BOOKING_ENABLED`; staff session auth |
| Staff portal payment link | `POST /staff/bookings/generate-payment-link` | `handleBookingGeneratePaymentLink` | `STAFF_ACTIONS_ENABLED` + `STRIPE_LINKS_ENABLED` |
| Staff portal Stripe link | `POST /staff/payments/:id/create-stripe-link` | `handlePaymentCreateStripeLink` | `STRIPE_LINKS_ENABLED` |

**Ambiguity — confirmation/status route:** There is **no** dedicated Staff API “confirm booking after payment” route for Luna. Bot create sets `booking_status: 'confirmed'` at insert time. Webhook verifier confirms webhook **does not** flip booking to confirmed — payment truth only. Post-payment booking status transitions beyond paid flag are **not** a single route (see Phase 12a entrypoint map).

**Ambiguity — booking hold only:** `scripts/main-booking-hold-postgres.js` / `main-booking-hold-pg-sql` serve the **legacy n8n Main** hold path, not the shared Staff API bot create engine. There is **no** `POST /staff/bot/bookings/hold` today.

---

## 4. Gates that must exist (and do today)

| Gate | Env / mechanism | Default | Verified by |
|------|-----------------|---------|-------------|
| Bot booking writes | `BOT_BOOKING_ENABLED === 'true'` | **false** | `verify-staff-bot-booking-create-api` |
| Stripe link creation | `STRIPE_LINKS_ENABLED === 'true'` | **false** | `verify-staff-stripe-payment-link-api`, `verify-staff-bot-stripe-link-api` |
| Staff portal writes | `STAFF_ACTIONS_ENABLED === 'true'` | **false** | `verify-staff-write-api` |
| Manual staff booking | `MANUAL_BOOKING_ENABLED === 'true'` | **false** | `verify-staff-manual-booking-create-api` |
| WhatsApp live send | `WHATSAPP_DRY_RUN` (true unless explicitly `'false'`) | **true** (dry) | n8n IF guards; `verify-staff-ask-luna-whatsapp-dry-run` |
| Guest automation pause | `bot_pause_states` via gate | active when not paused | `verify-staff-bot-guest-automation-gate` |
| `live_send_blocked` | Returned when `bot_paused` | default false | Phase 9.6 gate response |
| Idempotency | `idempotency_key` on writes; bot create auto-hash fallback | required on staff writes; optional hash on bot create | `verify-staff-bot-booking-create-api` |
| Audit log | `appendAuditLog` on bot create / dry-run | always | handler source |

**Gap — staff/owner approval gate:** No `POST /staff/bot/booking-write-approve` or signed approval token. Phase 13b should add **read-only** `write_eligibility` that lists `required_approvals[]` without implementing approval storage.

---

## 5. First safe write slice — what to write

**Recommendation: booking + draft payment row (single transaction via existing bot create), not hold-only.**

| Option | Verdict |
|--------|---------|
| **Booking hold only** | **Reject for Phase 13c** — not implemented on Staff API bot path; would be new schema/status and diverge from Staff Portal shared engine |
| **Booking + draft payment** | **Accept** — already implemented in `handleBotBookingCreate` (Stage 8.5.4): `bookings` + `booking_beds` + `quote_snapshot` in metadata + `payments` draft row (`not_requested` → updated with quote amounts). Stripe link remains a **separate** gated step |

**Why this is the minimal safe first write:**

1. Reuses proven shared-engine SQL (`buildManualBookingCreateSql`) — no new pricing truth.
2. Server-side `calculateWolfhouseQuote` re-run at create — client amounts ignored.
3. `selected_bed_codes` must come from dry-run availability — prevents blind writes.
4. `BOT_BOOKING_ENABLED=false` by default — 403 until ops flips.
5. `confirm: true` required — explicit caller intent.
6. Idempotency prevents duplicate bookings on retries.
7. Draft payment row enables **next** slice (Stripe link) without coupling link creation to booking create.
8. No WhatsApp, no Stripe API, no n8n in booking create handler (already verified).

**Still deferred after first write:** Stripe link, WhatsApp send, n8n activation, marking paid.

---

## 6. Must remain impossible in Phase 13 initial slices

| Forbidden | Enforcement |
|-----------|-------------|
| Marking paid from link creation | `handleBotPaymentCreateStripeLink` sets `checkout_created` only; `verify-staff-stripe-webhook-api` |
| Sending WhatsApp automatically | Bot create returns `sends_whatsapp: false`; n8n dry-run workflow inactive; `WHATSAPP_DRY_RUN=true` |
| Activating production n8n | Workflows `active: false`; no activation API in Luna path |
| Refunds / cancellations | No bot cancel/refund routes in Luna slice; out of scope |
| Date changes on paid bookings | Staff `date-change-preview` / move write — not Luna guest path |
| Unapproved Stripe link sends | `STRIPE_LINKS_ENABLED=false` default; link route 403 |
| Webhook invocation from agent | `LIVE_FORBIDDEN_ROUTES` in dry-run orchestrator |
| n8n owning booking/pricing truth | Staff API only |

---

## 7. Verifier checklist before any write slice

Run **in order** before enabling `BOT_BOOKING_ENABLED` on any environment:

```bash
npm run verify:luna-agent-phase12-closeout
npm run verify:staff-ask-luna-phase11-closeout
npm run verify:luna-agent-phase13-write-gates-plan
npm run verify:luna-agent-dry-run-orchestrator
npm run verify:staff-bot-guest-automation-gate
npm run verify:staff-bot-booking-create-api      # write route static contract
npm run verify:staff-bot-stripe-link-api         # link route static contract
npm run verify:staff-stripe-webhook-api          # payment truth only
```

**Per-slice proof requirements:**

| Slice | Additional proof |
|-------|------------------|
| 13b write-eligibility (read-only) | Eligibility returns `write_ready: false` when any dry-run prerequisite missing |
| 13c first booking write | Route returns **403** when `BOT_BOOKING_ENABLED=false`; returns **403/400** without `confirm:true`; no Stripe/WhatsApp in audit; idempotent duplicate safe |
| 13d Stripe link | Link route **403** when `STRIPE_LINKS_ENABLED=false`; payment status not `paid` after link |
| 13e WhatsApp | **STOP** — requires Stage 7.8 owner approval; `live_send_blocked` honored |

---

## 8. Recommended Phase 13b — smallest implementation slice

**13b: Write-eligibility evaluator (read-only, no DB writes)**

Add a pure function + optional Staff API route that accepts the same body as dry-run (or a dry-run response JSON) and returns:

```json
{
  "write_ready": false,
  "blocked_reasons": ["availability_not_checked"],
  "required_approvals": ["BOT_BOOKING_ENABLED", "confirm_true", "selected_bed_codes"],
  "dry_run_anchor": "POST /staff/bot/booking-dry-run",
  "would_call": [],
  "creates_booking": false,
  "creates_payment": false,
  "creates_stripe_link": false,
  "sends_whatsapp": false
}
```

When `write_ready: true`, `would_call` lists **only**:

`POST /staff/bot/bookings/create` (not Stripe, not WhatsApp).

### Files likely touched (13b)

| File | Change |
|------|--------|
| `scripts/lib/luna-guest-booking-write-eligibility.js` | **new** — maps dry-run output → eligibility |
| `scripts/lib/luna-guest-booking-dry-run.js` | optional — attach `write_eligibility` block to dry-run response |
| `scripts/staff-query-api.js` | optional — `POST /staff/bot/booking-write-eligibility` (read-only) |
| `scripts/verify-luna-agent-phase13-write-eligibility.js` | **new** — static + runtime smoke |
| `package.json` | npm script |

### Verifier name

`verify:luna-agent-phase13-write-eligibility` (13b)  
Plan anchor (13a): `verify:luna-agent-phase13-write-gates-plan`

---

## 9. Phase 13c — first actual write (after 13b)

Thin bridge route or orchestrator method:

1. Run dry-run internally (or validate fingerprint of prior dry-run).
2. Assert `write_eligibility.write_ready === true`.
3. Map `availability.selected_bed_codes` → create body.
4. Call existing `handleBotBookingCreate` logic with `confirm: true`, `idempotency_key`, `source: 'luna_dry_run_write'`.
5. Return create response + safety flags (`creates_stripe_link: false`, `sends_whatsapp: false`).

**Files likely touched (13c):** `scripts/lib/luna-guest-booking-write-bridge.js`, `scripts/staff-query-api.js`, `scripts/verify-luna-agent-phase13-booking-write-bridge.js`.

---

## 10. Explicit stop conditions

**STOP — do not proceed to write slice if:**

1. Phase 12 closeout or Phase 11 closeout fails.
2. Dry-run `planned_actions` never reaches `would_create_booking_after_approval` in staging proofs.
3. `availability.selected_bed_codes` empty when beds should be available (data/config issue).
4. Any verifier shows Stripe/WhatsApp/n8n calls inside dry-run or eligibility paths.
5. `BOT_BOOKING_ENABLED` flipped on production before staging proof with rollback plan.
6. Owner has not signed Stage 7.8 for WhatsApp — **never enable live send in Phase 13a–13d**.
7. Attempt to use `main-booking-hold-*` for Luna guest path instead of `handleBotBookingCreate` — architectural violation.
8. Missing `idempotency_key` strategy for n8n retries — duplicate booking risk.

**STOP — escalate ambiguity (do not guess):**

- Per-staff approval token API (does not exist — design before 13c if required).
- Booking hold-only status on Staff API bot path (does not exist).
- Separate bot payment-draft-only route (does not exist — bundled in create).
- `WHATSAPP_LIVE_SENDS_ENABLED` env (does not exist — use `WHATSAPP_DRY_RUN` + pause gate).

---

## 11. Phase map

| Phase | Scope | Writes |
|-------|-------|--------|
| **13a** | This plan + plan verifier | None |
| **13b** | Write-eligibility (read-only) | None |
| **13c** | Gated `bookings/create` bridge | Booking + draft payment only |
| **13d** | Gated Stripe link step | Checkout session + `checkout_created` |
| **13e** | WhatsApp send | **NO_GO** until Stage 7.8 |
