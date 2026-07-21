# Crowsnest AI usage source instrumentation (Slice 4)

Write-free **opt-in observer** on the shared Luna AI provider plus a pure **trusted dual-identity gate** that can adapt technical snapshots into `crowsnest.ai_usage.v1` events via the existing adapter. Builds on Slice 2 (contract) and Slice 3 (adapter). **Does not persist**, call the network, wire Staff / owner / guest callers, or turn on runtime telemetry by default.

## Audit result

Independent first-source audit concluded **`none_qualifies`**.

Every production AI path funnels through `callLunaAiJsonChat` (`scripts/lib/luna-ai-provider.js`), which previously returned assistant text only and discarded native `usage` / response `model`. No production caller currently supplies **both** required trusted identities (`client_slug` and `tenant_id`) at the AI call boundary:

- `tenant_id` is absent from all AI modules.
- Primary live client `wolfhouse-somo` baseline has `client_slug` without `tenant_id`.
- Other baselines may list both fields, but AI call sites never load them; equal strings must not be inferred as equivalence.
- Closest candidate (customer outreach draft) has ACL-trusted `client_slug` and a good operation label, but still no `tenant_id` and previously no usage metadata at the caller.

Therefore this slice **does not select a live emitter**. Runtime remains disabled until a caller can pass the opt-in observer **and** an authenticated dual-identity context.

## What this slice adds

1. **Optional per-call observer** on `callLunaAiJsonChat`: `onUsageObservation` (default no-op). Never global / never default-on. When omitted, the provider does not build snapshots and does not call an injected `nowMs` clock (historical return/throw path preserved).
2. Observer receives a **closed technical-only snapshot**: `provider`, request/response model (safe own-data), native usage own-data fields only (safe non-negative integers; invalid numerics omitted), `latency_ms`, `call_label`, `status`, and opaque safe `error_code` on failure.
3. Observer errors are **isolated** — synchronous throws and returned thenable/Promise rejections — and cannot alter AI return / throw behavior (`Promise<string|null>` and existing HTTP/network/parse throw semantics preserved). Snapshot construction and latency measurement run inside the same isolation boundary. The provider does not await the observer.
4. Pure helper `scripts/lib/crowsnest/crowsnest-ai-usage-observer.js`: requires explicit own-data `client_slug` and `tenant_id` as separate trusted inputs; never reads env or provider payloads for identity; fails closed on missing / accessor / inherited / unsafe identity; invokes `adaptCrowsnestAiUsageSuccess` / `adaptCrowsnestAiUsageFailure`; only forwards contract-valid events to an injected in-memory callback; callback failures (sync + thenable/Promise) isolated without awaiting; **no persistence**.

## Activation prerequisites

Before any production caller may emit:

1. Authenticated path supplies **both** `client_slug` and `tenant_id` as independent trusted own-data fields (no env inference, no equating, no baseline silent fill).
2. Caller passes `onUsageObservation` explicitly (opt-in) and routes snapshots through the dual-identity helper with an injected sink.
3. Privacy review confirms no content / PII / secret leakage in snapshots or events.
4. Separate later work owns storage / Spyglass UI — not this slice.

## Non-goals

- No DB / ledger / migration / storage / Spyglass UI.
- No Staff API / Hermes / Crowsnest UI runtime emit wiring.
- No cost / price tables.
- No changing `callLunaAiJsonChat` return type to objects.
- No blanket instrumentation of all shared-provider callers.
- No equating or inferring `client_slug` ↔ `tenant_id`.
- No network / provider SDK installs in this slice.

## Verify

```bash
npm run verify:crowsnest-ai-usage-source
```

Synthetic provider fixtures live under `fixtures/crowsnest-ai-usage-source/` and intentionally include content / PII-shaped strings in provider payloads to prove non-leakage into observer snapshots and adapted events.
