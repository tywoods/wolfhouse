# RADAR Slice 16C — Operations gate ledger (Staff API readiness source-partial)

**Status:** source partial progress only (zero live deploy / mutation / failure-drill claim)
**Master basis:** `acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b`
**Branch:** `radar/slice-16c-staff-api-readiness`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”

## Outcome

Add **truthful dependency-aware Staff API readiness** for Wolfhouse and Sunset **source/IaC only**. Keep `/healthz` as liveness. Add `/readyz` that performs a bounded read-only PostgreSQL check through the existing pool. Add ACA liveness/readiness/startup probes to both staging Bicep templates. **Do not deploy.** G02 remains `partial` — deployment and failure drill stay open.

## Artifacts

| Path | Role |
|------|------|
| `scripts/lib/staff-api-readiness.js` | `/readyz` contract + bounded SELECT 1 check |
| `scripts/staff-query-api.js` | Wires `/readyz`; `/healthz` unchanged (static) |
| `infra/azure/staging/main.bicep` | ACA probes (port 3036) |
| `infra/azure/sunset-staging/main.bicep` | Identical ACA probe contract |
| `scripts/lib/radar-slice16c-staff-api-readiness.js` | Locks + probe validators |
| `scripts/verify-radar-slice16c-staff-api-readiness.js` | RED/GREEN offline verifier |
| `fixtures/radar-operations/slice16c-*.json` | Expected endpoint/probe contracts |
| `npm run verify:radar-slice16c-staff-api-readiness` | Gate |

## Endpoint / probe contract

| Probe | Path | Port | Depends on Postgres | On failure |
|-------|------|------|---------------------|------------|
| Startup | `/healthz` | 3036 | No | Delays ready; eventual restart if never starts |
| Liveness | `/healthz` | 3036 | No | Restart container |
| Readiness | `/readyz` | 3036 | Yes (SELECT 1, 2500ms bound) | Remove traffic; **no** restart loop |

`/readyz` success: `200 { "status": "ready" }`

`/readyz` failure: `503 { "status": "not-ready" }` — never credentials, SQL, stack, or upstream errors.

## Verdict counts

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven` | 0 | Control fully evidenced end-to-end (incl. live deploy + drill) |
| `partial` | 8 | Some code and/or live evidence; gaps remain |
| `absent` | 1 | No safe control evidenced (G03) |
| **total** | **9** | Matrix gates |

## Matrix (summary)

| ID | Gate | Verdict |
|----|------|---------|
| G01 | Correlation / structured logs | `partial` |
| G02 | Readiness / dependencies | `partial` (source-partial via 16C) |
| G03 | Actionable tenant-aware alerts | `absent` |
| G04 | Webhook / payment / worker backlog | `partial` |
| G05 | Retry / replay safety | `partial` |
| G06 | Scaling / capacity | `partial` |
| G07 | Rollback / incident runbooks | `partial` |
| G08 | Retention / privacy | `partial` |
| G09 | Cost controls | `partial` (16B budget-threshold source) |

## Prior slice 16B (still partial)

**ID:** `16B_staging_rg_cost_budget_threshold` on **G09_cost_controls** — budget-threshold source only; not anomaly detection; deploy + notification delivery still open.

## Slice 16C progress

**ID:** `16C_staff_api_readiness_dependencies`

**Gate:** `G02_readiness_dependencies`

**Progress class:** `source_partial_progress_only`

### Still open

1. Live deploy of Staff API image + ACA probe template to both staging apps
2. Controlled readiness failure drill proving traffic shed without restart loops
3. Live probe inventory no longer empty/null

### Final controlled drill (remaining)

`16C_DRILL_readiness_failure_traffic_shed` — after approved deploy: make Postgres unreachable for Staff API; prove `/readyz=503` and traffic removed; prove `/healthz=200` without restart loop; restore PG; prove traffic returns.

## Gates

```bash
export PATH="/opt/data/.local/bin:$PATH"
export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
az bicep build --file infra/azure/staging/main.bicep --outfile tmp/radar-16c-staging-main.json
az bicep build --file infra/azure/sunset-staging/main.bicep --outfile tmp/radar-16c-sunset-main.json
npm run verify:radar-slice16c-staff-api-readiness
npm run verify:radar-slice16a-operations-gate-ledger
npm run verify:radar-slice16b-staging-cost-budgets
npm run verify:sunset-staging-iac-secret-scan
npm run verify:migration-integrity
npm run verify:sunset-staging-iac-diff-check
git diff --check acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b..HEAD
```

## Zero-live / zero-runtime proof

16C changes Staff API readiness source and staging Bicep probe declarations only. Live deploy is out of scope. No Azure mutating calls. No guest/payment/production actions. Database schema and Hermes staging must remain untouched.
