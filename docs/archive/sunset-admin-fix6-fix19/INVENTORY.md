# Inventory — Sunset Admin patch workflow (fix6–fix19)

Classification used when archiving. **Bucket A** = safe to archive (replaced by source/tests). **Bucket B** = emergency documentation value only. **Bucket D** = dangerous/stale deploy helper. **Bucket E** = left in `_work`/`tmp` (non-Admin or unknown).

## A — Replaced by committed source/tests (archived)

All files under `patches/`, `deploy/`, `probes-e2e/`, and `migration-023/` in this folder.

Notable entries:

| File | Notes |
|------|-------|
| `patches/restore-and-patch-staff-api.js` | SSH fetch from lunabox + chain patch-admin-fix8/9 — caused git/disk drift |
| `patches/repair-admin-merge.js` | Manual merge repair after conflicted admin edits |
| `patches/list-missing-admin-i18n.js` | → `scripts/verify-sunset-admin-i18n.js` |
| `patches/patch-admin-fix8.js` … `fix11.js` | Incremental UI patches; staging reached fix19 while chain stopped at fix9 |
| `deploy/deploy-sunset-admin-fix8.sh` etc. | One-off staging deploy scripts — superseded by normal image pipeline + verifiers |
| `probes-e2e/probe-regex-corruption.js` | Staging HTML probe for corrupted `\s`/`\d` regex — now static check in render verifier |
| `probes-e2e/e2e-admin-full.js` etc. | Ad-hoc Playwright against staging — now local fixture server verifier |

## B — Emergency documentation (archived, do not run)

| File | Why kept |
|------|----------|
| `patches/extract-staging-admin.py` | Shows how staging HTML was extracted when git was behind |
| `patches/tenant-business-config-head.js` | Snapshot used during read-model merge debugging |
| `migration-023/*` | Documents migration 023 apply orchestration (migrations themselves live in `database/`) |
| `probes-e2e/staging-*.txt` | Snippets from deployed UI for diff forensics |

## C — Promoted into verifiers

Nothing additional beyond `ddfdeb9`:

- missing admin i18n keys → `verify-sunset-admin-i18n.js`
- `adminSlotTimeEnd`, `renderAdminSchoolContext`, `renderAdminPackEditForm`, `/s+/g` corruption → static checks in `verify-sunset-admin-render.js`
- browser render both schools → Playwright in `verify-sunset-admin-render.js`
- `surf_packs` + lesson capacity read-model → offline mocks in `verify-sunset-admin-render.js`

## D — Dangerous duplicate / stale deploy (archived, labeled in README)

| File | Risk |
|------|------|
| `deploy/deploy-fix14.js` | Partial deploy without full verifier gate |
| `deploy/deploy-upsert-hotfix.sh`, `deploy-price-upsert-fix.sh` | Hotfix deploy bypassing review |
| `patches/restore-and-patch-staff-api.js` | Overwrites local `staff-query-api.js` from SSH |

No duplicate `scripts/lib/staff-query-api.js`, `scripts/sunset-admin-pack-rules.js`, or `scripts/tenant-admin-writes.js` were found in the repo.

## E — Left untouched (not Admin patch workflow)

Remaining `_work/*` and `tmp/*` files (channel routing, inbox, schedule polish, merge scripts, handoff commits, etc.) were **not** moved. Re-run inventory if those areas need their own archive pass.
