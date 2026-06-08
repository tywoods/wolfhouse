# Stage 27l — Hold + Payment Draft Design Lock

**Status:** DESIGN LOCK — docs only (2026-06-08).  
**Parent:** [STAGE-27K-PAYMENT-CHOICE-WIRE.md](STAGE-27K-PAYMENT-CHOICE-WIRE.md) · [STAGE-27A-GUEST-INTAKE-DESIGN.md](STAGE-27A-GUEST-INTAKE-DESIGN.md)  
**Prior:** Stage 27k — payment choice wired into guest intake dry-run (**PASS**)  
**Next:** Stage 27m — dry-run hold/payment-draft planner (no writes)

**Non-negotiables (27l):** No runtime code. No deploy. No DB writes. No migrations. No booking writes. No holds. No payment drafts. No Stripe. No payment links. No WhatsApp sends. No Meta. No n8n. No live guest automation.

**Context:** Stages 27b–27k built a read-only guest intake chain: router → readiness → availability → quote → payment choice. Stage **27l** locks the design for the **first state-changing slice**: creating a booking hold and draft payment record after `payment_choice_ready: true`. Implementation is deferred to 27m+.

**Related docs:** [STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md](STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md) · [STAGE-27H-GUEST-QUOTE-PROPOSAL-DRY-RUN.md](STAGE-27H-GUEST-QUOTE-PROPOSAL-DRY-RUN.md) · [STAGE-27J-PAYMENT-CHOICE-DRY-RUN.md](STAGE-27J-PAYMENT-CHOICE-DRY-RUN.md)

---

## 1. Purpose

Define entry gates, objects to create, hold rules, payment draft rules, Stripe link policy, safety/handoff cases, idempotency, Staff Portal visibility, and the staged implementation plan — **before** any guest hold or payment draft runtime work.

Guest booking WhatsApp remains **NO_GO**. Live WhatsApp, production Meta/n8n, guest automation, and payment-link sending stay disabled unless explicitly approved per slice.

---

## 2. Entry gate (all must pass)

Hold + payment draft creation may **only** be attempted when **all** conditions below are true on the combined intake chain (`result`, `availability`, `quote`, `payment_choice`, and validated intake fields):

| Gate | Field / check | Required value |
|------|---------------|----------------|
| G1 | `payment_choice.payment_choice_ready` | `true` |
| G2 | `payment_choice.next_safe_step` | `"ready_for_hold_payment_draft"` |
| G3 | `payment_choice.payment_choice` | `"deposit"` or `"full_payment"` (not arrival question, link request, or unclear) |
| G4 | `quote.quote_status` | `"ready"` |
| G5 | `availability.availability_status` | `"available"` |
| G6 | Intake / booking fields | Still valid at write time (see §2.1) |
| G7 | Explicit slice go/no-go | Hold/payment draft write slice approved (27n+); 27m remains dry-run only |

If any gate fails: **do not create hold or payment draft**. Return safe dry-run/handoff response; preserve chain state for staff review.

### 2.1 Intake / booking fields still valid

Re-validate before write (same rules as Stage 27e + 27h):

| Field | Required |
|-------|----------|
| `message_lane` (prior chain) | `new_booking_inquiry` |
| `check_in` / `check_out` | Present; `check_out > check_in` |
| `guest_count` | Integer ≥ 1 |
| `package_code` or explicit accommodation-only path | Present |
| `room_type` | `shared` or `private` |
| `guest_phone` | E.164 when available from thread |
| `guest_name` | Required before hold write |
| `guest_email` | Required before hold write |

Pricing amounts must come from **shared Staff API engine** (`calculateWolfhouseQuote` / booking preview) — not LLM-invented values. Quote snapshot at hold time must match engine output within tolerance; mismatch → `staff_handoff_required`.

---

## 3. State-changing objects to create (later slices)

When gates pass and an approved write slice runs (27n+), the system creates or updates:

| Object | Description | Source of truth |
|--------|-------------|-----------------|
| **Booking / hold record** | `bookings` row in hold state (`status: hold`, `payment_status: not_paid` or equivalent); `hold_expires_at` set per §4 | Staff API hold path (`main-booking-hold-*` / gated guest create adapter) |
| **Quote / invoice snapshot** | quote/invoice snapshot — immutable line items, totals, deposit tier, package code, dates — attached to booking `metadata` or linked quote table | `calculateWolfhouseQuote` / `runBookingPreviewDryRun` output only |
| **Draft payment record** | `payments` row in draft/unpaid state; amount = deposit or full per `payment_choice` | Shared payment create path; amount from engine |
| **Optional service / transfer line items** | Only from **structured extracted fields** (`service_interest`, `transfer_interest`) — never from free-text invention | Manual booking service record patterns (Stage 26); no auto-confirm paid services until payment truth |

**Not created in 27l or 27m:** Stripe Checkout Session, WhatsApp outbound, Meta send, n8n workflow activation, bed assignment writes (unless explicitly in a later slice).

**Intake state transition (logical):** `payment_choice_needed` → `hold_payment_draft_ready` (objects exist; link not sent).

---

## 4. Hold rules

| Rule | Policy |
|------|--------|
| **Hold expiry** | **6 hours** from hold creation (`hold_expires_at = now + 6 hours`) for guest intake holds |
| **Luna copy** | Luna must **not proactively mention** hold expiry to the guest in standard replies |
| **Expired hold return** | If guest returns after expiry, **re-check availability** before creating a new hold or payment link; never reuse stale availability |
| **Confirmation** | **No booking confirmation** until payment truth (webhook / paid status) — hold alone is not confirmation |
| **Active hold guard** | One active hold per phone + overlapping dates (existing `active_hold_exists` pattern) |
| **Terminal booking codes** | Do not overwrite cancelled / expired / confirmed bookings |

Hold does **not** assign beds permanently; availability selection from Stage 27f informs the hold but bed assignment may remain provisional until payment truth and staff ops (Phase 26 patterns).

---

## 5. Payment draft rules

| Rule | Policy |
|------|--------|
| **Amount basis** | `deposit` or `full_payment` from captured `payment_choice` |
| **Weekly package deposit** | **€200** (`20000` cents) — stays ≥ 7 nights / weekly tier per engine |
| **Custom / shorter stay deposit** | **€100** (`10000` cents) — per engine deposit tier |
| **Full payment** | Uses **quote total** (`quote_total_cents`) from shared engine |
| **Remaining balance** | After deposit, balance may be paid **cash, bank transfer, or Stripe on arrival/check-in** — explain in guest copy when asked; do not auto-create balance link in 27n |
| **Payment truth** | Payment draft is **not payment truth** — `payments.status` remains draft/unpaid until Stripe webhook or staff-recorded truth |
| **Draft vs link** | Draft payment row may exist without Stripe URL; link creation is Stage **27o** |

Deposit/full choice is **locked at hold creation** from `payment_choice`; changing choice after hold requires staff handoff or explicit re-plan path.

---

## 6. Stripe link rules

| Rule | Policy |
|------|--------|
| **Link creation timing** | **Later slice** (Stage **27o**) — not part of 27l/27m/27n |
| **Link send go/no-go** | Sending a link to a guest requires **explicit go/no-go** approval per environment |
| **Default** | **No live guest WhatsApp send** by default |
| **Payment received claims** | Luna must **not claim payment is received** until webhook/payment truth |
| **Reply safety** | Never say “payment link is ready” or “booking is confirmed” in automated guest copy until approved slice + truth |

27n may create hold + draft payment **without** Stripe link. 27o may create test-mode Checkout Session without WhatsApp send.

---

## 7. Safety / handoff cases

Automation must **stop and hand off** (`staff_handoff_required: true`, no hold/draft write) when:

| Code | Trigger |
|------|---------|
| `availability_changed_before_hold` | Availability no longer `available` at write time |
| `quote_changed_before_draft` | Recomputed quote differs from prior snapshot (dates, package, totals) |
| `payment_state_mismatch` | Existing booking/payment state conflicts with new hold/draft |
| `paid_cancellation_or_reschedule` | Guest wants cancel/reschedule after payment truth |
| `guest_refund_request` | Guest asks for refund |
| `transfer_exception` | Transfer cannot be priced or scheduled from structured fields alone |
| `unclear_service_line_items` | Service/transfer interest ambiguous — cannot map to catalog codes |
| `write_failure` | Any DB or API write failure during hold or payment draft |
| `hold_expired_recheck_failed` | Guest returned after hold expiry and availability re-check failed |
| `idempotency_conflict` | Idempotency key conflict with divergent payload |
| `missing_guest_identity` | `guest_name` or `guest_email` missing at write gate |

Preserve partial chain state and audit log for staff. Staff Portal inbox/conversation should show handoff reason.

---

## 8. Idempotency

Repeated guest messages (e.g. multiple “deposit is fine”) must **not** create duplicate holds or draft payments.

| Mechanism | Policy |
|-----------|--------|
| **Idempotency key** | Derive from stable tuple: `client_slug` + `guest_phone` + `check_in` + `check_out` + `payment_choice` + intake attempt id (or conversation thread id when available) |
| **Reuse active draft/hold** | If an **active non-expired hold** and matching **draft payment** already exist for the same idempotency scope, return existing records — no duplicate INSERT |
| **Audit / log events** | Required for every hold/draft attempt: `hold_created`, `hold_reused`, `payment_draft_created`, `payment_draft_reused`, `hold_payment_skipped`, `hold_payment_handoff`, `idempotency_replay` |
| **Dry-run (27m)** | Planner outputs `would_create_hold`, `would_create_payment_draft`, `idempotency_action` (`create` \| `reuse` \| `skip`) — **no writes** |

---

## 9. Staff Portal visibility

| Surface | Requirement |
|---------|-------------|
| **Staff API / queries** | Hold and draft payment visible on booking record after 27n write slice |
| **Booking drawer — Payments tab** | Eventually shows draft payment state, amount (deposit/full), status (draft/unpaid), and link URL when 27o creates one |
| **Booking drawer — Overview** | Hold status, `hold_expires_at` (staff-only; not shown to guest proactively) |
| **Inbox / Luna thread** | Staff can review proposed hold/payment plan from 27m dry-run before approving 27n write |
| **Pre-send review** | Staff can review before any live WhatsApp payment link send (27o+ with explicit GO) |

Staff Portal remains source of operational truth; guest Luna path must not bypass staff visibility for state-changing actions.

---

## 10. Future implementation plan

| Stage | Scope | Writes | Stripe | WhatsApp |
|-------|--------|--------|--------|----------|
| **27l** (this doc) | Design lock only | ❌ | ❌ | ❌ |
| **27m** | Dry-run hold/payment-draft **planner** — outputs plan, idempotency action, handoff flags | ❌ | ❌ | ❌ |
| **27n** | Gated **staging write** for hold + payment draft | ✓ hold + draft | ❌ | ❌ |
| **27o** | Stripe **test** Checkout link creation | ✓ | ✓ test mode | ❌ |
| **27p** | Webhook / **payment truth** confirmation path | ✓ status updates | ✓ webhook | ❌ (confirmation send still gated) |

Each slice requires its own verifier, docs update, and explicit go/no-go before the next.

### 27m planner output (preview)

Planned fields (no writes): `hold_plan_attempted`, `hold_plan_status`, `would_create_hold`, `would_create_payment_draft`, `planned_deposit_cents`, `planned_payment_amount_cents`, `idempotency_action`, `hold_payment_handoff_required`, `hold_payment_handoff_reasons`, `proposed_luna_reply` (safe; no confirmation/link-ready claims).

### 27n write gate (preview)

Requires: 27m plan `ready` + staging GO + all §2 gates + idempotency clear.

### 27p confirmation (preview)

Only after `payments.status = paid` (or deposit_paid where policy allows partial confirmation). Confirmation **send** remains separately gated.

---

## 11. Shared engine rule (unchanged)

All amounts, deposit tiers, line items, and availability must come from **Staff API shared engine** — not duplicated in guest AI prompts or Luna adapters.

| Layer | Path |
|-------|------|
| Quote / preview | `runBookingPreviewDryRun` → `calculateWolfhouseQuote` |
| Availability | `runGuestAvailabilityDryRun` → bed calendar queries |
| Hold execute (future) | `main-booking-hold-plan` / Staff API gated hold endpoint |
| Payment draft (future) | Shared payment create path aligned with manual booking flow |

Guest adapters **plan and gate**; they do **not** own business truth.

---

## 12. No-live-send gates (27l lock)

| Gate | Status |
|------|--------|
| Live WhatsApp sends to guests | **Disabled** |
| Production Meta / n8n guest automation | **Disabled** |
| Payment link sending to guests | **Disabled** unless explicit GO in 27o+ |
| Booking confirmation to guests | **Disabled** until payment truth + explicit send GO |
| Runtime hold/payment draft code | **Not in 27l** — design only |

Dry-run paths (27b–27k, future 27m) remain `dry_run: true`, `sends_whatsapp: false`, `live_send_blocked: true`.

---

## 13. Staging proof plan (later)

1. **27m:** Local verifier + harness for hold/payment plan output (no DB).
2. **27n:** Staging hold + draft payment write proof with test guest phone; verify Staff Portal visibility.
3. **27o:** Stripe test Checkout URL created; not sent via WhatsApp.
4. **27p:** Simulated or test webhook → payment truth → confirmation draft (send still gated).

**27l proof now:** static doc verifier only — `npm run verify:stage27l-hold-payment-draft-design`.

---

## 14. Verifier

```bash
npm run verify:stage27l-hold-payment-draft-design
```

Static checks: doc sections §2–§10, safety phrases, future stages 27m–27p, no runtime claims.
