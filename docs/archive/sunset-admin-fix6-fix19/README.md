# Sunset Admin fix6–fix19 — historical patch artifacts (archived)

These files are **not** the source of truth for Sunset Admin. They are one-off patch, deploy, probe, and e2e scripts from the fix6–fix19 whack-a-mole period (live Lunabox edits, partial git commits, chained Node/Python patch runners).

## Do not use

- **Do not run** any script in this folder against the current `scripts/staff-query-api.js` or staging.
- **Do not** treat Lunabox disk or Docker image tags as git baseline.
- **Do not** chain `restore-and-patch-staff-api.js` + `patch-admin-fix*.js` — that workflow caused regressions when git checkout reverted UI while read-model patches remained.

Many probe/e2e scripts hit **staging** and may embed credentials or hard-coded URLs. They are kept for forensic reference only.

## Source of truth (current)

| Layer | File(s) |
|-------|---------|
| UI + embedded browser JS | `scripts/staff-query-api.js` |
| Read model | `scripts/lib/tenant-business-config.js` |
| Write model | `scripts/lib/tenant-admin-writes.js`, `scripts/lib/sunset-admin-pack-rules.js` |
| i18n | `scripts/lib/staff-portal-i18n.js`, `scripts/lib/staff-portal-i18n-es-sunset.js` |
| Regression gate | `npm run verify:sunset-admin`, `node scripts/verify-sunset-admin-i18n.js` |

See **`docs/SUNSET-ADMIN-DEVELOPMENT.md`** for development and deploy rules.

## Folder layout

| Subfolder | Contents |
|-----------|----------|
| `patches/` | `patch-admin-fix*.js`, `restore-and-patch-staff-api.js`, `repair-admin-merge.js`, Python/Node one-off fixers |
| `deploy/` | `deploy-sunset-admin-*.sh`, `deploy-admin-*.sh`, `commit-admin-*.sh`, `deploy-fix14.js` |
| `probes-e2e/` | `tmp/` and `_work/` staging probes, Playwright e2e scratch scripts, fetch helpers |
| `migration-023/` | Sunset Admin location migration 023 orchestration (host/container scripts) |

## Replaced by committed verifiers

| Historical script | Replaced by |
|-------------------|-------------|
| `_work/list-missing-admin-i18n.js` | `scripts/verify-sunset-admin-i18n.js` |
| `tmp/probe-regex-corruption.js`, `tmp/probe-missing-fns.js` | Static checks in `scripts/verify-sunset-admin-render.js` |
| `tmp/e2e-admin-*.js`, `tmp/probe-live-ui.js` | Playwright section in `scripts/verify-sunset-admin-render.js` |
| `_work/probe-sunset-admin-config.js` | Read-model mocks in `verify-sunset-admin-render.js` + `verify-tenant-business-config.js` |

Archived: **2026-06-23** (commit `chore(sunset): archive admin patch workflow docs`).
