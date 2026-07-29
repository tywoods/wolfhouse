# Phase 1 — Vertical→Tenant isolation slice (membership + end-to-end propagation)

**Status:** SPEC / not implemented. Do **not** land the predicate change alone.
**Owner file (linchpin):** `scripts/lib/luna-front-desk-vertical-scope.js`
**Blocking review:** Skipper Task 2 (2026-07-28) — verdict **BLOCK a standalone
`VERTICAL_TENANT` membership widening**.

## Why this is one slice, not a predicate swap

The tempting change is to turn the tenant-equality boundary into a membership
check so a second surf school (e.g. `lawave`) stops getting a 403. That is
**unsafe on its own**, because the downstream surf-school adapter still
hard-forces Sunset. If `lawave` is admitted through the boundary before the
trusted slug is threaded through, a `lawave` request enters **Sunset-owned**
catalog / quote / create / availability / course-assignment operations.

Therefore membership widening **and** end-to-end `clientSlug` propagation must
land together, gated by one hostile regression suite.

## The boundary (exact site)

`scripts/lib/luna-front-desk-vertical-scope.js:39-48` — `assertResolvedVerticalScope`:

```js
const expectedTenant = VERTICAL_TENANT[expectedVerticalId];   // 'sunset' for surf_school
if (expectedTenant && resolved.clientSlug !== expectedTenant) {
  return { ok:false, status:403, reason:'tenant_mismatch', reason_code:'tenant_mismatch', ... };
}
```

`VERTICAL_TENANT` (line 14-17) maps one vertical → one tenant. This equality is
the audited 403 cross-tenant isolation boundary. The FORTRESS matrix
(`docs/FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md`, 97/97 GREEN) is its floor.

## Required atomic change set

1. **Membership, not equality.** Replace `resolved.clientSlug !== expectedTenant`
   with an audited membership check per vertical:
   - `surf_school` → `isSurfSchoolClient(slug)` (`surf-school-config.js`)
   - `accommodation` → `isWolfhouseClientSlug(slug)` (existing)
2. **Preserve the trusted slug.** `sunset` stays `sunset`; `lawave` stays
   `lawave`. Never coerce to a canonical tenant.
3. **Thread `resolved.clientSlug`** through every surf-school adapter op. Today
   these are hard-coded `SUNSET_CLIENT_SLUG` in
   `scripts/lib/verticals/surf-school-vertical-adapter.js`:
   - `:111` `supportedClientSlug: SUNSET_CLIENT_SLUG`
   - `:215` availability response `client_slug: SUNSET_CLIENT_SLUG`
   - `:233` course assignment `clientSlug: SUNSET_CLIENT_SLUG`
   - plus catalog / quote / create builders that resolve Sunset by constant.
4. **Location validation** against *that tenant's* surf-school config, not
   Sunset's location helper. A `lawave` request must not accept `sunset-somo` /
   `sunset-sardinero`, and Sunset must not accept a Lawave location.
5. **Keep `SUNSET_TENANT = 'sunset'`** as an explicit legacy compatibility
   constant — do **not** derive it from the membership collection.
6. **Fail closed before DB access** when tenant, vertical, and location
   membership disagree (no DB acquire / no write on a mismatch).

## Required hostile regression (new second-school suite)

Must prove more than "lawave is recognized":

- [ ] `lawave` resolves to `surf_school`.
- [ ] Resolved slug remains `lawave`, never `sunset`.
- [ ] `lawave` cannot use `sunset-somo` or `sunset-sardinero`.
- [ ] `sunset` cannot use a Lawave location.
- [ ] `lawave` catalog / quote / create queries bind `lawave`.
- [ ] No `lawave` request invokes a Sunset-hard-coded command.
- [ ] Forged `resolved={verticalId:'surf_school', clientSlug:'sunset'}` under
      `lawave` auth returns an audited **403** — **before** DB acquire/write.
- [ ] Existing Wolfhouse and unknown-tenant denial cases stay GREEN.

## Phase 1 gate (authoritative as of 2026-07-29)

Baseline debt cleared first (commits `020fcd9`, `b3f61f7`) so these are real
greens, not stale short-circuits:

```
node scripts/verify-fortress-tenant-identity-boundary-matrix.js
node scripts/verify-luna-front-desk-vertical-adapter.js
node scripts/verify-staff-auth-api.js
node scripts/verify-sunset-group-lesson-quote.js
node scripts/verify-sunset-course-equipment-booking-production.js
node scripts/verify-sunset-rental-db-precedence.js
node scripts/verify-sunset-create-quote-six-day-async.js
```

The new hostile second-school suite joins this gate when the slice lands.

## Do-not

- Do not merge the `VERTICAL_TENANT` map / predicate change alone.
- Do not derive the legacy `SUNSET_TENANT` constant from the membership set.
- Do not let mechanical literal-replacement sweeps touch this boundary without
  the propagation + hostile regression in the same change.
