# Email mailbox adapter boundary (Slice 1A + 1B + 1C-alpha + 1C-beta + 1C-gamma + 2A + 2B + 2C + 2D + 2F-A + 2F-B + 2F-C2 + inbound-envelope)

**Status:**
- **inbound-envelope (contract only):** provider-neutral immutable inbound email-envelope DTO + offline Microsoft Graph Mail.ReadBasic row mapper. Identity / ordering / dedup / staff-visible triage fields only. **PII fields must not be persisted or logged** until a later reviewed custody slice. No DB, runtime wiring, polling, Graph calls, OAuth scope changes, bodies, attachments, drafts, sends, deploy, or activation.
- **1A:** provider-neutral adapter/validation contract, fake adapter, focused tests.
- **1B:** canonical Postgres registry for tenant locations + email channel endpoints (**empty tables** on migrate; no backfill).
- **1C-alpha:** pure domain/repository layer over those tables for future Staff API routes (**no HTTP routes**, no auth role policy, no activation, no provider connectivity, no live data or deploy).
- **1C-beta:** smallest admin-only **READ** Staff API over that empty registry (list locations + list channel endpoints).
- **1C-gamma:** smallest admin-only, **explicitly kill-switched** registration **WRITE** API (`POST` locations + disabled channel endpoints). No activation, provider connectivity, live registration, or deploy.
- **2A:** pure offline **Microsoft Graph mailbox adapter boundary** with injected secret provider + injected HTTP transport, `listMessageEnvelopes({top})` only, deterministic fake transport tests. **No live network**, no Azure/Graph calls from verifiers, no DB/route/activation/deploy.
- **2B:** pure offline **Microsoft Graph app-only read-readiness contract** — machine-checkable security prerequisites (Exchange Online RBAC for Applications role **`Application Mail.ReadBasic`**, mailbox scope mechanism **`exchange_online_rbac_for_applications`** limited to `support@lunafrontdesk.com`, **empty** Entra application permission grants, opaque 1A `secret_ref` + exact material key *names*, network/activation off). Legacy `application_access_policy` + unscoped Entra `Mail.ReadBasic.All` are rejected. **Does not perform readiness discovery** and does not access Azure/Microsoft; never claims Entra/mailbox facts were independently verified.
- **2C (+2C.1 correction):** pure offline **Microsoft delegated OAuth + connector/auth-mode contract** — freezes default SaaS (`provider=microsoft_graph` + `auth_mode=delegated_authorization_code` / `microsoft_delegated_oauth`) as a Luna-owned multi-tenant **confidential web client** (auth code + **PKCE S256** + token-endpoint client auth; PKCE alone insufficient). Organizational accounts only; fixed hosts; exact redirect id; Phase A scopes **v2** (`openid`/`profile`/`offline_access` + Graph delegated exact set `User.Read` + `Mail.ReadBasic`; optional OIDC `email` display-only); token auth vocabulary `private_key_jwt` (preferred) + `client_secret_post` (temporary compatibility; form body fields; **not** `client_secret_basic`); server-owned one-time OAuth transaction; principal `ms_delegated_principal:{tid}:{oid}` (**not** mailbox); own-user live bind freeze (`/me.id` == `provider_principal_oid` → persist as `provider_resource_id`; concepts remain separate; no offline Graph); refresh-token custody module present after 2F-A (refresh-exchange adapter still blocked); mailbox binding unverified offline; deferred activation (schema does not enforce; readiness/activation false). **App-only enterprise (2A/2B) unchanged.** No live authorize/token/Graph/MSAL, routes, or activation.
- **2D:** additive **connector + mailbox binding identity** on `tenant_channel_endpoints` only (migration `058`). Nullable identity columns + CHECKs + partial unique ownership index. Domain `email-channel-endpoint-identity-contract`. **Does not flip 2C** activation/`schema_enforces` flags; enforces mailbox ownership identity only. Grant custody deferred to 2F-A dedicated table. No OAuth routes/tx columns, no Staff API expansion, no activation, no backfill.
- **2F-A:** durable **delegated grant custody** — dedicated `tenant_email_delegated_grants` table (migration `059`), owner-approved **envelope encryption** (AES-256-GCM ciphertext + wrapped per-generation DEK + exact Key Vault wrapping-key version ID may persist atomically with `grant_generation`; **raw refresh tokens forbidden** in PostgreSQL), injected envelope provider contract + **fake only**, custodian repository (install/acquire/renew/promote/reauth/abort/reconcile), lease TTL via DB `clock_timestamp()`, no TX across external I/O. Existing `resolveSecret` stays read-only. Refresh-exchange, Graph, OAuth routes, activation remain out.
- **2F-B:** production **Azure Key Vault envelope provider core** (`email-grant-envelope-azure-kv-provider`) — local AES-256-GCM + **RSA-OAEP-256 only** via injected exact-version `CryptographyClient` resolver (`{wrapKey,unwrapKey}`). Existing **Standard** vault (`wh-staging-kv` class) cannot hold symmetric oct/AES keys for A256KW; production **must not** use A256KW (requires Premium preview / Managed HSM — **not used**). Exact non-`latest` version pin; full HTTPS `/keys/{name}/{version}` identity; **full decrypt+reseal** rewrap (`next_aad`). No credential/SDK composition, live key, RBAC, network verifier, SecretClient, KeyClient/getKey, or activation in this slice.
- **2F-C2 (current):** **Sunset-staging-canary-only** runtime composition module (`email-grant-envelope-azure-kv-sunset-staging-runtime-composition`) — **default-off**, import-inert. Explicit factory only (not Staff API startup). When enabled via exact env allowlist, constructs `@azure/identity` `ManagedIdentityCredential` pinned to Sunset user-assigned MI client ID `0e05fbe3-e8c5-48aa-a914-30aed284e6f7` (prior live Azure evidence ↔ principal `5338388f-1685-40cb-ae69-dc2e00f32ad6`; **current Azure readback mandatory before deploy**) + `@azure/keyvault-keys` `CryptographyClient` for the **exact** Sunset staging versioned KEK, then hands the resolver into the 2F-B core. Never `DefaultAzureCredential`; never env/request-selected identity (`AZURE_CLIENT_ID`/`TENANT_ID`/`CLIENT_SECRET` ignored). **Must not** be deployed to production/other tenants/DR; those need a separately reviewed profile. **Does not claim runtime activation.** No OAuth routes, polling, Graph, refresh-exchange, migration changes, or live network from verifiers.
- **Sunset delegated read-health diagnostics:** default-off admin read-health may return allowlisted `graph_stage` only (plus sanitized status/generation/reachable/bounded count). Stages never include status codes, headers, body text, key names, subjects, addresses, tokens, or provider errors. Does not change Graph `$select`/parser acceptance, activation, or custody semantics.

**Not in slices 1A–1C-gamma:** Microsoft Graph / Gmail / IMAP network calls, OAuth, subscriptions, polling, send/drafts UI, attachment download/storage, Luna SOUL changes, live mailbox config, deploy, invented client/location/mailbox rows. Activation / secret_ref visibility / live provider connectivity remain deferred past 1C-gamma.

**Not in Slice 2A:** live Graph/Azure calls, default HTTP transport, provider SDKs, credential cache, access_token secret-material shortcut, polling/webhooks, send/draft/reply/forward, attachment download, DB lookups, Staff API routes, registry rows, schema, SOUL, activation, deploy.

**Not in Slice 2B:** live Entra/Azure/Graph/Key Vault discovery or admin confirmation automation; default network transport; composition/runtime factory; schema/migrations; Staff API routes; registry activation; polling/webhooks/send; SOUL; deploy; real credentials.

**Not in Slice 2C:** live Entra authorize/token/Graph/MSAL; default HTTP transport; OAuth callback Staff routes; schema/migrations; changing 2A `/me` or refresh_token adapter behavior; changing 2B EXO RBAC; activation/inbound/outbound; polling/webhooks/send; Google/IMAP/forwarding; GoDaddy support claims; per-customer Entra apps as default; deploy.

## Architectural decision (Slice 1A vs 1B)

Slice **1A intentionally ships no** endpoint persistence schema and no Graph/Gmail/IMAP network code — application validation only. Slice **1B** introduces the authoritative registry with **empty tables** (no backfill).

| Slice | Ships | Defers |
|-------|--------|--------|
| **1A** | Provider-neutral adapter identity + capability contract, secret-ref validation, tenant-aware location validation API (injected **synchronous** authority), fake adapter, verifiers | Endpoint persistence until a real tenant–location parent exists |
| **1B** | Authoritative `tenant_locations` parent + `tenant_channel_endpoints` with composite FK, CHECK constraints, partial unique active address; offline + ephemeral PG proofs | Provider network adapters (Graph/Gmail/IMAP); operator registration of real mappings; **any async PG→app locationAuthority bridge** |
| **1C-alpha (domain/repository)** | Focused module `scripts/lib/email-tenant-channel-registry.js`: list/create locations, list endpoints, create **disabled** endpoints; pure helper `buildPreloadedLocationAuthority`; offline hostile mock-pg + disposable PG proofs | HTTP routes; auth roles; feature flags; update/deactivate; provider adapters; activation / inbound / outbound enable paths; response redaction |
| **1C-beta (admin READ API)** | Extracted DI routes `scripts/lib/staff-email-registry-routes.js` wired into `staff-query-api.js`: `GET /staff/admin/email-registry/locations`, `GET /staff/admin/email-registry/channel-endpoints`; `requireAuth('admin')` + existing `assertStaffClientAccess` + `admin_db_read` gate; DTO allowlists; `secret_ref` always redacted (`secret_ref_present` only) | POST/PATCH/DELETE; activation; secret_ref visibility; provider connectivity; UI |
| **1C-gamma (admin WRITE API)** | Same module: `POST` same two paths; `requireAuth('admin')` + ACL + requested-tenant `staff_actions`/`admin_writes` via `authorizeAuthenticatedStaffRoute`; global kill switch `EMAIL_REGISTRY_WRITES_ENABLED` (exact case-insensitive `true` only); body allowlists; trusted `clientId` from slug UUID + `actor` from `user.staff_user_id`; domain writes via `{ client }` on `withPgClient`; endpoints always disabled | PATCH/DELETE; activation; secret_ref visibility; provider connectivity; UI; live registration |
| **2A (Graph adapter boundary)** | `email-secret-provider-contract`, `email-http-transport-contract`, `email-microsoft-graph-adapter`, optional `email-fake-http-transport`; app-only client_credentials → list message envelopes; exact allowlists; sanitized errors; offline verifier | Live network; default transport; SDK; send/draft/reply; polling/webhooks; DB; routes; activation; deploy |
| **2B (Graph app-only readiness)** | `email-graph-app-only-readiness-contract`: pure offline declaration of human-provided security evidence (`provider`, `auth_mode=application_client_credentials`, exact EXO role `Application Mail.ReadBasic`, empty `entra_application_permission_set`, mechanism `exchange_online_rbac_for_applications` → `support@lunafrontdesk.com` only, admin confirmation flag, opaque 1A `secret_ref` + material key names, network/activation/inbound/outbound/automation off); ready flag never implies live Azure verification | Live discovery; Entra/Graph/KV clients; composition factory; default transport; routes; activation; schema; deploy |
| **2C (delegated OAuth + connector mode)** | `email-connector-auth-mode-contract` + `email-microsoft-delegated-oauth-contract`: default SaaS matrix (`microsoft_graph` + `delegated_authorization_code`); confidential web + PKCE S256 + token-endpoint client auth; orgs-only authority; Phase A scopes; OAuth transaction / principal / mailbox-hint / refresh / deferred activation; readiness with `network_enabled=false` and binding **not verified offline** | Live OAuth/Graph/MSAL; routes; schema; activation; Google/IMAP; 2A/2B changes |
| **2D (endpoint identity schema)** | Migration `058` + `email-channel-endpoint-identity-contract`: seven nullable TEXT identity fields; supported mode pairs; binding_status lifecycle; partial unique `(provider, provider_tenant_id, provider_resource_id)` WHERE verified/reauthorization_required (C collation); domain pair/binding/reconnect-transfer validators | grant custody table (2F-A); OAuth tx columns; Staff routes; activation; secret package value inspection; shared-mailbox delegated claim |
| **2F-A (grant custody + envelope)** | Migration `059` `tenant_email_delegated_grants`; mode-guard triggers; envelope v1 + fake provider (A256KW local contract proof); custodian install/acquire/renew/promote/reauth/abort/reconcile; 2C module-present flags; offline verify + disposable PG prove | Real Azure KV wrap wiring; Graph/refresh-exchange; OAuth routes; Staff expansion; activation; per-grant KV secrets; broad GC |
| **2F-B (Azure KV envelope core)** | `email-grant-envelope-azure-kv-provider`: RSA-OAEP-256 only on Standard KV; version-pinned KEK; injected crypto client; full reseal rewrap; offline RSA fake verifier | Live KV/RBAC/credential composition; A256KW; Premium/HSM/new vault; @azure/identity; refresh-exchange; activation |
| **2F-C2 (Sunset-staging canary composition)** | `email-grant-envelope-azure-kv-sunset-staging-runtime-composition`: default-off; hard-pinned Sunset host+versioned key+MI client ID; lazy `ManagedIdentityCredential` + `CryptographyClient` (retries 0); canary-only boundary; offline verifier intercepts `Module._load` (no production DI) | Staff API wiring; other tenants/prod/DR deploy; OAuth routes; live network verifier; KeyClient/list/latest; request/env-selected identity; activation; refresh-exchange |

Application validation in `validateTenantChannelEndpointInput(input, { locationAuthority })` remains a **contract for writes**, not a substitute for DB integrity. Location authority is a **trusted out-of-band callback** (argument 2 only); it fails closed without a valid second-argument authority and never honors authority embedded in untrusted `input`.

**Slice 1B owns persistence.** Tables are **intentionally empty** after migration apply — no client/location/mailbox/secret backfill and no invented IDs or addresses. A later **operator-controlled registration** step supplies real tenant→location mappings and email endpoints. Persistence integrity for client+location ownership is the **composite DB FK** on `tenant_channel_endpoints` → `tenant_locations`.

**Slice 1C-alpha owns the pure repository API** that future Staff API routes can call safely. It does **not** register routes, enforce staff roles, or enable traffic. Endpoint creation always forces `channel=email`, `inbound_enabled=false`, `outbound_enabled=false`, `default_automation_mode='off'`, `active=false` in SQL parameters.

### Location authority boundary (do not pass async into 1A)

The Slice 1A validator requires a **trusted synchronous / preloaded** `locationAuthority` callback that returns `boolean` or `{ok,...}` **immediately**. It is intentionally **not** async and does **not** accept `Promise<boolean>`.

**Slice 1B does not ship a PG authority bridge** (no `email-tenant-location-authority-pg` adapter). Looking up `tenant_locations` over Postgres is inherently async; wiring that directly into `validateTenantChannelEndpointInput` would force an async Slice 1A API, which 1A explicitly does not do.

**Slice 1C-alpha is the future API write boundary** (domain layer only — no HTTP yet): `createDisabledTenantChannelEndpoint` begins a transaction, `SELECT`s the exact active `(client_id, location_id)` (optional `FOR SHARE`), then builds a **synchronous** `buildPreloadedLocationAuthority` closure / preloaded set for the 1A validator. **Do not** pass an async callback / `Promise`-returning function into `validateTenantChannelEndpointInput`.

## Architecture

```
Guest email provider  →  provider adapter (2A Graph app-only boundary today;
                              delegated /me adapter later)  →  Staff API / Postgres
                              ↑
                     email-mailbox-adapter-contract (1A)
                     + tenant_locations / tenant_channel_endpoints (1B)
                     + email-tenant-channel-registry (1C-alpha domain layer)
                     + staff-email-registry-routes (1C-beta READ + 1C-gamma kill-switched WRITE)
                     + email-microsoft-graph-adapter (2A; app-only; injected transport only)
                     + email-graph-app-only-readiness-contract (2B; enterprise offline prerequisites)
                     + email-connector-auth-mode-contract (2C; provider × auth_mode matrix)
                     + email-microsoft-delegated-oauth-contract (2C; default SaaS OAuth freeze)
                     + email-channel-endpoint-identity-contract (2D; binding identity)
                     + 058 tenant_channel_endpoints identity columns (2D)
                     + tenant_email_delegated_grants + envelope contracts (2F-A)
                     + email-delegated-grant-custodian (2F-A; no exchange)
                     + email-grant-envelope-azure-kv-provider (2F-B; RSA-OAEP-256 core)
                     + email-grant-envelope-azure-kv-sunset-staging-runtime-composition (2F-C2 canary; default-off)
```

- **One unified Staff Inbox** with channel-native threads (WhatsApp today; email endpoints registered later).
- **Staff API / Postgres** owns canonical endpoint product state via Slice 1B tables (still empty until operator registration).
- **1C-alpha repository** (`email-tenant-channel-registry.js`) is the only supported write path for locations/disabled endpoints. **Reads** inject `{ db }` (single-query executor; Pool OK for one SELECT). **Writes** require an explicitly pinned transaction `{ client }` for the full BEGIN…COMMIT/ROLLBACK sequence — not a Pool or generic `{ db }` (rejected as `transaction_client_required` before any SQL). No global PG/live config; Staff API `withPgClient` supplies the pinned client for 1C-beta reads and 1C-gamma writes.
- **1C-beta admin READ API** lists registry rows for authenticated admin/owner only; never enables traffic.
- **1C-gamma admin WRITE API** registers locations and **disabled** email endpoints only when `EMAIL_REGISTRY_WRITES_ENABLED=true`; never enables traffic.
- **Provider adapters** may later be `microsoft_graph`, `gmail_api`, or `imap_smtp`.
- **support@lunafrontdesk.com** is a licensed Microsoft 365 user mailbox and the intended first *test* Graph mailbox. Slice **2A** ships the Graph adapter **boundary** only (injected transport; verifiers use a deterministic fake — zero live Graph calls).

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
| `scripts/lib/email-inbound-envelope-contract.js` | **Canonical** provider-neutral immutable inbound domain envelope (exact own enumerable data keys; calendar-safe timestamps; identity/dedup/order/tie-break; legacy Graph transport conversion); documents PII keys; **persistence/logging forbidden** until custody slice; ImmutableId required before future MS persistence | Bodies, previews, recipients, headers, attachments, links, tokens, raw provider objects; Graph/OData field names; DB/network; runtime wiring; false ImmutableId provenance |
| `scripts/lib/email-microsoft-graph-inbound-envelope-mapper.js` | Offline mapper: approved Mail.ReadBasic row (+ optional validated/discarded `@odata.etag`) → **canonical** domain envelope; **provider + mailbox identity are explicit inputs** | Infer mailbox from row; network/Graph calls; retain etag/raw row; hasAttachments/body/uniqueBody/headers; claim ImmutableId provenance; runtime wiring |
| `scripts/lib/email-mailbox-adapter-contract.js` | Provider id allowlist, exact eight boolean capability keys, secret-ref scheme allowlist (`kv:`, `secret-ref:`) with body secret-shape checks, public-address normalization, endpoint **write validation** requiring trusted **synchronous** out-of-band `locationAuthority` callback | Import provider SDKs; store credentials; hardcode tenant locations; invent default locations; honor authority from untrusted input; accept async/`Promise` authority |
| `scripts/lib/email-mailbox-fake-adapter.js` | Deterministic in-memory adapter for tests (Graph/Gmail/IMAP capability *combinations* as data); `supports(unknown)` fails closed | Network I/O; production use; resolve secret values |
| `scripts/lib/email-tenant-channel-registry.js` (1C-alpha) | Tenant-scoped list/create for `tenant_locations`; list endpoints; `createDisabledTenantChannelEndpoint`; pure `buildPreloadedLocationAuthority`; reads via `{ db }`; writes via pinned `{ client }` transaction (BEGIN guarded; no Pool); stable structured errors (`location_already_exists`, `endpoint_already_exists`, `location_not_authorized`, `transaction_client_required`, `db_error`) | HTTP routes; auth roles; enable active/inbound/outbound/automation; resolve `secret_ref`; provider SDK/network; global PG pool; Pool as write executor; upsert; leak raw PG messages |
| `scripts/lib/staff-email-registry-routes.js` (1C-beta + 1C-gamma) | Admin GET list + POST create handlers; DI factory; client slug → ACL → requested-tenant authz → (writes) kill switch → UUID; DTO allowlists; `secret_ref` → `secret_ref_present` only; strict body allowlists; domain `{ client }` writes; audit intents; sanitized errors | PATCH/DELETE; activation; expose `secret_ref`; trust query/body `client_id` or actor; provider SDK; enforce auth itself (router owns `requireAuth`); nested BEGIN/COMMIT |
| `scripts/lib/email-secret-provider-contract.js` (2A) | Validate injected `{ resolveSecret }` shape; reuse 1A `validateEmailMailboxSecretRef` before resolve; return material only to private adapter flow | Default secret provider; log/return material in public errors; resolve non-ref credentials |
| `scripts/lib/email-http-transport-contract.js` (2A) | Validate injected async `{ request }` transport shape; fixed timeout constants | Default/network transport implementation |
| `scripts/lib/email-microsoft-graph-adapter.js` (2A) | Factory scoped to validated `microsoft_graph` endpoint + required `secretProvider` + `transport`; `listMessageEnvelopes({top})` only; app-only token then Graph messages GET; exact DTO allowlists; sanitized error codes | DB lookups; SDK; credential/token cache; access_token secret shortcut; send/draft/reply; host/url injection fields; partial list results |
| `scripts/lib/email-fake-http-transport.js` (2A tests) | Deterministic recording fake transport for verifiers | Network I/O / DNS |
| `scripts/lib/email-graph-app-only-readiness-contract.js` (2B) | Offline app-only read-readiness declaration: exact provider/auth/EXO Application role/`entra_application_permission_set=[]`/mailbox-scope/secret-package/network-off allowlists; reuses 1A `secret_ref` validator (input only); public DTO `secret_ref_present` + exact material key names (never serializes `secret_ref`); deep-frozen ok/fail envelopes; allowlisted error reasons only; `ready_for_human_authorized_live_prerequisite_check` never claims Azure/Entra/mailbox facts verified | Live discovery; Azure/Graph/KV SDK; env reads; routes; activation; composition factory; expose secret_ref value |
| `scripts/lib/email-connector-auth-mode-contract.js` (2C) | Provider × auth_mode × connector_mode allowlist; default SaaS vs enterprise separation; material key *names* by mode | Live OAuth; Google/IMAP; capability-flag overload |
| `scripts/lib/email-microsoft-delegated-oauth-contract.js` (2C) | Delegated OAuth freeze + readiness: confidential+PKCE, orgs hosts, Phase A scopes, transaction/principal/mailbox-hint/refresh/activation declarations; compact frozen DTO; network/activation false | Live authorize/token/Graph/MSAL; routes; schema; activation; 2A/2B mutation |
| `scripts/lib/email-channel-endpoint-identity-contract.js` (2D) | Exact enums; mode-pair + binding-identity validators; reconnect/transfer ownership declaration (`23505`, same-row reconnect, reauth reservation, aliases not independent); mode-dependent secret package key *names* only; DTO `secret_ref_present`; principal ≠ mailbox | DB/network/SDK; grant rotation writers; OAuth tx state; inspect secret-store values; claim SQL validates package contents |
| `scripts/lib/email-grant-envelope-provider-contract.js` (2F-A) | Envelope record v1 validation (AES-256-GCM, 12-byte nonce, 16-byte tag, version-pinned KEK, wrapped DEK bounds); AAD builder; refresh package encode/decode; injected `seal/open/rewrap` provider shape; zeroize helper | Azure SDK; production KEK; default provider; put/delete on 2A secret resolver |
| `scripts/lib/email-grant-envelope-fake-provider.js` (2F-A) | Process-local fake wrap + AES-256-GCM seal/open for tests only | Production crypto claim; network; Key Vault |
| `scripts/lib/email-grant-envelope-azure-kv-provider.js` (2F-B) | Production core: AES-256-GCM + RSA-OAEP-256 via injected version-pinned CryptographyClient; Standard KV only; rejects A256KW; full decrypt+reseal rewrap; zero provider-level retries | @azure/identity; KeyClient/getKey/latest; SecretClient; live network; credential composition |
| `scripts/lib/email-grant-envelope-azure-kv-sunset-staging-runtime-composition.js` (2F-C2) | Sunset-staging-canary-only default-off composition: exact 3-key env allowlist; hard-pin host+versioned key+MI client ID; lazy `ManagedIdentityCredential` + version-pinned `CryptographyClient` (maxRetries 0); one-arg env factory only (no production DI); public metadata allowlist; import-inert; never deploy elsewhere | Staff API startup; other tenants/prod/DR; request/env identity selection; KeyClient/list/latest; OAuth/Graph/activation; production test hooks |
| `scripts/lib/email-delegated-grant-custodian.js` (2F-A) | Pinned `{ client }` install/acquire/renew/promote/reauth/abort/reconcile/rewrap-commit; private open seam; public status DTO strips secrets; short TX; SQL `clock_timestamp()` for lease TTL | Graph/MS exchange; TX across I/O; Staff routes; raw tokens in errors |

Consumers must branch on **capability flags** (`remote_drafts`, `push_notifications`, …), not on provider-specific field shapes. Unknown provider ids, capability shapes, and **unknown capability keys on `supports()`** fail closed (throw / structured reject — never silent `false` for typos).

## Credentials

**Plaintext provider credentials never belong in Git, Postgres product rows, logs, or prompts.**

- Only opaque **secret references** are accepted by the 1A/1B contract and by the DB CHECK on `secret_ref`, with an **exact** scheme allowlist:
  - `kv:<bounded-safe-body>`
  - `secret-ref:<bounded-safe-body>`
- Validation order: parse/validate the exact scheme first; then enforce a bounded non-whitespace body grammar; then run secret/token/password **shape detectors against the reference body** (not only the full prefixed string).
- Bodies are non-whitespace, bounded, path-like labels — not passwords, OAuth tokens, JWTs, API keys, or PEM material.
- **Secrets are retrieved through an external secret provider by the adapter** at runtime. This contract never resolves, logs, or returns secret values.
- Pattern-based rejects include (non-exhaustive shape heuristics — **not** full entropy scanning): unprefixed raw secrets; unknown schemes; whitespace; empty refs; and secret-looking bodies after an allowed scheme such as `kv:sk-…`, `kv:password-hunter2`, `secret-ref:ya29.…`, prefixed JWT-shaped / Bearer / `api_key=` / `client_secret=` / `password=` values.
- Valid non-secret examples that remain accepted when body grammar permits: `kv:luna-support-email-credentials`, `secret-ref:tenant/email-mailbox`.

### Owner-approved delegated grant envelope (Slice 2F-A)

**Decision (owner-approved):** raw refresh tokens remain **forbidden** in PostgreSQL. For Microsoft **delegated** refresh-grant custody only, **AES-256-GCM ciphertext + wrapped per-generation DEK + exact Key Vault wrapping-key version ID** may be persisted on `tenant_email_delegated_grants` **atomically** with `grant_generation`.

| Rule | Detail |
|------|--------|
| Atomic unit | One PG transaction commits generation + envelope columns together |
| Not atomic | Microsoft token response; KEK wrap/unwrap I/O; process death between those steps |
| AAD | Binds `client_id`, `endpoint_id`, `grant_generation`, `operation_id`, algorithm version |
| KEK pin | Exact version id only — never `latest` / unversioned GET |
| App-only / Gmail / IMAP | **No grant row** (DB trigger + repository) |
| 2A `resolveSecret` | **Unchanged read-only** — not used for delegated refresh under envelope model |
| Public surfaces | `grant_present` / `grant_status` / `grant_generation` only — never ciphertext, wrapped DEK, nonce, tag, lease token, or raw token |
| 2F-B | Production KV provider core: RSA-OAEP-256 only; client composition deferred to 2F-C2 |
| 2F-C2 | Runtime composition default-**off**; explicit factory; no Staff API activation |

### Production KEK wrap (Slice 2F-B)

| Rule | Detail |
|------|--------|
| Vault SKU | Existing **Standard** Key Vault only (e.g. `wh-staging-kv` class / Sunset staging vault) — no Premium / Managed HSM / new resource |
| Wrap alg | **RSA-OAEP-256** only (RSA 3072/4096 KEK, exact version pin) |
| A256KW | **Not used in production** — requires Premium preview or Managed HSM; 2F-A fake keeps A256KW as local contract proof only; production provider **rejects** A256KW envelopes/config (no silent fallback) |
| Key identity | Full `https://{trusted-host}/keys/{name}/{version}` — never `latest`, unversioned, query, fragment, or path traversal |
| Client surface | Injected `getCryptographyClient(fullVersionedKeyId)` → own-data `{wrapKey,unwrapKey}` only; no KeyClient/getKey/SecretClient/`ManagedIdentityCredential`/`DefaultAzureCredential` in this module |
| Rewrap | **Full decrypt + reseal** under `next_aad` + target configured KEK (fresh DEK+nonce); never pure DEK rewrap while generation advances |
| Retry | Zero provider-level retries; sanitized transient codes (`408`/`429`/`5xx`) for caller lease policy |
| Deferred (2F-B) | Real SDK credential composition (see 2F-C2), live key create, RBAC, controlled live test, refresh-exchange, activation |

### Runtime composition (Slice 2F-C2) — Sunset-staging canary, default-off

Module: `scripts/lib/email-grant-envelope-azure-kv-sunset-staging-runtime-composition.js`
Gate: `npm run verify:email-grant-envelope-azure-kv-sunset-staging-runtime-composition`

**Deployment boundary:** this module is an **unmistakable Sunset-staging canary**. Host, versioned KEK, and user-assigned managed identity client ID are **hardcoded**. It must **never** be deployed to production, other tenants, DR, or rotated-key environments. Those require a **separately reviewed deployment authority/profile** (an analogous explicit module). Future tenant templates create their own profile — they must not silently reuse Sunset.

**Current state:** composition ships **default-off**. Future OAuth/refresh code must call the **explicit factory**; it is **not** wired into Staff API startup. `runtime_activation: false` always. This slice does **not** enable guest email, refresh-exchange, OAuth routes, polling, or Graph.

**Azure / RBAC facts (as of this slice):** C1 complete; controlled operator proof passed. Runtime ACA proof still deferred.

| Rule | Detail |
|------|--------|
| Credential | `@azure/identity` `ManagedIdentityCredential` with **source-pinned** client ID only — constructed only after enabled+valid config. **Never** `DefaultAzureCredential`. **Never** select identity from `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_CLIENT_SECRET` or request/env |
| Crypto client | `@azure/keyvault-keys` `CryptographyClient` for the **exact full versioned key ID** only; `retryOptions.maxRetries: 0` |
| Lazy load | Azure packages `require`d inside the enabled factory path only — module **import-inert** (no credential discovery/network at `require`) |
| Core boundary | 2F-B remains free of `@azure/*` / credential classes; composition supplies `getCryptographyClient` |
| No list/latest | Never `KeyClient`, `getKey`, `listPropertiesOfKeys`, unversioned, or `latest` resolution |
| Selection authority | **Source pin only** — request/body/tenant/query/env must never select vault host, key ID, or credential identity |
| Errors | Construction / SDK load never reads dependency exception properties (throwing `code` getters and proxy `ownKeys` / `getOwnPropertyDescriptor` / `getPrototypeOf` traps must not execute or leak). Caught SDK/client construction failures become a **newly-created fixed-code** error only. Provider ops use existing sanitized boundary |
| Factory surface | Public factory accepts **env only (one argument)** and always lazy-loads `@azure/identity` + `@azure/keyvault-keys` then constructs MIC + CryptographyClient. **No production DI** — no second-arg `createCredential` / `createCryptographyClient` / `loadAzureSdks` / `testDeps`. Exports are Sunset-specific create/parse names only (no generic aliases; no public mutable sanitized-code Set) |
| Offline tests | Verifier uses **fresh child processes** that intercept Node `Module._load` **before** requiring the composition module, supplying constructor spies/fakes for `@azure/*`. Ordinary in-process consumers cannot bypass Azure SDK identity while still receiving canary metadata |
| Public metadata | `composition_enabled`, `runtime_activation`, `deployment_boundary`, `trusted_host`, `kek_key_name`, `kek_key_version`, `wrap_alg` — never credentials, tokens, ciphertext, wrapped DEK |

**Sunset staging pin (public identities — not secrets):**

| Field | Exact value |
|-------|-------------|
| Trusted host | `luna-sunset-staging-kv.vault.azure.net` |
| Key name | `luna-email-grant-kek` |
| Key version | `fde9704bd37b45fabe1f12a6a615b032` |
| Versioned key ID | `https://luna-sunset-staging-kv.vault.azure.net/keys/luna-email-grant-kek/fde9704bd37b45fabe1f12a6a615b032` |
| MI client ID (constructor pin) | `0e05fbe3-e8c5-48aa-a914-30aed284e6f7` |
| MI principal (evidence; not constructor arg) | `5338388f-1685-40cb-ae69-dc2e00f32ad6` (`luna-sunset-staging-identity`) |
| Wrap alg | `RSA-OAEP-256` |

**Pre-deploy:** current Azure readback confirming the MI client ID still maps to principal `5338388f-1685-40cb-ae69-dc2e00f32ad6` is **mandatory** before any deploy.

**Env contract (exact allowlist — no secret values; three keys only):**

| Variable | Rule |
|----------|------|
| `EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED` | Exact case-insensitive `true` required to enable; omitted / `false` / `1` / `yes` → disabled (zero credential construction) |
| `EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST` | Required when enabled; must **exact-equal** the Sunset staging host above |
| `EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID` | Required when enabled; must **exact-equal** the full versioned key ID above (no query/fragment/latest/unversioned) |

Fail-closed **before** `ManagedIdentityCredential` construction: omitted/false enablement; malformed env; foreign host; unversioned/`latest`/query/fragment key ID; key-name or version mismatch; host/key disagreement; non-string/accessor traps. Hostile `AZURE_CLIENT_ID` / DI-looking env keys cannot influence identity or construction. Malformed/disabled paths never import `@azure/*`.

**Remaining activation steps (out of 2F-C2):** reconfirm RBAC Crypto User on the app identity; set the three env vars on Sunset staging ACA only; controlled live wrap/unwrap / runtime ACA proof (still deferred); wire factory into future refresh-exchange / OAuth callback (still gated); no guest email until those gates are green.

### Threat / crash model (2F-A)

| Crash / threat | Durable state | Recovery | Reauth risk |
|----------------|---------------|----------|-------------|
| Before lease COMMIT | unchanged | retry acquire | none |
| After lease, before open/exchange | `lease_held` | wait expiry / owner abort | none |
| After MS success, before seal or PG COMMIT | old generation; MS may have rotated RT | re-acquire; open old; may `invalid_grant` | **yes — accepted** |
| After CAS COMMIT | new generation + envelope durable | continue | no |
| Concurrent loser | lease_held_by_other / generation_conflict | discard sealed buffers | no |
| Lease expiry | DB `clock_timestamp()` steals expired lease | new worker acquires | none from steal alone |
| Endpoint mode changed under grant | trigger rejects | keep delegated pairing | n/a |
| Lost KEK version | grants unopenable | mass reauth | **yes** |

**Hard claims we do not make:** end-to-end atomicity with Microsoft; lease fences Microsoft invalidation; fake provider is production crypto; broad Key Vault GC is safe.

**Down migration 059:** structurally reversible (drops table/triggers); **operationally irreversible after use** (sealed grants destroyed → reauth). Does not delete Key Vault KEKs.

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

### Domain repository (1C-alpha)

Module: `scripts/lib/email-tenant-channel-registry.js`

| Operation | Behavior |
|-----------|----------|
| `buildPreloadedLocationAuthority` | Pure sync helper: trusted pair or `Set` of `${clientId}\0${locationId}` → boolean callback; exact canonical compare; never returns a Promise |
| `listTenantLocations({ clientId, includeInactive? }, { db })` | Always `WHERE client_id=$1`; deterministic `ORDER BY location_id`; single SELECT via `{ db }` executor |
| `listTenantChannelEndpoints({ clientId, includeInactive? }, { db })` | Always tenant-scoped; may return opaque `secret_ref` to trusted callers; never resolves it |
| `createTenantLocation(..., { client })` | Requires pinned transaction `{ client }` (not Pool/`{ db }` → `transaction_client_required`); BEGIN inside guarded try (`began` tracked); parameterized INSERT; default `active=true`; no upsert; unique → `location_already_exists`; COMMIT/post-BEGIN failures → `db_error` + same-client ROLLBACK when began |
| `createDisabledTenantChannelEndpoint(..., { client })` | Same pinned `{ client }` contract; reject mass-assignment / activation; BEGIN guarded; await active location `SELECT` (+ `FOR SHARE`); sync preloaded authority; 1A validate; force disabled SQL params; same-tenant address uniqueness via advisory xact lock (DB only uniquely constrains **active** addresses globally) |

Cross-tenant, missing, and inactive locations are indistinguishable as `location_not_authorized`. Endpoint creation requires an **active** location; rows under later-inactive locations are a future policy question. No update/deactivate functions in alpha.

Conflicts fail closed (409-style codes, not upsert): `location_already_exists` / `endpoint_already_exists`. DB errors map to `db_error` without raw SQL/secret content.

## Admin READ API (1C-beta)

Module: `scripts/lib/staff-email-registry-routes.js`
Wired in: `scripts/staff-query-api.js` (extracted-route ownership; auth + tenant route gate stay in the router).

| Method | Path | minRole | Behavior |
|--------|------|---------|----------|
| `GET` | `/staff/admin/email-registry/locations` | `admin` (owner inherits via rank) | List tenant locations for the ACL-scoped client |
| `GET` | `/staff/admin/email-registry/channel-endpoints` | `admin` (owner inherits via rank) | List tenant channel endpoints for the ACL-scoped client |

**Authorization (existing helpers only):**

1. Router: `requireAuth(req, res, 'admin')` → session + role rank; also runs `authorizeAuthenticatedStaffRoute` for the **home** tenant so `/staff/admin/...` requires that tenant’s `admin_db_read` (defense in depth).
2. Handler: `assertStaffClientAccess(user, clientSlug, res)` for the **requested** client slug (cross-client denied; does not reveal row existence).
3. Handler: injects and calls the same `authorizeAuthenticatedStaffRoute` for the **requested** `clientSlug`, method `GET`, and the exact admin route pathname (runtime env convention). Denied → existing 403 body (e.g. `reason_code: admin_db_read_disabled`) **before** client UUID lookup or repository list. Process-level reserved tenants keep authorizer behavior; no new exception list in the route module.
4. Client UUID resolved solely via parameterized `SELECT id FROM clients WHERE slug = $1` after ACL + requested-tenant authz. Query/body `client_id` is **never** used for scoping.

**Query params:**

| Param | Rules |
|-------|--------|
| `client` / `client_slug` | Tenant slug (default `DEFAULT_CLIENT`); subject to inject check + ACL |
| `include_inactive` | Omit → **true** (return all registry records — admin inventory default; endpoints are created inactive until a later activation slice). Exact `true` \| `false` (case-insensitive after trim). Any other value → **400**. No SQL from this flag beyond the repository’s active filter. |

**Response DTO allowlists (not raw rows):**

- **locations:** `id`, `location_id`, `display_name`, `active`, `created_at`, `updated_at`
- **endpoints:** `id`, `location_id`, `channel`, `provider`, `public_address`, `provider_resource_id`, `capabilities`, `inbound_enabled`, `outbound_enabled`, `default_automation_mode`, `active`, `created_at`, `updated_at`, `secret_ref_present` (boolean)

**Capabilities (fail-closed):** Before returning an endpoint DTO, capabilities must pass the Slice 1A `validateEmailMailboxCapabilities` allowlist (exactly the eight boolean keys). The response rebuilds a **fresh** object from that allowlist — never copies arbitrary JSON keys/nesting. Malformed DB capabilities (missing/extra/nested/non-boolean) fail the **whole** request as sanitized 500 `{ success: false, error: 'read failed' }` (no partial row).

Always omit for every role including admin: `secret_ref`, `created_by`, `updated_by`, `client_id`. Never log `secret_ref` or `err.message`. Logs use a bounded category + sanitized code allowlist only. Audit error fields use a stable allowlist (`db_error`, `capabilities_invalid`, …), never arbitrary repository text.

## Admin WRITE API (1C-gamma)

Same module + wiring. **POST only** (no PATCH/DELETE). Domain owns transactions; routes never nest `BEGIN`/`COMMIT`.

| Method | Path | minRole | Behavior |
|--------|------|---------|----------|
| `POST` | `/staff/admin/email-registry/locations` | `admin` (owner inherits) | Create tenant location (default `active=true`) |
| `POST` | `/staff/admin/email-registry/channel-endpoints` | `admin` (owner inherits) | Create **disabled** email endpoint via `createDisabledTenantChannelEndpoint` |

**Security gates (exact order before writes):**

1. Router: `requireAuth(req, res, 'admin')` (mandatory).
2. Resolve requested tenant **only** from query `client` / `client_slug` / `DEFAULT_CLIENT` — never body/query `client_id`.
3. `assertStaffClientAccess` for requested tenant.
4. `authorizeAuthenticatedStaffRoute` for **requested** tenant + `POST` + exact route pathname → enforces that tenant’s `staff_actions` **and** `admin_writes` (not home tenant alone).
5. Global kill switch `EMAIL_REGISTRY_WRITES_ENABLED`: exact case-insensitive `true` only. Omitted / `false` / `1` / `yes` → **403** `{ success: false, error: 'email_registry_writes_disabled' }` **before** UUID lookup and domain write.

**Input ownership:**

| Resource | Body allowlist | Rejected |
|----------|----------------|----------|
| Location | `location_id`, `display_name`, optional `active` (default `true`; only boolean `true` accepted — domain creates active locations) | `id`, `client_id`, `client`/`client_slug`, `created_by`, `updated_by`, actor/staff ids, unknown keys |
| Endpoint | `location_id`, `provider`, `public_address`, `provider_resource_id`, `capabilities`, `secret_ref` | `id`/client/actor fields; `active`, `inbound_enabled`, `outbound_enabled`, `default_automation_mode`; `locationAuthority` / `location_authority`; unknown keys |

- Require JSON **object** (not array).
- Trusted `clientId` from slug UUID lookup only.
- Trusted actor from authenticated `user.staff_user_id` only (UUID format validated **before** DB; 400 if missing/malformed). Never accept actor from request.
- Endpoint authority only via 1C-alpha domain async active-location lookup — **do not** construct request-supplied authority.
- Domain write deps: `{ client }` on the borrowed `withPgClient` PoolClient — never `{ db }` / Pool. Outer helper owns release.

**Responses:**

- Success **201** with allowlisted DTO (`location` / `endpoint`); never echo request body; never `secret_ref` (only `secret_ref_present`); exact rebuilt eight capabilities.
- `location_already_exists` / `endpoint_already_exists` → **409**
- `location_not_authorized` → **404** (indistinguishable missing/inactive/cross-tenant)
- Validation → **400** stable field-level codes
- `transaction_client_required` / `db_error` → sanitized **500** `{ success: false, error: 'write failed' }`
- Audit success/failure with allowlisted codes + actor id; never `secret_ref` or raw capability objects

**Out of 1C-gamma:** PATCH/DELETE, endpoint activation, secret_ref visibility, provider connectivity/OAuth/send/poll, UI/SOUL/deploy, live mailbox registration, domain/schema changes.

## Automation vs attention

- **Automation modes:** `automatic` | `draft_only` | `off` (DB default `off`).
- **Attention / handoff** is a separate concern (existing inbox/handoff paths) — not folded into automation mode.

## Attachments / payments

- No attachment payloads are downloaded or stored in this foundation. Later work may retain only safe attachment-present metadata / provider references.
- Payments remain in Stripe; payment-card data must never enter email endpoint or adapter records.

## Microsoft Graph adapter boundary (Slice 2A)

Pure offline boundary for a **tenant/endpoint-scoped** `microsoft_graph` mailbox adapter. No Staff API wiring, no registry activation, no live credentials, and no default network transport.

### Official endpoints (fixed hosts/paths)

| Step | Method | URL | Notes |
|------|--------|-----|--------|
| App-only token | `POST` | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` | `application/x-www-form-urlencoded`; `grant_type=client_credentials`; `scope=https://graph.microsoft.com/.default`; tenant segment is the only variable path part (URI-encoded) |
| List message envelopes | `GET` | `https://graph.microsoft.com/v1.0/users/{id\|UPN}/messages?$top={1..50}&$select={fixed allowlist}` | User segment is URI-encoded `provider_resource_id` or normalized `public_address`; `$select` is a fixed basic allowlist (no `body` / `uniqueBody` / `internetMessageHeaders`) |

Hosts and path templates are **fixed** in adapter code. Endpoint input must not supply `host`, `url`, `token_url`, `graph_url`, `authority`, or other injection fields.

### Least-privilege authorization (documented starting point)

Official Microsoft Learn model for **resource-scoped** app-only mailbox access is **Exchange Online RBAC for Applications** (replaces legacy Application Access Policies):

- **Exchange Online application role:** **`Application Mail.ReadBasic`** — least privilege for listing basic message envelopes (no body / previewBody / attachments / extended properties). Maps to Graph permission surface **`Mail.ReadBasic`** (Permissions List column on the role table).
- **Entra application (app-only) mail grants must be absent (empty set).** EXO Application RBAC grants are **independent of** and **union with** unscoped Entra grants; leaving `Mail.Read` / `Mail.ReadBasic` / `Mail.ReadBasic.All` (etc.) consented in Entra **defeats mailbox scope**.
- **Mailbox scope:** first-test mailbox only — `support@lunafrontdesk.com` — via EXO management scope / AU + `New-ManagementRoleAssignment` (not legacy AAP).
- This is **subject to live admin confirmation** against the actual service principal, EXO role assignment, and mailbox licensing. Slice 2A does not configure Entra/EXO; it only documents the requirement. The adapter always targets a single scoped user path from the endpoint identity.
- **Authoritative docs:** [RBAC for Applications in Exchange Online](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac); [Application Access Policies (legacy)](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-access-policies).

### Secret material (app-only only)

- Opaque `secret_ref` only on the endpoint (1A schemes).
- Injected secret provider resolves that ref to **exact** material keys: `tenant_id`, `client_id`, `client_secret` (non-empty strings).
- **No `access_token` secret-material shortcut.** Tests use fake app credentials + scripted fake transport.
- Credentials and tokens are **not cached**; discarded after each `listMessageEnvelopes` request path.
- Never log or return resolved material, `Authorization` values, `client_secret`, raw Graph bodies, or `secret_ref` in adapter errors.

### Capability surface (2A)

| Function | Behavior |
|----------|----------|
| `createMicrosoftGraphMailboxAdapter({ endpoint, secretProvider, transport })` | Validates endpoint allowlist + provider deps; returns frozen adapter |
| `adapter.listMessageEnvelopes(params?)` | See params policy below; token POST then messages GET via injected transport; fresh allowlisted envelope DTOs; **fail closed** (no partial rows) |

### Params, headers, tokens, and test recorder (2A hardening)

- **`listMessageEnvelopes` params:** `undefined` (default `top=10`) or a plain own-data-property object with exact optional key `top` only. Arrays, `null`, unknown keys, symbol keys, and accessor/getter properties → stable **`params_invalid`** (no raw input in details). Present `top` that is not an integer in **1..50** → **`top_invalid`**. Getters are never invoked during allowlist checks.
- **Successful token / Graph JSON responses:** require exactly one string `Content-Type` (case-insensitive name) whose value is a **strict** HTTP media type `application/json` (case-insensitive) with zero or more valid `;` parameters (`token=token` / `token=quoted-string`). Accepts normal `application/json` and `application/json; charset=utf-8`. Rejects empty/trailing parameters, CR/LF/control/DEL, commas/multiple media types, arrays, duplicate case-variant headers, invalid parameter tokens, malformed/unclosed quotes, and injection. Missing/wrong type → `token_response_malformed` or `graph_response_malformed`. Hostile header values are never surfaced in errors.
- **Access token:** before `Authorization` construction, bounded strict validation uses a conservative RFC 6750 **b64token** grammar: only ASCII visible non-whitespace `[A-Za-z0-9\-._~+/]` plus optional trailing `=` padding, with max length. Rejects all non-ASCII, every Unicode whitespace/line terminator/control (incl. U+00A0, U+0085, U+2028/U+2029), embedded `=`, invalid punctuation, and malformed padding. Realistic JWT/base64url/b64token values are accepted. Failure → `token_response_malformed` after exactly one token request and **no** Graph request.
- **Fake transport `getCalls()`:** persistent recorder is **fail-safe sanitized** — never retains raw request body material (stores constant `[REDACTED]` or omits body; exact wire body assertions belong only on the transient scripted-handler call). Persisted headers keep only a tiny safe metadata allowlist (`Accept`, `Content-Type` names/values after descriptor-safe own-data validation); **every other header value is redacted regardless of name** (covers `Authorization`, unknown `X-Access-Token` / `X-Secret` / `API-Key` / custom headers without name-inference). URL / method / `timeout_ms` metadata retained. Transient raw-call construction first snapshots the **request object itself** (own enumerable data properties via `Object.getOwnPropertyDescriptors`), then derives `method`/`url`/`headers`/`body`/`timeout_ms` solely from that snapshot; nested headers use the same descriptor-safe snapshot. Own accessors, inherited prototype getters, symbols, arrays, and non-plain values are never read/invoked. **After the snapshot, only exact expected primitives are accepted — no `String()`/`Number()`/template/`valueOf`/`toString`/`Symbol.toPrimitive` coercion of rejected values:** `method`/`url`/`body` require string data values (else default/omit); headers keep only own enumerable data-property **string** values (names from `Object.keys` descriptors; omit null/object/function/symbol/bigint/…); `timeout_ms` requires a finite safe integer number (else omit). Factory opts (e.g. `handler`) use the same descriptor-safe snapshot — never direct `opts.handler` [[Get]]. Null-prototype plain request data remains supported. Scripted handlers receive the unmutated raw call for wire assertions. `reset()` clears sanitized state.
- **Exact own-data allowlists (no ignored extras):** `readTransportResponse` accepts only own keys `status` / `headers` / `body` (status required); rejects extra string keys, symbols, and accessors without invocation. Graph list envelope requires exact own key `value` only (no `@odata.*` / nextLink for this non-pagination slice). Each message row requires exact own keys matching `$select` (`id`, `subject`, `from`, `receivedDateTime`, `isRead`, `conversationId`, `hasAttachments`, `internetMessageId`); nested `from` (if non-null) exact own key `emailAddress` only; nested `emailAddress` (if non-null) exact own keys `address`, `name`. Extras (`body` / `uniqueBody` / headers / unknown / symbols / accessors) → `graph_response_malformed`, no partial DTO. Token JSON may still include legitimate `expires_in` / `ext_expires_in` (allowlisted reads of `access_token` + `token_type` only; leak-safe).
- **Accessor defense:** endpoint, factory opts, secret material, transport response, secret-provider/transport contract shapes, fake-transport **request objects** (all five fields + nested headers), and Graph row/list mapping read own data properties only (reject accessors without invoking getters).

### Non-goals (Slice 2A)

- Live Azure / Graph / DNS / network I/O from modules or verifiers
- Default or fallback HTTP transport / provider SDK (`@microsoft/microsoft-graph-client`, MSAL, axios, …)
- Polling, webhooks, subscriptions, delta queries
- Send / draft / reply / reply-all / forward
- Attachment content download or storage
- Full message body / `uniqueBody` / internet headers in DTOs
- DB lookups, Staff API routes, registry activation, schema/migrations
- SOUL changes, deploy, live mailbox registration, credential storage in Git/Postgres product rows

## Microsoft Graph app-only read-readiness (Slice 2B)

Pure offline **security-prerequisite contract** for a future human-authorized live Graph integration. Module: `scripts/lib/email-graph-app-only-readiness-contract.js`.

Slice 2B freezes machine-checkable evidence an operator must declare **before** live activation. It **does not perform readiness discovery**, does not call Azure/Entra/Graph/Key Vault, and **never claims** those facts were independently verified — even when `ready_for_human_authorized_live_prerequisite_check` is `true`.

**Official mechanism (current):** [Role Based Access Control for Applications in Exchange Online](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac). Legacy [Application Access Policies](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-access-policies) are **replaced** and must **not** be used for new configuration. Microsoft Learn states EXO Application RBAC grants are **independent of** unscoped Entra grants and that the effective grant is a **union** — unscoped Entra mail permissions must be **removed** or scope is defeated.

### Declaration surface (exact own-data keys)

| Field | Rule |
|-------|------|
| `provider` | exact `microsoft_graph` |
| `auth_mode` | exact `application_client_credentials` |
| `exchange_application_role` | exact `Application Mail.ReadBasic` — reject broader EXO roles (`Application Mail.Read`, `Application Mail.ReadWrite`, Full Access, …) and Entra permission names used as role |
| `entra_application_permission_set` | exact empty array `[]` only — reject `Mail.ReadBasic.All`, `Mail.ReadBasic`, `Mail.Read`, send/write scopes, extras, non-empty sets (unscoped Entra defeats EXO resource scope) |
| `admin_consent_confirmed` | boolean; operator confirmation that EXO RBAC assignment is in place and Entra unscoped mail app grants are absent; `false` ⇒ structurally valid but incomplete |
| `mailbox_scope.mechanism` | exact `exchange_online_rbac_for_applications` — reject legacy `application_access_policy`, multi/all/tenant-wide |
| `mailbox_scope.allowed_public_addresses` | exact single element `support@lunafrontdesk.com` |
| `secret_package.secret_ref` | **input only** — opaque 1A `validateEmailMailboxSecretRef` (reuse — no weaker parser); **never returned** on success |
| `secret_package.material_keys` | set-equal to `['tenant_id','client_id','client_secret']`; reject `access_token` and raw value keys |
| `network_enabled` | exact `false` (true fails closed) |
| `registry_activation_enabled` | exact `false` |
| `inbound_enabled` / `outbound_enabled` | exact `false` |
| `default_automation_mode` | exact `off` |

**Rejected migration/compatibility shapes:** legacy top-level `permission_set` (including `['Mail.ReadBasic.All']`); mechanism `application_access_policy`; non-empty Entra application permission sets; mixed EXO RBAC + unscoped Entra grants; broader EXO application roles.

**Outputs:** fresh deeply frozen ok/fail envelopes. Success value is an allowlisted DTO — includes `exchange_application_role`, empty `entra_application_permission_set`, derived `graph_permission_via_exchange_rbac: ['Mail.ReadBasic']` (from the EXO role table; **not** an Entra grant claim), and `secret_package` as `{ secret_ref_present: true, material_keys: [...] }` only (**no** serialized `secret_ref` / ref value). Failures use stable error codes + allowlisted reason tokens only (never attacker-controlled unknown key names or raw values). Complete valid declarations set `ready_for_human_authorized_live_prerequisite_check: true` with empty `missing_requirements`; valid-incomplete (e.g. admin consent false) keeps `ok: true` with allowlisted missing ids only. Always `azure_facts_independently_verified` / `entra_facts_independently_verified` / `mailbox_facts_independently_verified` = `false`.

**Operator-owned steps (outside this contract / not automated by 2B):**

1. Entra app registration + enterprise application (service principal) for client-credentials — **do not** consent unscoped mail application permissions
2. Exchange Online service-principal pointer + management scope limited to **`support@lunafrontdesk.com`**
3. `New-ManagementRoleAssignment` with role **`Application Mail.ReadBasic`** and that resource scope
4. Confirm Entra application permission grants for mail remain **empty** (remove any unscoped consent if present)
5. Secret store package under opaque ref with exact three material keys; never Git/Postgres product rows
6. Keep network, registry activation, inbound, outbound, and automation **off** until a later explicit activation slice

### Non-goals (Slice 2B)

- Live Azure / Entra / Graph / Key Vault / DNS / network I/O from modules or verifiers
- Readiness discovery automation or “probe live tenant” helpers
- Default HTTP transport, MSAL, Graph SDK, composition/runtime factory
- Schema/migrations, registry rows, inventing client/location/mailbox seeds
- Activation / inbound / outbound / automation enablement
- New or enabled Staff API routes; polling, webhooks, send/draft/reply
- SOUL, deploy, real credentials in Git/Postgres/logs/prompts
- Mutating a live tenant from this repo/session (runbook is paste-ready for a later human only)

## Microsoft delegated OAuth + connector mode (Slice 2C)

**Pivot:** default SaaS Microsoft path is **one Luna-owned multi-tenant delegated OAuth connector**. App-only Exchange RBAC (2A/2B) remains optional enterprise and is **not** modified.

| `connector_mode` | `provider` | `auth_mode` | Default SaaS? |
|------------------|------------|-------------|----------------|
| `microsoft_delegated_oauth` | `microsoft_graph` | `delegated_authorization_code` | **Yes** |
| `microsoft_app_only_enterprise` | `microsoft_graph` | `application_client_credentials` | No (2A/2B) |

Impossible mixes (e.g. `gmail_api` + app-only, `imap_smtp` + delegated) fail closed. Auth mode is orthogonal to 1A capability booleans.

**Confidential web client:** auth code + PKCE **S256** (plain rejected) **and** separate token-endpoint client auth. Exact vocabulary: **`private_key_jwt`** (preferred) and **`client_secret_post`** (explicit temporary Microsoft v2 compatibility path: `client_id`/`client_secret` as **token form fields**; **no** Authorization Basic header). **`client_secret_basic` is rejected** (no silent alias). `pkce_only` / `none` rejected. PKCE S256 + confidential backend auth remain mandatory; browser/tenant never holds or supplies the app credential.

**Authority / hosts / redirect:** `account_audience=organizations` only (`consumers`/`common` rejected); fixed hosts `login.microsoftonline.com` + `graph.microsoft.com`; exact redirect id `luna_ms_delegated_oauth_callback`. No caller-supplied tenant/issuer/authority/token/Graph URLs.

**Phase A scopes (`phase_a_v2`):** required OIDC `openid`/`profile`/`offline_access`; optional OIDC `email` display-only non-authoritative; Graph delegated **exact set** `User.Read` + `Mail.ReadBasic` (`User.Read` is the required delegated permission for `/me`). Excluded: `Mail.Read` / `Mail.ReadWrite` / `Mail.Send`, `*.Shared`, `/.default`, EXO app roles. Own-user only; shared deferred. Phase B (`Mail.ReadWrite`/`Mail.Send`) is a named future set only.

**Server-owned OAuth transaction (callback consume declaration only):** high-entropy `state`/`nonce`; **PKCE S256** = real `base64url(SHA256(verifier))` with RFC 7636 verifier grammar (43–128 unreserved) and unpadded challenge; **mandatory** callback ownership (`expected_luna_client_id`/`expected_location_id`/`expected_staff_session_id` exact-equal stored owner); **`prior_consumed` must be exactly `false`** and **`consume` must be exactly `true`** — omission, non-boolean, `prior_consumed:true` (replay), `consume:false`/non-true, ownership mismatch, or expiry fail closed (server-side; not browser authority). Success status is always `consumed` (never `active`). Offline validator does **not** persist; `atomic_consume_required`/`replay_rejected`/`runtime_atomic_compare_and_consume` declare that the **runtime** callback must **atomically compare-and-consume** server state. TTL ≤600s. Public DTOs never include protocol artifacts or ownership secrets (state/nonce/verifier/challenge/codes/tokens/expected_*).

**Principal:** `ms_delegated_principal:{tid}:{oid}` after signature/keys, issuer from validated org tenant, `aud`=Luna app id, exp/nbf, nonce match, GUID tid/oid. **Not** mailbox identity; email claim never identity.

**Mailbox binding:** requested address is a **hint only**; offline never claims verified. Future live proof needs durable Microsoft mailbox resource id, canonical address, mailbox kind, access kind. Do not claim GoDaddy support. Shared/reseller restrictions → `pending_manual_validation` / `manual_validation_required`.

**Own-user live binding freeze (2C.1; declaration only — no Graph performed):** for `mailbox_kind=user` / `access_kind=own_user`, future live verification must obtain `/me.id`, require **`/me.id == validated provider_principal_oid`**, and persist that same value independently as **`provider_resource_id`** for Phase A own-user. Equality is **expected** for this constrained path, but principal and mailbox remain **separately named concepts/fields** (future shared/administered mailbox paths may diverge). Do **not** derive or verify mailbox offline; do **not** flip readiness/network/activation flags. Canonical address / mail / UPN / email claims are **display/routing evidence only** — not ownership keys.

**Secrets / refresh:** Luna-global app credential separate from per-grant opaque `secret_ref` (material name `refresh_token` only in store). Atomic CAS/lease rotation policy remains declared; terminal reauthorization on `invalid_grant`/revocation/policy/consent loss; no app-wide refresh token. **Refresh-token custody/CAS remains deferred:** refresh-exchange adapter is **blocked** until an injected durable grant custodian exists (no grant fields or adapter code in 2C.1).

**Deferred activation invariants** (schema does not enforce; readiness/activation false): one verified `(provider, tid, durable mailbox id)` → at most one active Luna client; reconnect updates/rotates; cross-client collision needs explicit transfer; one principal may administer multiple mailboxes; aliases do not create accounts.

**Non-goals (Slice 2C):** live OAuth/Graph/MSAL; routes/schema; mutating 2A/2B; activation; Google/IMAP/forwarding; GoDaddy claims; per-customer Entra apps as default; deploy/SOUL/real credentials in Git/Postgres/logs/prompts.

### Later human runbook (paste-ready placeholders only — not executed by 2B)

> **Warning:** Commands below mutate Entra/Exchange when run. Placeholders only — **no real IDs, secrets, or tenant values**. Never print or log secret values. Do not run from offline verifiers. Confirm each checkpoint before the next mutation.

**Authoritative references:**

- https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac
- https://learn.microsoft.com/en-us/exchange/permissions-exo/application-access-policies (legacy; do not use for new config)
- https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/new-managementscope
- https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/new-managementroleassignment
- https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/test-serviceprincipalauthorization

**Roles / permissions (exact):**

| Authority | Name | Required for 2B least privilege |
|-----------|------|----------------------------------|
| Exchange Online application role | `Application Mail.ReadBasic` | **Yes** (scoped via EXO RBAC) |
| Graph permission surface (via EXO role table) | `Mail.ReadBasic` | Granted by the EXO role when scoped; **not** consented as unscoped Entra app permission |
| Entra application permission grants (mail) | *(empty set)* | **Must be empty** — unscoped Entra grants union with EXO RBAC and defeat scope |
| Legacy AAP | `New-ApplicationAccessPolicy` / `application_access_policy` | **Do not use** for new configuration |

**Placeholders (replace offline; never commit real values):**

```text
<TENANT_ID>                  # Entra directory (tenant) ID
<APP_ID>                     # Application (client) ID of the app registration
<SP_OBJECT_ID>               # Enterprise Application / service principal Object ID
                             # (Microsoft Learn: do NOT use App Registration page Object ID;
                             #  AppId + ObjectId come from the enterprise app / Get-MgServicePrincipal)
<DISPLAY_NAME>               # Human label for the EXO service-principal pointer
<SCOPE_NAME>                 # Management scope name, e.g. Luna-Support-Mailbox-Only
<ROLE_ASSIGNMENT_NAME>       # Optional name for New-ManagementRoleAssignment
<TARGET_MAILBOX>             # support@lunafrontdesk.com
<SECRET_REF>                 # Opaque ref only, e.g. kv:<package-name> — never the secret value
```

**Checkpoint 0 — read-only preflight (no mutation)**

```powershell
# Connect with Exchange Online RBAC authority: Organization Management, or
# explicitly delegated required Exchange roles including Role Management.
# A separate Entra role/consent is required to inspect or remove Graph app grants.
Connect-ExchangeOnline
# Optional Entra read (Graph PowerShell) — inspect service principal only; do not print secrets.
# Connect-MgGraph -Scopes "Application.Read.All"
# Get-MgServicePrincipal -Filter "appId eq '<APP_ID>'" | Format-List AppId, Id, DisplayName
```

Confirm: app registration exists; enterprise app `AppId` / `Id` known; **no** unscoped mail application permissions consented (`Mail.Read*`, `Mail.Send`, etc.). If any are present, plan removal after EXO RBAC is verified (order below follows Microsoft Learn migration guidance).

**Checkpoint 1 — management scope (mutation)**

```powershell
New-ManagementScope -Name "<SCOPE_NAME>" `
  -RecipientRestrictionFilter "PrimarySmtpAddress -eq '<TARGET_MAILBOX>'"
Get-ManagementScope -Identity "<SCOPE_NAME>" | Format-List Name, RecipientFilter, ScopeRestrictionType
```

Confirm filter resolves only `support@lunafrontdesk.com` (adjust filter property only if your tenant requires a documented equivalent recipient filter).

**Checkpoint 2 — EXO service-principal pointer (mutation)**

```powershell
New-ServicePrincipal -AppId <APP_ID> -ObjectId <SP_OBJECT_ID> -DisplayName "<DISPLAY_NAME>"
Get-ServicePrincipal | Where-Object { $_.AppId -eq '<APP_ID>' } | Format-List DisplayName, AppId, ObjectId
```

**Checkpoint 3 — role assignment (mutation)**

```powershell
New-ManagementRoleAssignment -Name "<ROLE_ASSIGNMENT_NAME>" `
  -Role "Application Mail.ReadBasic" `
  -App <SP_OBJECT_ID> `
  -CustomResourceScope "<SCOPE_NAME>"
Get-ManagementRoleAssignment -RoleAssignee <SP_OBJECT_ID> | Format-Table Name, Role, RoleAssigneeName, AssignmentMethod
```

**Checkpoint 4 — remove unscoped Entra mail application grants (mutation if any exist)**

Remove organization-wide mail application permission consents from the app in Entra so they do not union with the scoped EXO grant. Do **not** leave `Mail.ReadBasic.All` / `Mail.Read` / etc. consented “just in case.” Prefer portal or Graph admin steps your org already uses; never paste client secrets into shells or tickets.

**Checkpoint 5 — verification (read-only)**

EXO service-principal pointers, management scopes, and role assignments can take
time to propagate. If the read-only authorization test does not show the new
grant immediately, wait and retry it before diagnosing failure or repeating any
mutation command.

```powershell
Test-ServicePrincipalAuthorization -Identity <SP_OBJECT_ID> -Resource <TARGET_MAILBOX> | Format-Table
# Expect Application Mail.ReadBasic in scope for support@lunafrontdesk.com (InScope True for that resource).
# Optional negative check: Test-ServicePrincipalAuthorization -Identity <SP_OBJECT_ID> -Resource <OTHER_MAILBOX>
# Expect InScope False (or no grant) for mailboxes outside the management scope.
```

Also confirm offline contract declaration (no live calls):

```bash
# Operator fills a local declaration object offline; never put secrets in the file.
npm run verify:email-graph-app-only-readiness
```

**Checkpoint 6 — secret package (out of band)**

Store `tenant_id`, `client_id`, `client_secret` under opaque `<SECRET_REF>` only. Never put secret values in Git, Postgres product rows, logs, prompts, or this runbook.

**Rollback (if you must undo EXO RBAC mutations)**

```powershell
# Remove role assignment(s) for the app (identify exact identity first).
Get-ManagementRoleAssignment -RoleAssignee <SP_OBJECT_ID> | Format-List Identity, Role, RoleAssigneeName
Remove-ManagementRoleAssignment -Identity "<ROLE_ASSIGNMENT_IDENTITY>" -Confirm:$false
# Optional: remove EXO service-principal pointer (assignments for it are removed with SP per Learn).
Remove-ServicePrincipal -Identity <SP_OBJECT_ID>
# Optional: remove management scope if unused by other assignments.
Remove-ManagementScope -Identity "<SCOPE_NAME>"
```

Do **not** re-introduce unscoped Entra mail application permissions as a “rollback.” If access must be denied quickly, remove the EXO role assignment / service principal pointer first.

**Coexistence warning (Microsoft Learn FAQ):** EXO Application RBAC permissions act **in addition to** Entra grants (union). Microsoft Entra permissions can only be constrained with legacy Application Access Policies. Resource-scoped access must be granted with RBAC for Applications **and** unscoped Entra organization-wide mail permissions must be removed, or effective scoping fails.

## Inbound email envelope (contract slice)

Modules: `scripts/lib/email-inbound-envelope-contract.js`, `scripts/lib/email-microsoft-graph-inbound-envelope-mapper.js`.
Gate: `npm run verify:email-inbound-envelope-contract`.

**Canonical normalized domain envelope** (provider-neutral, immutable) for identity, ordering, deduplication, and staff-visible triage (later Gmail/IMAP adapters reuse the same shape). This is the **single public domain meaning** of an inbound envelope.

| Normalized field | Role |
|------------------|------|
| `provider` | `microsoft_graph` \| `gmail_api` \| `imap_smtp` |
| `provider_mailbox_id` | Explicit mailbox identity (never inferred by the Microsoft mapper) |
| `provider_message_id` | Provider message identity (identity tuple member) |
| `received_at` | Canonical UTC ISO-8601 instant (impossible calendar dates rejected; no `Date.parse` rollover) |
| `subject` | Bounded optional subject |
| `sender_display_name` / `sender_address` | Bounded optional sender triage |
| `is_read` | Read state |
| `conversation_id` | Conversation/thread identity |
| `internet_message_id` | Internet Message-ID (**metadata only** — not identity/dedup) |

### Identity, dedup, order, tie-break (normative)

| Rule | Definition |
|------|------------|
| **Identity tuple** | `(provider, provider_mailbox_id, provider_message_id)` exactly (`EMAIL_INBOUND_ENVELOPE_IDENTITY_KEYS`) |
| **Dedup** | Two envelopes are duplicates iff identity tuples are equal. `internet_message_id` never participates. |
| **`internet_message_id` null** | Allowed. Null does not create identity. Two nulls on the same identity tuple are still the same message; nulls on different identities do not collide. |
| **`internet_message_id` duplicate** | The same Message-ID string may appear on distinct provider message identities (metadata only; not a dedup key). |
| **Ordering** | `received_at` **descending** (newest first) — `EMAIL_INBOUND_ENVELOPE_ORDER_DIRECTION = received_at_desc` |
| **Tie-break** | When `received_at` is equal: identity tuple ascending (`provider`, `provider_mailbox_id`, `provider_message_id`) |

### Microsoft durable identity (ImmutableId) — future persistence gate

- **Before any future persistence** of Microsoft `provider_message_id`, Graph requests must use **ImmutableId** semantics (`Prefer: IdType="ImmutableId"`). Rest IDs are not durable across moves/mailbox changes.
- Flags: `EMAIL_INBOUND_MICROSOFT_DURABLE_IDENTITY_REQUIRES_IMMUTABLE_ID = true`; offline mapper **does not claim** ImmutableId provenance (`EMAIL_INBOUND_MICROSOFT_MAPPER_CLAIMS_IMMUTABLE_ID_PROVENANCE = false`).
- This slice is **not runtime-wired** (`EMAIL_INBOUND_ENVELOPE_RUNTIME_WIRED = false`): no polling, routes, DB, OAuth, or activation.

### Legacy Graph transport-row compatibility surface

`email-microsoft-graph-adapter.js` `listMessageEnvelopes` / `ENVELOPE_DTO_KEYS` (`id`, `subject`, `from_address`, `from_name`, `received_at`, `is_read`, `conversation_id`, `has_attachments`, `internet_message_id`) is a **legacy provider/transport-row compatibility surface** (`GRAPH_TRANSPORT_ENVELOPE_SURFACE = legacy_provider_transport_row_compatibility`). It is **not** a second domain envelope. Existing adapter consumers keep that shape unchanged.

**One conversion point:** `convertLegacyGraphTransportEnvelopeToInbound({ provider, provider_mailbox_id, legacy })` maps transport → canonical domain (maps `id`→`provider_message_id`, `from_*`→`sender_*`; validates then **discards** transport-only `has_attachments`).

**PII keys** (`EMAIL_INBOUND_ENVELOPE_PII_KEYS`): `subject`, `sender_display_name`, `sender_address`, `internet_message_id`, `provider_message_id`, `conversation_id`, `provider_mailbox_id`. **Persistence and logging of envelope field values are forbidden** until a later reviewed custody slice (`EMAIL_INBOUND_ENVELOPE_PERSISTENCE_FORBIDDEN` / `EMAIL_INBOUND_ENVELOPE_LOGGING_FORBIDDEN`).

**Excluded:** bodies, previews, recipients, headers, attachments, links, tokens, raw provider objects. Microsoft mapper accepts only the approved Mail.ReadBasic row keyset plus optional `@odata.etag` (validated then discarded). No Graph/OData names on the normalized DTO. Contract fields must be **own enumerable data** (non-enumerable keys rejected).

## Verifiers

```bash
npm run verify:email-mailbox-adapter-contract
npm run verify:email-tenant-location-registry
npm run prove:email-tenant-location-registry-pg
npm run verify:email-tenant-channel-registry
npm run prove:email-tenant-channel-registry-pg
npm run verify:staff-email-registry-routes
npm run verify:email-microsoft-graph-adapter
npm run verify:email-inbound-envelope-contract
npm run verify:email-graph-app-only-readiness
npm run verify:email-microsoft-delegated-oauth-contract
npm run verify:email-channel-endpoint-identity
npm run prove:email-channel-endpoint-identity-pg
npm run verify:email-delegated-grant-custodian
npm run verify:email-grant-envelope-azure-kv-provider
npm run verify:email-grant-envelope-azure-kv-sunset-staging-runtime-composition
npm run verify:migration-integrity
```


`prove:email-tenant-location-registry-pg` and `prove:email-tenant-channel-registry-pg` use the disposable harness (Docker preferred; **PGlite acceptable** for local/CI proof). **Stock PostgreSQL must still be proven before deploy** — do not treat PGlite-only green as production migration sign-off.

Slice 1B registers migration `057` in `database/migrations/canonical-manifest.json` (forward order 55) plus explicit down classification. Tables remain empty until operator-controlled registration.

Slice 1C-alpha adds the domain/repository module and its offline + disposable PG proofs only — **no routes**, no auth role policy, no activation, no provider connectivity.

Slice 1C-beta adds the admin-only READ route module + DI wiring + focused offline route verifier — no writes, no activation, no provider connectivity, no live data or deploy.

Slice 1C-gamma extends the **same** route module with kill-switched POST registration + verifier coverage — **no** activation, provider connectivity, live data, or deploy.

Slice 2A adds the Graph adapter boundary modules + `verify:email-microsoft-graph-adapter` (offline hostile probes; injected fake transport only).

Slice 2B adds the app-only read-readiness contract + `verify:email-graph-app-only-readiness` (offline hostile probes; no network/discovery).

Slice 2C adds the connector/auth-mode matrix + Microsoft delegated OAuth contract + `verify:email-microsoft-delegated-oauth-contract` (offline hostile probes; no live OAuth/Graph/MSAL). App-only 2A/2B remain the separate enterprise path.

## Slice 2D — connector + mailbox binding identity

Migration: `058_tenant_channel_endpoint_identity.sql` · Down: `058_tenant_channel_endpoint_identity_down.sql` · Domain: `scripts/lib/email-channel-endpoint-identity-contract.js`.

**Columns** on `tenant_channel_endpoints` (all nullable TEXT; no defaults/backfill): `auth_mode`, `connector_mode`, `provider_tenant_id`, `provider_principal_oid`, `mailbox_kind`, `mailbox_access_kind`, `binding_status`. Reuses existing `provider_resource_id` / `public_address` / `secret_ref` unchanged.

**Invariants (SQL + domain share vocabulary):**
1. Provider allowlist equals migration 057 / domain `EMAIL_IDENTITY_PROVIDERS`: `microsoft_graph` | `gmail_api` | `imap_smtp`. Unknown/future providers fail closed before mode logic.
2. `auth_mode`/`connector_mode` both NULL or both non-NULL.
3. Non-NULL pairs only: `microsoft_graph`+`delegated_authorization_code`+`microsoft_delegated_oauth`; `microsoft_graph`+`application_client_credentials`+`microsoft_app_only_enterprise`.
4. Known non-Microsoft providers (`gmail_api`, `imap_smtp`) ⇒ all seven new identity fields NULL (legacy unclassified).
5. `binding_status` ∈ `unverified_offline` | `pending_manual_validation` | `verified` | `reauthorization_required` | `revoked` (or NULL).
6. Non-null identity components exact-trimmed/nonempty (descriptor-safe; no coercion); tid/oid = canonical lowercase hyphenated UUID. Non-null `provider_resource_id` must be exact-trimmed nonempty in **every** status (including unverified/pending/revoked); SQL `provider_resource_id_shape` CHECK.
7. `verified`/`reauthorization_required` require graph + supported pair + tid + nonempty `provider_resource_id` + mailbox kind/access. Delegated: oid + `mailbox_kind=user` + `mailbox_access_kind=own_user`. App-only: oid NULL + `mailbox_access_kind=application` + `mailbox_kind=user` (minimal honest kind; no shared-mailbox claim).
8. Pre-verification statuses may be incomplete but reject impossible half-pairs / provider-specific orphans. Principal is **not** mailbox.
9. Unique partial index `tenant_channel_endpoints_verified_mailbox_ownership_uidx` on `(provider, provider_tenant_id, provider_resource_id) COLLATE "C"` WHERE `binding_status IN ('verified','reauthorization_required')`. Conflict → SQLSTATE **23505**. Same-row reconnect = UPDATE. Cross-client transfer = future authorized row-lock/update. Aliases are not independent identities. Reauthorization reserves ownership. Database unique enforcement is **concurrency-safe by PostgreSQL semantics**; stock-PG concurrent loser/blocking behavior remains **unexecuted** in this environment (Docker daemon unavailable; PGlite is single-process/in-memory) — remaining pre-deploy proof requirement. Sequential ownership `23505` is proven offline.
10. `secret_ref` syntax unchanged. Mode-dependent package semantics (domain/docs only): delegated per-grant exact `refresh_token`; app-only `tenant_id`/`client_id`/`client_secret`; global delegated app credential separate; validate mode before resolve; public DTO only `secret_ref_present`. SQL does **not** validate package contents; no secret-store inspection.
11. No OAuth tx/nonce/pkce/code/token columns; no rotation state columns. **Does not flip 2C** activation readiness / `schema_enforces` flags (`schema_enforces_activation: false`).

Gate: `npm run verify:email-channel-endpoint-identity`. Disposable PG: `npm run prove:email-channel-endpoint-identity-pg` (Docker preferred; PGlite fallback; report blocker if neither).
