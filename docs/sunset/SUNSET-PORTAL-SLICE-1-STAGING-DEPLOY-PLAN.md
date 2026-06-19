# Sunset Portal Slice 1 — Staging Deploy Plan

**Status:** DRAFT — awaiting Captain sign-off  
**Date:** 2026-06-19  
**Branch:** `feat/sunset-multitenant-luna`  
**Scope:** Staging Staff API only. Read-only Sunset portal gating + Day Schedule tab.  
**Parent docs:** `SUNSET-PORTAL-SLICE-1-IMPLEMENTATION-PLAN.md`, `SUNSET-PORTAL-SLICE-1-SEED-INPUTS.md`, `VERIFY-LUNA-GOLDEN-DB-NOTE.md`

---

## ⛔ Approval gate — do not proceed until Captain approves

**No staging deploy, no seed execution, no production changes, and no merge to `master` until Captain explicitly signs off on this plan.**

Captain must approve in writing:

1. This deploy plan document.
2. The exact commit SHA to deploy (see §1).
3. Running the seed script against staging Postgres (see §6) — separate approval from code deploy.
4. Any change to `staff-portal-access.json` beyond current `all_clients_emails` (see §5).

Deckhand/Cursor **must not** deploy, seed, or merge without those approvals.

---

## 1. Branch and commit to deploy

| Item | Value |
|------|-------|
| **Branch** | `feat/sunset-multitenant-luna` |
| **Minimum feature commit** | `251b4095d49eec170de793f1b8a00edd9f4eb74c` — `feat(sunset): add read-only portal slice 1` |
| **Required prerequisite commits** | `6ff91e8` — seed manifest + `portal_demo` inputs; earlier Sunset tenant skeleton on branch |
| **Plan authoring HEAD** | `b36d1ca` (or later on same branch at approval time) |
| **Deploy pin** | Captain approves **one SHA** at deploy time; record it in the deploy log |

**Recommendation:** Deploy branch HEAD after pre-deploy checks pass. Slice 1 runtime code is contained in `251b409`; later commits on the branch are docs/tests only unless additional Sunset commits land before approval.

**Explicitly not in this deploy:** merge to `master`, production hosts, Hermes/Luna SOUL changes, database migrations.

---

## 2. Staging services affected

| Service | Host / resource | Impact |
|---------|-----------------|--------|
| **Staff API + portal UI** | `https://staff-staging.lunafrontdesk.com` | **Primary** — `scripts/staff-query-api.js` container restart/redeploy |
| Azure Container App | `wh-staging-staff-api` (port 3036) | New image from approved branch SHA |
| Staging Postgres (app DB) | `wh-staging-pg-app` / `wolfhouse_staging` | **Read-only for Slice 1 UI** until seed approved; seed writes demo rows only |
| Config bundle in image | `config/clients/*.baseline.json`, `staff-portal-access.json` | Must include `sunset.baseline.json` + existing Wolfhouse configs |

**Not affected (no deploy action):**

- Production Staff API or production DB
- Hermes gateway / `docker/hermes-staging/SOUL.md` (do not edit Luna SOUL)
- n8n (`wh-staging-n8n-main`, `wh-staging-n8n-worker`)
- Wolfhouse WhatsApp channel runtime
- Any new database migrations

---

## 3. Files and features included

### Runtime (commit `251b409`)

| File | Feature |
|------|---------|
| `scripts/staff-query-api.js` | Session `client_profiles`; tab gating; Day Schedule panel; `loadDaySchedule()`; startup `portalStartupAfterSession()` |
| `scripts/lib/staff-portal-clients.js` | `loadClientPortalProfile()`, `buildClientProfilesMap()`, `SURF_VERTICALS` |
| `scripts/lib/staff-portal-i18n.js` | Day Schedule nav + panel strings |
| `package.json` | `verify:sunset-portal-slice1` script |
| `scripts/verify-sunset-all.js` | Wires slice1 verifier |
| `scripts/verify-sunset-portal-slice1.js` | Offline gating checks (25 assertions) |

### Config / fixtures (branch; not in `251b409` but required on staging image)

| File | Purpose |
|------|---------|
| `config/clients/sunset.baseline.json` | `_meta.vertical: surf_school_rentals`; `portal_demo.lesson_slots` (3 demo slots) |
| `fixtures/sunset-portal-slice1/seed-manifest.json` | Machine-readable seed spec (validated offline; not executed until seed script + Captain approval) |
| `config/clients/staff-portal-access.json` | Current access model (see §5) |
| `config/clients/wolfhouse-somo.baseline.json` | Unchanged Wolfhouse tenant |

### Portal Slice 1 user-visible behavior

- **Sunset (`sunset`):** default tab WhatsApp; hide Booking Calendar + Tour Operator; show Day Schedule (read-only).
- **Wolfhouse (`wolfhouse-somo`):** default tab Booking Calendar; all existing tabs visible; Day Schedule hidden.

---

## 4. Pre-deploy checks (run on deploy worktree before image build)

Execute on `/opt/luna/Luna-Sunset` at the approved SHA:

```bash
npm run verify:sunset-all
npm run verify:sunset-portal-slice1
```

**Expected:** both pass with zero failures (verified 2026-06-19: `verify:sunset-all` 6/6, `verify:sunset-portal-slice1` 25/25).

### Known `verify:luna-golden` limitation (not a deploy blocker)

`verify:luna-golden` is **out of scope** for this Sunset deploy. On Lunabox it fails without local Postgres (`ECONNREFUSED 127.0.0.1:5433`). See `docs/sunset/VERIFY-LUNA-GOLDEN-DB-NOTE.md`.

| Check | Required for Slice 1 staging deploy? |
|-------|--------------------------------------|
| `verify:sunset-all` | **Yes** |
| `verify:sunset-portal-slice1` | **Yes** |
| `verify:luna-golden` | **No** — CI/dev-machine gate; do not start Postgres on Lunabox |

Optional additional Staff API smoke (Captain discretion): `npm run verify:staff-query-api`, `npm run verify:staff-query-ui` — not Sunset-specific but guard Wolfhouse portal regressions.

---

## 5. Staging config required

### Sunset client config

- **File:** `config/clients/sunset.baseline.json`
- **Vertical:** `_meta.vertical = surf_school_rentals` → portal treats tenant as surf vertical.
- **Demo slots:** `portal_demo.demo_mode = true`; `portal_demo.lesson_slots` (3 entries, dates include `2026-07-10`).
- **`deployment.enabled`:** remains `false` in skeleton — portal gating is config-driven; Captain may enable staging deploy flags separately if required by hosting pipeline.

**Staging image must include this file.** If absent, `loadClientPortalProfile(sunset)` falls back to Wolfhouse behavior (bed calendar default, no tab hiding).

### Staff access expectations

**Current `staff-portal-access.json`:**

```json
all_clients_emails: [tywoods@gmail.com]
```

- `listBaselineClients()` discovers all `*.baseline.json` clients, including `sunset`.
- `tywoods@gmail.com` receives **all** tenants (Wolfhouse + Sunset) via `all_clients_emails`.

**Is `all_clients_emails` enough for owner demo?**

**Yes** for Captain/owner demo: login as `tywoods@gmail.com`, use client selector to switch between Wolfhouse and Sunset, verify gating on each.

**Not enough** for a Sunset-only operator demo. For that, Captain must approve adding a scoped entry, e.g.:

```json
client_access: {
  sunset.demo@example.test: [sunset]
}
```

That change is **optional** and requires separate Captain approval (not part of Slice 1 code deploy minimum).

### Auth / safety defaults (staging container)

Per Azure staging scaffold: `STAFF_AUTH_REQUIRED=true`, `STAFF_ACTIONS_ENABLED=false`, `WHATSAPP_DRY_RUN=true`, `NODE_ENV=staging`. Slice 1 is read-only and aligns with these defaults.

---

## 6. Seed plan

### Still missing (not on branch)

| Artifact | Status | Owner |
|----------|--------|-------|
| `scripts/fixtures/sunset-portal-slice1-seed.js` | **Not implemented** | Cursor (after Captain approves seed run) |
| `scripts/fixtures/sunset-portal-slice1-cleanup.js` | **Not implemented** | Cursor |
| Seed execution on staging DB | **Not run** | Captain-approved ops only |

**Manifest ready:** `fixtures/sunset-portal-slice1/seed-manifest.json` (validated by `verify:sunset-portal-slice1-seed`, 116 assertions).

**Seed tag convention:** `metadata.source = sunset_demo_slice1` (distinct from Wolfhouse `stage8_demo`).

**Seed guards (mandatory in script):** `assertNotProduction()`, `assertClientSlug(sunset)`, refuse Wolfhouse rows.

### Demo without DB seed (config only)

Works immediately after Staff API deploy — no Postgres writes:

| Surface | Source |
|---------|--------|
| Tab gating (hide bed-calendar, tour-operator) | `loadClientPortalProfile()` |
| Default tab = WhatsApp | Session `client_profiles` |
| Day Schedule tab visible | `is_surf_vertical` |
| **Demo lesson slot tiles** | `portal_demo.lesson_slots` from baseline (capacity/booked from config) |
| Client selector lists Sunset | `sunset.baseline.json` on disk |
| Read-only badge / i18n | Static UI |

**Empty without seed:** WhatsApp inbox conversations, Day Schedule lessons/rentals tables (`services.lessons_today`, `services.gear_today` return no rows).

### Requires DB seed (after Captain approves seed run)

| Surface | DB entities |
|---------|-------------|
| WhatsApp inbox demo threads | `conversations`, `messages` |
| Day Schedule lessons table | `booking_service_records` (`surf_lesson`, etc.) |
| Day Schedule rentals/gear table | `booking_service_records` (`board_rental`, `wetsuit`, etc.) |
| Optional handoff queue item | `staff_handoffs` (golden-04 kids age scenario) |

**Reference demo date:** align smoke tests with manifest (`2026-07-10` for lesson slots; service record dates per manifest).

### Seed execution policy

1. Captain approves seed run **separately** from code deploy.
2. Run seed script once against `wolfhouse_staging` with staging credentials.
3. Record seed tag + row counts in deploy log.
4. Do **not** run seed in this planning phase or before Captain sign-off.

---

## 7. Manual smoke test checklist (staging)

Run at `https://staff-staging.lunafrontdesk.com` after deploy (+ optional seed).

### A. Login and session

- [ ] Open `/staff/login`; authenticate with approved staff email.
- [ ] `GET /staff/auth/session` returns `clients` including `sunset` and `wolfhouse-somo`.
- [ ] Response includes `client_profiles.sunset` with `is_surf_vertical: true`, `default_tab: conversations`.

### B. Sunset tenant (`client=sunset`)

- [ ] Select **Sunset Surf School** in client dropdown.
- [ ] **Default tab** is WhatsApp (not Booking Calendar).
- [ ] **Booking Calendar** tab is hidden.
- [ ] **Tour Operator** tab is hidden.
- [ ] **Day Schedule** tab is visible.
- [ ] Open Day Schedule; demo lesson slot tiles render for `2026-07-10` (from config).
- [ ] Date picker + Load refreshes view without errors.
- [ ] **No Wolfhouse leakage:** no room codes (R1–R7), no bed calendar grid, no Wolfhouse packages/rates, no `wolfhouse-somo` data in query responses when `client=sunset`.
- [ ] *(If seeded)* WhatsApp inbox shows demo conversations (`demo-conv-sunset-001`, `002`).
- [ ] *(If seeded)* Day Schedule lessons/rentals tables show manifest rows.

### C. Wolfhouse regression (`client=wolfhouse-somo`)

- [ ] Switch to Wolfhouse; **default tab** is Booking Calendar.
- [ ] Booking Calendar and Tour Operator tabs **visible**.
- [ ] Day Schedule tab **hidden**.
- [ ] Bed calendar loads; existing Wolfhouse flows unchanged.

### D. Read-only constraints

- [ ] No new write affordances introduced in Day Schedule (no create/edit/payment actions).
- [ ] `STAFF_ACTIONS_ENABLED=false` behavior unchanged for staging.

---

## 8. Rollback plan

### Code rollback (fast)

1. Redeploy previous known-good Staff API image SHA (pre-`251b409`) to `wh-staging-staff-api`.
2. Confirm Wolfhouse portal smoke (bed calendar default, no Day Schedule tab).
3. Record rollback SHA and time in deploy log.

### Config rollback

- Remove or rename `config/clients/sunset.baseline.json` from staging image **only if** Sunset tenant must disappear entirely (portal falls back to Wolfhouse profile for unknown slugs).
- Revert any `staff-portal-access.json` Sunset-only user entries if added.

### Seed rollback (if seed was run)

1. Run `scripts/fixtures/sunset-portal-slice1-cleanup.js` (when implemented) — deletes rows where `metadata->> source = sunset_demo_slice1`.
2. Verify: zero Sunset demo conversations/service records remain; Wolfhouse `stage8_demo` rows untouched.

### Production

**Do not rollback production** — Slice 1 does not touch production. If production was never deployed, no action.

---

## 9. Deploy sequence (after Captain approval)

| Step | Action | Owner |
|------|--------|-------|
| 1 | Captain signs off this plan + SHA | Captain |
| 2 | Run pre-deploy checks (§4) at pinned SHA | Deckhand/Cursor |
| 3 | Build Staff API container image from `feat/sunset-multitenant-luna` | Captain/Ops |
| 4 | Deploy to `wh-staging-staff-api` only | Captain/Ops |
| 5 | Run manual smoke §7A–C (config-only demo) | Deckhand |
| 6 | *(Optional, separate approval)* Implement + run seed script | Cursor + Captain |
| 7 | Re-run smoke §7B seeded items | Deckhand |
| 8 | Captain demo sign-off or rollback per §8 | Captain |

---

## 10. Summary

Portal Slice 1 is **code-complete and offline-verified** on `feat/sunset-multitenant-luna`. Staging deploy is a **Staff API image update** plus existing config files. A **partial demo works without DB seed** (tab gating + Day Schedule config slots). **Full demo** (inbox + service tables) requires the **not-yet-written seed script** and **Captain-approved seed run**. `verify:luna-golden` remains excluded. **Do not proceed until Captain approves this plan.**

---

*Document version: 1.0 — 2026-06-19*
