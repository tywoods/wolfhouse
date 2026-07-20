# RADAR Slice 16B — Operations gate ledger (budget-threshold partial progress)

**Status:** source partial progress only (zero live deploy / mutation / anomaly-detection claim)
**Master basis:** `5a8b08d395e11c51baf928b918016d5dd5bb4afe`
**Branch:** `radar/slice-16b-staging-cost-budgets`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”

## Outcome

Add a **standalone staging-only Azure budget-threshold module** (ActualCost budgets + parameterized ops-email action groups). This is **budget-threshold partial progress only**. It does **not** deploy, does **not** prove notification delivery, and does **not** claim cost anomaly detection.

## Artifacts

| Path | Role |
|------|------|
| `infra/azure/staging-cost-budgets/rg-budget-threshold.bicep` | Standalone RG module (AG + budget only) |
| `infra/azure/staging-cost-budgets/parameters.*.example.json` | Secret-free locked params (no email) |
| `infra/azure/staging-cost-budgets/README.md` | Module contract |
| `fixtures/radar-operations/slice16b-budget-threshold-plan.json` | Secret-free resource plan |
| `scripts/lib/radar-slice16b-staging-cost-budgets.js` | Locks + RED/GREEN + scope short-circuit |
| `scripts/preflight-radar-slice16b-staging-cost-budgets.js` | Exact sub/RG preflight (no Azure calls) |
| `scripts/verify-radar-slice16b-staging-cost-budgets.js` | Offline 16B verifier |
| `fixtures/radar-operations/gate-matrix.json` | Updated gate matrix |
| `npm run verify:radar-slice16b-staging-cost-budgets` | Gate |

## Verdict counts

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven` | 0 | Control fully evidenced end-to-end (incl. delivery) |
| `partial` | 8 | Some code and/or live evidence; gaps remain |
| `absent` | 1 | No safe control evidenced (G03) |
| **total** | **9** | Matrix gates |

## Matrix (summary)

| ID | Gate | Verdict |
|----|------|---------|
| G01 | Correlation / structured logs | `partial` |
| G02 | Readiness / dependencies | `partial` |
| G03 | Actionable tenant-aware alerts | `absent` |
| G04 | Webhook / payment / worker backlog | `partial` |
| G05 | Retry / replay safety | `partial` |
| G06 | Scaling / capacity | `partial` |
| G07 | Rollback / incident runbooks | `partial` |
| G08 | Retention / privacy | `partial` |
| G09 | Cost controls | `partial` |

## G09 semantics (truthful)

**G09 = cost controls** — not “anomaly detection alone”.

| Sub-control | Status | Notes |
|-------------|--------|-------|
| Budget threshold | `partial` | Standalone IaC source for USD 120/40, 80%/100% Enabled thresholds, ops-email AG per RG. **Not deployed.** Live budgets still `[]`. |
| Notification delivery | `open` | Real delivery proof required; Enabled configuration alone fails. |
| Anomaly detection | `absent` / open | **Not implemented; not claimed by 16B.** |

## Resource plan (secret-free)

| RG | Budget | Amount USD | Thresholds | Action group |
|----|--------|------------|------------|--------------|
| `wh-staging-rg` | `wh-staging-rg-monthly-actualcost` | 120 | 80%, 100% Actual Enabled | `wh-staging-ops-budget-ag` |
| `luna-sunset-staging-rg` | `luna-sunset-staging-rg-monthly-actualcost` | 40 | 80%, 100% Actual Enabled | `luna-sunset-staging-ops-budget-ag` |

Deployment mode: **Incremental** only. Allowed types: `Microsoft.Insights/actionGroups`, `Microsoft.Consumption/budgets` only. `opsNotifyEmail` has **no default** and is **omitted** from committed params.

## Slice 16B progress

**ID:** `16B_staging_rg_cost_budget_threshold`
**Gate:** `G09_cost_controls`
**Progress class:** `budget_threshold_partial_progress_only`
**Does not implement:** `anomaly_detection`

### Still open

1. Live deploy of budgets/AGs to the two staging RGs
2. Real notification **delivery** proof
3. Cost **anomaly detection** (separate acceptance)

### Final controlled drill (remaining)

`16B_DRILL_budget_threshold_notify` — after approved deploy: confirm thresholds; prove **notification delivery**; re-list budgets read-only; prove no container restart/deploy/DB write; leave anomaly detection unmet.

## Gates

```bash
export PATH="/opt/data/.local/bin:$PATH"
export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
az bicep build --file infra/azure/staging-cost-budgets/rg-budget-threshold.bicep --outfile tmp/radar-16b-rg-budget-threshold.json
npm run verify:radar-slice16a-operations-gate-ledger
npm run verify:radar-slice16b-staging-cost-budgets
npm run verify:sunset-staging-iac-secret-scan
npm run verify:migration-integrity
npm run verify:sunset-staging-iac-diff-check
git diff --check 5a8b08d395e11c51baf928b918016d5dd5bb4afe..HEAD
```

## Zero-live / zero-runtime proof

16B adds standalone staging-cost-budgets IaC, fixtures, preflight, and verifiers only. It must not change `scripts/staff-query-api.js`, Hermes runtime, `database/`, or wire into `infra/azure/staging/main.bicep` / `infra/azure/sunset-staging/main.bicep`. Live deploy is hard-disabled. No Azure mutating calls in this slice.
