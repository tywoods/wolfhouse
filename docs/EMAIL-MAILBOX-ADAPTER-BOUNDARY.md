# Email mailbox adapter boundary (Slice 1A)

**Status:** foundation only — provider-neutral adapter/validation contract, fake adapter, focused tests, and this architecture note.
**Not in this slice:** DB schema / `tenant_channel_endpoints` table, Microsoft Graph / Gmail / IMAP network calls, OAuth, subscriptions, polling, send/drafts UI, attachment download/storage, Luna SOUL changes, live mailbox config, deploy.

## Architectural decision (Slice 1A vs 1B)

This repo has **no authoritative tenant/location parent relation** suitable for a strong composite FK. Slice 1A therefore **intentionally ships no endpoint persistence schema** and no weak canonical endpoint table.

| Slice | Ships | Defers |
|-------|--------|--------|
| **1A (this)** | Provider-neutral adapter identity + capability contract, secret-ref validation, tenant-aware location validation API (injected authority), fake adapter, verifiers, this note | Any Postgres registry for mailboxes / channel endpoints |
| **1B (next)** | Must introduce or reuse an **authoritative tenant–location registry** and a **composite FK** before `tenant_channel_endpoints` (or equivalent) can become canonical product state | Provider network adapters (Graph/Gmail/IMAP) remain later |

Application validation in `validateTenantChannelEndpointInput(input, { locationAuthority })` is a **contract for future writes**, not a substitute for DB integrity. Location authority is a **trusted out-of-band callback** (argument 2 only); it fails closed without a valid second-argument authority and never honors authority embedded in untrusted `input`.

## Architecture

```
Guest email provider  →  (future) provider adapter  →  Staff API / Postgres
                              ↑
                     email-mailbox-adapter-contract
                     (identity + capabilities + write validation)
```

- **One unified Staff Inbox** with channel-native threads (WhatsApp today; email endpoints registered later).
- **Staff API / Postgres** will own canonical product state **after** Slice 1B registry work — not in 1A.
- **Provider adapters** may later be `microsoft_graph`, `gmail_api`, or `imap_smtp`.
- **support@lunafrontdesk.com** is a licensed Microsoft 365 user mailbox and will be the first *test* adapter later — this slice contains **zero Graph-specific logic**.

## Adapter boundary

| Layer | Owns | Must not |
|-------|------|----------|
| `scripts/lib/email-mailbox-adapter-contract.js` | Provider id allowlist, exact eight boolean capability keys, secret-ref scheme allowlist (`kv:`, `secret-ref:`) with body secret-shape checks, public-address normalization, endpoint **write validation** requiring trusted out-of-band `locationAuthority` callback | Import provider SDKs; store credentials; hardcode tenant locations; invent default locations; ship DB migrations; honor authority from untrusted input |
| `scripts/lib/email-mailbox-fake-adapter.js` | Deterministic in-memory adapter for tests (Graph/Gmail/IMAP capability *combinations* as data); `supports(unknown)` fails closed | Network I/O; production use; resolve secret values |

Consumers must branch on **capability flags** (`remote_drafts`, `push_notifications`, …), not on provider-specific field shapes. Unknown provider ids, capability shapes, and **unknown capability keys on `supports()`** fail closed (throw / structured reject — never silent `false` for typos).

## Credentials

**Provider credentials never belong in Git, Postgres product rows, logs, or prompts.**

- Only opaque **secret references** are accepted by the contract, with an **exact** scheme allowlist suitable for provider-neutral secret managers:
  - `kv:<bounded-safe-body>`
  - `secret-ref:<bounded-safe-body>`
- Validation order: parse/validate the exact scheme first; then enforce a bounded non-whitespace body grammar; then run secret/token/password **shape detectors against the reference body** (not only the full prefixed string).
- Bodies are non-whitespace, bounded, path-like labels — not passwords, OAuth tokens, JWTs, API keys, or PEM material.
- **Secrets are retrieved through an external secret provider by the adapter** at runtime. This contract never resolves, logs, or returns secret values.
- Pattern-based rejects include (non-exhaustive shape heuristics — **not** full entropy scanning): unprefixed raw secrets; unknown schemes; whitespace; empty refs; and secret-looking bodies after an allowed scheme such as `kv:sk-…`, `kv:password-hunter2`, `secret-ref:ya29.…`, prefixed JWT-shaped / Bearer / `api_key=` / `client_secret=` / `password=` values.
- Valid non-secret examples that remain accepted when body grammar permits: `kv:luna-support-email-credentials`, `secret-ref:tenant/email-mailbox`.

## Location integrity (application contract only)

There is **no** authoritative tenant–location parent table for a composite FK in Slice 1A.

`validateTenantChannelEndpointInput(input, { locationAuthority })` therefore:

- Treats **argument 1** as untrusted endpoint field input and **argument 2** as trusted dependencies only.
- Requires a **trusted callback** `locationAuthority(client_id, location_id) => boolean | {ok,...}` that evaluates the **canonical** `client_id` + `location_id` pair. Allowlists/resolvers must live inside that trusted callback — they are **not** accepted from `input`.
- **Never** reads `location_authority`, allowlists, resolvers, or authorization decisions from `input`.
- **Rejects** an input object that contains `location_authority` / `locationAuthority` as a forbidden field so callers cannot mistakenly believe it is honored.
- **Fails closed** if the trusted second-argument authority is absent or not a function.
- **Fails** for unknown locations and locations that belong to another tenant (via the trusted callback).
- Validated **output never includes** authority or dependency values.
- Enforces **canonical lowercase kebab** `location_id` tokens; rejects uppercase, surrounding whitespace, internal whitespace, empty, and malformed tokens.
- Does **not** import Sunset-specific routing or hardcode any production location ids into the shared contract.

DB-enforced composite FK and registry are **Slice 1B** prerequisites for endpoint persistence.

## Automation vs attention

- **Automation modes:** `automatic` | `draft_only` | `off`.
- **Attention / handoff** is a separate concern (existing inbox/handoff paths) — not folded into automation mode.

## Attachments / payments

- No attachment payloads are downloaded or stored in this foundation. Later work may retain only safe attachment-present metadata / provider references.
- Payments remain in Stripe; payment-card data must never enter email endpoint or adapter records.

## Verifiers

```bash
npm run verify:email-mailbox-adapter-contract
npm run verify:migration-integrity
```

Slice 1A adds **no** migration and must not alter `database/migrations/canonical-manifest.json`.
