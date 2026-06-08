# Stage 27a — Guest Intake Design Lock

**Status:** DESIGN LOCK — docs only (2026-06-08).  
**Parent:** Stage 27 — Guest AI intake / extraction  
**Prior:** Phase 26 — Staff Portal operations (transfers, services, payments) **COMPLETE ENOUGH / PASS**  
**Next:** Stage 27b — read-only intake extractor + dry-run harness (no live send)

**Non-negotiables (27a):** No runtime code. No DB writes. No deploy. No Stripe calls. No WhatsApp. No Meta. No n8n activation. No live guest AI path.

**Context:** Stage 26 built staff-facing transfer, service, and payment operations. Stage 27 is the first **client-facing Luna / guest intake** design. Guest booking WhatsApp remains **NO_GO**. Live WhatsApp, production Meta/n8n, guest automation, and payment-link sending stay disabled unless explicitly approved.

**Related docs:** [STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md](STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md) · [PHASE-26-AIRPORT-TRANSFERS-DESIGN.md](PHASE-26-AIRPORT-TRANSFERS-DESIGN.md) · [PHASE-15.1-LUNA-MESSAGE-INTAKE-EXTRACTION-PLAN.md](PHASE-15.1-LUNA-MESSAGE-INTAKE-EXTRACTION-PLAN.md) · [PHASE-9.1-BOT-PAUSE-RESUME-DESIGN.md](PHASE-9.1-BOT-PAUSE-RESUME-DESIGN.md)

---

## 1. Purpose

Define the **guest intake state machine**, required fields, safe staff handoff cases, dry-run reply path, shared-engine rules, language/tone, transfer/service capture, payment-link policy, no-live-send gates, and staging proof plan — before any guest-facing runtime work.

Stage 27a is **design lock only**. Implementation slices (27b+) must not send WhatsApp, activate n8n, or deliver payment links to guests without explicit go/no-go.

---

## 2. Guest intake states

Each guest conversation thread carries an **`intake_state`** (logical; persistence TBD in 27b). States are monotonic within a booking attempt unless staff resets or a new inquiry starts.

| State | Meaning | Typical Luna action (dry-run) |
|-------|---------|-------------------------------|
| `inquiry_received` | First or returning message recognized as Wolfhouse booking interest | Greet; identify language; ask what dates/guests they have in mind |
| `collecting_required_details` | Missing one or more required fields for next gate | Ask targeted follow-ups (dates, guest count, package, contact) |
| `ready_for_availability_check` | Minimum fields present to call Staff API availability | Internal: call `/staff/bot/availability-check` (dry-run path); draft “checking beds…” reply |
| `availability_checked` | Availability result known (`has_enough_beds`, `selected_bed_codes`, blockers) | Explain availability or alternate dates; proceed toward quote if beds found |
| `quote_ready` | Quote computed via shared engine; amounts not invented in prompt | Present quote summary from engine output; explain deposit vs full |
| `payment_choice_needed` | Guest must choose deposit or full amount (or cash/bank on arrival for balance) | Ask deposit or full; explain remaining balance options |
| `hold_payment_draft_ready` | Booking/hold + payment draft prepared but **not sent** | Draft reply includes checkout URL placeholder or “link ready for staff review” — **no live link send** |
| `payment_pending` | Payment link issued (future slice) or guest told to pay; awaiting Stripe webhook truth | Remind gently; never claim paid until webhook truth |
| `confirmed_after_payment_truth` | Webhook marked deposit/full paid; confirmation draft available | Draft confirmation copy from engine/metadata — **no live send in 27a** |
| `staff_handoff_required` | Automation stops; staff owns thread | Draft handoff note; set needs-human; preserve partial extraction |

**State transitions (summary):**

```
inquiry_received
  → collecting_required_details (missing fields)
  → ready_for_availability_check (fields complete)
ready_for_availability_check → availability_checked
availability_checked → quote_ready (beds + quote engine OK)
  → staff_handoff_required (unclear availability / policy / low confidence)
quote_ready → payment_choice_needed
payment_choice_needed → hold_payment_draft_ready (draft link created, not sent)
hold_payment_draft_ready → payment_pending (future: after explicit GO + link send)
payment_pending → confirmed_after_payment_truth (webhook only)
any → staff_handoff_required (handoff triggers in §4)
```

---

## 3. Required fields before gates

All field validation and pricing must come from **Staff API shared engine** responses — not LLM-invented values.

### 3.1 Before quote (`quote_ready`)

| Field | Required | Notes |
|-------|----------|-------|
| `check_in` | ✓ | ISO date; half-open stay semantics |
| `check_out` | ✓ | ISO date |
| `guest_count` | ✓ | Integer ≥ 1 |
| `package_code` or explicit non-package/custom stay | ✓ | Wolfhouse packages from config; custom/shorter stay path allowed |
| `room_type` | ✓ | `shared` or `private` (Wolfhouse MVP) |
| `client_slug` | ✓ | Tenant scope (e.g. `wolfhouse-somo`) |
| `guest_phone` | ✓ | E.164 from WhatsApp thread when available |

Optional at quote time (improve reply quality): `guest_name`, `guest_email`, `add_ons` interest (not confirmed paid), transfer interest (§7).

### 3.2 Before hold (`hold_payment_draft_ready`)

Everything in §3.1, plus:

| Field | Required | Notes |
|-------|----------|-------|
| `availability_checked` | ✓ | `has_enough_beds: true` with `selected_bed_codes` |
| `payment_choice` | ✓ | `deposit` or `full_amount` |
| `guest_name` | ✓ | For booking record |
| `guest_email` | ✓ | For booking record |

Hold = booking row + draft payment row via shared create path (gated; dry-run may stop before write in early slices).

### 3.3 Before payment draft / link (`hold_payment_draft_ready` → link generation)

Everything in §3.2, plus:

| Field | Required | Notes |
|-------|----------|-------|
| `booking_id` / `booking_code` | ✓ | From gated create |
| `payment_id` | ✓ | Draft payment row |
| `payment_link_amount_cents` | ✓ | From engine — deposit or full per choice |
| Explicit **go/no-go** for link send | ✓ | Stage 27a: link generation may run in harness; **send to guest disabled** |

### 3.4 Before confirmation (`confirmed_after_payment_truth`)

| Field | Required | Notes |
|-------|----------|-------|
| Payment webhook truth | ✓ | `payments.status = paid`; booking `payment_status` updated |
| `amount_paid_cents` | ✓ | From webhook, not guest claim |
| Assigned beds / room context | ✓ | From booking + `booking_beds` |
| Confirmation draft | ✓ | From `buildPaymentConfirmationDraft()` / metadata — **send gated separately** |

Guest-stated “I paid” is **never** sufficient. Confirmation language only after payment truth.

---

## 4. Safe handoff cases (`staff_handoff_required`)

Luna must **not** auto-continue guest automation when any case below applies. Response flags: `staff_handoff_required: true`, `live_send_blocked: true`, `handoff_reason: <code>`, draft preserved for staff.

| Code | Trigger |
|------|---------|
| `paid_cancellation_or_reschedule` | Guest wants to cancel or move dates after payment truth |
| `date_change_different_nights` | Date change alters night count / repricing beyond simple move |
| `unclear_availability` | Engine returns ambiguous blockers, partial fits, or staff-only overrides needed |
| `uncertain_package_or_pricing` | Package unclear, custom quote, or engine `requires_reprice` / warnings |
| `transfer_exception` | Bilbao/Santander edge case, manual override, or flight lookup failure needing staff |
| `bilbao_no_package_request` | Guest wants Bilbao transfer without package — policy: unavailable; staff exception path |
| `bad_weather_lesson_refund` | No-waves / lesson refund / goodwill compensation — policy + human judgment |
| `low_confidence_language_or_intent` | Extractor confidence below threshold or mixed intents |
| `outside_policy_question` | Guest asks something outside published policy (discounts, pets, exceptions, legal) |
| `payment_state_mismatch` | Guest claims paid but DB/webhook disagrees; duplicate payment; wrong amount |

**Staff Ask Luna** and **Pause Luna** (Phase 9) remain independent — handoff does not block staff tools.

---

## 5. Dry-run guest reply path

Stage 27a defines the **target shape** for a read-only / dry-run pipeline. No live send in this stage.

```
Inbound guest message (WhatsApp text — NOT connected live in 27a)
  ↓
Staff API intake interpreter (future: POST /staff/bot/guest-intake-dry-run)
  ↓ structured interpretation:
      intent, extracted_fields, intake_state, missing_fields,
      confidence, handoff_reason?, engine_calls[]
  ↓
Shared engine calls (read-only or gated dry-run):
      booking-preview · availability-check · quote-preview
      (optional gated: booking-create + payment draft — harness only)
  ↓
Proposed Luna reply:
      reply_draft, next_action, intake_state
  ↓
Response envelope (always):
      sends_whatsapp: false
      live_send_blocked: true
      whatsapp_sent: false
      no_write_performed: true   (27a / early 27b default)
      payment_link_sent: false
      calls_n8n: false
```

**Explicit prohibitions (27a):**

- No live send to guest
- No WhatsApp outbound
- No Meta / Graph API activation
- No n8n workflow activation
- No payment link sent to guest (URL may appear in `reply_draft` for staff review only)

Pause gate (Phase 9): if Luna paused for conversation → same dry-run output but `bot_paused: true`.

---

## 6. Shared engine rule

**Luna guest intake must use the Staff API booking / pricing / payment engine.** The LLM layer extracts intent and fields only; it does **not** own business truth.

| Concern | Source of truth | Guest AI must NOT duplicate |
|---------|-----------------|------------------------------|
| Package prices | `calculateWolfhouseQuote()` / config | Hard-coded package totals in prompts |
| Deposits | Engine `deposit_required_cents` | €200/€100 in prompt logic |
| Transfer prices | Transfer config + quote engine | Santander/Bilbao amounts in prompts |
| Service prices | Pricing config + service records path | Wetsuit/lesson/yoga prices in prompts |
| Availability | `/staff/bot/availability-check` | “We have beds” without engine call |
| Payment truth | Stripe webhook + `payments` / `bookings` rows | Guest message or LLM assumption |

**Allowed pattern:** LLM → structured JSON → Staff API endpoint → engine response → LLM formats **reply_draft** from engine numbers only.

**Forbidden pattern:** LLM computes total, deposit, or availability inline and skips engine.

See [STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md](STAGE-8.5.1-LUNA-BOT-SHARED-ENGINE-INTEGRATION-MAP.md).

---

## 7. Language and tone

| Rule | Detail |
|------|--------|
| Baseline | English |
| Supported guest languages | Italian, Spanish, German, French |
| Reply language | Match guest language when **confident**; otherwise English with gentle offer to continue in their language |
| Tone | Warm, welcoming — Cami / Wolfhouse voice |
| Identity | **Luna from Wolfhouse** (surf house Somo; not generic “AI assistant”) |
| Avoid | Robotic disclaimers, over-apologizing, inventing policies, promising unavailable transfers |

Multilingual routing may reuse patterns from Staff Ask Luna (normalize, accent strip) — but guest intake intents are **separate** from staff ops intents.

---

## 8. Transfer and service capture

### 8.1 Transfer interest (structured extraction)

Capture when guest mentions airport pickup, flight, or transfer:

| Field | Capture |
|-------|---------|
| `transfer_interest` | boolean |
| `airport_code` | `SDR` / `BIO` / unknown |
| `city_or_origin` | free text if no airport code |
| `direction` | `arrival` / `departure` / both |
| `flight_number` | optional |
| `flight_date` | optional — paired with flight number for lookup |
| `flight_time` | optional — from guest or future lookup |
| `transfer_notes` | free text |

**Stage 26 rules apply:** flight number alone does not determine date; Bilbao without package → handoff (`bilbao_no_package_request`); Santander package included vs €25 non-package — engine/config decides price.

Luna may **acknowledge** transfer interest in dry-run reply; transfer rows are written via staff or future gated write — not confirmed in guest chat alone.

### 8.2 Service interest (wetsuit, board, lesson, yoga)

Capture structured **interest** only:

| Service | Fields |
|---------|--------|
| Wetsuit / board rental | `service_type`, `rental_days` or dates, quantity |
| Surf lesson | `service_type`, preferred date(s), quantity |
| Yoga | `service_type`, preferred date(s), quantity |

**Services do not become confirmed paid items** until proper quote / payment / `booking_service_records` flow (Stage 8.8 Flow A/B). Guest chat “yes add yoga” → intake metadata only until staff or gated create path runs.

Meals: on-site only — record interest, no Stripe link in guest flow (existing rule).

---

## 9. Payment-link rules

| Rule | Detail |
|------|--------|
| Choice | Ask **deposit** or **full amount** before link draft |
| Weekly package deposit | **€200** (`20000` cents) — from engine when package qualifies |
| Custom / shorter stay deposit | **€100** (`10000` cents) — from engine |
| Remaining balance | May be **cash**, **bank transfer**, or **Stripe on arrival** — explain in reply; do not pressure full prepay unless guest chooses |
| Confirmation | Only after **payment truth** / proper `payment_status` — never on link creation alone |
| Live link send | Requires **explicit go/no-go** — disabled in Stage 27a |

Payment link amount always from `payments.amount_due_cents` after engine create — never from client body or LLM.

---

## 10. No-live-send gates

All gates default **OFF** for guest automation in Stage 27a:

| Gate | Stage 27a |
|------|-----------|
| Live WhatsApp sends | **Disabled** |
| Production Meta / WhatsApp Business API | **Disabled** |
| Production / guest n8n workflows | **Disabled** |
| Guest automation (auto-reply loop) | **Disabled** |
| Payment link sending to guest | **Disabled** unless explicitly approved |

Existing env flags remain authoritative: `WHATSAPP_DRY_RUN`, bot pause, `BOT_BOOKING_ENABLED`, live-send checklists (Phase 18). Stage 27 slices add intake-specific dry-run endpoints — they inherit these gates.

---

## 11. Staging proof plan

### 11.1 Now (Stage 27a) — docs-only proof

- [x] Design lock doc: [STAGE-27A-GUEST-INTAKE-DESIGN.md](STAGE-27A-GUEST-INTAKE-DESIGN.md)
- [x] Static verifier: `npm run verify:stage27a-guest-intake-design`
- [x] PROJECT-STATE + ROADMAP pointers

No runtime proof in 27a.

### 11.2 Later — dry-run fixture harness (Stage 27b)

- Fixture messages (EN/ES/IT/DE/FR): first inquiry, dates+g guests, package question, transfer mention, payment choice
- Expected: `intake_state`, `missing_fields`, `reply_draft`, `sends_whatsapp: false`
- No DB writes in first harness slice

### 11.3 Later — endpoint harness (Stage 27c)

- `POST /staff/bot/guest-intake-dry-run` (name TBD): inbound message → structured state → proposed reply
- Bot token auth; read-only default
- Hosted staging proof with inactive n8n

### 11.4 Later — controlled booking / quote / payment draft tests (Stage 27d+)

- Gated create on staging disposable bookings only
- Stripe test-mode link generation without guest delivery
- Webhook truth → confirmation draft — no WhatsApp send

---

## 12. Out of scope (Stage 27a)

- Runtime extractor implementation
- DB schema / migrations for intake state
- n8n workflow changes
- WhatsApp / Meta integration
- Live payment link delivery
- Confirmation send to guest
- Production deploy

---

## 13. Suggested slice map (reference only)

| Slice | Focus |
|-------|-------|
| **27a** | Design lock (this doc) |
| **27b** | Read-only extractor + fixture harness |
| **27c** | Dry-run API endpoint + static verifier |
| **27d** | Gated booking/payment draft harness (staging, no send) |
| **27e+** | n8n pipe wiring, live-send gates, pilot |

---

## 14. Safety summary

| Rule | Stage 27a |
|------|-----------|
| Docs only | ✓ |
| No runtime guest path | ✓ |
| No DB | ✓ |
| No deploy | ✓ |
| No Stripe | ✓ |
| No WhatsApp / Meta | ✓ |
| No n8n activation | ✓ |
| Shared engine for all money/availability truth | ✓ |
| Live WhatsApp | **NO_GO** |
