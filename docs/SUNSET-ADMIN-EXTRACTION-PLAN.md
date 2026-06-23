# Sunset Admin extraction plan

**Status:** Planning only — no implementation in this document.  
**Baseline:** Admin working; regression gate `ddfdeb9` + archive/docs `d033d0e`.  
**Goal:** Split Sunset Admin out of `scripts/staff-query-api.js` (~40k lines) without changing runtime behavior, UI, or deploy posture.

---

## 1. Current Admin ownership map

| Concern | Owner today | Key symbols / paths |
|---------|-------------|---------------------|
| **Admin config GET / read model** | `scripts/lib/tenant-business-config.js` (resolver); `scripts/staff-query-api.js` (HTTP) | `resolveTenantBusinessConfig`, `resolveTenantBusinessConfigAsync`, `mergeDbWithConfig`, `withLocationMeta`; `handleAdminConfig` (~L34050) |
| **Lesson time capacity read** | `tenant-business-config.js` | `mapCapacityRows`, `lesson_capacity` on resolved config; per-slot `capacity` on `lesson_times` via DB merge / `attachLessonPrices` |
| **Lesson time writes** | `scripts/lib/tenant-admin-writes.js` (DB + validation); `staff-query-api.js` (routes) | `putLessonCapacityDefault`, `createLessonTimeRule`, `patchLessonTimeRule`, `deactivateLessonTimeRule`; routes `PUT …/lesson-capacity`, `POST/PATCH/DELETE …/lesson-times` |
| **Surf pack CRUD** | `scripts/lib/sunset-admin-pack-rules.js` (validation + DB); `tenant-admin-writes.js` (shared audit/helpers); `staff-query-api.js` (routes) | `validatePackBody`, `createSurfPackRule`, `patchSurfPackRule`, `deactivateSurfPackRule`; routes `POST/PATCH/DELETE …/surf-packs` |
| **Rental price writes** | `tenant-admin-writes.js`; `staff-query-api.js` | `validatePricePatchBody`, `validatePriceCreateBody`, `patchPriceRule`, `createRentalPriceRule`, `deactivatePriceRule`; routes `POST/PATCH/DELETE …/prices` |
| **Admin browser rendering** | `staff-query-api.js` embedded browser IIFE (~L21870–L22756) | `renderAdminFromConfig`, `renderAdminSection*`, `renderAdminLessonCards`, `renderAdminPackCards`, `adminRenderPackEditForm`, `wireAdminTab` markup targets `#admin-*-body` |
| **Admin edit/save browser handlers** | Same IIFE (~L22758–L23150+) | `wireAdminTab` click delegate, `adminApiRequest`, `adminReloadConfig`, `adminReloadConfigKeepingEdit`, `loadAdminTab`, `adminEditTarget` state |
| **Admin i18n** | `scripts/lib/staff-portal-i18n.js` (EN); `scripts/lib/staff-portal-i18n-es-sunset.js` (ES overlay); browser `portalT()` in IIFE | Keys `admin.*`; school keys `school.sunsetSomo`, `school.sunsetSardinero` |
| **School display labels** | Browser: `getSunsetLocationLabel()` in IIFE; server: `sunset-school-locations.js` + `sunset-admin-location-store.js` | `sunset-somo` → “Sunset”; `sunset-sardinero` → “elSardi” (never rename ID) |
| **Schedule school cache / lesson config** | `staff-query-api.js` Schedule block (~L19385–L20108) | `scheduleFetchSchoolConfig`, `scheduleSchoolConfigUrl` → same `GET /staff/admin/config`, `scheduleAdminCacheMatchesSchool`, `scheduleInvalidateSchoolConfigCache` on `setSunsetLocation` |
| **Change history / audit** | Read: `tenant-business-config.js` (`mapAuditRows`, `change_history`); Write audit: `tenant-admin-writes.js` (`insertConfigAudit`); API log: `staff-query-api.js` (`appendAuditLog` on GET) | `#admin-history-body` via `renderAdminSectionChangeHistoryFromConfig` |

### Physical layout inside `staff-query-api.js`

| Region | Approx. lines | Notes |
|--------|---------------|-------|
| Admin CSS | ~L16156–L16230 | `.portal-admin-*` inside main `<style>` |
| Admin HTML shell | ~L17578–L17604 | `#tab-admin`, section bodies |
| School location (shared) | ~L19072–L19240 | Used by Admin, Schedule, Customers, Inbox |
| Admin browser module | ~L21870–L23150 | `var adminConfigCache`, helpers, render, wire, load |
| Admin HTTP handlers | ~L34046–L34460 | `handleAdminConfig*` + route table ~L39883+ |
| Server requires (already extracted) | ~L195–L226 | `tenant-business-config`, `tenant-admin-writes`, `sunset-admin-pack-rules` |

**Note:** There is no function named `adminRenderLessonPriceStrip`; lesson price UI uses `.portal-admin-lesson-price-strip` CSS and `adminIsLessonPrice` filtering in `renderAdminSectionPricesFromConfig`.

---

## 2. Extraction candidates ranked by risk

Risk scale: **low** = mechanical, testable, little coupling; **high** = cross-tab state, template literals, or write round-trips.

### A. Pure Admin browser helper functions — **low** (best first PR)

| Proposed module | Functions to move (or mirror) |
|-----------------|------------------------------|
| `scripts/lib/sunset-admin-pure.js` | `adminHumanizeText`, `adminSlotTimeStart`, `adminSlotTimeEnd`, `adminSlotDurationLabel`, `adminParseTimeHm`, `adminParseCapacity`, `adminMinutesFromHm`, `adminEurosFromAmount`, `adminParseEurosToCents`, `adminParseEurosToCentsOptional`, `adminPeriodSortKey`, `adminParsePriceRow` (non-DOM parts) |

| Attribute | Detail |
|-----------|--------|
| **Why low** | No `document`, `portalT`, or `fetch`; regex bugs here caused label corruption — Node unit tests catch `\s`/`\d` escaping without Playwright. |
| **Why not zero** | Today these live inside a browser IIFE in a template literal; moving requires a **parity strategy** (see PR1). |
| **Tests before move** | Add `scripts/verify-sunset-admin-pure.js` (or `node --test`) with vectors: wetsuit/surf lesson/adolescent strings, slot times `11:00-13:00`, capacity edge cases. Existing `verify-sunset-admin-render.js` static checks remain. |
| **Rollback** | Revert single new module + verifier; browser inline copies unchanged until wired. |

### B. Admin UI render functions — **high**

| Proposed module | Functions |
|-----------------|-----------|
| `scripts/browser/sunset-admin-render.js` (future) | `renderAdminFromConfig`, `renderAdminFallback`, `renderAdminLoadingShell`, `renderAdminSectionBusinessInfoFromConfig`, `renderAdminSectionLessonTimesFromConfig`, `renderAdminSectionPricesFromConfig`, `renderAdminSectionChangeHistoryFromConfig`, `renderAdminLessonCards`, `renderAdminPackCards`, pack/price/time edit forms |

| Attribute | Detail |
|-----------|--------|
| **Why high** | Depends on `el`, `escHtml`, `portalT`, `adminConfigCache`, `adminEditTarget`, `adminCfgWritesEnabled`; builds HTML strings. |
| **Tests before move** | `npm run verify:sunset-admin` (Playwright) mandatory; optional DOM snapshot compare pre/post. |
| **Rollback** | Revert `buildUiHtml()` include path; keep monolith slice in git history. |

**Recommended approach:** Do **not** extract as Node modules. Extract as a **plain UTF-8 browser file** included via `fs.readFileSync` into `<script>` (same pattern as `scripts/lib/sunset-admin-verify-ui-html.js`). Removes template-literal regex hazard for that file only.

### C. Admin browser event/save handlers — **high**

| Proposed module | Functions |
|-----------------|-----------|
| `scripts/browser/sunset-admin-actions.js` | `wireAdminTab`, `loadAdminTab`, `adminReloadConfig`, `adminReloadConfigKeepingEdit`, `adminApiRequest`, `adminShowMessage` |

| Attribute | Detail |
|-----------|--------|
| **Why high** | Large `wireAdminTab` switch; touches write APIs, `adminSaveBusy`, `scheduleInvalidateSchoolConfigCache` after saves (if any), school query via `adminClientQuery`. |
| **Tests before move** | `verify:sunset-admin` + manual staging write smoke (full repo only) before any deploy PR. |
| **Rollback** | Revert browser include; handlers stay in monolith. |

**Defer until B’s include mechanism is proven.**

### D. Admin route handlers — **medium**

| Proposed module | Functions |
|-----------------|-----------|
| `scripts/lib/staff-admin-routes.js` | `handleAdminConfig`, `handleAdminConfigPricePatch/Post/Delete`, `handleAdminConfigLessonCapacityPut`, `handleAdminConfigLessonTimePost/Patch/Delete`, `handleAdminConfigSurfPackPost/Patch/Delete`, `decodeAdminPathId` |

| Attribute | Detail |
|-----------|--------|
| **Why medium** | Already delegates to `tenant-*` libs; needs injected deps (`sendJSON`, `withPgClient`, `appendAuditLog`, `assertStaffClientAccess`, env flags). |
| **Why not low** | Route table wiring in main server must stay in sync; easy to miss a path. |
| **Tests before move** | `verify-tenant-business-config.js`; extend with HTTP-level tests against fixture server (optional); `verify:sunset-admin` for GET shape. |
| **Rollback** | Re-export handlers from monolith `require('./lib/staff-admin-routes')` — one-line route table revert. |

### E. Admin read-model — **medium** (mostly done)

| Proposed module | What remains in monolith |
|-----------------|--------------------------|
| `tenant-business-config.js` (existing) | `mergeDbWithConfig` surf_packs `[]` vs missing; capacity merge; `attachLessonPrices` |

| Attribute | Detail |
|-----------|--------|
| **Why medium** | Logic is already extracted; risk is **changing** merge rules during “cleanup”. |
| **Tests before move** | `verify-sunset-admin-render.js` § read-model; `verify-tenant-business-config.js`. |
| **Rollback** | Revert `tenant-business-config.js` only. |

**PR4** = fixtures + tests only, no behavior change.

### F. Admin i18n verification — **low** (keep as verifier)

| Item | Recommendation |
|------|----------------|
| `scripts/verify-sunset-admin-i18n.js` | **Stay a verifier** — scans `portalT('…')` in `staff-query-api.js` (later: scan `scripts/browser/sunset-admin-*.js` too). |
| Reusable utility | Optional `scripts/lib/staff-portal-i18n-scan.js` shared by verifier — **only if** PR2 splits browser files (avoid premature abstraction). |

### G. Sunset school-location utilities — **medium–high**

| Proposed split | Functions |
|----------------|-----------|
| `scripts/browser/sunset-school-context.js` (future) | `getSunsetLocation`, `getSunsetLocationLabel`, `adminClientQuery`, `sunsetLocationQuerySuffix`, `setSunsetLocation`, `refreshSunsetSchoolContextLabels` |
| `scripts/lib/sunset-school-config-cache.js` (future, PR5) | `scheduleFetchSchoolConfig`, `scheduleInvalidateSchoolConfigCache`, `scheduleAdminCacheMatchesSchool`, caches |

| Attribute | Detail |
|-----------|--------|
| **Why high** | Shared by Schedule, Customers, Inbox, Admin; `renderAdminSchoolContext` re-renders Admin on school switch. |
| **Tests before move** | `verify:sunset-admin` both locations; `verify-sunset-luna-school-context.js` (full repo); schedule pack e2e if restored. |
| **Rollback** | Revert school block as a unit. |

**Server-side** `normalizeSunsetLocationId` / labels already live in `sunset-school-locations.js` — do not duplicate.

---

## 3. Recommended PR sequence

Order prioritizes **testable pure logic → server routes → browser file split → shared cache**, each independently deployable.

### PR 1: Pure Admin helper mirror + unit verifier (no browser wire-up)

| | |
|--|--|
| **Files** | Add `scripts/lib/sunset-admin-pure.js`; add `scripts/verify-sunset-admin-pure.js`; optional `package.json` script `verify:sunset-admin-pure`. **Do not** remove inline browser functions yet. |
| **Tests** | New pure verifier (regex/parse vectors); `npm run verify:sunset-admin`; `node scripts/verify-sunset-admin-i18n.js`. |
| **Verifier commands** | `node scripts/verify-sunset-admin-pure.js`; `npm run verify:sunset-admin`; `node scripts/verify-sunset-admin-i18n.js`; `node --check scripts/staff-query-api.js`. |
| **Risk** | **Low** |
| **Rollback** | Delete new files; zero runtime change if browser not wired. |

### PR 2: External browser Admin script (render + helpers), included by `buildUiHtml`

| | |
|--|--|
| **Files** | Add `scripts/browser/sunset-admin-ui.js` (UTF-8, no Node template nesting); change `buildUiHtml()` to inject `<script>\n${fs.readFileSync(...)}\n</script>`; shrink monolith by deleted lines; update `sunset-admin-verify-ui-html.js` if needed. |
| **Tests** | `verify:sunset-admin` (critical); static check that monolith no longer contains corrupted `/s+/g` patterns in moved region; `verify-sunset-admin-pure` parity optional (AST or shared tests). |
| **Risk** | **Medium–high** (single include point; must preserve IIFE scope or use explicit `window` exports minimally). |
| **Rollback** | Revert to inline script block in `staff-query-api.js` (one git revert). |

**Alternative (safer sub-PR):** PR 2a = extract **helpers only** to browser file; PR 2b = extract render functions.

### PR 3: Extract Admin HTTP route handlers

| | |
|--|--|
| **Files** | Add `scripts/lib/staff-admin-routes.js`; `staff-query-api.js` `require` + thin delegates; route table unchanged paths. |
| **Tests** | `verify-tenant-business-config.js`; `verify:sunset-admin` GET assertions; optional supertest on fixture server. |
| **Risk** | **Medium** |
| **Rollback** | Inline handlers back into monolith. |

### PR 4: Read-model fixtures (no merge logic change)

| | |
|--|--|
| **Files** | Add `scripts/fixtures/sunset-admin-config-snapshots.json`; extend `verify-sunset-admin-render.js` or `verify-tenant-business-config.js` to assert golden shapes (surf_packs `[]`, capacity 200, location_id). |
| **Tests** | Existing verifiers + snapshot tests. |
| **Risk** | **Low** |
| **Rollback** | Remove fixtures only. |

### PR 5: Schedule/Admin shared school config cache module

| | |
|--|--|
| **Files** | `scripts/browser/sunset-school-schedule-config.js` or shared browser bundle; isolate `scheduleFetchSchoolConfig` + invalidation; ensure `setSunsetLocation` still invalidates before Admin reload. |
| **Tests** | `verify:sunset-admin` both schools; add focused test: switch school in Playwright → assert `location_id` on second Admin load; full-repo schedule verifiers. |
| **Risk** | **High** |
| **Rollback** | Revert cache module; keep monolith schedule block. |

### PR 6 (optional, later): Admin CSS + HTML partials

| | |
|--|--|
| **Files** | `scripts/templates/tab-admin.html`, `styles/portal-admin.css` included in `buildUiHtml`. |
| **Risk** | **Medium** (layout regressions) |
| **Defer** | Until PR2–3 stable. |

---

## 4. What NOT to extract yet

| Area | Reason |
|------|--------|
| Full portal HTML shell (`buildUiHtml` tabs, drawer, bed-calendar) | Wolfhouse + surf gating intertwined; high blast radius. |
| `switchToTab`, `initStaffPortalSession`, auth/session boot | All tabs depend on startup order (`portal-profile-pending`). |
| Schedule ops board, inbox merge, customers tab | Not Admin; school cache coupling makes PR5 a prerequisite. |
| DB write paths refactor inside `tenant-admin-writes.js` | Needs staging round-trip or integration tests not in sparse clone. |
| `sunset-admin-location-store.js` JSON overlay semantics | Migration 023 / location column detection — deploy-sensitive. |
| Pack tier business rules | Keep in `sunset-admin-pack-rules.js`; don’t fork validation. |
| Moving Admin CSS before browser JS is stable | Visual regressions hard to catch without full Playwright coverage. |
| Replacing embedded JS with npm frontend build (webpack/esbuild) | New toolchain risk; out of scope. |
| `renderAdminSchoolContext` into Admin-only bundle before school switch PR | Called from `refreshSunsetSchoolContextLabels` (multi-tab). |

---

## 5. Test gate for each PR

### Required on every Admin extraction PR

```bash
node --check scripts/staff-query-api.js
npm run verify:sunset-admin          # expect 69 passed, 0 failed
node scripts/verify-sunset-admin-i18n.js   # expect 4 passed, 0 failed
```

### PR-specific additions

| PR | Extra commands |
|----|----------------|
| PR1 | `node scripts/verify-sunset-admin-pure.js` (new) |
| PR2 | Same; confirm Playwright both schools + no ReferenceError |
| PR3 | `node scripts/verify-tenant-business-config.js` |
| PR4 | `node scripts/verify-tenant-business-config.js` |
| PR5 | Above + school-switch scenario in `verify-sunset-admin-render.js` (future case) |

### Full-repo (run when checkout is complete; **do not block** sparse clone)

| Command | Known sparse-clone failure |
|---------|----------------------------|
| `node scripts/verify-sunset-portal-v1.js` | Missing `Dockerfile.luna-sunset-staff-api`; some demo-seed assertions |
| `node scripts/verify-sunset-luna-school-context.js` | Missing `./luna-guest-booking-dry-run` |
| `node scripts/verify-tenant-business-config.js` | `lesson times from portal_demo` if baseline lacks `portal_demo.lesson_slots` |
| `node scripts/verify-portal-locale-isolation.js` | **File does not exist** (use `verify-portal-tenant-isolation.js` with staging passwords) |

**Blocking failures for Admin extraction:** only `verify:sunset-admin` and `verify-sunset-admin-i18n` unless the PR touches server read-model (then `verify-tenant-business-config` must pass in full repo).

---

## 6. Deploy / rollback checklist (future PRs that ship)

Use when an extraction PR is deployed to staging — **not** for planning/doc-only commits.

### Pre-deploy

- [ ] Branch merged with all PR test gates green on **full** lunabox checkout.
- [ ] `npm run verify:sunset-admin` — 69/69, both `sunset-somo` and `sunset-sardinero`.
- [ ] `node scripts/verify-sunset-admin-i18n.js` — 0 missing keys.
- [ ] `node --check scripts/staff-query-api.js`.
- [ ] No unintended changes to SOUL, Meta, WhatsApp/email, Wolfhouse routes, secrets, or migration files.
- [ ] Image tag recorded (e.g. `whstagingacr…/luna-sunset-staff-api:<git-sha>-<timestamp>`).

### Deploy rules

- [ ] **Image-only** staff API deploy unless explicitly approved otherwise.
- [ ] **No migration** unless separate approved migration PR (e.g. 023).
- [ ] `SUNSET_ADMIN_DB_READ_ENABLED` / `SUNSET_ADMIN_WRITES_ENABLED` unchanged unless intentional.

### Post-deploy smoke

- [ ] Hard refresh `/staff/ui` (Ctrl+Shift+R).
- [ ] Open Admin tab — Sunset (`sunset-somo`): non-empty business, lessons, rentals, history; heading **Sunset**.
- [ ] Switch school to elSardi (`sunset-sardinero`): heading **elSardi**; sections still populated; `GET /staff/admin/config?...&location=sunset-sardinero` returns matching `location_id`.
- [ ] Browser console: no `ReferenceError`; no raw `admin.*` keys; no `wet uit` / `urf le on` / `adole cent`.
- [ ] Optional: run Playwright verifier against staging (future); local `verify:sunset-admin` against release artifact if wired.

### Rollback

- [ ] Redeploy previous image tag (document tag in deploy note).
- [ ] Re-run post-deploy smoke on rolled-back image.
- [ ] If rollback was due to extraction PR, revert git commit and rebuild image — **do not** re-run archived `_work/patch-admin-*.js` scripts.

---

## 7. First implementation prompt (PR 1 only)

Copy the block below into a new Cursor task when ready to implement. **Do not run until explicitly requested.**

---

**Prompt — PR 1: Sunset Admin pure helper mirror (no behavior change)**

Repository context:

- Admin regression gate: `npm run verify:sunset-admin` (69 passed) and `node scripts/verify-sunset-admin-i18n.js` (4 passed).
- Development rules: `docs/SUNSET-ADMIN-DEVELOPMENT.md`.
- Extraction plan: `docs/SUNSET-ADMIN-EXTRACTION-PLAN.md` PR 1.

Task: Implement **PR 1 only** — extract **pure** Sunset Admin helper logic into a Node module with tests. **Do not change browser/runtime behavior** in this PR.

Constraints:

- No UI redesign.
- No changes to `wireAdminTab`, render functions, routes, or `buildUiHtml` output (byte-identical `/staff/ui` HTML/JS for Admin sections).
- No deploy, migrations, SOUL, Meta, WhatsApp/email, Wolfhouse/prod, or secrets.
- Keep `sunset-sardinero` as internal ID; display label elSardi unchanged.

Steps:

1. Create `scripts/lib/sunset-admin-pure.js` with pure functions mirroring the browser implementations of:
   - `adminHumanizeText`
   - `adminSlotTimeStart`
   - `adminSlotTimeEnd`
   - `adminSlotDurationLabel`
   - `adminParseTimeHm`
   - `adminParseCapacity`
   - (optional same PR) `adminMinutesFromHm`, `adminEurosFromAmount`, `adminParseEurosToCents`

   Copy logic exactly from `scripts/staff-query-api.js` (browser IIFE). Use normal JS regex literals in the Node file (no template-literal escaping).

2. Create `scripts/verify-sunset-admin-pure.js` with test vectors covering:
   - Labels: “Wetsuit rental”, “surf lesson”, “Adult / adolescent group surf lesson” — must not produce `wet uit`, `urf le on`, `adole cent`.
   - Slot time: `11:00-13:00` → start/end/duration labels match current behavior.
   - Capacity: valid integers, reject garbage.

3. Add npm script `verify:sunset-admin-pure` in `package.json` if safe.

4. **Do not** remove or replace inline browser functions in `staff-query-api.js` in this PR (mirror-only).

5. Run and report:
   ```bash
   node scripts/verify-sunset-admin-pure.js
   npm run verify:sunset-admin
   node scripts/verify-sunset-admin-i18n.js
   node --check scripts/staff-query-api.js
   ```

6. Commit message: `refactor(sunset): add pure admin helper module and verifier`

Deliver: files changed, pass/fail counts, confirmation `/staff/ui` Admin output unchanged (verify:sunset-admin still 69/69).

---

## Appendix: regression → extraction mapping

| Historical regression | Owner layer | Extraction mitigates via |
|----------------------|-------------|---------------------------|
| Missing `adminSlotTimeEnd` | Browser IIFE | PR1 pure tests + PR2 static browser file + `verify:sunset-admin` ReferenceError check |
| Regex `\s` → `s` corruption | Template literal | PR2 external `.js` file (no nested escaping) |
| Raw `admin.*` i18n keys | i18n + render | `verify-sunset-admin-i18n` + Playwright |
| `surf_packs` missing on GET | Read model | `verify-sunset-admin-render` mocks; PR4 fixtures |
| Capacity revert to 25 | Read merge | `verify-sunset-admin-render` + `verify-tenant-business-config` |
| Wrong school cache on switch | Schedule + Admin | PR5 cache module + Playwright both locations |
| `git checkout` nuking UI patches | Process | `docs/SUNSET-ADMIN-DEVELOPMENT.md` + smaller files in git |

---

*Document version: 2026-06-23. Planning pass only — no code changes.*
