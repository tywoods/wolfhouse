# Stage 27w.3 — Luna Guest Simulator Flow Test Harness

**Status:** PASS — local verifier (2026-06-08).  
**Script:** `scripts/run-luna-guest-simulator-flow.js`  
**Endpoint:** `POST /staff/bot/guest-automation-review-dry-run` ([STAGE-27V-GUEST-AUTOMATION-REVIEW.md](STAGE-27V-GUEST-AUTOMATION-REVIEW.md))  
**Verifier:** `npm run verify:stage27w3-luna-simulator-flow`

**Non-negotiables:** HTTP harness only · no deploy · default review-only · no WhatsApp · no Meta · no n8n · no public guest automation · no live Stripe · hold/draft and Stripe TEST link only with explicit CLI flags.

---

## 1. Purpose

Automate multi-turn Luna guest booking conversations through the existing Staff API simulator review endpoint — chaining `guest_context` across turns so we can hard-test Luna without clicking every turn in the Staff Portal UI.

Builds on Stage 27w (simulator UI), 27w.2 (guest_context merge), and 27v (review dry-run).

---

## 2. npm scripts

```bash
# Run multi-turn flow (pass CLI args after --)
npm run luna:guest-sim:flow -- --fixture booking-deposit

# Static verifier (no network)
npm run verify:stage27w3-luna-simulator-flow
```

---

## 3. Auth

| Env | Purpose |
|-----|---------|
| `LUNA_BOT_INTERNAL_TOKEN` | Sent as `X-Luna-Bot-Token` on POST |
| `STAFF_API_BASE_URL` | Default base URL when `--base-url` omitted |

Load from `infra/.env` when present (via `dotenv`).

**Local:** Start Staff API (`npm run staff:api` → usually `http://127.0.0.1:3036`). Open auth may work without a token when `STAFF_AUTH_REQUIRED` is not true.

**Staging:** Set `LUNA_BOT_INTERNAL_TOKEN` from Key Vault / staging secrets. Base: `https://staff-staging.lunafrontdesk.com`.

Production hosts are blocked by the harness.

---

## 4. CLI options

| Flag | Default | Description |
|------|---------|-------------|
| `--base-url <url>` | `STAFF_API_BASE_URL` or `http://127.0.0.1:3036` | Staff API base |
| `--phone <e164>` | `+34600999999` | Guest phone |
| `--name <text>` | `Staging Test Guest` | Guest name (hold/draft writes) |
| `--email <email>` | `staging-test@wolfhouse.test` | Guest email (hold/draft writes) |
| `--reference-date <iso>` | `2026-06-08` | Date anchor for parsing |
| `--fixture <name>` | `booking-deposit` | Multi-turn flow fixture |
| `--create-hold-draft` | off | Also call `guest-simulator-create-hold-draft` |
| `--create-stripe-test-link` | off | Also call `guest-simulator-create-stripe-test-link` (requires hold draft) |
| `--json` | off | Print full result JSON |
| `--help` | | Usage |

**Default run is review-only** — no hold/draft writes, no Stripe links.

---

## 5. Fixture: `booking-deposit`

| Turn | Message | Expected |
|------|---------|----------|
| 1 | Hi, we are 2 people interested in the Malibu package | `new_booking_inquiry` · `guest_count: 2` · `package_interest: malibu` · asks dates |
| 2 | July 10 to July 17 | preserves count/package · dates present · `booking_intake_ready: true` · `availability_check_attempted: true` · must NOT ask “How many guests?” |
| 3 | Deposit is fine | *(only if prior turn `quote.payment_choice_needed: true`)* · `payment_choice: deposit` · `payment_choice_ready: true` · `next_safe_step: ready_for_hold_payment_draft` |

Each turn uses the prior review as `guest_context` (including `extracted_fields`).

Optional write steps (explicit flags only):

| Step | Endpoint | Expected |
|------|----------|----------|
| Hold/draft | `POST /staff/bot/guest-simulator-create-hold-draft` | `write_status: created` or `reused_existing` · `booking_id` · `payment_draft_id` |
| Stripe TEST | `POST /staff/bot/guest-simulator-create-stripe-test-link` | `stripe_link_created` or `reused` · `stripe_checkout_url` · test mode · no WhatsApp |

---

## 6. Local usage

```bash
npm run staff:api

# Review-only multi-turn flow
npm run luna:guest-sim:flow -- --base-url http://127.0.0.1:3036 --fixture booking-deposit

# JSON output
npm run luna:guest-sim:flow -- --fixture booking-deposit --json
```

---

## 7. Hosted staging usage

```bash
set STAFF_API_BASE_URL=https://staff-staging.lunafrontdesk.com
set LUNA_BOT_INTERNAL_TOKEN=<staging-secret>

npm run luna:guest-sim:flow -- --fixture booking-deposit
```

---

## 8. Write test usage (staging/local only)

```bash
npm run luna:guest-sim:flow -- --fixture booking-deposit --create-hold-draft --create-stripe-test-link
```

Requires payment choice ready from the review chain. Creates staging test hold + payment draft and Stripe TEST checkout URL — **not sent to guest**.

---

## 9. Output

Human-readable per-turn summary, or `--json` with:

- `result`: `PASS` · `PARTIAL` · `FAIL`
- `turns[]`: message, `proposed_luna_reply`, lane/state, extracted fields, availability, quote, payment choice
- `hold_draft` / `stripe_test_link` when flags passed
- `first_failure` with raw JSON excerpt on failure
- Safety: `dry_run`, `sends_whatsapp: false`, `live_send_blocked: true`

`PARTIAL` when a conditional turn (e.g. deposit) is skipped because `payment_choice_needed` was false on the prior turn.

---

## 10. Related docs

- [STAGE-27W-LUNA-GUEST-SIMULATOR.md](STAGE-27W-LUNA-GUEST-SIMULATOR.md) — Staff Portal simulator UI
- [STAGE-27V-GUEST-AUTOMATION-REVIEW.md](STAGE-27V-GUEST-AUTOMATION-REVIEW.md) — review endpoint
- [STAGE-27D-GUEST-INTAKE-HARNESS.md](STAGE-27D-GUEST-INTAKE-HARNESS.md) — single-turn intake harness
