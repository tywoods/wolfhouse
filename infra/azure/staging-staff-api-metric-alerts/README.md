# Staging Staff API metric alerts (RADAR 16H)

Standalone, reviewable Azure **source module** for tenant-named metric alerts on both staging Staff API Container Apps. Progress class: **source partial only**. Supersedes deferred 16F/16G.

This slice ships **Bicep + offline verifier only**. It does **not** include a deployment wrapper, does **not** claim execution, does **not** deploy, does **not** prove notification delivery, and does **not** run an alert-fire drill.

## Scope (hard locks — fail closed in Bicep)

| Lock | Enforcement |
|------|-------------|
| Subscription | `assertSubscription` via `subscription().subscriptionId == 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9` (`fail('wrong_subscription')`) |
| RG / app tuple | `resourceGroup().name` + `containerAppName` must be exactly `wh-staging-rg`→`wh-staging-staff-api` or `luna-sunset-staging-rg`→`luna-sunset-staging-staff-api` |
| Tenant slug | Derived from RG (`wolfhouse` / `sunset`) — **not** a parameter |
| Action group | Derived 16B ops AG name from RG — **reference only**, never create/modify |
| Metric / operator / threshold / severity / window / enabled | Bicep **vars** (constants) — **not** overridable parameters |
| Only param | `containerAppName` (still tuple-asserted) |
| Resource types | `Microsoft.Insights/metricAlerts` only |
| Live deploy (this slice) | **disabled** — source + offline gates only |

## Deployment mode (truthful)

Safe **Incremental** operator deployment remains **open**. ARM deployment mode is external to template evaluation — **this template cannot enforce ARM mode**. The `deploymentModeRequired` output is documentary only.

All live proof remains open: deploy, notification delivery, alert-fire drill.

## Alerts (enabled, tenant-named)

| Alert name | Metric | Aggregation | Dimension | Operator | Threshold | Window / eval |
|------------|--------|-------------|-----------|----------|-----------|---------------|
| `{tenant}-staff-api-requests-5xx` | `Requests` | `Total` | `statusCodeCategory=5xx` | `GreaterThanOrEqual` | `3` | `PT5M` / `PT1M` |
| `{tenant}-staff-api-restart-count` | `RestartCount` | `Total` | (none) | `GreaterThan` | `0` | `PT5M` / `PT1M` |

Severity locked to **2**. Both alerts `enabled: true` (var `alertsEnabled`).

## Resources declared (exactly one type)

1. `Microsoft.Insights/metricAlerts` — two alerts per RG

The module is **structurally unable** to create/modify Container Apps, action groups, budgets, PostgreSQL, Key Vault, managed identities, networking, or production RGs.

## Files

| Path | Role |
|------|------|
| `rg-staff-api-metric-alerts.bicep` | RG-scoped module (deploy once per staging RG) |
| `parameters.wh-staging.example.json` | Secret-free example — **only** `containerAppName` |
| `parameters.luna-sunset-staging.example.json` | Secret-free example — **only** `containerAppName` |

**Not wired** into `infra/azure/staging/main.bicep` or `infra/azure/sunset-staging/main.bicep`.

## Offline gate

```bash
npm run verify:radar-slice16h-staff-api-metric-alerts
```

The offline verifier is **independent**: it does not import any plan/preflight/implementation library; it compares the complete compiled ARM contract to `fixtures/radar-operations/slice16h-expected-contract.json`, and independently compiles adversarial Bicep overrides proving wrong subscription/RG/app/action-group/threshold/severity/window cannot produce a valid deployment template.

## Progress class

`source_partial_progress_only` — source + offline ARM proof. Remaining open:

- Safe Incremental **operator deployment** of metric alerts to the two staging RGs
- Real notification **delivery** proof
- Alert-**fire** controlled drill
