# RADAR Slice 16A — Operations gate ledger

**Status:** audit only (zero live mutation / deploy / restart / DB-secret read / guest-payment action / production query)
**Master basis:** `28a30a688baa637e1bcb549d9b585cb5917942d1`
**Branch:** `radar/slice-16a-gate-ledger`
**Azure read-only scope:** `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”

## Outcome

Code- and live-evidence-backed frozen RADAR operations gate ledger across logging, readiness, alerts, webhook/worker backlog, retry/replay, scaling, rollback/incident runbooks, retention/privacy, and cost anomaly detection. Exactly one Slice 16B gate is **selected** (not implemented).

## Artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/gate-matrix.json` | Machine-readable gate matrix |
| `fixtures/radar-operations/live-inventory.json` | Sanitized staging live inventory + MTD costs |
| `fixtures/radar-operations/contract.json` | Frozen acceptance contract |
| `fixtures/radar-operations/findings.md` | Human findings rollup |
| `scripts/verify-radar-slice16a-operations-gate-ledger.js` | Deterministic offline verifier |
| `npm run verify:radar-slice16a-operations-gate-ledger` | Gate |

## Verdict counts

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven` | 0 | Control fully evidenced end-to-end |
| `partial` | 7 | Some code and/or live evidence; gaps remain |
| `absent` | 2 | No safe control evidenced |
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
| G09 | Cost anomaly detection | `absent` |

Full evidence paths, line ranges, live refs, and gaps live in `gate-matrix.json`.

## Live cost snapshot (MonthToDate ActualCost, USD)

Captured read-only via Cost Management query (no budgets mutated):

| Resource group | MTD total (USD) |
|----------------|----------------:|
| `wh-staging-rg` | 65.12 |
| `luna-sunset-staging-rg` | 16.91 |
| **Combined** | **82.03** |

Service breakdowns are frozen in `live-inventory.json#costs_mtd`.

## Live monitor / alert / diagnostic inventory (sanitized)

- **Metric alerts:** none on either RG
- **Activity log alerts:** none on either RG
- **Scheduled query rules:** none on either RG
- **Budgets:** none on either RG
- **Action groups:** `Application Insights Smart Detection` on `wh-staging-rg` (ARM role receivers only; 0 email/SMS/webhook); none on Sunset
- **Diagnostic settings (sampled staff-api/pg/kv/appinsights/logs):** none
- **ACA env logging:** both envs `logsDestination=log-analytics`
- **Retention:** LAW 30 days; App Insights 90 days
- **Staff API ACA:** Wolfhouse `minReplicas=0` `maxReplicas=1` `probes=[]`; Sunset `minReplicas=1` `maxReplicas=1` `probes=null`
- **Jobs:** Sunset `hold-expiry` cron `15 * * * *`; `sch-obs` Manual
- **Postgres backups:** 7-day retention, geo-redundant disabled (all three flexible servers)
- **Public healthz:** both staging hostnames HTTP 200 `status=ok` without dependency fields

## Critical gaps

1. **G03 — actionable tenant-aware alerts absent** (critical): no metric/query alerts; no tenant-aware notify path.
2. **G09 — cost anomaly detection absent** (high): MTD cost known; no budget/anomaly notify.
3. **G02 — readiness partial** (high): `/healthz` is not dependency-aware; live ACA probes empty.
4. **G07 — restore drill unproven** despite runbook text and 7-day PG backups.

## Selected Slice 16B (selection only — do not implement in 16A)

**ID:** `16B_staging_rg_cost_budget_anomaly`
**Gate:** `G09_cost_anomaly_detection`
**Why smallest:** complete live absence (`budgets=[]`), Azure budget + action group only, no Staff API/Hermes runtime change, offline-testable, uses measured MTD baselines.

### Acceptance criteria (finite)

1. Consumption budget on `wh-staging-rg` with amount ≥ measured MTD baseline and ≥1 notification threshold (e.g. 80% / 100%).
2. Same for `luna-sunset-staging-rg`.
3. Action group has a non-ARM ops receiver (email or webhook); no secrets in git.
4. Secret-free fixture + verifier prove budget names/scopes/thresholds.
5. Diff excludes Staff API / Hermes / DB schema / guest-payment runtime behavior changes.

### Final controlled drill (16B)

`16B_DRILL_budget_threshold_notify` — create budgets + confirm Enabled thresholds/receivers; re-list budgets read-only; prove no container restart/deploy/DB write.

### Final controlled drill (16A)

`16A_DRILL_ledger_freeze_read_only` — freeze ledger from clean master; offline verify; push branch; no PR/merge; Azure GET + CostManagement query only.

## Gates

```bash
npm run verify:radar-slice16a-operations-gate-ledger
npm run verify:sunset-staging-iac-secret-scan
npm run verify:migration-integrity
npm run verify:sunset-staging-iac-diff-check
git diff --check 28a30a688baa637e1bcb549d9b585cb5917942d1..HEAD
```

## Zero-mutation proof

16A adds ledger documentation, secret-free fixtures, and a read-only deterministic verifier only. It must not change `scripts/staff-query-api.js`, Hermes runtime, `database/`, or staging Bicep templates. Live Azure work was inventory + cost query within the two staging resource groups only.
