# RADAR findings (16A freeze + 16B budget-threshold + 16F metric-alert source-partial)

**Master basis (16F):** `acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b`
**Policy:** absence is not safe (`proven` | `partial` | `absent`).

## Verdict rollup

| Verdict | Count |
|---------|------:|
| proven | 0 |
| partial | 9 |
| absent | 0 |
| **total** | **9** |

## Critical gaps

1. **G03 actionable tenant-aware alerts — partial (source only)**
   Standalone staging Staff API metric-alert IaC added (tenant-named Requests 5xx >=3 PT5M/PT1M + RestartCount >0 PT5M/PT1M; refs 16B ops AG by name). **Not deployed** — live metric_alerts still `[]`. Notification delivery and alert-fire drill remain open.

2. **G09 cost controls — partial (budget-threshold source only)**
   Standalone staging budget-threshold IaC added (USD 120/40, 80%/100% Enabled, ops-email AG per RG). **Not deployed** — live budgets still `[]`. Real notification delivery proof remains open. **Anomaly detection remains absent / not claimed.**

## Other high partials

- **G02 readiness:** `/healthz` is static ok; ACA probes empty/null; scale-to-zero on Wolfhouse staff API.
- **G01 logs:** JSONL audit + LAW destination exist; no correlation ID / tenant-structured access log.
- **G04/G05 backlog + replay:** handlers/jobs/idempotency keys exist; backlog metrics and full replay proof missing.
- **G07 runbooks:** docs present; PHASE-7.4 restore drill not executed; PG backup 7d, geo-redundant off.

## Slice 16F

`16F_staff_api_metric_alerts` on **G03_actionable_tenant_aware_alerts** — progress class `source_partial_progress_only`. Does not deploy; does not prove delivery or alert fire.

## Slice 16B

`16B_staging_rg_cost_budget_threshold` on **G09_cost_controls** — progress class `budget_threshold_partial_progress_only`. Does not implement anomaly detection.

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16F. Module is Incremental-only and structurally limited to `Microsoft.Insights/metricAlerts` (AG/app referenced only).
