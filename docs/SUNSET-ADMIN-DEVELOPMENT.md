# Sunset Admin — development guide

Rules for working on the Sunset surf-school **Admin** tab without repeating the fix6–fix19 regression cycle.

**Branching, deploy, and task reporting:** see [`SUNSET-DEVELOPMENT-WORKFLOW.md`](./SUNSET-DEVELOPMENT-WORKFLOW.md) (`origin/master` base, clean worktree, Lunabox deploy-only, required deploy report fields).

## Source of truth

Use **committed git source + verifiers**, not:

- Lunabox working tree or Docker image tags alone
- `_work/patch-admin-*.js` or archived scripts under `docs/archive/sunset-admin-fix6-fix19/`
- Ad-hoc `tmp/probe-*.js` against staging

| Layer | Responsibility | Primary files |
|-------|----------------|---------------|
| UI render/edit | Admin tab markup, embedded browser JS, fetch/save calls | `scripts/staff-query-api.js` |
| Read model | `GET /staff/admin/config` shape, baseline + optional DB merge | `scripts/lib/tenant-business-config.js` |
| Write model | PATCH/PUT admin routes, validation | `scripts/lib/tenant-admin-writes.js`, `scripts/lib/sunset-admin-pack-rules.js` |
| i18n | EN base + Sunset ES overlay | `scripts/lib/staff-portal-i18n.js`, `scripts/lib/staff-portal-i18n-es-sunset.js` |
| School metadata | Location labels, per-location store | `scripts/lib/sunset-school-locations.js`, `scripts/lib/sunset-admin-location-store.js` |

## Required verifiers before any Admin deploy

Minimum gate (runs locally, no staging credentials):

```bash
npm run verify:sunset-admin
node scripts/verify-sunset-admin-i18n.js
```

In a **full** repo checkout, also run when available:

```bash
node scripts/verify-sunset-portal-v1.js
node scripts/verify-tenant-business-config.js
node scripts/verify-sunset-luna-school-context.js
```

**No deploy claim** until `verify:sunset-admin` passes (both `sunset-somo` and `sunset-sardinero` Admin tabs render with non-empty sections, no `ReferenceError`, no mangled labels, no raw `admin.*` keys).

## Editing `scripts/staff-query-api.js`

This file is ~40k lines with embedded browser JavaScript inside Node template literals.

- **UTF-8 only.** Do not save or transfer as UTF-16 (PowerShell `Out-File` default, bad `scp` modes). Null bytes break `node --check`.
- **Avoid PowerShell `StrReplace` / bulk regex** on this file; prefer a normal editor or a small Node patch script that reads/writes UTF-8.
- After edits: `node --check scripts/staff-query-api.js`
- **Do not** `git checkout scripts/staff-query-api.js` during Admin work unless intentionally reverting — then re-run all verifiers above.

### Embedded browser JS — regex escaping

Regex backslashes inside Node template literals must be **doubled** so the browser receives the intended pattern.

| Browser needs | Example broken source | Example correct in template literal |
|---------------|----------------------|----------------------------------------|
| `/\s+/g` | `.replace(/s+/g` | `.replace(/\\s+/g` |
| `/\d+/` | `/(d+)/` | `/(\\d+)/` |
| word boundary | corrupted humanize | `new RegExp('\\\\b1 hour\\\\b'` |

Corrupted patterns previously turned **wetsuit** → **wet uit**, **surf lesson** → **urf le on**, **adolescent** → **adole cent**. The render verifier asserts these do not reappear.

## Three-layer rule for Admin fields

When adding or changing an Admin field:

1. **UI** — render, edit form, client `fetch` in `staff-query-api.js`
2. **Write** — route handler + validation in `tenant-admin-writes.js` / pack rules
3. **Read** — `resolveTenantBusinessConfig` / `mergeDbWithConfig` in `tenant-business-config.js`
4. **i18n** — key in EN and `staff-portal-i18n-es-sunset.js`; run `verify-sunset-admin-i18n.js`

A change in only one layer causes silent regressions (e.g. surf pack saves but GET omits `surf_packs`, or capacity saves but reload shows default 25).

## School location rule

Sunset has two schools. Internal IDs are stable — **never rename** `sunset-sardinero`.

| `location` query param | UI label |
|----------------------|----------|
| `sunset-somo` | Sunset |
| `sunset-sardinero` | elSardi |

All Sunset Admin, Schedule, and Customers config fetches must include `location` when `client=sunset`. Schedule lesson config must not reuse another school’s cache after a school switch (`scheduleInvalidateSchoolConfigCache` on `setSunsetLocation`).

## Admin tab sections (regression checklist)

The render verifier expects non-empty:

- Business info (school heading)
- Lessons / packs (`#admin-times-body`)
- Rental prices (`#admin-prices-body`)
- Change history (`#admin-history-body`)

## Historical patch workflow (deprecated)

One-off scripts from fix6–fix19 are archived at:

`docs/archive/sunset-admin-fix6-fix19/`

See that folder’s `README.md` — **do not run** archived patch or deploy scripts.

## Out of scope for Admin-only changes

Do not modify in Admin passes: SOUL, Meta routing, WhatsApp/email outbound, Wolfhouse prod, secrets, or run migrations unless explicitly tasked.
