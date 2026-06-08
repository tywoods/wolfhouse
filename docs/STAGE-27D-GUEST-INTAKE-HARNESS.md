# Stage 27d — Guest Intake Dry-Run Test Harness

**Status:** PASS — local verifier (2026-06-08).  
**Script:** `scripts/run-guest-intake-dry-run.js`  
**Endpoint:** `POST /staff/bot/guest-intake-dry-run` ([STAGE-27C-GUEST-INTAKE-ENDPOINT.md](STAGE-27C-GUEST-INTAKE-ENDPOINT.md))  
**Verifier:** `npm run verify:stage27d-guest-intake-harness`

**Non-negotiables:** Manual HTTP harness only · no deploy · no DB writes · no Stripe · no WhatsApp · no Meta · no n8n · no payment links · no live guest automation.

---

## 1. Purpose

Quickly exercise the Stage 27c guest intake dry-run endpoint against **local** or **staging** Staff API with readable summary output — no UI, no n8n, no outbound guest messages.

---

## 2. npm scripts

```bash
# Run harness (pass CLI args after --)
npm run guest:intake:dry-run -- --fixture en-booking

# Static verifier (no network)
npm run verify:stage27d-guest-intake-harness
```

---

## 3. Auth

Same pattern as `scripts/proof-luna-booking-dry-run-route.js`:

| Env | Purpose |
|-----|---------|
| `LUNA_BOT_INTERNAL_TOKEN` | Sent as `X-Luna-Bot-Token` on POST |
| `STAFF_API_BASE_URL` | Default base URL when `--base-url` omitted |

Load from `infra/.env` when present (via `dotenv`).

**Local:** Start Staff API (`npm run staff:api` → usually `http://127.0.0.1:3036`). If `STAFF_AUTH_REQUIRED` is not true and no token is configured, open auth may work without a token.

**Staging:** Set `LUNA_BOT_INTERNAL_TOKEN` from Key Vault / staging secrets. Example base: `https://staff-staging.lunafrontdesk.com`.

If you get **HTTP 401** without a token on staging, set `LUNA_BOT_INTERNAL_TOKEN` and retry — the harness will not print the token.

---

## 4. CLI options

| Flag | Description |
|------|-------------|
| `--base-url <url>` | Staff API base (default `http://localhost:3000`; env `STAFF_API_BASE_URL` overrides) |
| `--message "..."` | Guest message text |
| `--language-hint <code>` | Optional `en` · `it` · `es` · `de` · `fr` |
| `--reference-date <YYYY-MM-DD>` | Optional date anchor for parsing |
| `--guest-phone <e164>` | Optional guest phone |
| `--fixture <name>` | Built-in example (see below) |
| `--json` | Print full JSON instead of summary |
| `--help` | Usage |

---

## 5. Built-in fixtures

| Name | Scenario |
|------|----------|
| `en-booking` | English new booking inquiry |
| `it-booking` | Italian booking inquiry |
| `es-transfer` | Spanish transfer question |
| `de-wetsuit` | German wetsuit/board request |
| `fr-unclear` | French unclear booking question |
| `cancel-refund` | Cancellation/refund request |
| `payment-balance` | Payment/balance question |
| `checkin-info` | Check-in / house info |
| `general-random` | General / policy question |

---

## 6. Local example

Terminal 1:

```bash
npm run staff:api
```

Terminal 2:

```bash
npm run guest:intake:dry-run -- \
  --base-url http://127.0.0.1:3036 \
  --fixture en-booking
```

Sample summary lines:

```
message_lane:         new_booking_inquiry
intake_state:         collecting_required_details
proposed_luna_reply:  Hi! I'm Luna from Wolfhouse 🌊 …
dry_run:              true
sends_whatsapp:       false
live_send_blocked:    true
```

---

## 7. Staging example

```bash
# infra/.env or shell:
# LUNA_BOT_INTERNAL_TOKEN=<from Key Vault>
# STAFF_API_BASE_URL=https://staff-staging.lunafrontdesk.com

npm run guest:intake:dry-run -- --fixture es-transfer
npm run guest:intake:dry-run -- --message "I'd like to pay now please" --json
```

---

## 8. Safety

The harness only **POSTs JSON** to `/staff/bot/guest-intake-dry-run`. It does not:

- Write to Postgres
- Call Stripe
- Send WhatsApp / Meta messages
- Activate n8n workflows
- Create payment links

Exit code **0** = HTTP 200 and `success: true` with expected safety flags on `result`.

---

## 9. Verification

```bash
npm run verify:stage27d-guest-intake-harness
```

**Next:** **Stage 27e** — optional hosted proof script against staging (still dry-run, no live send).
