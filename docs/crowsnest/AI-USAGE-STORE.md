# Crowsnest AI usage durable store (ledger foundation)

Secret-free **append-only ledger** for validated `crowsnest.ai_usage.v1` product AI usage events. Builds on the contract (and later adapter/source slices). **Does not** wire production call sites, open DB pools, expose API routes, or change Spyglass UI.

## Goal

- Persist only contract-valid technical receipts.
- Deduplicate on opaque `event_id` (`ON CONFLICT DO NOTHING`).
- Keep `client_slug` and `tenant_id` as independent columns.

## Non-goals

- No migration apply / Azure credential wiring in this slice.
- No import of `pg` into `crowsnest-api`; callers inject a query-capable `db`.
- No JSON blob, prompt, response, guest, booking, conversation, message, email, phone, raw provider payload, account, or credential columns.
- No Spyglass UI or read API in this slice.

## Migration

`database/migrations/050_crowsnest_ai_usage_events.sql` creates `crowsnest_ai_usage_events` with:

- unique `event_id` primary key
- `occurred_at`, `client_slug`, `tenant_id`, `source_service`, `operation`
- `provider`, `model`, `status`, nullable opaque `error_code`
- `tokens_availability` plus nullable measured token counts (null when unavailable — never fake zeros)
- `latency_ms`, `cost_state`, nullable `cost_amount_micros` / `cost_currency`
- indexes on `occurred_at`, `(tenant_id, occurred_at)`, `(client_slug, occurred_at)`, `(provider, occurred_at)`
- CHECKs aligned with contract status / token / cost relationships

## Store API

```js
const { recordCrowsnestAiUsageEvent } = require('./crowsnest-ai-usage-store');

const result = await recordCrowsnestAiUsageEvent({ db, event });
// { ok: true, inserted: boolean } | { ok: false, errors: string[] }
```

1. Run `validateCrowsnestAiUsageEvent` **before** any SQL.
2. Parameterized `INSERT ... ON CONFLICT (event_id) DO NOTHING` only.
3. Never mutate the input event.
4. Database failures return a safe `{ ok: false, errors: ['store_write_failed'] }` (no connection strings or raw driver messages).

## Verify

```bash
npm run verify:crowsnest-ai-usage-store
```
