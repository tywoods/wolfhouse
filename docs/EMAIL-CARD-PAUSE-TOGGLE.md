# Mailbox master pause — EMAIL-CARD-PAUSE-TOGGLE-001

## Scope and operator contract

Staging-only Microsoft, Gmail and IMAP/SMTP mailbox cards for Sunset and Wolfhouse.
Each connected card has a top-right On | Off segmented control; selected Off is red.
This is a **mail-flow pause**, not disconnect, permission editing, Schedule, Autonomy,
Gina, or a new automatic-send feature. No production enablement is authorized here.

`mail_flow_paused` is separate from `active`, inbound/outbound permissions and
`default_automation_mode`. Off leaves credentials, grants, scopes, connection health,
reauthorization and saved configuration alone. On restores processing under the
existing saved permissions; it does not grant new permission or enable automation.

Off prevents **new admissions**. An operation admitted before the pause may finish;
this does not cancel a provider request already running. A broadcast admits each
recipient separately against the selected mailbox: pause stops subsequent recipients
without selecting a fallback mailbox or replaying recipients already sent.

New draft-open/regeneration claims recheck the endpoint under the existing row lock.
Stored drafts remain visible, and already-admitted draft completion/CAS remains allowed.
The separately callable current-message content authority also checks pause.
Send recovery retains tenant/identity authorization while allowing only the existing
journal-proven committed inspection or send-dispatched reconciliation. It does not
admit a fresh send while paused.

## Persistence and installation prerequisites

- Migration: `database/migrations/105_email_mailbox_pause.sql`.
- Default `mail_flow_paused = false` preserves existing behavior.
- Separate `mail_flow_pause_updated_at` / `mail_flow_pause_updated_by` audit fields.
- The endpoint update trigger preserves `updated_at` for pause-only updates, so pause
  does not change broadcast sender preference. Ordinary configuration updates retain
  the existing timestamp behavior.
- Apply the migration **before** pause-aware runtime installation. The registry DTO
  requires the new column. This document is not approval to apply it or deploy.
- Keep `STAFF_PORTAL_ORIGIN` set to the exact existing portal origin. The authenticated
  pause mutation enforces matching Origin (or Referer fallback) and JSON content type.
- Existing tenant-specific staging/settings gates and admin/owner authorization apply.

`POST /staff/admin/email-settings/pause` accepts only:

```json
{"client":"sunset","location_id":"sunset-somo","endpoint_id":"<endpoint UUID>","paused":true}
```

The update is scoped by client, location, endpoint, email channel and supported provider.
Cookie authentication alone is not sufficient: route/client authorization, role, body,
origin, content type and staging gates must all pass. No credential material is returned.

## Offline verification

These tests use fabricated fixtures, embedded PostgreSQL or loopback HTTP. They do not
verify a live mailbox, OAuth session, provider send, deployment or staging recovery.
Use the repository's Node dependencies; the PostgreSQL tests require
`@electric-sql/pglite`, and browser rendering requires Playwright plus Chromium.

```bash
node scripts/verify-email-card-pause-toggle.js
node scripts/verify-email-mailbox-pause-http.js
node scripts/verify-email-mailbox-pause-pglite.js
node scripts/verify-email-pause-admission-fences.js
node scripts/verify-email-pause-drafting.js
node scripts/verify-email-pause-broadcast.js
node scripts/verify-email-card-pause-ui.js
node scripts/verify-email-pause-browser.js
node scripts/verify-staff-email-inbox-routes.js
node scripts/verify-staff-email-outbound-recovery-route.js
node scripts/verify-email-delegated-grant-read-health.js
node scripts/verify-migration-integrity.js
node scripts/verify-hermes-send-flags.js
```

`verify-email-pause-admission-fences.js` is only a structural backstop, not behavioral
proof. Embedded PostgreSQL tests exercise the actual delta worker and draft owners,
pause/resume, isolation, preserved configuration, and stored-draft visibility.
Draft boundary-order tests exercise pause before admission and after admission;
they are not a real two-connection contention proof. Broadcast tests inject transport
callbacks to prove recipient boundaries without external sends. Browser screenshots
are offline rendering evidence, not screenshots of a deployed portal.

Baseline-aware verification must report pre-existing failures rather than replacing
expectations to manufacture an all-green result. Latest execution logs and baseline
comparisons belong in the handoff proof bundle, not as permanent assertions here.

## Handoff boundaries

Export the complete diff, base commit, SHA-256 and actual test logs. Verify patch
application against the pinned baseline. Before integrating, check current GitHub
master for overlapping changes and migration-number conflicts. A local apply check
is not current-master verification. No push, deploy, credential action, routing change,
or real guest send is included in this task's approval.
