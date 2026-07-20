# RADAR findings (16A freeze + 16B budget-threshold + 16C readiness source-partial)

**Master basis (16C):** `acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b`
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

3. **G02 readiness — partial (source only)**
   16C adds `/readyz` (bounded read-only Postgres via pool) + ACA probes in Wolfhouse/Sunset staging Bicep. **Not deployed.** Live probes still empty/null. Failure drill open.

## Other high partials

- **G01 logs:** JSONL audit + LAW destination exist; no correlation ID / tenant-structured access log.
- **G04/G05 backlog + replay:** handlers/jobs/idempotency keys exist; backlog metrics and full replay proof missing.
- **G07 runbooks:** docs present; PHASE-7.4 restore drill not executed; PG backup 7d, geo-redundant off.

## Slice 16B

`16B_staging_rg_cost_budget_threshold` on **G09_cost_controls** — progress class `budget_threshold_partial_progress_only`. Does not implement anomaly detection.

## Slice 16C

`16C_staff_api_readiness_dependencies` on **G02_readiness_dependencies** — progress class `source_partial_progress_only`. Deployment + `16C_DRILL_readiness_failure_traffic_shed` remain open.

## Zero-mutation (this slice)

No live deploy/restart/DB-secret/guest/payment/production mutation in 16C. Database and Hermes staging sources must stay unchanged. Staff API readiness + staging Bicep probes are intentional source changes only.
