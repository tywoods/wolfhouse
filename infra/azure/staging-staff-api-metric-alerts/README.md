# Staging Staff API metric alerts (RADAR 16F)

Standalone, reviewable Azure module for **tenant-named metric alerts** on both staging Staff API Container Apps. Progress class: **source partial only**. Does **not** deploy, does **not** prove notification delivery, and does **not** run an alert-fire drill.

## Scope (hard locks)

| Lock | Value |
|------|-------|
| Subscription | `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9` |
| RG / app / tenant / AG pairs | `wh-staging-rg` → `wh-staging-staff-api` / `wolfhouse` / `wh-staging-ops-budget-ag`; `luna-sunset-staging-rg` → `luna-sunset-staging-staff-api` / `sunset` / `luna-sunset-staging-ops-budget-ag` |
| Metric namespace | `Microsoft.App/containerApps` |
| Scope | App ARM resource ID only |
| Action group | **Reference** existing 16B per-RG ops AG name — never create/modify |
| Deployment mode | **Incremental** only |
| Live deploy (this slice) | **disabled** — source + offline gates only |

## Alerts (enabled, tenant-named)

| Alert name | Metric | Aggregation | Dimension | Operator | Threshold | Window / eval |
|------------|--------|-------------|-----------|----------|-----------|---------------|
| `{tenant}-staff-api-requests-5xx` | `Requests` | `Total` | `statusCodeCategory=5xx` | `GreaterThanOrEqual` | `3` | `PT5M` / `PT1M` |
| `{tenant}-staff-api-restart-count` | `RestartCount` | `Total` | (none) | `GreaterThan` | `0` | `PT5M` / `PT1M` |

Severity locked to **2**. Both alerts `enabled: true`.

## Resources declared (exactly one type)

1. `Microsoft.Insights/metricAlerts` — two alerts per RG

The module is **structurally unable** to create/modify Container Apps, action groups, budgets, PostgreSQL, Key Vault, managed identities, networking, or production RGs (those types are not declared as created resources; preflight refuses extras).

## Files

| Path | Role |
|------|------|
| `rg-staff-api-metric-alerts.bicep` | RG-scoped module (deploy once per staging RG) |
| `parameters.wh-staging.example.json` | Secret-free locked params for Wolfhouse staging |
| `parameters.luna-sunset-staging.example.json` | Secret-free locked params for Sunset staging |

**Not wired** into `infra/azure/staging/main.bicep` or `infra/azure/sunset-staging/main.bicep`.

## Preflight / gates

```bash
npm run verify:radar-slice16f-staff-api-metric-alerts
node scripts/preflight-radar-slice16f-staff-api-metric-alerts.js --resource-group wh-staging-rg
```

Preflight short-circuits unless subscription + RG + app + action-group match the locks exactly, rejects Complete mode, wrong scope, production markers, and unknown/live flags. It does **not** deploy.

The offline verifier is **independent**: it does not import the plan/preflight library; it compares the complete compiled and plan contracts to `fixtures/radar-operations/slice16f-expected-contract.json` and owns one-field RED mutations for wrong scope, production marker, changed metric/dimension/operator/threshold/window/severity, missing/extra action, extra resources, Complete/live/unknown args.

## Progress class

`source_partial_progress_only` — source + offline proof. Remaining open:

- Live **deployment** of metric alerts to the two staging RGs
- Real notification **delivery** proof
- Alert-**fire** controlled drill
