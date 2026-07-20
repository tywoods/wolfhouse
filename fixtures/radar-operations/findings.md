# RADAR findings (16A freeze + 16B budget-threshold + 16H metric-alert + 16I readiness + 16J correlation source-partial)

**Master basis (16J):** `d9d297e8d28b499316fdcb89ff7954ebb4cdae06`
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

3. **G02 readiness / dependencies — partial (source only via 16I)**
   Staff API `/readyz` + ACA probes added in source (dedicated max-1 readiness pool; `/healthz` stays DB-independent). **Not deployed** — live ACA probes still empty/null. Controlled readiness failure drill and lifecycle integration remain open. Supersedes deferred 16C (no signal/shutdown framework in 16I).

4. **G01 correlation / structured logs — partial (source only via 16J)**
   Staff API request correlation middleware added (UUIDv4 accept/generate, ALS, response header; header + context only). **No completion logging / lifecycle listeners.** **Not deployed** — request completion logs, LAW/App Insights delivery + search, retention, and correlation drill remain open. Supersedes deferred 16D (no async log queue; no signal/shutdown ownership).

## Other partial notes

- **G04/G05 backlog + replay:** handlers/jobs/idempotency keys exist; backlog metrics and full replay proof missing.
- **G07 runbooks:** docs present; PHASE-7.4 restore drill not executed; PG backup 7d, geo-redundant off.
- **G08 retention / privacy:** LAW/App Insights retention proven live; correlation completion retention still open.

## Slice 16J

`16J_staff_api_request_correlation` on **G01_correlation_structured_logs** — progress class `source_partial_progress_only`. Supersedes deferred 16D. Header + ALS only. Does not deploy; does not add completion logging, lifecycle listeners, async log queue, or signal/shutdown ownership; request completion logs/delivery/search/retention/drill remain open.

## Slice 16I

`16I_staff_api_readiness_dependencies` on **G02_readiness_dependencies** — progress class `source_partial_progress_only`. Supersedes deferred 16C. Does not deploy; does not add signal/shutdown framework; lifecycle integration of `closeReadinessPool` remains open.

## Slice 16H

`16H_staff_api_metric_alerts` on **G03_actionable_tenant_aware_alerts** — progress class `source_partial_progress_only`. Supersedes deferred 16F/16G. Does not deploy; does not ship a deployment wrapper; does not prove delivery or alert fire.

## Slice 16B

`16B_staging_rg_cost_budget_threshold` on **G09_cost_controls** — progress class `budget_threshold_partial_progress_only`. Does not implement anomaly detection.

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16J. Database, Hermes staging, and staging Bicep unchanged vs master. Staff API correlation middleware is intentional 16J ownership.
