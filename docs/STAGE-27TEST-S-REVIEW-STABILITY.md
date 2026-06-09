# Stage 27test-s — Review dry-run stability diagnostics

## Why this exists

Hosted full torture runs (~565 review-only HTTP calls over ~30 minutes) occasionally return **HTTP 500** from the Staff API. Failed fixture IDs differ between runs, and manual retries of the same payload succeed — indicating **intermittent infrastructure instability under sustained load**, not Luna logic bugs.

This stage adds:

1. **Structured server-side error logging** on review dry-run 500s (`LUNA_REVIEW_DRY_RUN_ERROR`)
2. **Optional `--retry-500` in the torture runner** to separate transient 500s from real Luna failures
3. **Request correlation** (`run_id`, `fixture_id`) for log search

No production behavior changes. No writes, Stripe, WhatsApp, Meta, or n8n.

---

## Endpoints instrumented

- `POST /staff/bot/guest-automation-review-dry-run`
- `POST /staff/bot/guest-inbound-review-dry-run`

On catch/500, the server logs one JSON line to stderr with marker `LUNA_REVIEW_DRY_RUN_ERROR`. Stack traces are **server-side only** — client responses remain safe (no stack).

---

## Run hosted torture (no retry — default)

Default behavior is **no retry** (`--retry-500` defaults to `0`). Use this first to measure raw infra stability:

```bash
npm run luna:guest-torture -- --base-url https://staff-staging.lunafrontdesk.com --endpoint
```

Expect JSON/text report with `passed`, `failed`, and HTTP 500 counters at zero unless failures occur.

---

## Run hosted torture with retry

If 500s occur, rerun with up to 2 retries (backoff 500ms, then 1500ms):

```bash
npm run luna:guest-torture -- --base-url https://staff-staging.lunafrontdesk.com --endpoint --retry-500 2
```

Report fields:

| Field | Meaning |
|-------|---------|
| `initial_http_500_count` | Requests that returned 500 (or network reset) on first attempt |
| `recovered_http_500_count` | Those that succeeded after retry |
| `unrecovered_http_500_count` | Still failed after all retries |
| `passed` / `failed` | Final logical pass/fail (recovered 500s count as pass) |

Recovered 500s are **not** Luna logic failures but should trigger infra follow-up if non-zero.

---

## Search logs for errors

After deploying diagnostics to staging, search Azure/container logs for:

```
LUNA_REVIEW_DRY_RUN_ERROR
```

Each line is JSON with: `endpoint`, `correlation_id`, `run_id`, `fixture_id`, `client_slug`, `channel`, `guest_phone_masked`, `message_length`, `error_name`, `error_message`, `error_stack`, `elapsed_ms`.

Example (Azure CLI):

```bash
az containerapp logs show -n wh-staging-staff-api -g <resource-group> --tail 500 | grep LUNA_REVIEW_DRY_RUN_ERROR
```

---

## Demo gate (acceptable thresholds)

| Criterion | Required |
|-----------|----------|
| Logical torture pass | **565/565** |
| Unrecovered HTTP 500 | **0** |
| Recovered HTTP 500 | Rare OK for logic confidence; **infra follow-up required** |

Do not proceed to WhatsApp demo wiring until hosted torture is **565/565** with **0 unrecovered HTTP 500**.

---

## Local verification

```bash
npm run verify:stage27test-s-review-stability
npm run verify:stage27test-l-torture-generator
npm run luna:guest-torture -- --local --limit 100
npm run luna:guest-golden -- --local
npm run luna:guest-flow-batch -- --local --fixture-set booking-core
```

---

## Staging deploy and proof

1. **Deploy diagnostics** — build/push Staff API image with this commit and route 100% traffic to the new revision.

2. **Full hosted torture without retry:**
   ```bash
   npm run luna:guest-torture -- --base-url https://staff-staging.lunafrontdesk.com --endpoint
   ```

3. **If 500s occur, rerun with retry:**
   ```bash
   npm run luna:guest-torture -- --base-url https://staff-staging.lunafrontdesk.com --endpoint --retry-500 2
   ```

4. **Search logs:**
   ```bash
   az containerapp logs show -n wh-staging-staff-api -g <resource-group> --tail 500 | grep LUNA_REVIEW_DRY_RUN_ERROR
   ```
