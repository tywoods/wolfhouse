# Automated Staff Notifications — Staging Runbook

**Feature branch:** `cursor/automated-staff-notifications-slice-1` (slices 1–5) + live-send slice  
**Staff Portal (staging):** https://staff-staging.lunafrontdesk.com  
**Current state:** UI + CRUD API + dry-run CLI + gated manual live CLI + **staging job deploy script (operator-run)** — job not installed until deploy script runs with `--apply`

---

## 1. What this feature does

Owners/admins can schedule **Automated Staff Notifications** from the Luna Staff tab:

- Save a **title** and **prompt** (Ask Luna question text).
- Pick **recipients** from active Staff & Owner Numbers for the tenant.
- Choose **days of week** (Mon=0 … Sun=6) and a **local time** (timezone default `Europe/Madrid`).
- Enable/disable each automation.

A separate **dry-run CLI** (`scripts/run-staff-automated-notifications.js`) can execute due automations:

- Runs Ask Luna once per due automation.
- Writes **audit rows** to `staff_automated_notification_events` with status `dry_run` or `failed`.
- Updates automation `last_run_at`, `last_status`, `last_error`.
- **Does not send WhatsApp messages** (default mode).

A **gated live CLI** (`--live`) can send WhatsApp to allowlisted test numbers only when **all** env gates are set (see §6.4). Still **manual CLI only** — no cron.

---

## 2. Files in this feature

| Area | Path |
|------|------|
| Migration | `database/migrations/033_staff_automated_notifications.sql` |
| CRUD + runner lib | `scripts/lib/staff-automated-notifications.js` |
| Dry-run CLI | `scripts/run-staff-automated-notifications.js` |
| Staging job deploy | `scripts/deploy-staff-automated-notifications-job.js` |
| Staff Portal UI + API routes | `scripts/staff-query-api.js` |
| Verifiers | `scripts/verify-staff-automated-notification-ui.js` |
| | `scripts/verify-staff-automated-notifications-crud.js` |
| | `scripts/verify-staff-automated-notifications-runner.js` |
| | `scripts/verify-staff-automated-notifications-live.js` |
| | `scripts/verify-staff-automated-notifications-scheduler.js` |
| npm scripts | `package.json` (`verify:staff-automated-notification-*`) |

### API routes (admin auth + client access)

- `GET/POST /staff/automated-notifications?client=...&location=...`
- `PUT/DELETE /staff/automated-notifications/:id?client=...&location=...`

Routes require `requireAuth(..., 'admin')` and `assertStaffClientAccess`. Recipients are validated server-side against **active** `wolfhouse_staff_whatsapp_numbers` rows for the same `client_slug`.

---

## 3. Migration to apply (staging only — operator action)

Apply once on staging Postgres (from a host that can reach the DB):

```bash
node scripts/run-migration.js database/migrations/033_staff_automated_notifications.sql
```

Creates:

- `staff_automated_notifications`
- `staff_automated_notification_events` (audit + dedupe)

**Do not run this migration against production until explicitly approved.**

The lib also has idempotent `ensureStaffAutomatedNotificationsTables()` for lazy table creation on first API use, but the migration is the canonical schema source.

---

## 4. Staging deploy prerequisites

1. **Merge feature branch to `master`** on GitHub (PR review complete).
2. **Clean tree on deploy machine:**
   ```bash
   git checkout master
   git pull --ff-only origin master
   node scripts/assert-repo-sync.js
   ```
3. **No dirty deploy** — Staff API image must be built from a clean `master` SHA (`node scripts/assert-deploy-from-master.js` / `npm run deploy:preflight` before `az acr build`).
4. Deploy **Staff API** staging image only (operator laptop). This feature does not require Hermes/Luna image changes for portal UI/API.
5. **Do not** enable live WhatsApp env flags for this feature (none exist yet).

---

## 5. Local verification (before merge / after pull)

Feature-specific gates (all should pass):

```bash
node scripts/verify-staff-automated-notification-ui.js
node scripts/verify-staff-automated-notifications-crud.js
node scripts/verify-staff-automated-notifications-runner.js
node scripts/verify-staff-automated-notifications-live.js
node scripts/verify-staff-automated-notifications-scheduler.js
node scripts/verify-staff-whatsapp-notifications.js
```

Broader repo gates (run before staging deploy; note known unrelated failures may exist on some branches):

```bash
node scripts/verify-staff-tenant-scope.js
node scripts/verify-luna-all.js
```

---

## 6. Staging validation steps

### 6.1 Portal UI (owner/admin)

1. Log in to https://staff-staging.lunafrontdesk.com as owner/admin.
2. Open **Luna Staff** tab.
3. Confirm card order: **Staff & Owner Numbers** → **Automated Staff Notifications** → Owner Insights → Staff WhatsApp Alerts.
4. Under **Staff & Owner Numbers**, add an **approved test number** only (not real staff/guest lines unless explicitly approved).
5. Under **Automated Staff Notifications**:
   - Create automation (title, prompt, ≥1 recipient, ≥1 day, time, enabled).
   - Confirm it appears in **Saved automations**.
   - **Edit** — form loads values; save changes.
   - **Delete** — confirm dialog; row removed.
6. Confirm validation errors show for empty title/prompt/recipients/days/time before save.

### 6.2 Dry-run CLI (manual, on staging Staff API host or operator shell with DB access)

Pick a time when the automation is due, or pass `--now` aligned to the automation schedule:

```bash
node scripts/run-staff-automated-notifications.js \
  --client=wolfhouse-somo \
  --now=2026-07-07T09:30:00+02:00 \
  --window-minutes=0
```

For Sunset multi-location:

```bash
node scripts/run-staff-automated-notifications.js \
  --client=sunset \
  --location=sunset-somo \
  --now=2026-07-07T09:30:00+02:00 \
  --window-minutes=5
```

Expected JSON summary fields: `due_count`, `event_count`, `dry_run_count`, `failed_count`, `skipped_count`, `mode: "dry_run"`.

**Hard reject live mode without gates:**

```bash
node scripts/run-staff-automated-notifications.js --live
# Must exit non-zero: "Live send blocked — required gates not satisfied"
```

### 6.4 Manual live test — approved recipient only

**Operator-only.** Use a single approved test number — never real staff blast or production lines unless explicitly signed off.

Live mode requires **all** of the following at once:

| Gate | Value |
|------|--------|
| CLI | `--live` flag |
| `STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED` | `true` |
| `WHATSAPP_DRY_RUN` | `false` |
| `STAFF_AUTOMATED_NOTIFICATIONS_ALLOWED_PHONES` | Comma-separated E.164 allowlist; each recipient phone must appear in this list |

If any gate fails, the CLI exits non-zero, prints the reason, and **does not** call Ask Luna or send WhatsApp.

Example (staging shell with DB + WhatsApp creds — replace phone with approved test line):

```bash
export STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED=true
export WHATSAPP_DRY_RUN=false
export STAFF_AUTOMATED_NOTIFICATIONS_ALLOWED_PHONES=+34600000000

node scripts/run-staff-automated-notifications.js \
  --live \
  --client=wolfhouse-somo \
  --now=2026-07-07T09:30:00+02:00 \
  --window-minutes=0
```

Expected JSON summary: `mode: "live"`, `sent_count`, `failed_count`, `skipped_count`, `ask_luna_count`.

Message format per recipient:

```
{automation title}

{Ask Luna answer}

Automated Luna Staff notification
```

Re-running the same due slot **dedupes** before Ask Luna/send (increment `skipped_count` for existing `dedupe_key` + `recipient_phone`).

---

## 6.5 Staging scheduler (Azure Container Apps Job — operator-run)

**This slice adds the deploy script only.** Merging code does **not** create or enable the job. The operator must run the deploy script explicitly.

### 6.5.1 Dry-run job first (recommended)

Preview commands (no Azure changes):

```bash
node scripts/deploy-staff-automated-notifications-job.js
```

Apply dry-run scheduled job (Ask Luna + audit events only — **no WhatsApp sends**):

```bash
STAFF_AUTOMATED_NOTIFICATIONS_JOB_DEPLOY_APPLY=1 \
  node scripts/deploy-staff-automated-notifications-job.js --apply
```

Creates/updates job `wh-staging-staff-automated-notifications` in `wh-staging-rg`:

- **Schedule:** `*/5 * * * *` (UTC; every 5 minutes)
- **Image:** current `wh-staging-staff-api` image (override with `--image=...`)
- **Command:** `node scripts/run-staff-automated-notifications.js --client=wolfhouse-somo --window-minutes=5`
- **Env defaults:** `WHATSAPP_DRY_RUN=true`, `STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED=false`

Europe/Madrid due-time logic remains in the runner (`--window-minutes=5` matches the schedule cadence).

### 6.5.2 Inspect job logs + audit events

```bash
az containerapp job execution list \
  -g wh-staging-rg \
  -n wh-staging-staff-automated-notifications \
  -o table

az containerapp job logs show \
  -g wh-staging-rg \
  -n wh-staging-staff-automated-notifications \
  --execution <execution-name> \
  --container wh-staging-staff-automated-notifications \
  --tail 100
```

Then inspect `staff_automated_notification_events` (§6.3). Expect `mode: "dry_run"` summaries in logs until live gates are enabled.

### 6.5.3 Live scheduled mode (approved test numbers only)

Requires the **same gates** as manual `--live`:

| Gate | Value |
|------|--------|
| Deploy flag | `--live` |
| `STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED` | `true` (set on job) |
| `WHATSAPP_DRY_RUN` | `false` (set on job) |
| `STAFF_AUTOMATED_NOTIFICATIONS_ALLOWED_PHONES` | Comma-separated E.164 allowlist |

```bash
STAFF_AUTOMATED_NOTIFICATIONS_JOB_DEPLOY_APPLY=1 \
  node scripts/deploy-staff-automated-notifications-job.js \
  --live \
  --allowed-phones=+34600000000 \
  --apply
```

Keep allowlist to **approved staff/test numbers** only. Recipients not on the allowlist are skipped; runner never sends without allowlist match.

### 6.5.4 Rollback / disable

Stop scheduled runs (switch to Manual trigger):

```bash
STAFF_AUTOMATED_NOTIFICATIONS_JOB_DEPLOY_APPLY=1 \
  node scripts/deploy-staff-automated-notifications-job.js --disable --apply
```

Delete job entirely:

```bash
STAFF_AUTOMATED_NOTIFICATIONS_JOB_DEPLOY_APPLY=1 \
  node scripts/deploy-staff-automated-notifications-job.js --delete --apply
```

Or directly:

```bash
az containerapp job delete -g wh-staging-rg -n wh-staging-staff-automated-notifications --yes
```

**Production:** `--prod` is refused by the deploy script. Do not target prod or Sunset with this slice.

### 6.3 Inspect audit events (Postgres)

```sql
SELECT id, automation_id, client_slug, due_local_date, due_local_time,
       recipient_phone, status, LEFT(answer_preview, 80) AS preview, error, created_at
  FROM staff_automated_notification_events
 WHERE client_slug = 'wolfhouse-somo'
 ORDER BY created_at DESC
 LIMIT 20;
```

Also confirm automation row updated:

```sql
SELECT id, title, last_run_at, last_status, last_error
  FROM staff_automated_notifications
 WHERE client_slug = 'wolfhouse-somo'
 ORDER BY updated_at DESC;
```

Re-running the same due slot should **dedupe** (increment `skipped_count`, no duplicate events for same `dedupe_key` + `recipient_phone`).

---

## 7. Hard gates (do not bypass on staging)

| Gate | Rule |
|------|------|
| Live WhatsApp | **Manual CLI or scheduled job** with all env gates + allowlist. Portal/API never send. |
| Cron / scheduler | **Operator-run only** via `deploy-staff-automated-notifications-job.js --apply`. Not installed by merge alone. |
| Test numbers | Use approved test recipients only — not production staff/guest numbers. |
| Prod migration | Do not apply `033` to production until signed off. |
| Prod / Sunset live | Do not run `--live` against prod or Sunset unless explicitly approved. |

---

## 8. Rollback

### Portal / API broken after deploy

1. Redeploy Staff API staging image to the **previous known-good SHA** (Azure Container Apps revision rollback).
2. Portal UI falls back gracefully if migration not applied (empty list / lazy ensure-table); worst case disable card via revert deploy.

### Migration already applied

- Migration is **additive** (new tables only).
- **Do not `DROP TABLE`** unless explicitly approved.
- Disabling automations in UI (`enabled=false`) stops due matches without schema rollback.

### Feature flag / code rollback

- Revert merge commit on `master` and redeploy Staff API from prior SHA.
- Existing automation rows remain in DB but are inert if code is reverted (no runner cron exists).

---

## 9. Out of scope (future slices)

- Production scheduled job / prod enablement.
- “Send test now” button in portal UI.
- Production cutover sign-off.
- Broad live rollout without per-recipient allowlist.
- Sunset tenant scheduled notifications (unless explicitly approved).
