# Crowsnest AI usage adapter (Slice 3)

Pure, offline adapter that maps native OpenAI / Anthropic technical usage fields into a validated `crowsnest.ai_usage.v1` event. Builds on the Slice 2 contract; **does not persist**, call the network, wire provider runtimes, or touch Staff API / Crowsnest UI.

## Goal

- Accept an explicit trusted tenant context plus deterministic call metadata.
- Adapt success/failure outcomes into contract-valid events.
- Keep provider content, PII, secrets, and raw error payloads out of the event.

## Non-goals

- No storage, ledger, database, or migration.
- No import into Luna AI call sites, Staff API, Hermes, or Crowsnest API/UI/auth.
- No cost computation, price tables, or pricing configuration.
- No inference of `client_slug` / `tenant_id` from env, request objects, or provider payloads.

## Trusted context (required)

Callers must supply, independently:

| Field | Notes |
|-------|--------|
| `client_slug` | Trusted opaque client identity |
| `tenant_id` | Trusted opaque tenant identity (never equated to `client_slug`) |
| `source_service` | Opaque service label |
| `operation` | Opaque operation label |
| `event_id` | Opaque event id |
| `occurred_at` | UTC ISO-8601 with `Z` |
| `latency_ms` | Non-negative safe integer |
| `provider` | `openai` or `anthropic` |

Provider response fields named `client_slug` / `tenant_id` are **ignored**. Missing trusted identity fails closed (`ok: false`).

## Success adaptation

`adaptCrowsnestAiUsageSuccess({ ...context, response, cost? })`

Inspects **only** these native technical fields:

| Provider | Model | Usage fields |
|----------|-------|----------------|
| OpenAI | `response.model` | `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens` |
| Anthropic | `response.model` | `usage.input_tokens`, `usage.output_tokens` (total = exact safe `input + output`) |

Never copies choices, content, messages, prompts, IDs, metadata, errors, headers, request payloads, or arbitrary provider fields.

### Token semantics

- Complete, consistent, safe non-negative integer usage → `tokens.availability = "measured"` (including explicit zeros).
- Missing, partial, negative, fractional, unsafe, inconsistent, or overflow usage → `tokens.availability = "unavailable"` (no fake zeros; no partial measured counts).
- Anthropic totals use exact safe arithmetic only; overflow → unavailable.

### Model fail-closed

`response.model` must already be a contract-safe technical identifier. Absent, blank, whitespace-padded, unsafe, or secret-shaped models return `ok: false` with errors — the adapter never invents a model name.

### Cost

Defaults to `{ state: "unavailable" }`. Optional explicit closed cost input may be:

- `provider_reported` / `estimated` with safe non-negative `amount_micros` and uppercase 3-letter `currency`, or
- `unavailable` with no amount/currency.

Invalid cost shapes fail closed. The adapter never computes cost.

## Failure adaptation

`adaptCrowsnestAiUsageFailure({ ...context, error_code, model })`

- Requires a safe opaque `error_code` only — does **not** accept or copy a raw provider error payload (`error`, `error_message`, `raw_error`, bodies, etc. are ignored if present).
- Requires an explicit safe `model` (no successful response model to read).
- Forces `tokens.availability = "unavailable"` and `cost.state = "unavailable"` (any `cost` input is ignored).

## Result shape

Every call returns either:

- `{ ok: true, event }` where `event` has already passed `validateCrowsnestAiUsageEvent`, or
- `{ ok: false, errors: string[] }` (no event).

## Verify

```bash
npm run verify:crowsnest-ai-usage-adapter
```

Synthetic provider fixtures live under `fixtures/crowsnest-ai-usage-adapter/` and intentionally include content/PII-shaped strings in provider payloads to prove non-leakage into events.
