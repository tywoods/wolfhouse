# Phase 1b — De-tenant the pricing/booking (money) spine

**Status:** SPEC / **BLOCKED — do not implement yet.** Money layer, higher blast
radius than 1a. Land only after review AND after the prerequisite below is met.
**Precondition:** Phase 1a landed (`187cb5d`) — membership boundary + adapter
fail-closed wall. See `docs/PHASE-1-VERTICAL-TENANT-ISOLATION-SLICE.md`.

## ⛔ Hard prerequisite (verified 2026-07-29): no provisioned second tenant exists

1b's whole point is to let a *provisioned* second school transact. Today there is
none. The only configured second surf school, `lawave`
(`config/clients/lawave.baseline.json`), is a **non-live skeleton**:

- `deployment.enabled: false`, `_meta.status: "config_skeleton"`, `version: 0.1`
- `catalog.offerings: {}` — **zero** priced offerings
- its own `pricing_policy` mandates: `on_unverified_seed_in_live:
  "block_do_not_quote"`, `on_provisional_in_live:
  "handoff_or_block_do_not_autocharge"`, and `live_autonomous_charge_requires:
  "pricing_status_confirmed"`.

De-tenanting the money spine now would open a quote/charge path for a tenant
whose own config says **do not quote**. The **Phase 1a fail-closed wall is the
correct, policy-compliant terminal state** for such a tenant: recognized, walled,
no money path.

**Unblock 1b only when** a second tenant is (a) `deployment.enabled: true`,
(b) has owner-confirmed `pricing_status_confirmed` offerings (not skeleton /
provisional / TODO), and (c) has real per-tenant pricing rows/config. Until then,
leave every gate below intact — they are correctly protecting, not merely
single-tenant debt.

## Goal

Let a second provisioned surf school bind its own tenant end-to-end (catalog /
quote / create / price) so it can transact, then **remove that tenant from the
Phase 1a `PROVISIONED_CLIENT_SLUGS` wall** in `surf-school-vertical-adapter.js`.
Until a tenant is fully wired here, it stays walled (fails closed) — never
half-open.

## Exact de-tenant sites

### 1. `scripts/lib/tenant-business-config.js` (the hard gate)

All pin to `SUNSET_ADMIN_CLIENT = 'sunset'` (`:31`). Replace single-tenant
equality with a surf-school membership predicate (`isSurfSchoolClient`) + a
per-tenant admin-config source (baseline JSON already resolves per-slug via
`resolveSurfSchoolConfig`; DB rows are scoped by `client_slug`):

- `:288` `resolveFromConfigFile` → `unsupported_client` unless `is_surf_vertical
  && slug === SUNSET_ADMIN_CLIENT`. Widen to any surf-school slug; keep
  fail-closed for non-surf/reserved slugs.
- `:386-387` `loadTenantBusinessConfigFromDb` → **throws `tenant_scope_violation`**
  if `slug !== SUNSET_ADMIN_CLIENT`. Widen to membership; keep the throw for
  reserved / non-surf slugs (defense-in-depth, not a single-tenant pin).
- `:587-588` second `tenant_scope_violation` throw — same treatment.
- `:697` returns `false` unless sunset — audit what this gates (overlay/flag) and
  widen consistently.
- `:933`, `:949`, `:999`, `:1038-1039` — `SUNSET_CLIENT_SLUG` / reserved-slug
  checks; re-express as "is a provisioned surf-school tenant", preserving the
  reserved-slug and Wolfhouse exclusions exactly.

Keep `SUNSET_ADMIN_CLIENT` / `SUNSET_CLIENT_SLUG` as explicit legacy identity
constants — do **not** derive membership from them.

### 2. Service executors (bind the trusted slug, drop the sunset pin)

Each executor currently rejects any command whose `clientSlug !== SUNSET_CLIENT_SLUG`:

- `luna-front-desk-catalog-service.js:419`
- `luna-front-desk-quote-service.js:1888`, `:1934`
- `luna-front-desk-booking-create-service.js:135`

Change to: accept any provisioned surf-school slug, and thread that slug into the
command builders (which currently hard-code `clientSlug: SUNSET_CLIENT_SLUG`) and
into every `resolveTenantBusinessConfigAsync(SUNSET_CLIENT_SLUG, …)` call
(~30 sites across the three services). The adapter must pass
`request.resolved.clientSlug` into `buildSunset*Command(...)` instead of relying
on the internal constant.

### 3. Adapter identity outputs

`surf-school-vertical-adapter.js` — once services are de-tenanted, replace the
adapter's own `SUNSET_CLIENT_SLUG` outputs with `request.resolved.clientSlug`:
`supportedClientSlug` (`:111`), availability `client_slug` (`:215`), and
`assertCourseAssignable` `clientSlug` (`:233`). Then narrow / remove the
`PROVISIONED_CLIENT_SLUGS` wall for the now-supported tenant.

## Required additions to the hostile gate (1b asserts)

Extend `scripts/verify-vertical-tenant-isolation-second-school.js` (and/or a DB
integration test) to prove, for a fully-provisioned second school:

- catalog / quote / create queries **bind that tenant's slug** (not sunset).
- prices/config come from that tenant's rows/baseline — never Sunset's.
- Sunset and the second school cannot read each other's catalog/prices.
- HTTP-layer forgery: authenticated tenant is compared to `resolved`; a forged
  `resolved.clientSlug` that disagrees with auth returns an audited 403 before
  DB acquire/write.

## Do-not

- Do not remove a tenant from the 1a wall until its full path (config + services
  + adapter identity) binds its own slug and the 1b asserts are green.
- Do not weaken the reserved-slug / Wolfhouse exclusions while widening.
- Do not derive membership from the legacy `SUNSET_*` identity constants.
