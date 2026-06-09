# Stage 27test-l — Luna Guest Torture Test Generator

**Status:** IMPLEMENTED  
**Verifier:** `npm run verify:stage27test-l-torture-generator`  
**Generate:** `npm run luna:guest-torture:generate`  
**Run:** `npm run luna:guest-torture`

Large deterministic torture suite (500+ cases) for Luna guest inbound/simulator review **before n8n wiring**. Default mode is **review-only** — no hold/draft writes, Stripe, WhatsApp, Meta, or n8n.

---

## Files

| File | Role |
|------|------|
| `scripts/generate-luna-guest-torture-fixtures.js` | Deterministic fixture generator (seed `27100`) |
| `scripts/fixtures/generated-luna-guest-torture.json` | Generated cases (commit after regen) |
| `scripts/run-luna-guest-torture-tests.js` | Bulk runner + scoring report |
| `scripts/verify-stage27test-l-torture-generator.js` | Static verifier |

Reuses helpers from `run-luna-guest-golden-tests.js` and `run-luna-guest-flow-batch.js`.

---

## Generate fixtures

```bash
npm run luna:guest-torture:generate
# or
node scripts/generate-luna-guest-torture-fixtures.js --output scripts/fixtures/generated-luna-guest-torture.json
```

**Category targets (565 total):**

| Category | Count |
|----------|------:|
| booking_intake_single | 150 |
| multi_turn_booking | 100 |
| multilingual | 75 |
| package_explainer | 50 |
| payment | 50 |
| service_addon | 40 |
| transfer | 40 |
| cancel_change_refund | 30 |
| weird_off_topic_angry | 30 |

Languages: EN, IT, ES, DE, FR, mixed.

---

## Run locally (review-only)

```bash
npm run verify:stage27test-l-torture-generator

# Sample
npm run luna:guest-torture -- --local --limit 50

# By category
npm run luna:guest-torture -- --local --category booking_intake_single --limit 20

# JSON report
npm run luna:guest-torture -- --local --limit 100 --json
```

**Mode:** `--local` uses inbound review (single) and orchestrator dry-run (flows) without HTTP. No DB writes on single-message local path; flows use read-only availability when `DATABASE_URL` is set.

---

## Run hosted (review-only)

```bash
export LUNA_BOT_INTERNAL_TOKEN=...
npm run luna:guest-torture -- \
  --base-url https://staff-staging.lunafrontdesk.com \
  --endpoint \
  --limit 100
```

Endpoint mode assigns unique `guest_phone` / idempotency keys per case (same hygiene as golden runner).

---

## Scoring report

Console / JSON includes:

- total / passed / failed / pass rate %
- pass rate by category and language
- top failure reasons
- first 20 failures (id, message, lane, action, reason)
- banned-term hits
- hallucination-risk hits
- safety-flag failures

---

## Safety expectations (every case)

- `banned_reply_terms_absent`
- `must_not_confirm_booking` (no confirmation without payment truth)
- `must_not_claim_payment_received` (no payment truth from guest text)
- `must_not_invent_availability` (no invented availability without check)
- Response safety flags: `dry_run:true`, `sends_whatsapp:false`, `live_send_blocked:true`, `no_write_performed:true`

Hallucination-risk phrases (e.g. “booking is confirmed”, “payment received”) are flagged.

---

## Score thresholds (before live public wiring)

| Scope | Target |
|-------|--------|
| **Overall torture pass rate** | **≥ 95%** |
| **Booking core categories** (`booking_intake_single`, `multi_turn_booking`, `multilingual`) | **≥ 98%** |
| **Dangerous safety failures** (banned terms, hallucination-risk, safety flags) | **100% none** |

Failures in torture are expected to drive router/intake tuning — not all 565 cases use strict lane assertions. Categories like `service_addon` and `transfer` use `accept_lanes` where routing may legitimately vary.

---

## Related

- Golden runner: [STAGE-27TEST-A-GOLDEN-RUNNER.md](STAGE-27TEST-A-GOLDEN-RUNNER.md)
- Flow batch: [STAGE-27TEST-D-FLOW-BATCH.md](STAGE-27TEST-D-FLOW-BATCH.md)
- Inbound review: [STAGE-27X1-GUEST-INBOUND-REVIEW.md](STAGE-27X1-GUEST-INBOUND-REVIEW.md)

**Next:** Run full local/hosted torture baselines → tune failures → then 27x.2 n8n pipe wiring (disabled/dry-run).
