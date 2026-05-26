# Migration Risks

Risks for moving Wolfhouse from Airtable → PostgreSQL while keeping n8n + Google Sheets.

## Critical risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Airtable automations not documented in repo** | Bed assign / cancel / confirm stop working on cutover | Export automation list from Airtable; screenshot triggers; recreate as n8n+Postgres triggers before disabling AT automations |
| **Dual bed-assignment logic** (Main inline vs Bed Assignment workflow) | Different results WhatsApp vs staff path | Single shared assignment module (Postgres function or one n8n sub-workflow); deprecate duplicate |
| **No Stripe — payment truth is manual** | False confirmations, revenue loss | Implement Stripe webhook-only `paid` transition before marketing auto-pay to guests |
| **Webhook URLs hardcoded** (`tywoods.app.n8n.cloud`) | Break on Azure move | Parameterize base URL in n8n env; update Apps Script + Airtable in one change window |
| **Shared webhook UUID** (Manual Entries + Send Confirmation) | Import/deploy collision | Regenerate unique webhook IDs on Azure import |

## Data risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Booking Beds status from parent** | Orphan or stale bed rows if parent update fails | Transactional updates in Postgres; nightly reconciliation job |
| **Overlap / availability queries** | Double bookings | Index `(hostel_id, bed_id, assignment_start_date, assignment_end_date)`; SQL overlap constraint or exclusion |
| **Airtable record ID mapping** | Broken links during dual-write | `airtable_record_id` on all tables; validation report pre-cutover |
| **CSV seed is point-in-time** | Missing production rows | Re-export Airtable before final seed; compare counts |
| **Guest data on multiple tables** | Inconsistent phone/email | Introduce `guests` table; backfill from Conversations + Bookings |

## Operational risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Ale/Cami non-technical** | Cannot fix failed syncs | Staff alerts from `automation_errors`; simple “retry sync” menu in Sheets |
| **30-min planning sync delay** | Sheet stale up to 30 min | Keep schedule; add manual “Refresh planning” webhook optional |
| **Manual Entries single-row processor** | Queue backlog | Postgres `manual_entries` status + parallel workers later |
| **LLM non-determinism** | Wrong dates/packages | Keep parser JSON schema; log raw LLM output to `workflow_events` |
| **Hold expiry schedule only in Main** | Zombie holds block beds | Postgres cron or n8n schedule against `hold_expires_at` |

## Security risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **`docs/api keys.txt` in workspace** | Credential leak | Delete from repo; rotate keys; use Azure Key Vault / n8n credentials |
| **Public n8n webhooks** | Spoofed cancellations | Add shared-secret header validation |
| **PII in logs** | GDPR issues | Redact phone/email in `automation_errors` |

## Technical / platform risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **n8n queue mode misconfiguration** | Lost executions | Test Redis + worker scaling on staging |
| **Two Postgres databases** (n8n internal vs app) | Confusion | Separate servers or schemas; clear naming `wolfhouse_app` |
| **Google Sheets API quotas** | Paint failures | Exponential backoff; store errors in `automation_errors` |

## Business continuity

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Big-bang cutover** | Cannot take bookings | Phased dual-write (see `docs/phased-cutover-plan.md`) |
| **Rollback** | Data divergence | Keep Airtable read-only snapshot; reversible flag per workflow |
