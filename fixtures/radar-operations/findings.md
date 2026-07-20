# RADAR findings (16A freeze + 16B budget-threshold partial progress)

**Master basis (16B):** `5a8b08d395e11c51baf928b918016d5dd5bb4afe`
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
- **G07 runbooks:** docs present; PHASE-7.4 restore drill not executed; PG backup 7d, geo-redundant off.

## Slice 16B

`16B_staging_rg_cost_budget_threshold` on **G09_cost_controls** — progress class `budget_threshold_partial_progress_only`. Does not implement anomaly detection.

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16B. Module is Incremental-only and structurally limited to action groups + consumption budgets.
