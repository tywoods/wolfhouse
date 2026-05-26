# Phased Cutover Plan (Airtable → PostgreSQL)

Aligned with `docs/recommended-migration-order.md` — operator-facing summary.

## Phase timeline

| Phase | Duration (estimate) | Guest impact | Airtable |
|-------|---------------------|--------------|----------|
| 0 Foundation | 1 week | None | Source of truth |
| 1 Read replica | 1–2 weeks | None | Source of truth |
| 2 Stripe | 1–2 weeks | Test guests only | Dual-write payment fields |
| 3 Dual-write workflows | 3–6 weeks | Low if tested | Still truth |
| 4 Flip | 1 day + 2 week soak | Medium — monitored | Read-only archive |
| 5 Hardening | Ongoing | Low | Off |

## Dual-write pattern (each workflow)

```
Trigger → Read Postgres (or Airtable during transition)
       → Business logic (prefer single shared Code/SQL)
       → WRITE Postgres (transaction)
       → WRITE Airtable (async branch, failures → automation_errors)
       → Downstream webhook
```

Feature flag in n8n: `DATA_SOURCE=airtable|postgres|dual`.

## Workflow cutover order

1. Sync Planning Sheet (read Postgres assignments)
2. Cancel Bed Assignments
3. Bed Assignment
4. Reassign Bed Assignments
5. Manual Entries Queue Processor
6. Operator Room Release
7. Stripe Create Session + Webhook
8. Send Confirmation
9. Staff Reply / Return To Bot
10. Main Booking Assistant

## Airtable automation migration matrix

| Airtable automation (verify in UI) | Replacement |
|-----------------------------------|-------------|
| Booking cancelled → cancel beds | Postgres trigger OR booking status change → n8n `cancel-booking-beds` |
| Assignment needed | `assign-beds-to-booking` on `assignment_status = unassigned` |
| Send confirmation checkbox | Stripe webhook OR `send_confirmation` flag in Postgres |
| Operator release created | `operator-room-release` webhook |
| *(document yours)* | |

## Google Sheets — unchanged until Phase 5

- Manual Entries columns stay
- `Airtable Booking ID` column becomes `Postgres Booking ID` (UUID) with optional `airtable_record_id` hidden column for rollback

## Rollback procedure

1. Set `DATA_SOURCE=airtable` on all workflows
2. Re-enable Airtable automations
3. Pause Postgres writes
4. Post-mortem in `automation_errors`

## Success metrics for Ale/Cami

| Metric | Target |
|--------|--------|
| WhatsApp bookings without engineer help | 80–90% |
| Manual sheet bookings | 10–20% |
| Mean time to fix sync error (with runbook) | < 15 min staff, < 1 hr engineer |
| Double-booking incidents | 0 |

## Communication plan

- Before Phase 4: 30-min Loom for owners (Manual Entries + “if bot silent”)
- Phase 4 window: low-season weekday morning
- You on standby via phone

## Post-cutover cleanup

- Remove Airtable nodes from workflows (keep export JSON archive)
- Drop unused Airtable fields
- Consolidate bed assignment logic
- Delete `docs/api keys.txt` from all machines
