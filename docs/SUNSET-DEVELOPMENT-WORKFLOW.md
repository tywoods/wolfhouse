# Sunset — development workflow

Guardrails for all Sunset work (Admin, portal, schedule, customers, Luna tools). **No runtime behavior** is implied by this document — it records how the team and Cursor agents must work.

## Source of truth

| Rule | Detail |
|------|--------|
| **Git base** | `origin/master` is the only default base for new Sunset branches. |
| **Stale branches** | Do **not** branch from old Sunset feature branches (e.g. `feat/sunset-portal-v1-slice-2a`) unless explicitly instructed — they may be stale or partially merged. |
| **Committed source** | Changes land in git on a task branch, merge to `master`, then deploy. |
| **Lunabox** | **Deploy-only** — pull merged `master`, build image, update Container App. Not a second source of truth for edits. |
| **No patch workflow** | Do not apply one-off patches from `_work/`, sparse clones, or archived scripts under `docs/archive/sunset-admin-fix6-fix19/`. |

Admin-specific file ownership and verifier detail: [`SUNSET-ADMIN-DEVELOPMENT.md`](./SUNSET-ADMIN-DEVELOPMENT.md).

---

## Standard workflow (Cursor / operator)

### 1. Start — clean worktree required

```bash
git fetch origin
git checkout master
git pull --ff-only origin master
git status --short
```

If `git status --short` is non-empty, **stop and report**. Do not commit, push, or deploy from a dirty worktree.

### 2. Create task branch

Branch from current `master` only:

```bash
git checkout -b cursor/<short-task-name>
```

Use a descriptive slug (e.g. `cursor/sunset-admin-capacity-label`).

### 3. Make only the requested change

- Minimize scope — one logical change per branch when possible.
- Sunset Staff API paths: `scripts/staff-query-api.js`, `scripts/lib/sunset-*`, `config/clients/sunset.*`, related verifiers.
- Do **not** touch Wolfhouse prod, Hermes SOUL, Meta routing, outbound WhatsApp/email, secrets, or run migrations unless explicitly tasked.

### 4. Verifiers — before commit

Run the gates that match the change. **No deploy claim** until relevant verifiers pass.

**Minimum for any Sunset Admin / portal change:**

```bash
node scripts/verify-sunset-package-runtime.js
npm run verify:sunset-admin
node scripts/verify-sunset-admin-i18n.js
node scripts/verify-tenant-business-config.js
```

**If touching Admin helper / browser code, also:**

```bash
node scripts/verify-sunset-admin-helper-parity.js
node scripts/verify-sunset-admin-pure.js
```

**If touching lesson-time writes, also:**

```bash
node scripts/verify-sunset-admin-lesson-patch.js
```

Broader portal work may also require `npm run verify:sunset-all` or `node scripts/verify-sunset-portal-v1.js` — see Admin guide.

### 5. Commit and push

```bash
git add <intended files only>
git commit -m "<message>"
git push origin cursor/<short-task-name>
```

Open a PR to `master`. Operator merges on GitHub; Lunabox pulls after merge.

### 6. Task report (required)

Every completed task report must include:

- Base SHA ( `master` at branch creation )
- Branch name
- Commit SHA
- Files changed
- Tests / verifiers run with **exact pass/fail output**
- Confirmation: no deploy, migration, SOUL, Meta, outbound, Wolfhouse prod, or secrets changes (unless explicitly in scope)

---

## Deploy workflow (Lunabox / operator only)

Deploy **only** from merged `master`, never from an unmerged branch or dirty tree.

### Pre-deploy

1. On Lunabox (or deploy host): `git fetch origin && git checkout master && git pull --ff-only origin master`
2. Confirm clean worktree: `git status --short` must be empty
3. Record deploy SHA: `git rev-parse HEAD`
4. Run the same verifier set that applies to the deployed change (minimum Admin gate above if portal-related)

### Build and release

- Image: `Dockerfile.luna-sunset-staff-api`
- Registry / app: `whstagingacr.azurecr.io/luna-sunset-staff-api:<tag>` → Azure Container App `luna-sunset-staging-staff-api` (`luna-sunset-staging-rg`)
- Staging URL: https://sunset-staging.lunafrontdesk.com

### Post-deploy report (required)

Every deploy report **must** include:

| Field | Example |
|-------|---------|
| **Git SHA** | `abc1234` (exact commit deployed) |
| **Image** | `whstagingacr.azurecr.io/luna-sunset-staff-api:abc1234-sunset-…` |
| **Revision** | Container App revision name / id after update |
| **Verifier results** | Commands run + pass/fail (paste or summarize exit codes) |
| **Rollback image** | Previous known-good image tag to revert to |

Do not claim “deployed” or “green” without all five fields.

---

## Explicitly forbidden without separate approval

- Deploy from dirty worktree or unmerged branch
- Patches from stale/sparse clones or `_work/` one-offs
- Database migrations on Sunset staging DB
- SOUL / Hermes guest persona changes for Sunset
- Meta / WhatsApp / email outbound configuration
- Wolfhouse staging or production changes
- Secrets or live Stripe keys in git

---

## Related docs

- [`SUNSET-ADMIN-DEVELOPMENT.md`](./SUNSET-ADMIN-DEVELOPMENT.md) — Admin tab layers, i18n, school locations
- [`sunset/SUNSET-STAFF-PORTAL-V1-BUILD-PLAN.md`](./sunset/SUNSET-STAFF-PORTAL-V1-BUILD-PLAN.md) — portal slice planning
- [`archive/sunset-admin-fix6-fix19/README.md`](./archive/sunset-admin-fix6-fix19/README.md) — deprecated patch history (do not run)
