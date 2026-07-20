# RADAR Slice 16P — Operations gate ledger (live-drill evidence reconciliation)

**Status:** partial/live-proven evidence only (this slice does **not** deploy; records prior operator-observed 16O live drill)
**Master basis:** `594247f12a823e9b90140c56eb8645b057e1fd37`
**Branch:** `radar/slice-16p-live-drill-evidence`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”

## Outcome

Reconcile **bounded operator-observed facts** from the completed 16O live drill into a secret-free evidence fixture and upgrade gate `progress_class` to `partial_live_proven` only where those facts support. **Do not deploy in this slice.** Verdict `proven` remains **0**. Explicitly do **not** claim human inbox receipt, organic metric alert firing, production, abrupt paths, retention/search, dependency failure, real-PG contention, or completion logging.

## Operator-observed facts (locked)

| Fact | Value |
|------|-------|
| Image SHA | `594247f` (`594247f12a823e9b90140c56eb8645b057e1fd37`) |
| Wolfhouse deploy revision | `0000514` |
| Sunset deploy revision | `0000274` |
| Observed on deploy | health/ready; malformed / missing / oversize generic webhook responses |
| Wolfhouse rollback → rollforward | `0000515` → `0000516` |
| Sunset rollback → rollforward | `0000275` → `0000276` |
| After rollforward | health/readiness passed; final image `594247f` |
| AG test API Wolfhouse | Email Status=`Succeeded`, state=`Complete`; sent `2026-07-20T21:35:00.5549824Z`; completed `2026-07-20T21:38:26.1342044Z` |
| AG test API Sunset | Email Status=`Succeeded`, state=`Complete`; sent `2026-07-20T21:39:53.8402179Z`; completed `2026-07-20T21:43:16.2619454Z` |

## Artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16p-live-drill-evidence.json` | Bounded locked evidence + `lock_hash` |
| `fixtures/radar-operations/slice16p-expected-contract.json` | Independent contract |
| `scripts/verify-radar-slice16p-live-drill-evidence.js` | Offline RED/GREEN; rejects altered/overstated evidence |
| `npm run verify:radar-slice16p-live-drill-evidence` | Gate |

## Verdict counts

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven` | 0 | Control fully evidenced end-to-end (incl. full drills) — **none** |
| `partial` | 9 | Some code and/or live evidence; gaps remain |
| `absent` | 0 | No safe control evidenced |
| **total** | **9** | Matrix gates |

## Matrix (summary)

| ID | Gate | Verdict / progress |
|----|------|-------------------|
| G01 | Correlation / structured logs | `partial` / source_partial (completion logging open) |
| G02 | Readiness / dependencies | `partial` / **partial_live_proven** (healthy path) |
| G03 | Actionable tenant-aware alerts | `partial` / **partial_live_proven** (AG test API only) |
| G04 | Webhook / payment / worker backlog | `partial` |
| G05 | Retry / replay safety | `partial` / source_partial (16M event-id claim / stripe_event_id; real-PG open) |
| G06 | Scaling / capacity | `partial` / source_partial (16L capacity-pressure CpuPercentage/MemoryPercentage; organic fire open) |
| G07 | Rollback / incident runbooks | `partial` / **partial_live_proven** (revision rollback/rollforward) |
| G08 | Retention / privacy | `partial` / **partial_live_proven** (deploy + malformed/missing/oversize) |
| G09 | Cost controls | `partial` / **partial_live_proven** (AG test API only; anomaly absent) |

## Explicitly not claimed

- human inbox receipt
- organic metric alert firing
- production
- abrupt paths
- retention/search
- dependency failure
- real-PG contention
- completion logging

## Slice 16P progress

**ID:** `16P_live_drill_evidence_reconciliation`
**Primary gate:** `G08_retention_privacy` (also updates G02/G03/G07/G09)
**Progress class:** `partial_live_proven_evidence_only`
**Does not implement:** human inbox, organic alert fire, production, abrupt paths, retention/search, dependency failure, real-PG contention, completion logging, any `proven` gate verdict

### Still open

- Human inbox receipt of AG test emails
- Organic metric alert firing
- Abrupt webhook paths; SDK/secret live inject
- Log retention / PII redaction / retention search
- Controlled dependency-failure readiness drill
- Real PostgreSQL contention drill
- Request completion logging
- Postgres restore drill
- Budget resource live-list; anomaly detection

## Prior partial progress retained

- **16O** `16O_stripe_webhook_error_minimization` — live deploy + partial privacy probe via 16P
- **16M** `16M_stripe_webhook_event_id_claim` on G05 — source-partial (real-PG open)
- **16L** `16L_staff_api_capacity_pressure_alerts` on G06 — source-partial (organic fire open)
- **16K** `16K_staff_api_healthz_minimization` on G08 — health observed via 16P
- **16J** `16J_staff_api_request_correlation` on G01 — source-partial (completion logging open)
- **16I** `16I_staff_api_readiness_dependencies` on G02 — healthy path via 16P
- **16H** `16H_staff_api_metric_alerts` on G03 — AG test API via 16P
- **16B** `16B_staging_rg_cost_budget_threshold` on G09 — AG test API via 16P; anomaly absent

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16P. Database, Hermes staging, Staff API runtime, staging Bicep, 16H metric-alert module, and 16B budget module must remain unchanged vs master basis `594247f`.
