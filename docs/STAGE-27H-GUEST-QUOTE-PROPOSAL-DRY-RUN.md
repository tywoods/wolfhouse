# Stage 27h — Guest Quote Proposal Dry-Run Adapter

**Status:** PASS — local verifier (2026-06-08).  
**Parent:** [STAGE-27F-GUEST-AVAILABILITY-DRY-RUN.md](STAGE-27F-GUEST-AVAILABILITY-DRY-RUN.md) · [STAGE-27E-BOOKING-INTAKE-READINESS.md](STAGE-27E-BOOKING-INTAKE-READINESS.md)  
**Adapter:** `scripts/lib/luna-guest-quote-proposal-dry-run.js`  
**Verifier:** `npm run verify:stage27h-guest-quote-proposal-dry-run`

**Non-negotiables:** No deploy · no booking writes · no holds · no payment drafts/links · no Stripe · no WhatsApp · no Meta · no n8n · no live guest automation.

---

## 1. Purpose

When Stage **27e** intake is ready and Stage **27f** availability returns `available`, this adapter prepares a **dry-run quote proposal** using the existing Staff API pricing engine — without inventing new pricing logic.

---

## 2. Reused helper (do not duplicate)

| Layer | Path |
|-------|------|
| **Adapter** | `runGuestQuoteProposalDryRun(routerResult, availabilityResult, context)` |
| **Delegated helper** | `runBookingPreviewDryRun(fields)` in `scripts/lib/luna-guest-booking-dry-run.js` |
| **Pricing engine** | `calculateWolfhouseQuote()` in `scripts/lib/wolfhouse-quote-calculator.js` |
| **HTTP anchor** | `POST /staff/bot/booking-preview` |
| **Config** | `config/clients/wolfhouse-somo.pricing.json` |

The adapter **only** calls `runBookingPreviewDryRun`. It does **not** embed Formula B, seasonal tables, or deposit tiers.

---

## 3. Gate (when quote runs)

All must be true on `result` + `availability`:

| Field | Value |
|-------|--------|
| `message_lane` | `new_booking_inquiry` |
| `booking_intake_ready` | `true` |
| `readiness_state` | `ready_for_availability_check` |
| `availability.availability_check_attempted` | `true` |
| `availability.availability_status` | `available` |

Otherwise: `quote_proposal_attempted: false`, `quote_status: not_ready` — **no** pricing call.

---

## 4. Input mapping

From router `extracted_fields` only (no invented services):

| Field | Source |
|-------|--------|
| `check_in` / `check_out` | extracted dates |
| `guest_count` | extracted count |
| `package_code` | `package_interest` (`accommodation_only` → `no_package`) |
| `add_ons` | `service_interest` array (objects with `code` only) |
| `transfer_interest` | passed through for summary; transfer price not auto-quoted |
| `room_type` | extracted or default `shared` |

---

## 5. Output fields

| Field | Notes |
|-------|--------|
| `quote_proposal_attempted` | `true` only when gate passed and preview invoked |
| `quote_status` | `not_ready` · `ready` · `needs_staff_review` · `error` |
| `quote_result_summary` | Human-readable summary |
| `quote_total_cents` | From engine when `ready` |
| `deposit_options` | `deposit_required_cents`, weekly €200 / custom €100 tiers |
| `payment_choice_needed` | `true` when `quote_status === ready` |
| `quote_handoff_required` | Staff review / error paths |
| `proposed_luna_reply` | Safe Luna copy |

---

## 6. Deposit / payment-choice behavior

| Stay | Deposit tier (engine) |
|------|------------------------|
| 7-night weekly package | €200 (`standard_package`) |
| Custom / shorter stay | €100 (`custom_or_short_stay`) |

When `quote_status` is `ready`, reply may ask **deposit vs full amount**. Never:

- create payment draft or Stripe link  
- say payment link is ready  
- confirm booking  

---

## 7. Safety limits

| Action | 27h |
|--------|-----|
| Pure quote calculation | ✅ when gated |
| Booking create / hold / payment draft / Stripe | ❌ |
| WhatsApp / Meta / n8n | ❌ |
| `dry_run: true` · `sends_whatsapp: false` · `live_send_blocked: true` | ✅ always |

---

## 8. Verification

```bash
npm run verify:stage27h-guest-quote-proposal-dry-run
```

**Next:** **Stage 27i** — wire quote adapter into guest intake endpoint/harness (gated).
