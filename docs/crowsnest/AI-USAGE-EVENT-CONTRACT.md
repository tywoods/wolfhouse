# Crowsnest AI usage event contract (v1)

Secret-free, tenant-aware **event shape + pure validator** for future Crowsnest AI usage telemetry. This slice defines the contract only.

## Goal

- Own a stable `crowsnest.ai_usage.v1` event schema under Crowsnest.
- Validate events offline with a closed, privacy-preserving schema.
- Keep `client_slug` and `tenant_id` as separate required identity fields.

## Non-goals (this slice)

- No storage, ledger, database table, or migration.
- No runtime wiring into Luna AI call sites, Staff API, Hermes, or Crowsnest UI.
- No network calls, provider SDKs, or hardcoded model prices.
- No inference, normalization, or mapping between `client_slug` and `tenant_id`.

## Field table

| Field | Required | Notes |
|-------|----------|--------|
| `schema_version` | yes | Must be `crowsnest.ai_usage.v1` |
| `event_id` | yes | Opaque safe identifier |
| `occurred_at` | yes | UTC ISO-8601 with `Z`; optional 1–3 fractional second digits; must be a real calendar instant (canonical UTC component round-trip — values Date.parse would normalize, e.g. Feb 30, are rejected) |
| `client_slug` | yes | Non-empty safe identifier (independent of `tenant_id`) |
| `tenant_id` | yes | Non-empty safe identifier (independent of `client_slug`) |
| `source_service` | yes | Opaque service label |
| `operation` | yes | Opaque operation / call label |
| `provider` | yes | `openai` or `anthropic` |
| `model` | yes | Opaque model id string |
| `status` | yes | `succeeded` or `failed` |
| `error_code` | when failed | Opaque safe code only; forbidden on success |
| `tokens` | yes | See token semantics |
| `latency_ms` | yes | Non-negative `Number.isSafeInteger` (rejects values above `Number.MAX_SAFE_INTEGER`) |
| `cost` | yes | See cost semantics |

Closed schema: unknown top-level or nested fields are rejected.

## Privacy policy

Events must not carry guest/operator content or secrets. Forbidden key names (any nesting, case-insensitive) include: actor, guest, booking, conversation, session, thread, prompt, response, message(s), transcript, phone, email, name, api_key, secret, password, authorization, cookie(s), metadata, payload, credential(s), access/refresh/private key material, and raw error message/body fields.

Secret-shaped string values (for example `sk-…`, `sk-ant-…`, `Bearer …`) are rejected. Fixtures use only synthetic identifiers.

## Trusted tenant requirement

Emitters must supply **trusted** `client_slug` and `tenant_id` from an authenticated tenant context. The contract treats both as required opaque fields and does **not** derive one from the other. Today many AI call sites lack that trusted context, so this slice does not attach to provider call sites.

## Token semantics

- `tokens.availability = "measured"`: require non-negative `Number.isSafeInteger` fields `input_tokens`, `output_tokens`, `total_tokens` with `total_tokens === input_tokens + output_tokens`. Measured zeros are allowed only under `measured`.
- `tokens.availability = "unavailable"`: only `availability` is allowed. Do **not** fake zeros to mean “unknown”.

## Cost semantics

- `cost.state = "provider_reported"` or `"estimated"`: require `amount_micros` (non-negative `Number.isSafeInteger`) and uppercase ISO-4217 `currency`.
- `cost.state = "unavailable"`: only `state` is allowed (no amount/currency).
- This slice never embeds model price tables; cost values must be supplied by a later adapter from provider data or an explicit estimator.

## First-source discovery conclusion

Independent discovery found **no** existing Crowsnest usage store or production token/cost ledger.

`scripts/lib/luna-ai-provider.js` is a **future first-source candidate**: OpenAI and Anthropic JSON responses pass through `callLunaAiJsonChat`, but that helper currently returns assistant text only and discards usage metadata. This slice intentionally does **not** adapt that source, because call sites do not consistently supply trusted tenant context.

## Next slice

Adapt provider result into this event shape **without persisting**, and only after a trusted tenant-context design exists for emitters. Storage / Spyglass UI remain later work.

## Verify

```bash
npm run verify:crowsnest-ai-usage-contract
```
