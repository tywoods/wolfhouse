# RADAR 16A findings (audit only)

**Master basis:** `28a30a688baa637e1bcb549d9b585cb5917942d1`  
**Policy:** absence is not safe (`proven` | `partial` | `absent`).

## Verdict rollup

| Verdict | Count |
|---------|------:|
| proven | 0 |
| partial | 7 |
| absent | 2 |
| **total** | **9** |

## Critical gaps

1. **G03 actionable tenant-aware alerts — absent**  
   Live: metric/activity/scheduled alerts = `[]` on both `wh-staging-rg` and `luna-sunset-staging-rg`. Smart Detection action group has ARM roles only (no email/webhook). No tenant dimensions.

2. **G09 cost anomaly detection — absent**  
   Live MTD ActualCost captured, but Consumption budgets = `[]` on both RGs. No anomaly notify path.

## Other high partials

- **G02 readiness:** `/healthz` is static ok; ACA probes empty/null; scale-to-zero on Wolfhouse staff API.
- **G01 logs:** JSONL audit + LAW destination exist; no correlation ID / tenant-structured access log.
- **G04/G05 backlog + replay:** handlers/jobs/idempotency keys exist; backlog metrics and full replay proof missing.
- **G07 runbooks:** docs present; PHASE-7.4 restore drill not executed; PG backup 7d, geo-redundant off.

## Selected 16B (selection only)

`16B_staging_rg_cost_budget_anomaly` on **G09** — smallest absent surface (budgets + action group), no runtime code change.

## Zero-mutation

No deploy/restart/DB/secret/guest/payment/production mutation in 16A. Azure scope limited to the two staging RGs; CostManagement query used for MTD totals only.
