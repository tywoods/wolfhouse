# Stage 27t — Guest Automation Gate Design Lock

**Status:** DESIGN LOCK — docs only (2026-06-08).  
**Parent:** [STAGE-27S-CONFIRMATION-LIVE-SEND-ALLOWLIST.md](STAGE-27S-CONFIRMATION-LIVE-SEND-ALLOWLIST.md) · [STAGE-27A-GUEST-INTAKE-DESIGN.md](STAGE-27A-GUEST-INTAKE-DESIGN.md) · [PHASE-9.1-BOT-PAUSE-RESUME-DESIGN.md](PHASE-9.1-BOT-PAUSE-RESUME-DESIGN.md)  
**Prior proven chain:** Stage **27q** confirmation preview dry-run · **27r** confirmation send go/no-go · **27s** live-send allowlist · **27s.1** hosted allowlisted WhatsApp send proof (`WHATSAPP_DRY_RUN` restored to `true`)  
**Next:** Stage **27u** — guest automation orchestrator dry-run (no live send)

**Non-negotiables (27t):** No runtime code. No deploy. No DB writes. No Stripe. No WhatsApp sends. No Meta. No n8n activation. **No public guest automation wired yet.**

**Context:** Stages 27b–27s.1 built and proved a discrete guest booking/payment/confirmation chain on Staff API helpers — preview (27q), send go/no-go (27r), allowlisted live send (27s/27s.1). **Public/client-facing Luna guest intake is not wired.** Stage **27t** locks the **automation gate** design before any orchestrator or inbound WhatsApp routing connects to that chain.

**Related docs:** [STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md](STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md) · [STAGE-27Q-CONFIRMATION-PREVIEW.md](STAGE-27Q-CONFIRMATION-PREVIEW.md) · [STAGE-27R-CONFIRMATION-SEND-GO-NO-GO.md](STAGE-27R-CONFIRMATION-SEND-GO-NO-GO.md) · [STAGE-27L-HOLD-PAYMENT-DRAFT-DESIGN.md](STAGE-27L-HOLD-PAYMENT-DRAFT-DESIGN.md)

---

## 1. Purpose

Define entry gates, guest automation states, required fields, handoff cases, source-of-truth rules, send policy, and the staged implementation plan — **before** wiring public/client-facing Luna guest intake or connecting inbound WhatsApp to the proven 27q–27s chain.

Guest booking WhatsApp automation remains **NO_GO** for public traffic. Draft replies and dry-run orchestration may be built in 27u+; live guest sends remain blocked except explicit allowlisted proof slices.

---

## 2. Proven chain (do not bypass)

| Stage | Capability | Live send |
|-------|------------|-----------|
| **27q** | `runGuestConfirmationPreviewDryRun` — confirmation preview from `confirmation_draft` | ❌ |
| **27r** | `runGuestConfirmationSendGoNoGo` — explicit `confirm_send` gate | ❌ default (`WHATSAPP_DRY_RUN=true`) |
| **27s** | `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` — recipient allowlist when dry-run off | Allowlisted proof only |
| **27s.1** | Hosted staging proof — one allowlisted WhatsApp confirmation | ✓ proof only; dry-run restored |

The orchestrator (27u+) must **call these helpers** — not reimplement confirmation copy, send logic, or payment truth.

---

## 3. Entry gates (all must pass before automation advances)

Automation may **only** proceed when **all** applicable gates below pass. Any failure → safe dry-run reply or `staff_handoff_required`; no state-changing writes unless an approved write slice (27n–27p) explicitly allows it.

| Gate | Check | Required / policy |
|------|-------|-------------------|
| **G1** | `client_slug` | Valid tenant (e.g. `wolfhouse-somo`); unknown slug → block |
| **G2** | `channel` | Supported inbound channel only (e.g. `whatsapp`); unsupported → handoff |
| **G3** | Guest vs staff/owner phone routing | Guest thread only for automation; staff/owner numbers route to staff tools or block guest chain |
| **G4** | Pause/resume state | `bot_pause_states.paused = false` (Phase 9); paused → `bot_paused:true`, draft preserved, no automation advance |
| **G5** | Human takeover state | No active `needs_human` / staff takeover on thread; if staff owns thread → automation stops |
| **G6** | `WHATSAPP_DRY_RUN` / live-send state | Default `true`; live send only when dry-run off **and** allowlist/env GO explicitly set for proof slice |
| **G7** | Allowlisted live-send proof rules | When `WHATSAPP_DRY_RUN=false`: `LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST` must include recipient; empty allowlist → fail closed (27s) |
| **G8** | Public automation master switch | **OFF** until Stage 27x+ explicit GO; 27t–27w remain dry-run or staff-review only |

If any gate fails: return safe response with `live_send_blocked: true`, `sends_whatsapp: false`, preserve partial state for staff review.

---

## 4. Guest automation states

Logical `automation_state` / `next_safe_step` values for the orchestrator. States align with proven 27b–27s helpers; monotonic within a booking attempt unless staff resets or handoff occurs.

| State | Meaning | Typical action (dry-run default) |
|-------|---------|----------------------------------|
| `intake_only` | Message received; routing/classification only | Classify intent; no engine writes |
| `collect_required_details` | Missing required fields for next gate | Ask targeted follow-ups |
| `ready_for_availability` | Minimum fields for availability check | Call availability dry-run / engine |
| `ready_for_quote` | Availability OK; ready for quote engine | Call quote dry-run; present engine totals |
| `ready_for_payment_choice` | Quote ready; need deposit vs full | Capture `payment_choice` |
| `ready_for_hold_payment_draft` | Payment choice captured; hold/draft gate (27l/27n) | Plan or gated write per approved slice |
| `ready_for_stripe_link_go_no_go` | Hold + draft exist; Stripe link slice (27o) | Create test link; **no guest send** until GO |
| `ready_for_confirmation_preview` | Payment truth recorded (27p); preview gate (27q) | `runGuestConfirmationPreviewDryRun` |
| `ready_for_confirmation_send_go_no_go` | Preview ready (27q); send gate (27r/27s) | `runGuestConfirmationSendGoNoGo`; live send blocked by default |
| `staff_handoff_required` | Automation stops; staff owns thread | Draft handoff note; preserve extraction |

**Transition summary:**

```
intake_only → collect_required_details | ready_for_availability
collect_required_details → ready_for_availability (fields complete)
ready_for_availability → ready_for_quote | staff_handoff_required
ready_for_quote → ready_for_payment_choice | staff_handoff_required
ready_for_payment_choice → ready_for_hold_payment_draft
ready_for_hold_payment_draft → ready_for_stripe_link_go_no_go (27n+)
ready_for_stripe_link_go_no_go → (payment truth 27p) → ready_for_confirmation_preview
ready_for_confirmation_preview → ready_for_confirmation_send_go_no_go (27q ready)
ready_for_confirmation_send_go_no_go → (27r/27s; default no live send)
any → staff_handoff_required (§6)
```

---

## 5. Required fields before quote / hold / payment

All validation and amounts from **Staff API shared engine** — Luna must **not** invent prices, availability, or payment state.

### 5.1 Before quote (`ready_for_quote`)

| Field | Required | Notes |
|-------|----------|-------|
| `check_in` | ✓ | ISO date |
| `check_out` | ✓ | `check_out > check_in` |
| `guest_count` | ✓ | Integer ≥ 1 |
| `package_code` or explicit **no-package / accommodation-only** intent | ✓ | Must be structured, not inferred prices |
| `room_type` | ✓ | `shared` or `private` (MVP) |
| `client_slug` | ✓ | Tenant scope |

### 5.2 Before hold / payment draft (`ready_for_hold_payment_draft`)

Everything in §5.1, plus:

| Field | Required | Notes |
|-------|----------|-------|
| `availability_status` | ✓ | `available` with selected beds from engine |
| `payment_choice` | ✓ | `deposit` or `full_payment` |
| `guest_name` | ✓ | Before payment link / hold write |
| `guest_email` | ✓ | Before payment link / hold write |
| `guest_phone` | ✓ | E.164 from thread when available |

### 5.3 Transfer / service interest

| Rule | Policy |
|------|--------|
| Capture interest | `service_interest`, `transfer_interest` from structured extraction only |
| Pricing | **Never invent** transfer/service prices in Luna copy |
| Line items | Map to catalog codes via Staff API; unclear → handoff |
| Bilbao policy | Bilbao transfer under 4 guests without staff override → handoff (§6) |

### 5.4 Unpaid states — must not preview as confirmed

| Status | Policy |
|--------|--------|
| `waiting_payment`, `checkout_created`, `draft`, `not_requested` | No confirmation preview as paid; no “booking confirmed” copy |
| Guest payment claim without webhook | Handoff — payment claim not found |

---

## 6. Handoff cases (`staff_handoff_required`)

Automation must **stop** when any case applies. Flags: `staff_handoff_required: true`, `live_send_blocked: true`, `handoff_reason: <code>`, draft preserved.

| Code | Trigger |
|------|---------|
| `ambiguous_dates_or_guests` | Unclear check-in/out, overlapping messages, or guest count ambiguity |
| `unavailable_or_conflicting_beds` | Engine returns no beds, partial fit, or bed conflict |
| `paid_cancellation_or_reschedule` | Cancel or date change after payment truth |
| `refund_or_cash_refund_request` | Guest asks for refund or cash refund |
| `angry_guest_or_escalation` | Hostile tone, threats, repeated complaints — human judgment |
| `staff_room_assignment_conflict` | Manual staff assignment conflicts with automation plan |
| `bilbao_under_four_no_override` | Bilbao transfer requested with &lt; 4 guests without staff override |
| `unsupported_airport_or_flight_mismatch` | Airport/flight data unsupported or inconsistent with transfer rules |
| `uncertain_package_or_pricing` | Package unclear, custom quote, or engine warnings / reprice required |
| `payment_claim_not_found` | Guest claims paid; webhook/DB disagree |
| `repeated_failed_clarification` | Multiple clarification loops without resolving required fields |
| `low_language_confidence` | Extractor/language confidence below threshold |

Staff Ask Luna and Pause Luna (Phase 9) remain independent — handoff does not block staff tools.

---

## 7. Source-of-truth rules

| Layer | Role |
|-------|------|
| **Staff API** | **Brain** — intake interpretation, gates, engine calls, orchestration, audit |
| **n8n** | **Pipe** — inbound/outbound message transport when explicitly activated; not business logic owner |
| **Stripe webhook** | **Payment truth** — `payments.status`, booking `payment_status`; guest claims insufficient |
| **Shared booking/pricing/payment engine** | Quote, availability, hold, payment draft, confirmation draft — single engine paths |

**Luna must never invent:**

- Availability or bed assignments
- Prices, deposits, or line items
- Payment state (“you are paid”) without webhook truth
- Room assignment beyond engine/staff truth
- Flight times or transfer schedules not from structured lookup

Guest adapters **plan, gate, and draft** — they do **not** own business truth.

---

## 8. Send policy

| Rule | Policy |
|------|--------|
| **Public live guest sends** | **Not wired yet** — master NO_GO until 27x+ explicit product GO |
| **Draft replies** | Allowed in dry-run / staff-review paths (`sends_whatsapp: false`, `live_send_blocked: true`) |
| **Live sends** | Only in **explicit allowlisted proof slices** (27s.1 pattern); never default for public traffic |
| **Confirmation send** | Remains gated by **27r** (`confirm_send:true`) + **27s** (allowlist when dry-run off) |
| **Payment links** | No live guest WhatsApp payment-link send until explicit GO (27o+ pattern) |
| **Default env** | `WHATSAPP_DRY_RUN=true` after any proof; staging restored post-27s.1 |

Orchestrator outputs must always expose: `sends_whatsapp`, `live_send_blocked`, `confirmation_send_allowed` (false until 27r GO path).

---

## 9. Next stage sequence

| Stage | Scope | Public automation | Live WhatsApp |
|-------|--------|-------------------|---------------|
| **27t** (this doc) | Design lock only | ❌ | ❌ |
| **27u** | Guest automation **orchestrator dry-run** — wires intake states to 27b–27q helpers; no inbound public loop | ❌ | ❌ |
| **27v** | **Staff Portal** guest automation review surface — proposed replies, state, handoff reasons | ❌ | ❌ |
| **27w** | **Allowlisted guest live-send proof** — mirrors 27s.1 for full guest path segment | ❌ public | ✓ allowlisted proof only |
| **27x** | **Limited staging guest automation** — explicit GO; staging tenant only | Staging only | Gated |
| **Production** | Later — **explicit go/no-go** only; not implied by 27t–27x | Product GO | Product GO |

Each slice requires its own verifier, docs update, and explicit go/no-go before the next.

---

## 10. Staff Portal visibility (27v preview)

| Surface | Requirement |
|---------|-------------|
| Inbox thread | Show `automation_state`, `next_safe_step`, handoff reasons |
| Proposed reply | Staff can review/edit before any future live send |
| Pause / takeover | Phase 9 pause + needs-human visible and respected |
| Booking drawer | Hold, payment draft, confirmation preview from orchestrator chain |

---

## 11. No-live-send gates (27t lock)

| Gate | Status |
|------|--------|
| Public guest automation wired | **Disabled — not wired yet** |
| Live WhatsApp to guests | **Disabled** (default dry-run) |
| Production Meta / n8n guest loop | **Disabled** |
| Confirmation live send | **27r/27s gated**; 27s.1 proved allowlisted path only |
| Runtime orchestrator code | **Not in 27t** — design only |

Dry-run paths remain: `sends_whatsapp: false`, `live_send_blocked: true`, `no_write_performed: true` unless an approved write slice explicitly performs writes.

---

## 12. Verifier

```bash
npm run verify:stage27t-guest-automation-gate-design
```

Static checks: doc sections §3–§9, proven chain 27q/27r/27s/27s.1, safety phrases, future stages 27u–27x, no runtime claims.
