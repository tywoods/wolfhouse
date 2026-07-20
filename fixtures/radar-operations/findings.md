# RADAR findings (16A freeze + 16B budget-threshold + 16D correlation source-partial)

**Master basis (16D):** `acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b`
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
- **G01 logs:** 16D adds Staff API HTTP correlation + structured completion event (source-partial). Deploy + LAW/App Insights query proof + e2e Meta→Hermes→Staff→Stripe remain open.
- **G04/G05 backlog + replay:** handlers/jobs/idempotency keys exist; backlog metrics and full replay proof missing.
- **G07 runbooks:** docs present; PHASE-7.4 restore drill not executed; PG backup 7d, geo-redundant off.

## Slice 16D

`16D_staff_api_request_correlation` on **G01_correlation_structured_logs** — progress class `source_partial_progress_only`. Strict singleton `X-Request-Id` (reject ambiguous / duplicate wire lines), immutable echo (incl. `addTrailers`/`writeEarlyHints`), ALS, finite route-template classifier, exactly-one completion via FIFO one-at-a-time async delivery with overflow accounting + shutdown flush, optional construction/entry-validated process scope only. Does not claim live log-query proof. Legacy npm alias `verify:staff-api` remains **absent**.

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16D. Staging main Bicep and Hermes untouched.
