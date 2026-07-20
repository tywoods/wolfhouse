# Staging Staff API metric alerts (RADAR 16F)

Standalone, reviewable Azure module for **tenant-named metric alerts** on both staging Staff API Container Apps. Progress class: **source partial only**. Does **not** deploy, does **not** prove notification delivery, and does **not** run an alert-fire drill.

## Scope (hard locks — fail closed in Bicep)

| Lock | Enforcement |
|------|-------------|
| Subscription | `assertSubscription` via `subscription().subscriptionId == 6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9` (`fail('wrong_subscription')`) |
| RG / app tuple | `resourceGroup().name` + `containerAppName` must be exactly `wh-staging-rg`→`wh-staging-staff-api` or `luna-sunset-staging-rg`→`luna-sunset-staging-staff-api` |
| Tenant slug | Derived from RG (`wolfhouse` / `sunset`) — **not** a parameter |
| Action group | Derived 16B ops AG name from RG — **reference only**, never create/modify |
| Metric / operator / threshold / severity / window / enabled | Bicep **vars** (constants) — **not** overridable parameters |
| Only param | `containerAppName` (still tuple-asserted) |
| Deployment mode | **Incremental** only (ARM mode is external — shell-free argv builder always pins it) |
| Live deploy (this slice) | **disabled** — source + offline gates only |

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

## Deployment argv builder (shell-free, opaque capability, no executor)

`runPreflight` issues a **frozen opaque capability** registered by object identity in a private WeakSet/WeakMap, bound to exact subscription, RG, app, template path/hash, and Incremental mode.

`buildDeploymentArgv` accepts **only** a still-valid in-process capability from `runPreflight`. It assembles argv exclusively from the binding, always pins subscription / RG / template / `--mode Incremental`, and **never executes** (no live call). It rejects:

- caller-shaped booleans / result objects (legacy bool auth, forged `{ ok: true }`)
- clones and JSON roundtrips (identity not registered)
- altered bound fields and cross-RG/app reuse
- replay after one-shot consumption
- unknown builder keys and extra args
- Complete mode

## Preflight / gates

```bash
npm run verify:radar-slice16f-staff-api-metric-alerts
node scripts/preflight-radar-slice16f-staff-api-metric-alerts.js --resource-group wh-staging-rg
```

Preflight short-circuits unless subscription + RG + app + action-group match the locks exactly, rejects Complete mode, wrong scope, production markers, and unknown/live flags. It does **not** deploy. Successful preflight issues an opaque capability (not serializable across process boundaries).

The offline verifier is **independent**: it does not import the plan/preflight library; it compares the complete compiled and plan contracts to `fixtures/radar-operations/slice16f-expected-contract.json`, independently compiles adversarial Bicep overrides (wrong sub/RG/app/AG/threshold/severity/window), and owns one-field RED mutations plus child-process wrapper proofs that forged/replayed/cross-bound capabilities and Complete mode cannot authorize argv.

## Progress class

`source_partial_progress_only` — source + offline proof. Remaining open:

- Live **deployment** of metric alerts to the two staging RGs
- Real notification **delivery** proof
- Alert-**fire** controlled drill
