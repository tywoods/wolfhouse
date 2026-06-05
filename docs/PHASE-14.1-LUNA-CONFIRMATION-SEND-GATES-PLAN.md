# Phase 14.1 — Luna Confirmation Send Gate Plan

**Status:** PASS — docs + static plan verifier (Phase 14a). **No send implementation in this slice.**
**Parent:** Phase 14 — confirmation send from payment truth (gated)
**Prior:** Phase 13 gated booking/payment flow (closeout `821571d`), Phase 12 dry-run foundation, Phase 11 Ask Luna read-only ops
**Next:** Phase 14b — read-only `confirmation-preview` route/helper (no send); Phase 14c — gated send (NO_GO until owner Stage 7.8 approval)

**Non-negotiables (14a):** No runtime send path. No DB writes. No WhatsApp sends. No n8n activation. No Stripe. No payment changes. No booking changes. No migrations. No deploy.

**Architecture (unchanged):**

- Staff API is the brain; n8n is the message pipe only.
- Stripe webhook is the **only** payment truth; payment links **never** mark paid.
- Live WhatsApp remains **NO_GO** unless explicitly approved (Stage 7.8 gate).
- Confirmation content (owner-confirmed, `config/clients/wolfhouse-somo.baseline.json`): **address + gate code `2684#` + room number**, and **NOT bed number**.

**Proof chain anchor:** booking `MB-WOLFHO-20260920-b6f9c7`, payment `1c09c7a9-860f-4056-8492-b9825397abe4`, `deposit_paid`, €100 paid / €170 balance, `confirmation_draft` present, `confirmation_sent_at` null (Phase 13g/13h).

---

## 1. Current confirmation state (as built, read-only)

| Question | Answer | Source |
|----------|--------|--------|
| Where is `confirmation_draft` stored? | `bookings.metadata.confirmation_draft` (jsonb) | `handleStripeWebhook` persists via `jsonb_build_object('confirmation_draft', …)` (`staff-query-api.js`) |
| Who writes it? | **Stripe webhook only** — `buildPaymentConfirmationDraft(pm, bkPayStatus, …)` | `staff-query-api.js` `buildPaymentConfirmationDraft` |
| When is it built? | Only when `payment_status === 'deposit_paid'` or `'paid'`; otherwise `null` | `buildPaymentConfirmationDraft` early-return guard |
| What fields does it include? | `booking_code`, `guest_name`, `payment_status`, `amount_paid_cents`, `balance_due_cents`, `room_number` (= `primary_room_code`), `address`, `gate_code`, `sends_whatsapp:false`, `whatsapp_dry_run:true` | `buildPaymentConfirmationDraft` return shape |
| Room number present? | **Yes** — `room_number: pm.primary_room_code` | draft shape |
| Bed number present? | **No** — bed code never added to draft; config `include_bed_number:false` | draft shape + `wolfhouse-somo.baseline.json` |
| Address / gate code source | `config/clients/<slug>.baseline.json` → `confirmation.address` / `confirmation.gate_code` (`2684#`) via `loadClientConfirmationArrival` | `staff-query-api.js` |
| How is `confirmation_sent_at` tracked? | `bookings.confirmation_sent_at` column. Read-only exposed in booking context API + drawer (`Confirm` row). **Set only** by legacy n8n node `Postgres - Mark Booking Confirmed` (`build-send-confirmation-local.js`: `confirmation_sent_at = COALESCE(confirmation_sent_at, NOW())` with `WHERE … confirmation_sent_at IS NULL`, gated by `WHATSAPP_DRY_RUN`). | `build-send-confirmation-local.js`, booking context |
| Existing Staff API send/preview route? | **None.** No `confirmation-preview` and no `send-confirmation` route in `staff-query-api.js`. Only the legacy n8n `Wolfhouse - Send Confirmation` pipe exists. | grep of `staff-query-api.js` |

**Confirmed (not ambiguous):** draft includes **room number but not bed number**; webhook is the only writer of the draft; `confirmation_sent_at` is never set by any Staff API route today.

**Reported ambiguity (do not guess in 14a):**

- There is **no** Staff API confirmation route yet — Phase 14b must add it; reusing the legacy n8n `Send Confirmation` mark-confirmed SQL as the only `confirmation_sent_at` writer is a **gap to close** (Staff API should own the truth write, n8n stays the pipe).
- `confirmation_send_mode: "auto_after_payment_truth"` in config describes **trigger logic only**, not authorization to send live WhatsApp (`real_whatsapp_send_gate: separate_gate_or_shadow_mode_until_proven`). Auto-confirm DECISION ≠ live-send AUTHORIZATION.

---

## 2. What the confirmation send gate must require

All must be true before any send (dry-run or live):

| Gate | Rule | Enforcement anchor (today / planned) |
|------|------|--------------------------------------|
| Payment truth exists | Payment row marked `paid` by webhook; `paid_at` set | `handleStripeWebhook` (only paid-writer) |
| Booking paid status | `bookings.payment_status` ∈ {`deposit_paid`, `paid`} | matches `buildPaymentConfirmationDraft` guard |
| Draft exists | `bookings.metadata.confirmation_draft` present | webhook persistence |
| Content correct | address + gate code + room number present; **bed number absent** | draft shape + config flags |
| Live-send gate | `WHATSAPP_DRY_RUN !== 'false'` ⇒ draft-only; live requires explicit env (e.g. future `WHATSAPP_LIVE_SENDS_ENABLED`) **and** Stage 7.8 owner sign-off | n8n IF guards today; **no** live env yet |
| Explicit approval | request `confirm: true` / `send_approved: true` + `requireBotAuth` (bot) or staff session | planned 14c |
| Idempotency | `idempotency_key` + `confirmation_sent_at IS NULL` guard; no duplicate send | legacy SQL guard pattern to reuse |
| Pause / automation gate | `bot_paused === false`, `live_send_blocked === false` | `bot_pause_states` gate |
| Audit log | `appendAuditLog` on every preview/send attempt | existing audit pattern |

---

## 3. What must remain impossible

| Forbidden | Why / enforcement |
|-----------|-------------------|
| Send before webhook payment truth | No draft exists until webhook sets `deposit_paid`/`paid`; gate requires draft + paid |
| Send from Stripe link creation alone | `handleBotPaymentCreateStripeLink` sets `checkout_created` only — no draft, no paid |
| Send when booking unpaid | Gate requires `payment_status` ∈ {`deposit_paid`,`paid`} |
| Duplicate confirmation send | `confirmation_sent_at IS NULL` guard + idempotency key |
| Bed number to guest | Draft excludes bed code; config `include_bed_number:false`; verifier asserts absence |
| Send while WhatsApp live disabled | `WHATSAPP_DRY_RUN` default true ⇒ dry-run draft only |
| n8n activation without approval | Workflows `active:false`; no activation API in Luna path; Stage 7.8 owner gate |
| n8n owning confirmation truth | Staff API must own `confirmation_sent_at`; n8n is pipe only |

---

## 4. Suggested future routes (no implementation in 14a)

| Route | Purpose | Writes |
|-------|---------|--------|
| `POST /staff/bot/bookings/:id/confirmation-preview` | Read-only: return `confirmation_draft` + safety flags + content proof | **None** |
| `POST /staff/bot/bookings/:id/send-confirmation` | Gated send (dry-run default) | `confirmation_sent_at` only after live send success |

Alternative: reuse/extend the legacy n8n `Wolfhouse - Send Confirmation` as the **pipe**, but the **decision + truth write** must live in Staff API, not n8n.

---

## 5. Recommended first implementation slice — Phase 14b

**14b: read-only `confirmation-preview` route/helper (no send).**

- Input: booking id or `booking_code`.
- Output: `confirmation_draft` + safety flags + content assertions.
- Proves: `address`, `gate_code` (`2684#`), `room_number` present; **`bed_number` absent**.
- Returns `sends_whatsapp:false`, `no_n8n:true`, `confirmation_sent:false`, `dry_run:true`.
- **No send. No DB write. No n8n. No Stripe.**

Files likely touched (14b): `scripts/lib/luna-confirmation-preview.js` (new helper), `scripts/staff-query-api.js` (read-only route), `scripts/verify-luna-agent-phase14-confirmation-preview.js` (new), `package.json`.

---

## 6. Later send slice (Phase 14c) requirements — NO_GO until approved

- Explicit `confirm` / `send_approved` approval on request.
- WhatsApp live-send env gate (new `WHATSAPP_LIVE_SENDS_ENABLED` or equivalent) **plus** Stage 7.8 owner sign-off.
- **Dry-run default**: live only when env explicitly flipped.
- Idempotency: `idempotency_key` + `confirmation_sent_at IS NULL`.
- `confirmation_sent_at` updated **only after** send success (Staff API owns the write).
- No n8n live send unless workflow explicitly activated with approval.

---

## 7. Verifiers that must protect it

| Guarantee | Verifier check |
|-----------|----------------|
| Cannot send unpaid booking | gate requires `deposit_paid`/`paid` |
| Cannot send before webhook payment truth | draft only exists post-webhook |
| Cannot send duplicate | `confirmation_sent_at IS NULL` + idempotency |
| Confirmation excludes bed number | assert no bed code in draft/preview output |
| Confirmation includes room number + address + gate code | assert present in draft/preview |
| Dry-run returns draft only | `sends_whatsapp:false`, `confirmation_sent:false` |
| `WHATSAPP_DRY_RUN` blocks live send | default true ⇒ no live send |

**14a plan verifier:** `verify:luna-agent-phase14-confirmation-gates-plan` (this doc's static anchor).
**14b verifier (future):** `verify:luna-agent-phase14-confirmation-preview`.

---

## 8. Explicit stop conditions

**STOP — do not proceed to send slice if:**

1. Phase 11/12/13 closeouts fail.
2. Any path can set `confirmation_sent_at` without webhook payment truth.
3. Preview/draft ever includes a bed code/bed number.
4. Live WhatsApp env/owner Stage 7.8 approval not granted — **never send live in 14a/14b**.
5. n8n would own the confirmation truth write instead of Staff API.
6. Idempotency guard missing — duplicate-send risk.

**STOP — escalate ambiguity (do not guess):**

- No Staff API confirmation route exists yet (must be designed in 14b before any send).
- No `WHATSAPP_LIVE_SENDS_ENABLED` env exists (live send uses `WHATSAPP_DRY_RUN` + pause gate + Stage 7.8 today).
- Legacy n8n `Send Confirmation` is currently the only `confirmation_sent_at` writer — Staff API ownership is a gap to close in 14c.

---

## 9. Phase map

| Phase | Scope | Sends |
|-------|-------|-------|
| **14a** | This plan + plan verifier | None |
| **14b** | Read-only `confirmation-preview` route/helper | None |
| **14c** | Gated send | **NO_GO** until Stage 7.8 owner approval |
