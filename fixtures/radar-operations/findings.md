# RADAR findings (16A freeze + 16B budget-threshold + 16H metric-alert + 16I readiness + 16J correlation + 16K healthz + 16L capacity-pressure + 16M Stripe event-id claim + 16N request completion log source-partial)

**Master basis (16N):** `3e94498321cd26e64394984a5926d7a583226692`
**Policy:** absence is not safe (`proven` | `partial` | `absent`).

## Verdict rollup

| Verdict | Count |
|---------|------:|
| proven | 0 |
| partial | 9 |
| absent | 0 |
| **total** | **9** |

## Critical gaps

1. **G05 retry / replay safety — partial (source only via 16M)**
   Fail-closed Stripe webhook `payment_events` event-id claim before booking-payment and addon_service mutations (same txn; ON CONFLICT DO NOTHING RETURNING id; minimized payload). **Not deployed.** Live concurrency, replay operator, DLQ, and controlled drill remain open. Ignored/unmatched event types intentionally unclaimed.

2. **G06 scaling / capacity — partial (source only via 16L)**
   Wolfhouse + Sunset staging Bicep declare Staff API capacity-pressure alerts (CpuPercentage Average >80 + MemoryPercentage Average >80; PT15M/PT5M; severity 2; enabled; static Microsoft.App/containerApps criteria; wired to subscription-pinned future 16B ops AG resource ID param). **Not deployed** — live metric_alerts still `[]`. No autoscaling added; replicas unchanged. Deploy, alert fire, sustained load, response-time/SLO, and backpressure remain open.

3. **G03 actionable tenant-aware alerts — partial (source only)**
   Standalone staging Staff API metric-alert IaC added (tenant-named Requests 5xx >=3 PT5M/PT1M + RestartCount >0 PT5M/PT1M; refs 16B ops AG by name). Source module only — **no deployment wrapper**. **Not deployed** — live metric_alerts still `[]`. Safe Incremental operator deploy, notification delivery, and alert-fire drill remain open. Template cannot enforce ARM mode.

4. **G09 cost controls — partial (budget-threshold source only)**
   Standalone staging budget-threshold IaC added (USD 120/40, 80%/100% Enabled, ops-email AG per RG). **Not deployed** — live budgets still `[]`. Real notification delivery proof remains open. **Anomaly detection remains absent / not claimed.**

5. **G02 readiness / dependencies — partial (source only via 16I)**
   Staff API `/readyz` + ACA probes added in source (dedicated max-1 readiness pool; `/healthz` stays DB-independent). **Not deployed** — live ACA probes still empty/null. Controlled readiness failure drill and lifecycle integration remain open. Supersedes deferred 16C (no signal/shutdown framework in 16I).

6. **G01 correlation / structured logs — partial (source only via 16J + 16N)**
   Staff API request correlation middleware (UUIDv4 accept/generate, ALS, response header) plus safe synchronous normal-completion structured logs (`staff_api_request_completed` via await+finally at `createStaffQueryApiHttpServer`; allowlisted fields only; no lifecycle listeners). **Not deployed** — Azure stdout/LAW delivery + searchable query, retention, abrupt-path coverage, and correlation drill remain open. Supersedes deferred 16D (no async log queue; no signal/shutdown ownership).

7. **G08 retention / privacy — partial (source only via 16K)**
   Public Staff API `/healthz` minimized in source to `{status:ok,service:staff-api}` (no auth/stage/provider/model/key/config/tenant/note). **Not deployed** — live `/healthz` still exposes detailed fields. LAW/App Insights retention remain proven live. Log-retention/PII redaction proof and privacy drill remain open.

## Other partial notes

- **G04 backlog:** handlers/jobs exist; backlog metrics missing.
- **G07 runbooks:** docs present; PHASE-7.4 restore drill not executed; PG backup 7d, geo-redundant off.

## Slice 16N

`16N_staff_api_request_completion_log` on **G01_correlation_structured_logs** — progress class `source_partial_progress_only`. Builds on 16J ALS. At `createStaffQueryApiHttpServer`, await ALS-wrapped handler and emit exactly one allowlisted JSON record in a finally block for normal settlement only (console/process stdout). Fields: `event`, `request_id`, `tenant_slug`, `method`, `route`, `status_code`, `duration_ms`. No req/res lifecycle listeners; no signal/shutdown/queue/flush; abrupt paths out of scope. Does not deploy; delivery/search/retention/abrupt-path/drill remain open.

## Slice 16M

`16M_stripe_webhook_event_id_claim` on **G05_retry_replay_safety** — progress class `source_partial_progress_only`. Addon path has no pre-transaction already-paid shortcut; every matched addon event claims under transaction, locks owned payment FOR UPDATE after claim; distinct-event already-paid → processed ledger + `duplicate_business_outcome` with `no_business_mutation`/`no_payment_or_service_rewrite` (not `no_db_write`). Exact-ID retry → `stripe_event_id_already_claimed`. COMMIT failure returns `outcome_unknown=true` (never claimed definitely rolled back). Does not deploy; does not add replay operator/DLQ; does not claim ignored event types; deploy/live concurrency/real-PG ambiguous-commit drill/replay/DLQ/drill remain open.

## Slice 16L

`16L_staff_api_capacity_pressure_alerts` on **G06_scaling_capacity** — progress class `source_partial_progress_only`. Does not deploy; does not add autoscaling; does not mutate replicas; does not alter 16H; does not claim load/SLO/backpressure; deploy/fire/load/SLO/backpressure remain open.

## Slice 16K

`16K_staff_api_healthz_minimization` on **G08_retention_privacy** — progress class `source_partial_progress_only`. Does not deploy; does not change `/readyz` or authenticated diagnostics; live deploy / log-retention proof / privacy drill remain open.

## Slice 16J

`16J_staff_api_request_correlation` on **G01_correlation_structured_logs** — progress class `source_partial_progress_only`. Supersedes deferred 16D. Header + ALS only. Does not deploy; does not add lifecycle listeners, async log queue, or signal/shutdown ownership; delivery/search/retention/drill remain open (completion emission owned by 16N).

## Slice 16I

`16I_staff_api_readiness_dependencies` on **G02_readiness_dependencies** — progress class `source_partial_progress_only`. Supersedes deferred 16C. Does not deploy; does not add signal/shutdown framework; lifecycle integration of `closeReadinessPool` remains open.

## Slice 16H

`16H_staff_api_metric_alerts` on **G03_actionable_tenant_aware_alerts** — progress class `source_partial_progress_only`. Supersedes deferred 16F/16G. Does not deploy; does not ship a deployment wrapper; does not prove delivery or alert fire.

## Slice 16B

`16B_staging_rg_cost_budget_threshold` on **G09_cost_controls** — progress class `budget_threshold_partial_progress_only`. Does not implement anomaly detection.

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16N. Database schema, Hermes staging, staging Bicep, and 16H metric-alert module unchanged vs master. Staff API completion-log helper + createServer wiring are intentional 16N ownership.
