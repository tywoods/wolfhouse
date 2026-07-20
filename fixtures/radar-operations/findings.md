# RADAR findings (16A freeze + 16B budget-threshold + 16H metric-alert source-partial)

**Master basis (16H):** `acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b`
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
   Standalone staging Staff API metric-alert IaC added (tenant-named Requests 5xx >=3 PT5M/PT1M + RestartCount >0 PT5M/PT1M; refs 16B ops AG by name). Source module only — **no deployment wrapper**. **Not deployed** — live metric_alerts still `[]`. Safe Incremental operator deploy, notification delivery, and alert-fire drill remain open. Template cannot enforce ARM mode.

2. **G09 cost controls — partial (budget-threshold source only)**
   Standalone staging budget-threshold IaC added (USD 120/40, 80%/100% Enabled, ops-email AG per RG). **Not deployed** — live budgets still `[]`. Real notification delivery proof remains open. **Anomaly detection remains absent / not claimed.**

## Other partial notes

- **G01/G02 correlation + readiness:** source or partial controls exist; full live proof gaps remain.
- **G04/G05 backlog + replay:** handlers/jobs/idempotency keys exist; backlog metrics and full replay proof missing.
- **G07 runbooks:** docs present; PHASE-7.4 restore drill not executed; PG backup 7d, geo-redundant off.

## Slice 16H

`16H_staff_api_metric_alerts` on **G03_actionable_tenant_aware_alerts** — progress class `source_partial_progress_only`. Supersedes deferred 16F/16G. Does not deploy; does not ship a deployment wrapper; does not prove delivery or alert fire.

## Slice 16B

`16B_staging_rg_cost_budget_threshold` on **G09_cost_controls** — progress class `budget_threshold_partial_progress_only`. Does not implement anomaly detection.

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16H. Module is structurally limited to `Microsoft.Insights/metricAlerts` (AG/app referenced only). Operator Incremental deploy remains open and is not claimed as enforced by the template.
