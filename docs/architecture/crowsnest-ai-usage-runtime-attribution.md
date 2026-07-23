# Crowsnest AI-Usage Runtime Attribution — ADR / Slice B

## Status

Approved direction — Sunset Luna/Hermes staging first, with a canonical server-owned identity boundary. 2026-07-23.

## Decision

The first live AI-usage source will be **Sunset Luna/Hermes staging**. Before it may emit any receipt, its runtime must receive an immutable configured Crowsnest client and canonical tenant identity from server-owned deployment/configuration.

The observer must not infer identity from phone numbers, URLs, logical labels such as `sunset`, prompts, WhatsApp messages, request bodies, or provider responses. The Staff owner SQL path is a later valid plumbing source, but is not the first live source because it does not answer the product question: how much AI usage is Luna generating for Sunset.

## Why

Spyglass needs trustworthy client attribution. A server-owned configured identity boundary makes Sunset Luna receipts auditable and prevents misattributing tenant usage. It also permits the same observer pattern to be reused for future tenants without central Crowsnest database access to tenant data.

## Product and deployment boundary

- **Sunset Hermes runtime** owns one immutable configured Crowsnest client/tenant identity and may emit safe observations after a provider call.
- **Crowsnest core** owns the existing provider-neutral receipt contract, event adapter, and durable ledger store.
- **Ledger migration 050** is the only durable schema; it must be applied separately by an owner-capable operator before live receipt recording.
- A tenant reporter sends only the normalized receipt to Crowsnest's guarded ledger ingest/write boundary; Crowsnest never reads Sunset tenant databases.
- No prompt/message retention, AI UI change, historical backfill, or broad tenant rollout belongs to this slice.

## Workflow and invariants

```text
Sunset Luna/Hermes staging provider call
  → runtime obtains configured canonical Crowsnest client + tenant identity
  → provider result exposes safe measured receipt facts
  → opt-in observer normalizes a closed receipt
  → Crowsnest contract/store validates and writes idempotently
```

A missing/invalid trusted identity, malformed receipt, unsupported provider data, unavailable ledger, or observer failure produces **no ledger write** and must not alter the guest-facing Luna response.

Each provider-call attempt gets a fresh opaque `event_id`. Retried delivery of that same receipt must use the same event ID; no prompt/message-derived idempotency key is permitted.

## Allowed persisted facts

- opaque event ID / idempotency identifier;
- canonical client and tenant identifiers from server-owned configured runtime context;
- provider and model identifiers;
- measured or unavailable token counts, latency, cost amount/currency, outcome category;
- safe timestamps and schema/policy version.

## Forbidden facts

- prompts, completions, tool arguments, message/conversation text;
- guest/staff names, phones, emails, WhatsApp identifiers;
- raw provider payloads, headers, responses, or errors;
- credentials, DSNs, tokens, browser input, URLs, inferred identity;
- arbitrary JSON/metadata blobs.

## Module boundaries

1. A **Sunset runtime identity resolver** (`scripts/lib/crowsnest/crowsnest-sunset-ai-usage-identity.js`) reads only server-owned, immutable `CROWSNEST_AI_USAGE_*` configuration and validates the canonical identity shape. Dormant until a future observer injects it.
2. `crowsnest-ai-usage-contract` validates the closed receipt shape.
3. `crowsnest-ai-usage-adapter` normalizes provider-safe receipt facts.
4. A narrow **observer** runs after one approved Sunset Luna provider call and is injected with the receipt writer.
5. `crowsnest-ai-usage-store` performs the parameterized idempotent ledger write.

No module may read guest messages, query a tenant database, create its own DB pool, use a browser-supplied client/tenant ID, or log raw provider traffic.

## Slice B1 — canonical Sunset identity boundary

**Status:** implemented (identity configuration/validation only; observer not wired).

### Owner and seam

| Role | Path |
|------|------|
| Identity resolver (pure, dormant) | `scripts/lib/crowsnest/crowsnest-sunset-ai-usage-identity.js` → `resolveSunsetHermesAiUsageIdentity({ env })` |
| Fixture gate | `npm run verify:crowsnest-sunset-ai-usage-identity` |
| Sunset staging runtime | `hermes-sunset-luna` on Lunabox gateway `:8092` (`docker/hermes-sunset/docker-compose.vm.yml`) |
| Future observer seam (B2; not wired in B1) | `docker/hermes-staging/apply_gateway_patches.py` turn-handler patch → `wolfhouse.output_guard.guard_turn_response` |
| Live provider call | Inside the external Hermes image (not in-repo) |

### Exact non-secret env names

| Env name | Maps to contract field |
|----------|------------------------|
| `CROWSNEST_AI_USAGE_CLIENT_SLUG` | `client_slug` |
| `CROWSNEST_AI_USAGE_TENANT_ID` | `tenant_id` |

Both must be present, trimmed, match the AI-usage contract opaque-id rule (`SAFE_ID_RE`), not secret-shaped, not equal to each other, and **must not** be the logical slug `sunset`. No aliases (`LUNA_CLIENT_SLUG`, `LUNA_TENANT_ID`, `DEFAULT_CLIENT_SLUG`, phone, URL, request, message, provider, or browser fields).

### Deployment binding rule

1. Earthling obtains `public.clients.id` for `slug='sunset'` through an **authorized read-only Staff lookup** (Staff staging Postgres `public.clients`). Do not invent, commit, print, or fixture that value.
2. Place the two env **names** above with authoritative opaque/UUID values into Lunabox `/etc/hermes-sunset-luna.env` (compose `env_file` + optional compose passthrough; staging `write_luna_env` / Sunset bootstrap forward when set).
3. Recreate `hermes-sunset-luna` so process env loads the binding.
4. Prove presence without echoing values (name/length checks only).
5. Unset or invalid binding → resolver returns `{ ok: false, reason }` → future observer must not emit. B1 leaves the observer unwired (dormant by default).

**Exit criteria:** an operator can prove, without exposing values, that every Sunset Luna staging instance can receive the same valid canonical Crowsnest identity and refuses to observe usage when the binding is absent.

## Slice B2 — one opt-in Sunset provider observer

- Wire exactly one provider-call seam after B1 passes.
- Emit one fixture-backed synthetic receipt through an injected writer.
- Missing identity/receipt/writer failure creates no write and does not affect the guest reply.
- No live provider, Azure, migration, API, query, or Spyglass UI change.

## Follow-on operational milestone

Only after code review/merge:

1. owner applies migration 050 and grants minimum ledger write privilege;
2. deploy the exact merged Crowsnest/Sunset runtime revisions with observation disabled by default;
3. bind the Sunset staging canonical identity through secure non-secret configuration;
4. explicitly enable only the single approved Sunset source;
5. verify one real safe receipt through aggregate/safe metadata only;
6. then add a read-only aggregate API and replace only sample AI panel values backed by genuine receipts.

## Explicit non-goals

- automatic identity inference or cross-tenant mapping;
- provider-wide scraping, backfill, or reconstructed historical usage;
- Crowsnest direct tenant-database reads;
- AI usage UI, client breakdowns, allowance board, or reporting schedules;
- automatic messages, payments, CRM writes, or any irreversible external action.
