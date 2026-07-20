# RADAR Slice 16L — Operations gate ledger (Staff API capacity-pressure alerts source-partial)

**Status:** source partial progress only (zero live deploy / mutation; load / SLO / backpressure / alert-fire open)
**Master basis:** `c01e08d3b0039840ced37ae5a8e04fdd2384aba2`
**Branch:** `radar/slice-16l-capacity-pressure-alerts`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”

## Outcome

Add **source-only Staff API capacity-pressure metric alerts** for both Wolfhouse and Sunset staging Container Apps: `CpuPercentage` Average >80 and `MemoryPercentage` Average >80, severity 2, enabled, 5-minute evaluation, 15-minute window. Wire each alert to the existing future **16B operations action group resource ID parameter** with subscription-pinned/owned AG IDs. Use exact `Microsoft.App/containerApps` metric namespace and static criteria only. **Do not** add autoscaling, mutate min/max replicas, alter 16H 5xx/restart alerts, or claim backpressure/load/SLO proof. **Do not deploy.** G06 remains `partial` (capacity-alert source-partial only).

## Artifacts

| Path | Role |
|------|------|
| `infra/azure/staging/main.bicep` | Wolfhouse capacity alerts + `opsActionGroupResourceId` |
| `infra/azure/sunset-staging/main.bicep` | Sunset capacity alerts + `opsActionGroupResourceId` |
| `scripts/verify-radar-slice16l-staff-api-capacity-alerts.js` | Offline RED/GREEN verifier |
| `fixtures/radar-operations/slice16l-expected-contract.json` | Frozen independent contract |
| `fixtures/radar-operations/slice16l-capacity-alert-plan.json` | Plan fixture |
| `npm run verify:radar-slice16l-staff-api-capacity-alerts` | Gate |

## Bounded contract

| Bound | Value |
|-------|--------|
| Alerts per tenant | exactly 2 (`cpu-pressure`, `memory-pressure`) |
| Metrics | `CpuPercentage`, `MemoryPercentage` |
| Aggregation / operator / threshold | Average / GreaterThan / 80 |
| Window / eval | PT15M / PT5M |
| Severity / enabled | 2 / true |
| Namespace | `Microsoft.App/containerApps` |
| Criteria | StaticThresholdCriterion only |
| Actions | `opsActionGroupResourceId` (16B ops AG, subscription-pinned) |
| Forbidden | autoscaling, replica mutation, 16H edits, load/SLO/backpressure claims |

## Exact alerts

| Tenant | Alert name |
|--------|------------|
| Wolfhouse | `wolfhouse-staff-api-cpu-pressure` |
| Wolfhouse | `wolfhouse-staff-api-memory-pressure` |
| Sunset | `sunset-staff-api-cpu-pressure` |
| Sunset | `sunset-staff-api-memory-pressure` |

## Verdict counts

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven` | 0 | Control fully evidenced end-to-end (incl. live deploy + fire + load) |
| `partial` | 9 | Some code and/or live evidence; gaps remain |
| `absent` | 0 | No safe control evidenced |
| **total** | **9** | Matrix gates |

## Matrix (summary)

| ID | Gate | Verdict |
|----|------|---------|
| G01 | Correlation / structured logs | `partial` (16J correlation source still partial) |
| G02 | Readiness / dependencies | `partial` (16I readiness source still partial) |
| G03 | Actionable tenant-aware alerts | `partial` (16H metric-alert source still partial) |
| G04 | Webhook / payment / worker backlog | `partial` |
| G05 | Retry / replay safety | `partial` |
| G06 | Scaling / capacity | `partial` (16L capacity-pressure source-partial; deploy/load/SLO open) |
| G07 | Rollback / incident runbooks | `partial` |
| G08 | Retention / privacy | `partial` (16K healthz source-partial; deploy/retention/drill open) |
| G09 | Cost controls | `partial` (16B budget-threshold source still partial) |

## G06 semantics (truthful)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| Capacity-pressure metric alerts (source) | `partial` | CPU+Memory Average >80 in both staging Bicep |
| Autoscaling rules | `open` / absent live | Not added by 16L |
| Replica bounds | unchanged | min/max not mutated |
| Live deploy of capacity alerts | `open` | Not claimed |
| Alert fire / delivery | `open` | Not claimed |
| Sustained load / soak | `open` | Not claimed |
| Response-time / capacity SLO | `open` | Not claimed |
| Backpressure behavior | `open` | Not claimed |

## Slice 16L progress

**ID:** `16L_staff_api_capacity_pressure_alerts`
**Gate:** `G06_scaling_capacity`
**Progress class:** `source_partial_progress_only`
**Does not implement:** live deploy, alert fire, autoscaling, load proof, response-time/SLO, backpressure

### Still open

- Live deploy of capacity-pressure alerts to Wolfhouse + Sunset staging
- Actual alert firing / notification delivery
- Sustained load / soak proof
- Response-time / capacity SLO
- Backpressure behavior proof

## Prior partial progress retained

- **16K** `16K_staff_api_healthz_minimization` on G08 — source-partial healthz (not deployed)
- **16J** `16J_staff_api_request_correlation` on G01 — source-partial correlation (not deployed)
- **16I** `16I_staff_api_readiness_dependencies` on G02 — source-partial readiness (not deployed)
- **16H** `16H_staff_api_metric_alerts` on G03 — source-partial metric alerts (not deployed)
- **16B** `16B_staging_rg_cost_budget_threshold` on G09 — budget-threshold source-partial (not deployed)

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16L. Database, Hermes staging, and 16H metric-alert module must remain unchanged vs master basis. Wolfhouse/Sunset staging Bicep capacity-alert additions are intentional 16L ownership; replica/traffic/auth/DB paths protected.
