# Stage 27test-d — Luna Guest Flow Batch Runner

**Status:** IMPLEMENTED (2026-06-09)  
**Parent:** [STAGE-27W3-LUNA-SIMULATOR-FLOW-TESTS.md](STAGE-27W3-LUNA-SIMULATOR-FLOW-TESTS.md) · [STAGE-27TEST-A-GOLDEN-RUNNER.md](STAGE-27TEST-A-GOLDEN-RUNNER.md) · [STAGE-27X1-GUEST-INBOUND-REVIEW.md](STAGE-27X1-GUEST-INBOUND-REVIEW.md)  
**Verifier:** `npm run verify:stage27test-d-flow-batch`  
**Harness:** `npm run luna:guest-flow-batch`

Repeatable batch runner for **multi-turn** Luna guest booking conversations through the existing simulator/review flow. Stresses booking paths beyond one happy path before n8n wiring.

**Default: review-only** — no hold/draft writes, no Stripe, no WhatsApp, no Meta, no n8n.

---

## Files

| File | Role |
|------|------|
| `scripts/fixtures/luna-guest-flow-batch.json` | 26+ multi-turn flow fixtures (`booking-core` set) |
| `scripts/run-luna-guest-flow-batch.js` | Batch runner + per-flow assertions |
| `scripts/verify-stage27test-d-flow-batch.js` | Static verifier |

---

## Endpoints

| Path | Used for |
|------|----------|
| `POST /staff/bot/guest-automation-review-dry-run` | Default simulator multi-turn flows |
| `POST /staff/bot/guest-inbound-review-dry-run` | Inbound idempotency flow (`flow-inbound-idempotent`) |
| `POST /staff/bot/guest-simulator-create-hold-draft` | **Only** with `--create-hold-draft` |
| `POST /staff/bot/guest-simulator-create-stripe-test-link` | **Only** with `--create-hold-draft --create-stripe-test-link` |

---

## npm scripts

```bash
# Static verifier (no network)
npm run verify:stage27test-d-flow-batch

# Review-only batch (local when no token; endpoint when LUNA_BOT_INTERNAL_TOKEN set)
npm run luna:guest-flow-batch -- --fixture-set booking-core --count 10

# Single flow
npm run luna:guest-flow-batch -- --fixture flow-en-malibu-deposit

# Staging review-only
npm run luna:guest-flow-batch -- --base-url https://staff-staging.lunafrontdesk.com --count 5 --endpoint
```

---

## CLI options

| Flag | Default | Description |
|------|---------|-------------|
| `--base-url <url>` | `STAFF_API_BASE_URL` or `http://127.0.0.1:3036` | Staff API base |
| `--local` | off | Force local orchestrator (needs `DATABASE_URL` for availability) |
| `--endpoint` | auto when token set | Force HTTP endpoint mode |
| `--count N` | all matching | Run first N flows |
| `--fixture-set NAME` | `booking-core` | Filter by fixture set |
| `--fixture ID` | | Run single flow by id |
| `--json` | off | JSON report only |
| `--fail-fast` | off | Stop on first flow failure |
| `--create-hold-draft` | off | Hold/draft write for `write_eligible:true` flows only |
| `--create-stripe-test-link` | off | Stripe TEST link (requires hold flag; does not pay checkout) |
| `--phone-prefix PREFIX` | `+34600998` | Unique phone per flow (index appended) |
| `--reference-date DATE` | `2026-06-08` | Date anchor |

---

## Fixture coverage (`booking-core`)

26 flows including:

- EN Malibu deposit / full payment
- EN Uluwatu deposit · Waimea beginner · accommodation only
- Missing guest count / package · dates-first ordering
- Package question mid-flow · cash/bank before deposit · send link after quote
- Service / transfer mid-flow
- IT / ES / DE / FR booking flows
- Typo/slang dates · package/date change before payment
- Unavailable dates · cancel/refund handoff · off-topic mid-flow
- Inbound idempotent replay · one-message full booking

Each flow defines `turns[]` with per-turn `expect` and optional `final_expect`.

---

## Per-flow assertions

- Final lane / `proposed_next_action` / handoff when expected
- `quote_status: ready` when quote-ready path expected
- `payment_choice_ready: true` when payment turn expected
- Banned internal terms absent in replies
- Safety flags: `dry_run`, `sends_whatsapp:false`, `live_send_blocked`, `no_write_performed`
- `must_not_reask` for already-known fields (guest count, dates, package)
- Conditional turns (`quote_payment_choice_needed`) skipped when quote not ready

---

## Write mode (explicit flags only)

```bash
# Hold/draft for write_eligible flows only
npm run luna:guest-flow-batch -- --fixture flow-en-malibu-deposit --create-hold-draft --endpoint

# Stripe TEST link (no checkout payment, no payment truth)
npm run luna:guest-flow-batch -- --fixture flow-en-malibu-deposit --create-hold-draft --create-stripe-test-link --endpoint
```

Requirements for write:

- Flow marked `write_eligible: true`
- Final review has `payment_choice_ready: true` and hold plan ready
- Expect `booking_code` and `payment_draft_id` on success
- Stripe mode additionally expects `stripe_checkout_url` (TEST mode)

---

## Auth

| Env | Purpose |
|-----|---------|
| `LUNA_BOT_INTERNAL_TOKEN` | `X-Luna-Bot-Token` for staging/authenticated hosts |
| `STAFF_API_BASE_URL` | Default base URL |
| `DATABASE_URL` | Required for `--local` availability checks |

Production hosts are blocked by the runner.

---

## Safety

- Default run: review-only orchestrator path
- No WhatsApp send · no Meta · no n8n · no live automation
- Hold/draft and Stripe only with explicit CLI flags
- Stripe TEST link created but checkout not paid; no payment truth applied

---

## Related

- Single-flow harness: [STAGE-27W3-LUNA-SIMULATOR-FLOW-TESTS.md](STAGE-27W3-LUNA-SIMULATOR-FLOW-TESTS.md)
- Single-message golden bulk: [STAGE-27TEST-A-GOLDEN-RUNNER.md](STAGE-27TEST-A-GOLDEN-RUNNER.md)
- Package explainer: commit `0f637fa` (27test-c)
