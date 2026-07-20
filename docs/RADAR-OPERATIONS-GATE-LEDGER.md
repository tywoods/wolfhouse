# RADAR Slice 16H — Operations gate ledger (Staff API metric alerts source-partial)

**Status:** source partial progress only (zero live deploy / mutation / notification-delivery / alert-fire claim; no deployment wrapper)
**Master basis:** `acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b`
**Branch:** `radar/slice-16h-metric-alert-source-only`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Supersedes:** deferred 16F / 16G

## Outcome

Add a **standalone staging-only Azure metric-alert source module** for both Staff API Container Apps (tenant-named Requests 5xx + RestartCount alerts). This is **source partial progress only**. It does **not** include a deployment wrapper, does **not** claim execution, does **not** deploy, does **not** prove notification delivery, and does **not** run an alert-fire drill. It **references** (never creates/modifies) the existing per-RG ops action-group name from 16B.

Safe **Incremental** operator deployment and all live proof remain **open**. The template **cannot enforce ARM mode**.

## Artifacts

| Path | Role |
|------|------|
| `infra/azure/staging-staff-api-metric-alerts/rg-staff-api-metric-alerts.bicep` | Standalone RG module (metricAlerts only) |
| `infra/azure/staging-staff-api-metric-alerts/parameters.*.example.json` | Secret-free locked params |
| `infra/azure/staging-staff-api-metric-alerts/README.md` | Module contract |
| `fixtures/radar-operations/slice16h-metric-alert-plan.json` | Secret-free alert plan |
| `fixtures/radar-operations/slice16h-expected-contract.json` | Frozen independent contract |
| `scripts/verify-radar-slice16h-staff-api-metric-alerts.js` | Offline independent 16H verifier |
| `fixtures/radar-operations/gate-matrix.json` | Updated gate matrix (G03 source-partial) |
| `npm run verify:radar-slice16h-staff-api-metric-alerts` | Gate |

## Verdict counts

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven` | 0 | Control fully evidenced end-to-end (incl. delivery + fire) |
| `partial` | 9 | Some code and/or live evidence; gaps remain |
| `absent` | 0 | No safe control evidenced |
| **total** | **9** | Matrix gates |

## Matrix (summary)

| ID | Gate | Verdict |
|----|------|---------|
| G01 | Correlation / structured logs | `partial` |
| G02 | Readiness / dependencies | `partial` |
| G03 | Actionable tenant-aware alerts | `partial` (source-partial via 16H) |
| G04 | Webhook / payment / worker backlog | `partial` |
| G05 | Retry / replay safety | `partial` |
| G06 | Scaling / capacity | `partial` |
| G07 | Rollback / incident runbooks | `partial` |
| G08 | Retention / privacy | `partial` |
| G09 | Cost controls | `partial` (16B budget-threshold source still partial) |

## G03 semantics (truthful)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| Metric alert IaC | `partial` | Standalone source module: tenant-named Requests 5xx (>=3 / PT5M/PT1M) + RestartCount (>0 / PT5M/PT1M) on both Staff API apps. Namespace `Microsoft.App/containerApps`. Bicep fail-closes exact subscription + RG/app tuple via `subscription()`/`resourceGroup()`; derives tenant slug + 16B AG from RG; thresholds/severity/windows are vars (not params). **Not deployed.** Live metric_alerts still `[]`. |
| Action group | reference-only | 16B per-RG ops AG name **derived from RG** in Bicep; never creates/modifies AGs |
| Deployment wrapper | absent (intentional) | 16H is source-only; no argv builder / safe-deploy entry |
| ARM mode enforcement | not claimable | Template cannot enforce ARM mode; Incremental is operator practice |
| Notification delivery | `open` | Real delivery proof required |
| Alert-fire drill | `open` | Controlled fire drill required |

## Resource plan (secret-free)

| RG | App | Tenant | Action group (ref) | Alerts |
|----|-----|--------|--------------------|--------|
| `wh-staging-rg` | `wh-staging-staff-api` | `wolfhouse` | `wh-staging-ops-budget-ag` | `wolfhouse-staff-api-requests-5xx`, `wolfhouse-staff-api-restart-count` |
| `luna-sunset-staging-rg` | `luna-sunset-staging-staff-api` | `sunset` | `luna-sunset-staging-ops-budget-ag` | `sunset-staff-api-requests-5xx`, `sunset-staff-api-restart-count` |

Allowed create type: `Microsoft.Insights/metricAlerts` only. Only parameter: `containerAppName` (tuple-asserted).

## Slice 16H progress

**ID:** `16H_staff_api_metric_alerts`
**Gate:** `G03_actionable_tenant_aware_alerts`
**Progress class:** `source_partial_progress_only`
**Does not implement:** live deploy, notification delivery, alert-fire drill, deployment wrapper, ARM-mode enforcement

### Still open

1. Safe Incremental **operator deployment** of metric alerts to the two staging RGs
2. Real notification **delivery** proof
3. Alert-**fire** controlled drill

### Final controlled drill (remaining)

`16H_DRILL_metric_alert_fire_notify` — after approved Incremental operator deploy: confirm alerts Enabled; prove notification delivery; prove controlled alert fire; re-list metric alerts read-only; prove no container restart/deploy/DB write / AG mutation.

## Gates

```bash
export PATH="/opt/data/.local/bin:$PATH"
export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
az bicep build --file infra/azure/staging-staff-api-metric-alerts/rg-staff-api-metric-alerts.bicep --outfile tmp/radar-16h-rg-staff-api-metric-alerts.json
npm run verify:radar-slice16a-operations-gate-ledger
npm run verify:radar-slice16b-staging-cost-budgets
npm run verify:radar-slice16h-staff-api-metric-alerts
npm run verify:sunset-staging-iac-secret-scan
npm run verify:migration-integrity
npm run verify:sunset-staging-iac-diff-check
git diff --check acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b..HEAD
```

## Zero-live / zero-runtime proof

16H adds standalone staging-staff-api-metric-alerts IaC, fixtures, and an independent verifier only. It must not change `scripts/staff-query-api.js`, Hermes runtime, `database/`, or wire into `infra/azure/staging/main.bicep` / `infra/azure/sunset-staging/main.bicep`. No deployment wrapper. Live deploy is hard-disabled. No Azure mutating calls in this slice.
