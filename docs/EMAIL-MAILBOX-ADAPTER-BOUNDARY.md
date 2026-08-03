# Email mailbox adapter boundary (Slice 1A + 1B)

**Status:**
- **1A:** provider-neutral adapter/validation contract, fake adapter, focused tests.
- **1B:** canonical Postgres registry for tenant locations + email channel endpoints (**empty tables** on migrate; no backfill).

**Not in these slices:** Microsoft Graph / Gmail / IMAP network calls, OAuth, subscriptions, polling, send/drafts UI, attachment download/storage, Luna SOUL changes, live mailbox config, deploy, invented client/location/mailbox rows.

## Architectural decision (Slice 1A vs 1B)

Slice **1A intentionally ships no** endpoint persistence schema and no Graph/Gmail/IMAP network code — application validation only. Slice **1B** introduces the authoritative registry with **empty tables** (no backfill).

| Slice | Ships | Defers |
|-------|--------|--------|
| **1A** | Provider-neutral adapter identity + capability contract, secret-ref validation, tenant-aware location validation API (injected **synchronous** authority), fake adapter, verifiers | Endpoint persistence until a real tenant–location parent exists |
| **1B (this registry)** | Authoritative `tenant_locations` parent + `tenant_channel_endpoints` with composite FK, CHECK constraints, partial unique active address; offline + ephemeral PG proofs | Provider network adapters (Graph/Gmail/IMAP); operator registration of real mappings; **any async PG→app locationAuthority bridge** |

Application validation in `validateTenantChannelEndpointInput(input, { locationAuthority })` remains a **contract for writes**, not a substitute for DB integrity. Location authority is a **trusted out-of-band callback** (argument 2 only); it fails closed without a valid second-argument authority and never honors authority embedded in untrusted `input`.

**Slice 1B owns persistence.** Tables are **intentionally empty** after migration apply — no client/location/mailbox/secret backfill and no invented IDs or addresses. A later **operator-controlled registration** step supplies real tenant→location mappings and email endpoints. Persistence integrity for client+location ownership is the **composite DB FK** on `tenant_channel_endpoints` → `tenant_locations`; no application authority bridge is required for that guarantee.

### Location authority boundary (do not pass async into 1A)

The Slice 1A validator requires a **trusted synchronous / preloaded** `locationAuthority` callback that returns `boolean` or `{ok,...}` **immediately**. It is intentionally **not** async and does **not** accept `Promise<boolean>`.

**Slice 1B does not ship a PG authority bridge** (no `email-tenant-location-authority-pg` adapter). Looking up `tenant_locations` over Postgres is inherently async; wiring that directly into `validateTenantChannelEndpointInput` would force an async Slice 1A API, which this slice explicitly does not do.

A **future API write slice** must design the async lookup boundary **before** writing — e.g. resolve active `(client_id, location_id)` in the handler, then pass a **synchronous** closure or preloaded set into the 1A validator. **Do not** pass an async callback / `Promise`-returning function into `validateTenantChannelEndpointInput`.

## Architecture

```
Guest email provider  →  (future) provider adapter  →  Staff API / Postgres
                              ↑
                     email-mailbox-adapter-contract
                     + tenant_locations / tenant_channel_endpoints (1B)
```

- **One unified Staff Inbox** with channel-native threads (WhatsApp today; email endpoints registered later).
- **Staff API / Postgres** owns canonical endpoint product state via Slice 1B tables (still empty until operator registration).
- **Provider adapters** may later be `microsoft_graph`, `gmail_api`, or `imap_smtp`.
- **support@lunafrontdesk.com** is a licensed Microsoft 365 user mailbox and will be the first *test* adapter later — these slices contain **zero Graph-specific network logic**.

## Slice 1B schema (empty on apply)

Migration: `057_tenant_locations_and_channel_endpoints.sql`
Down: `057_tenant_locations_and_channel_endpoints_down.sql`

| Table | Role |
|-------|------|
| `tenant_locations` | Canonical parent: `client_id` → `clients(id)` RESTRICT; unique `(client_id, location_id)` for composite FK; platform-global unique `location_id`; canonical lowercase-kebab; non-empty `display_name`; `active` + audit timestamps/actors (`UUID` → `staff_users`) |
| `tenant_channel_endpoints` | Email-only endpoints; composite FK `(client_id, location_id)` → `tenant_locations` RESTRICT; provider allowlist matches 1A; normalized lowercase `public_address` (no default; uppercase/untrimmed rejected); `secret_ref` (`kv:` / `secret-ref:` only); capabilities JSONB with exact eight boolean keys; defaults `inbound_enabled=false`, `outbound_enabled=false`, `default_automation_mode='off'`, `active=false` |

**Registry `active` vs inbound/outbound:** `active` is registry activation (partial unique index on normalized public address when active). It is separate from `inbound_enabled` / `outbound_enabled`. No row may receive or send merely because it was inserted.

## Adapter boundary

| Layer | Owns | Must not |
|-------|------|----------|
| `scripts/lib/email-mailbox-adapter-contract.js` | Provider id allowlist, exact eight boolean capability keys, secret-ref scheme allowlist (`kv:`, `secret-ref:`) with body secret-shape checks, public-address normalization, endpoint **write validation** requiring trusted **synchronous** out-of-band `locationAuthority` callback | Import provider SDKs; store credentials; hardcode tenant locations; invent default locations; honor authority from untrusted input; accept async/`Promise` authority |
| `scripts/lib/email-mailbox-fake-adapter.js` | Deterministic in-memory adapter for tests (Graph/Gmail/IMAP capability *combinations* as data); `supports(unknown)` fails closed | Network I/O; production use; resolve secret values |

Consumers must branch on **capability flags** (`remote_drafts`, `push_notifications`, …), not on provider-specific field shapes. Unknown provider ids, capability shapes, and **unknown capability keys on `supports()`** fail closed (throw / structured reject — never silent `false` for typos).

## Credentials

**Provider credentials never belong in Git, Postgres product rows, logs, or prompts.**

- Only opaque **secret references** are accepted by the contract and by the DB CHECK on `secret_ref`, with an **exact** scheme allowlist:
  - `kv:<bounded-safe-body>`
  - `secret-ref:<bounded-safe-body>`
- Validation order: parse/validate the exact scheme first; then enforce a bounded non-whitespace body grammar; then run secret/token/password **shape detectors against the reference body** (not only the full prefixed string).
- Bodies are non-whitespace, bounded, path-like labels — not passwords, OAuth tokens, JWTs, API keys, or PEM material.
- **Secrets are retrieved through an external secret provider by the adapter** at runtime. This contract never resolves, logs, or returns secret values.
- Pattern-based rejects include (non-exhaustive shape heuristics — **not** full entropy scanning): unprefixed raw secrets; unknown schemes; whitespace; empty refs; and secret-looking bodies after an allowed scheme such as `kv:sk-…`, `kv:password-hunter2`, `secret-ref:ya29.…`, prefixed JWT-shaped / Bearer / `api_key=` / `client_secret=` / `password=` values.
- Valid non-secret examples that remain accepted when body grammar permits: `kv:luna-support-email-credentials`, `secret-ref:tenant/email-mailbox`.

### Secret-ref parity (DB vs Slice 1A app)

Intentional, bounded differences are allowed:

- The **DB CHECK may be stricter** than Slice 1A for some shapes (e.g. any body matching `^sk-` after an allowed scheme, even short bodies that the app pattern may not flag).
- The **DB must never accept** a value that Slice 1A **rejects** on the shared adversarial corpus used by the 1B offline/PG proofs (raw secrets, unknown schemes, whitespace, `kv:sk-…`, `password-` / `Bearer` / JWT / `ya29.` / `api_key=` / `client_secret=` / `password=` bodies, etc.).
- App-only normalization helpers (e.g. public-address lowercasing before validate) are not a license for the DB to store un-normalized forms — endpoints CHECK already requires already-normalized lowercase addresses.

## Location integrity

### Application contract (1A)

`validateTenantChannelEndpointInput(input, { locationAuthority })`:

- Treats **argument 1** as untrusted endpoint field input and **argument 2** as trusted dependencies only.
- Requires a **trusted synchronous callback** `locationAuthority(client_id, location_id) => boolean | {ok,...}` evaluating the **canonical** pair. Allowlists/resolvers live inside that callback — **not** from `input`. Return value must not be a `Promise`.
- **Never** reads authority from `input`; presence of `location_authority` / `locationAuthority` on input is forbidden.
- **Fails closed** if the trusted second-argument authority is absent or not a function.
- Enforces **canonical lowercase kebab** `location_id` tokens.

### Database registry (1B)

- `tenant_locations` is the authoritative parent.
- `tenant_channel_endpoints` composite FK enforces same-tenant location ownership (tenant A cannot attach endpoints to tenant B’s location).
- Deleting a referenced location or client is **RESTRICT**ed.
- Does **not** rewrite existing free-text location columns or migration 039.
- Does **not** ship an async PG `locationAuthority` adapter into the 1A validator.

## Automation vs attention

- **Automation modes:** `automatic` | `draft_only` | `off` (DB default `off`).
- **Attention / handoff** is a separate concern (existing inbox/handoff paths) — not folded into automation mode.

## Attachments / payments

- No attachment payloads are downloaded or stored in this foundation. Later work may retain only safe attachment-present metadata / provider references.
- Payments remain in Stripe; payment-card data must never enter email endpoint or adapter records.

## Verifiers

```bash
npm run verify:email-mailbox-adapter-contract
npm run verify:email-tenant-location-registry
npm run prove:email-tenant-location-registry-pg
npm run verify:migration-integrity
```

`prove:email-tenant-location-registry-pg` uses the disposable harness (Docker preferred; **PGlite acceptable** for local/CI proof). **Stock PostgreSQL must still be proven before deploy** — do not treat PGlite-only green as production migration sign-off.

Slice 1B registers migration `057` in `database/migrations/canonical-manifest.json` (forward order 55) plus explicit down classification. Tables remain empty until operator-controlled registration.
