# Staging Staff API metric alerts (RADAR 16G)

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
| Deployment mode | **Incremental** only (ARM mode is external — `runSafeDeploymentEntry` always pins it) |
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

## Safe deployment entry point (`runSafeDeploymentEntry`)

Canonical Bicep is resolved via `realpath` from `__dirname` only — **no** `root` / `cwd` / `templatePath` overrides.

The entry point:

1. Requires the Bicep file clean (or untracked-but-matching) at the pinned git blob/hash
2. Compiles exact ARM JSON bytes (`az bicep build`)
3. Writes them to a fresh mode-`0700` temp dir / mode-`0400` file
4. Spawns shell-free (`spawnSync`, `shell:false`) with absolute temp path, exact subscription + RG, `--mode Incremental`, and explicit `containerAppName=…`
5. Verifies ARM bytes/hash before spawn and after completion (fails if mutated)
6. Cleans temp in `finally`

`spawnFn` may be dependency-injected **only in tests**. Production requires `live: true` + exact operator confirmation, and this source slice still hard-disables live apply (`liveDeployEnabled: false`). Deployment/drill remain open.

Adversarial coverage: alternate root/cwd/symlink/path, hash mismatch, temp mutation, Complete mode, extra args, exact argv.

## Preflight / gates

```bash
npm run verify:radar-slice16g-staff-api-metric-alerts
node scripts/preflight-radar-slice16g-staff-api-metric-alerts.js --resource-group wh-staging-rg
```

`runPreflight` short-circuits unless subscription + RG + app + action-group match the locks exactly, rejects Complete mode, wrong scope, production markers, and unknown/live flags. It does **not** deploy. Successful preflight verifies scope + pinned Bicep blob; it does not spawn deploy.

The offline verifier is **independent**: it does not import the plan/preflight library; it compares the complete compiled and plan contracts to `fixtures/radar-operations/slice16g-expected-contract.json`, independently compiles adversarial Bicep overrides (wrong sub/RG/app/AG/threshold/severity/window), and owns one-field RED mutations plus child-process probes that path overrides, hash keys, temp mutation, Complete mode, and extra args cannot authorize `runSafeDeploymentEntry`.

## Progress class

`source_partial_progress_only` — source + offline proof. Remaining open:

- Live **deployment** of metric alerts to the two staging RGs
- Real notification **delivery** proof
- Alert-**fire** controlled drill
