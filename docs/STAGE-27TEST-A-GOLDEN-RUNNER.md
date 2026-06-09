# Stage 27test-a — Luna Guest Golden Message Runner

**Status:** IMPLEMENTED (2026-06-08)  
**Parent:** [STAGE-27X1-GUEST-INBOUND-REVIEW.md](STAGE-27X1-GUEST-INBOUND-REVIEW.md) · [STAGE-27X-LITE-INBOUND-REVIEW-WIRING-DESIGN.md](STAGE-27X-LITE-INBOUND-REVIEW-WIRING-DESIGN.md)  
**Verifier:** `npm run verify:stage27test-a-golden-runner`  
**Harness:** `npm run luna:guest-golden`

Bulk golden-message test runner for Luna guest-facing inbound review. Runs **128** curated cases against the Stage **27x.1** inbound review path in **review-only mode** — no live WhatsApp, Stripe, booking/hold/payment writes, Meta, or n8n.

---

## Files

| File | Role |
|------|------|
| `scripts/fixtures/luna-guest-golden-messages.json` | 128 golden cases |
| `scripts/run-luna-guest-golden-tests.js` | Bulk runner + report |
| `scripts/verify-stage27test-a-golden-runner.js` | Static verifier |

---

## Categories

| Category | Examples |
|----------|----------|
| `booking_en` / `booking_it` / `booking_es` / `booking_de` / `booking_fr` | Package interest, full one-message bookings |
| `booking_partial_missing_dates` | Guest count + package, no dates |
| `booking_partial_missing_guest_count` | Dates + package, no count |
| `booking_partial_missing_package` | Dates + count, accommodation-only / no package |
| `booking_full_one_message` | Complete intake in one message |
| `payment_before_quote` | "Pay now" / payment link before quote |
| `payment_choice_after_quote` | Deposit/full with prior quote `guest_context` |
| `payment_balance` | Remaining balance questions |
| `service_addon` | Surf lesson, wetsuit, yoga |
| `transfer` | Airport pickup / Santander / Bilbao edge |
| `checkin_faq` | Check-in time, wifi, luggage |
| `cancel_change` | Cancel, refund, reschedule |
| `angry_unclear` / `off_topic` | Complaints, gibberish, policy edge |
| `mixed_typo` | Cross-language typos |
| `existing_booking` | Messages with booking code |

Each case includes:

```json
{
  "id": "en-book-01",
  "category": "booking_en",
  "language": "en",
  "message_text": "...",
  "guest_context": {},
  "expected": {
    "message_lane": "new_booking_inquiry",
    "booking_intake_ready": false,
    "required_missing_fields": ["dates"],
    "handoff_required": false,
    "proposed_next_action": "ask_missing_details",
    "banned_reply_terms_absent": true
  }
}
```

Optional `expected` fields are enforced only when present.

---

## Local usage

```bash
# Verifier only (commit gate)
npm run verify:stage27test-a-golden-runner

# Run all cases locally (no server — uses runGuestInboundReviewDryRun without DB)
npm run luna:guest-golden -- --local

# Sample run
npm run luna:guest-golden -- --local --limit 20

# Filter
npm run luna:guest-golden -- --local --language en --category booking_en
npm run luna:guest-golden -- --local --category payment_before_quote --fail-fast

# JSON report
npm run luna:guest-golden -- --local --limit 10 --json
```

**Mode selection:**

| Condition | Mode |
|-----------|------|
| `--local` | Local function (no HTTP, no DB writes) |
| `--endpoint` | HTTP to `--base-url` |
| Default | HTTP if `LUNA_BOT_INTERNAL_TOKEN` set; else local |

---

## Staging usage

```bash
export LUNA_BOT_INTERNAL_TOKEN=...
npm run luna:guest-golden -- \
  --base-url https://staff-staging.lunafrontdesk.com \
  --endpoint \
  --limit 50
```

**Endpoint hygiene (27test-j):** Each case gets a unique `guest_phone`, `inbound_message_id`, and `idempotency_key` scoped by `--run-id` (default `auto`). This avoids stale staging inbound cache from reusing one shared phone. Local mode keeps a fixed deterministic phone. Override with `--phone-prefix +34600997` and `--run-id my-smoke-1` if needed. Fixtures may set explicit `guest_phone` / `inbound_message_id` only for idempotency replay tests.

Staging runs may persist review artifacts via existing **27x.1** conversation metadata (review-only). No booking/hold/payment writes.

---

## Pass / fail report

Console summary:

```
── Luna Guest Golden Test Report ──
Mode:     local
Total:    128
Passed:   112
Failed:   16

Failures by category:
  booking_it: 4
  mixed_typo: 2

Failures by language:
  it: 4
  en: 12

First failure detail:
  id:      it-book-09
  message: Prenotazione Malibu ...
  reason:  booking_intake_ready expected true got false
  actual:  lane=new_booking_inquiry action=ask_missing_details missing=["dates"]
```

Each failure includes:

- First failing expectation
- Actual `message_lane`, `proposed_next_action`, `missing_required_fields`
- Banned internal terms found in `proposed_luna_reply` (if any)
- Safety flag failures (`dry_run`, `sends_whatsapp`, `live_send_blocked`, `no_write_performed`)

---

## Banned guest reply terms

Replies must **not** leak internal automation vocabulary:

- confirmed quote
- payment choice / payment_choice
- quote_status
- guest_context
- intake_state / readiness_state
- automation gate
- next_safe_step
- dry run
- idempotency
- webhook

---

## Safety limits

| Action | Allowed |
|--------|---------|
| `POST /staff/bot/guest-inbound-review-dry-run` | ✓ (existing 27x.1) |
| Local `runGuestInboundReviewDryRun` without pg | ✓ |
| WhatsApp / Meta / n8n / Stripe | ❌ |
| Hold / payment / booking writes | ❌ |
| New public webhook routes | ❌ |

---

## Next steps

1. Run full golden suite locally and tune expectations where router behavior drifts.
2. Add failing cases to CI once staging token available (`--limit` smoke first).
3. Wire n8n (27x.2) only after golden pass rate is acceptable.
