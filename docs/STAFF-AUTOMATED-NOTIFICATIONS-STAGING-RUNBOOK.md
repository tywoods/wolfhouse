# Automated Staff Notifications — Staging Runbook

**Feature branch:** `cursor/automated-staff-notifications-slice-1`  
**Staff Portal (staging):** https://staff-staging.lunafrontdesk.com  
**Current state:** UI + CRUD API + dry-run CLI only — **live WhatsApp sends are not enabled**

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
- **Does not send WhatsApp messages.**

---

## 2. Files in this feature

| Area | Path |
|------|------|
| Migration | `database/migrations/033_staff_automated_notifications.sql` |
| CRUD + runner lib | `scripts/lib/staff-automated-notifications.js` |
| Dry-run CLI | `scripts/run-staff-automated-notifications.js` |
| Staff Portal UI + API routes | `scripts/staff-query-api.js` |
| Verifiers | `scripts/verify-staff-automated-notification-ui.js` |
| | `scripts/verify-staff-automated-notifications-crud.js` |
| | `scripts/verify-staff-automated-notifications-runner.js` |
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

**Hard reject live mode:**

```bash
node scripts/run-staff-automated-notifications.js --live
# Must exit non-zero: "Live sends not implemented in this slice."
```

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
| Live WhatsApp | **Do not enable.** No `sendLunaWhatsAppMessage` in this feature; CLI rejects `--live`. |
| Cron / scheduler | **Do not install.** Runner is manual CLI only. |
| Test numbers | Use approved test recipients only — not production staff/guest numbers. |
| Prod migration | Do not apply `033` to production until signed off. |
| Prod env | Do not add live-send env flags for automated notifications. |

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

- Live WhatsApp delivery to recipients after Ask Luna answer.
- Cron / scheduled runner installation.
- “Send test now” button in portal UI.
- Production cutover sign-off.
