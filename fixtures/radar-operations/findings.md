# RADAR 16A2 findings (audit only)

**Master basis:** `5a8b08d395e11c51baf928b918016d5dd5bb4afe`
**Branch:** `radar/slice-16a2-ledger-provenance`
**Policy:** absence is not safe (`proven` | `partial` | `absent`).

## Verdict rollup

| Verdict | Count |
|---------|------:|
| proven | 0 |
| partial | 7 |
| absent | 2 |
| **total** | **9** |

## Semantic corrections (vs merged 16A)

1. **G09 renamed to cost controls** — budgets are threshold controls, not anomaly detection.
2. **Separate acceptances frozen** — budget-notification vs anomaly-detection.
3. **16B = budget-threshold partial progress only** — does not implement anomaly detection.
4. **Notification proof** — real delivery required; Enabled configuration alone fails.
5. **Diagnostics** — absence qualified to sampled allowlist only.
6. **App Insights retention** — workspace-based effective analytics retention follows LAW (30d), not component 90d alone.
7. **Provenance** — exact allowlisted capture tool + manifest + response hashes make the ledger independently reproducible.

## Critical gaps

1. **G03 actionable tenant-aware alerts — absent**
   Live: metric/activity/scheduled alerts = `[]` on both `wh-staging-rg` and `luna-sunset-staging-rg`. Smart Detection action group has ARM roles only (no email/webhook). No tenant dimensions.

2. **G09 cost controls — absent**
   Live MTD ActualCost captured. Budget threshold control absent (`budgets=[]` both RGs). Anomaly detection absent (separate control). No notification delivery path.

## Other high partials

- **G02 readiness:** `/healthz` is static ok (config flags ≠ dependency readiness); ACA probes empty/null; scale-to-zero on Wolfhouse staff API.
- **G01 logs:** JSONL audit + LAW destination exist; no correlation ID / tenant-structured access log; sampled diagnostics empty.
- **G04/G05 backlog + replay:** handlers/jobs/idempotency keys exist; backlog metrics and full replay proof missing.
- **G07 runbooks:** docs present; PHASE-7.4 restore drill not executed; PG backup 7d, geo-redundant off.
- **G08 retention:** LAW 30d; workspace-based App Insights effective analytics retention 30d.

## Selected 16B (selection only)

`16B_staging_rg_cost_budget_threshold` on **G09_cost_controls** — budget-threshold partial progress only (budgets + action group + real notification delivery proof). Anomaly detection remains separately absent.

## Zero-mutation

No deploy/restart/DB/secret/guest/payment/production mutation in 16A2. Azure scope limited to the two staging RGs; CostManagement query used for MTD totals only. Capture tool RED-refuses production/secret/DB/mutation surfaces before dispatch.
