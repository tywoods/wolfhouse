# RADAR findings (16A freeze + 16B budget-threshold + 16E Staff API rollback source-partial)

**Master basis (16E):** `acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b`
**Policy:** absence is not safe (`proven` | `partial` | `absent`).

## Verdict rollup

| Verdict | Count |
|---------|------:|
| proven | 0 |
| partial | 8 |
| absent | 1 |
| **total** | **9** |

## Critical gaps

1. **G03 actionable tenant-aware alerts — absent**
   Live: metric/activity/scheduled alerts = `[]` on both `wh-staging-rg` and `luna-sunset-staging-rg`. Smart Detection action group has ARM roles only (no email/webhook). No tenant dimensions.

2. **G09 cost controls — partial (budget-threshold source only)**
   Standalone staging budget-threshold IaC added (USD 120/40, 80%/100% Enabled, ops-email AG per RG). **Not deployed** — live budgets still `[]`. Real notification delivery proof remains open. **Anomaly detection remains absent / not claimed.**

## Other high partials

- **G02 readiness:** `/healthz` is static ok; ACA probes empty/null; scale-to-zero on Wolfhouse staff API.
- **G01 logs:** JSONL audit + LAW destination exist; no correlation ID / tenant-structured access log.
- **G04/G05 backlog + replay:** handlers/jobs/idempotency keys exist; backlog metrics and full replay proof missing.
- **G07 runbooks:** 16E adds fail-closed staging Staff API ACA traffic-weight rollback runbook/preflight (source-partial). Live rollback/restore drill and PHASE-7.4 PG restore drill remain open. PG backup 7d, geo-redundant off.

## Slice 16E

`16E_staff_api_aca_traffic_rollback_runbook` on **G07_rollback_incident_runbooks** — progress class `source_partial_progress_only`. Does not execute live rollback. Open drill: `16E_DRILL_live_rollback_restore`.

## Slice 16B (still partial)

`16B_staging_rg_cost_budget_threshold` on **G09_cost_controls** — progress class `budget_threshold_partial_progress_only`. Does not implement anomaly detection.

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16E. Preflight plans traffic-weight change only and hard-disables live execute.
