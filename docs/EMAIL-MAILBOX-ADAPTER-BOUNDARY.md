# Email mailbox adapter boundary (Slice 1A + 1B + 1C-alpha + 1C-beta + 1C-gamma)

**Status:**
- **1A:** provider-neutral adapter/validation contract, fake adapter, focused tests.
- **1B:** canonical Postgres registry for tenant locations + email channel endpoints (**empty tables** on migrate; no backfill).
- **1C-alpha:** pure domain/repository layer over those tables for future Staff API routes (**no HTTP routes**, no auth role policy, no activation, no provider connectivity, no live data or deploy).
- **1C-beta:** smallest admin-only **READ** Staff API over that empty registry (list locations + list channel endpoints).
- **1C-gamma:** smallest admin-only, **explicitly kill-switched** registration **WRITE** API (`POST` locations + disabled channel endpoints). No activation, provider connectivity, live registration, or deploy.

**Not in these slices:** Microsoft Graph / Gmail / IMAP network calls, OAuth, subscriptions, polling, send/drafts UI, attachment download/storage, Luna SOUL changes, live mailbox config, deploy, invented client/location/mailbox rows. Activation / secret_ref visibility / provider connectivity remain deferred past 1C-gamma.

## Architectural decision (Slice 1A vs 1B)

Slice **1A intentionally ships no** endpoint persistence schema and no Graph/Gmail/IMAP network code — application validation only. Slice **1B** introduces the authoritative registry with **empty tables** (no backfill).

| Slice | Ships | Defers |
|-------|--------|--------|
| **1A** | Provider-neutral adapter identity + capability contract, secret-ref validation, tenant-aware location validation API (injected **synchronous** authority), fake adapter, verifiers | Endpoint persistence until a real tenant–location parent exists |
| **1B** | Authoritative `tenant_locations` parent + `tenant_channel_endpoints` with composite FK, CHECK constraints, partial unique active address; offline + ephemeral PG proofs | Provider network adapters (Graph/Gmail/IMAP); operator registration of real mappings; **any async PG→app locationAuthority bridge** |
| **1C-alpha (domain/repository)** | Focused module `scripts/lib/email-tenant-channel-registry.js`: list/create locations, list endpoints, create **disabled** endpoints; pure helper `buildPreloadedLocationAuthority`; offline hostile mock-pg + disposable PG proofs | HTTP routes; auth roles; feature flags; update/deactivate; provider adapters; activation / inbound / outbound enable paths; response redaction |
| **1C-beta (admin READ API)** | Extracted DI routes `scripts/lib/staff-email-registry-routes.js` wired into `staff-query-api.js`: `GET /staff/admin/email-registry/locations`, `GET /staff/admin/email-registry/channel-endpoints`; `requireAuth('admin')` + existing `assertStaffClientAccess` + `admin_db_read` gate; DTO allowlists; `secret_ref` always redacted (`secret_ref_present` only) | POST/PATCH/DELETE; activation; secret_ref visibility; provider connectivity; UI |
| **1C-gamma (admin WRITE API)** | Same module: `POST` same two paths; `requireAuth('admin')` + ACL + requested-tenant `staff_actions`/`admin_writes` via `authorizeAuthenticatedStaffRoute`; global kill switch `EMAIL_REGISTRY_WRITES_ENABLED` (exact case-insensitive `true` only); body allowlists; trusted `clientId` from slug UUID + `actor` from `user.staff_user_id`; domain writes via `{ client }` on `withPgClient`; endpoints always disabled | PATCH/DELETE; activation; secret_ref visibility; provider connectivity; UI; live registration |

Application validation in `validateTenantChannelEndpointInput(input, { locationAuthority })` remains a **contract for writes**, not a substitute for DB integrity. Location authority is a **trusted out-of-band callback** (argument 2 only); it fails closed without a valid second-argument authority and never honors authority embedded in untrusted `input`.

**Slice 1B owns persistence.** Tables are **intentionally empty** after migration apply — no client/location/mailbox/secret backfill and no invented IDs or addresses. A later **operator-controlled registration** step supplies real tenant→location mappings and email endpoints. Persistence integrity for client+location ownership is the **composite DB FK** on `tenant_channel_endpoints` → `tenant_locations`.

**Slice 1C-alpha owns the pure repository API** that future Staff API routes can call safely. It does **not** register routes, enforce staff roles, or enable traffic. Endpoint creation always forces `channel=email`, `inbound_enabled=false`, `outbound_enabled=false`, `default_automation_mode='off'`, `active=false` in SQL parameters.

### Location authority boundary (do not pass async into 1A)

The Slice 1A validator requires a **trusted synchronous / preloaded** `locationAuthority` callback that returns `boolean` or `{ok,...}` **immediately**. It is intentionally **not** async and does **not** accept `Promise<boolean>`.

**Slice 1B does not ship a PG authority bridge** (no `email-tenant-location-authority-pg` adapter). Looking up `tenant_locations` over Postgres is inherently async; wiring that directly into `validateTenantChannelEndpointInput` would force an async Slice 1A API, which 1A explicitly does not do.

**Slice 1C-alpha is the future API write boundary** (domain layer only — no HTTP yet): `createDisabledTenantChannelEndpoint` begins a transaction, `SELECT`s the exact active `(client_id, location_id)` (optional `FOR SHARE`), then builds a **synchronous** `buildPreloadedLocationAuthority` closure / preloaded set for the 1A validator. **Do not** pass an async callback / `Promise`-returning function into `validateTenantChannelEndpointInput`.

## Architecture

```
Guest email provider  →  (future) provider adapter  →  Staff API / Postgres
                              ↑
                     email-mailbox-adapter-contract (1A)
                     + tenant_locations / tenant_channel_endpoints (1B)
                     + email-tenant-channel-registry (1C-alpha domain layer)
                     + staff-email-registry-routes (1C-beta READ + 1C-gamma kill-switched WRITE)
```

- **One unified Staff Inbox** with channel-native threads (WhatsApp today; email endpoints registered later).
- **Staff API / Postgres** owns canonical endpoint product state via Slice 1B tables (still empty until operator registration).
- **1C-alpha repository** (`email-tenant-channel-registry.js`) is the only supported write path for locations/disabled endpoints. **Reads** inject `{ db }` (single-query executor; Pool OK for one SELECT). **Writes** require an explicitly pinned transaction `{ client }` for the full BEGIN…COMMIT/ROLLBACK sequence — not a Pool or generic `{ db }` (rejected as `transaction_client_required` before any SQL). No global PG/live config; Staff API `withPgClient` supplies the pinned client for 1C-beta reads and 1C-gamma writes.
- **1C-beta admin READ API** lists registry rows for authenticated admin/owner only; never enables traffic.
- **1C-gamma admin WRITE API** registers locations and **disabled** email endpoints only when `EMAIL_REGISTRY_WRITES_ENABLED=true`; never enables traffic.
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
| `scripts/lib/email-tenant-channel-registry.js` (1C-alpha) | Tenant-scoped list/create for `tenant_locations`; list endpoints; `createDisabledTenantChannelEndpoint`; pure `buildPreloadedLocationAuthority`; reads via `{ db }`; writes via pinned `{ client }` transaction (BEGIN guarded; no Pool); stable structured errors (`location_already_exists`, `endpoint_already_exists`, `location_not_authorized`, `transaction_client_required`, `db_error`) | HTTP routes; auth roles; enable active/inbound/outbound/automation; resolve `secret_ref`; provider SDK/network; global PG pool; Pool as write executor; upsert; leak raw PG messages |
| `scripts/lib/staff-email-registry-routes.js` (1C-beta + 1C-gamma) | Admin GET list + POST create handlers; DI factory; client slug → ACL → requested-tenant authz → (writes) kill switch → UUID; DTO allowlists; `secret_ref` → `secret_ref_present` only; strict body allowlists; domain `{ client }` writes; audit intents; sanitized errors | PATCH/DELETE; activation; expose `secret_ref`; trust query/body `client_id` or actor; provider SDK; enforce auth itself (router owns `requireAuth`); nested BEGIN/COMMIT |

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

## Verifiers

```bash
npm run verify:email-mailbox-adapter-contract
npm run verify:email-tenant-location-registry
npm run prove:email-tenant-location-registry-pg
npm run verify:email-tenant-channel-registry
npm run prove:email-tenant-channel-registry-pg
npm run verify:staff-email-registry-routes
npm run verify:migration-integrity
```

`prove:email-tenant-location-registry-pg` and `prove:email-tenant-channel-registry-pg` use the disposable harness (Docker preferred; **PGlite acceptable** for local/CI proof). **Stock PostgreSQL must still be proven before deploy** — do not treat PGlite-only green as production migration sign-off.

Slice 1B registers migration `057` in `database/migrations/canonical-manifest.json` (forward order 55) plus explicit down classification. Tables remain empty until operator-controlled registration.

Slice 1C-alpha adds the domain/repository module and its offline + disposable PG proofs only — **no routes**, no auth role policy, no activation, no provider connectivity.

Slice 1C-beta adds the admin-only READ route module + DI wiring + focused offline route verifier — no writes, no activation, no provider connectivity, no live data or deploy.

Slice 1C-gamma extends the **same** route module with kill-switched POST registration + verifier coverage — **no** activation, provider connectivity, live data, or deploy.
