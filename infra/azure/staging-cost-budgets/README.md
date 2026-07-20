# Staging cost budget thresholds (RADAR 16B)

Standalone, reviewable Azure module for **budget-threshold** controls on the two staging resource groups only. This is **not** cost anomaly detection.

## Scope (hard locks)

| Lock | Value |
|------|-------|
| Subscription | `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9` |
| Resource groups | `wh-staging-rg`, `luna-sunset-staging-rg` |
| Category / grain | ActualCost via `category=Cost` + `thresholdType=Actual`, `Monthly` |
| Amounts (USD) | `wh-staging-rg` **120**, `luna-sunset-staging-rg` **40** |
| Thresholds | **80%** and **100%**, both `enabled: true` |
| Deployment mode | **Incremental** only |
| Live deploy (this slice) | **disabled** — source + offline gates only |

## Resources declared (exactly two types)

1. `Microsoft.Insights/actionGroups` — one parameterized ops-email action group per RG
2. `Microsoft.Consumption/budgets` — one monthly ActualCost budget per RG

The module is **structurally unable** to touch Container Apps, PostgreSQL, Key Vault, managed identities, networking, or production RGs (those types are not present and preflight refuses them).

## Files

| Path | Role |
|------|------|
| `rg-budget-threshold.bicep` | RG-scoped module (deploy once per staging RG) |
| `parameters.wh-staging.example.json` | Secret-free locked params for Wolfhouse staging (no email) |
| `parameters.luna-sunset-staging.example.json` | Secret-free locked params for Sunset staging (no email) |

**Not wired** into `infra/azure/staging/main.bicep` or `infra/azure/sunset-staging/main.bicep`.

## Email parameter (no default / no personal address in git)

`opsNotifyEmail` has **no default** and is **omitted** from committed parameter files. Supply only at deploy time:

```bash
# Example overlay (gitignored) — do not commit
# parameters.opsNotifyEmail.value = <REQUIRED_OPS_NOTIFY_EMAIL>
```

Or env: `WH_RADAR_16B_OPS_NOTIFY_EMAIL`.

## Preflight / gates

```bash
npm run verify:radar-slice16b-staging-cost-budgets
node scripts/preflight-radar-slice16b-staging-cost-budgets.js --resource-group wh-staging-rg
```

Preflight short-circuits unless subscription + RG match the locks exactly, rejects Complete mode, missing/invalid email, changed amounts/thresholds, and extra resource types. It does **not** deploy.

## Progress class

`budget_threshold_partial_progress_only` — source + offline proof. Remaining open:

- Real notification **delivery** proof (Enabled config alone fails)
- Cost **anomaly detection** (separate control; not claimed here)
