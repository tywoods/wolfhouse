# RADAR Slice 16A2 — Operations gate ledger (provenance)

**Status:** audit only (zero live mutation / deploy / restart / DB-secret read / guest-payment action / production query)
**Master basis:** `5a8b08d395e11c51baf928b918016d5dd5bb4afe`
**Branch:** `radar/slice-16a2-ledger-provenance`
**Azure read-only scope:** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”

## Outcome

Make the frozen RADAR operations gate ledger **independently reproducible** and **semantically truthful**: exact allowlisted read-only Azure capture (commands/REST paths/API versions/timestamps/response hashes), strengthened offline verifier (JSON refs, cite semantics, runtime-path range diff, reconstructed claims), and corrected G09 cost-controls semantics. Exactly one Slice 16B gate is **selected** (not implemented): budget-threshold partial progress only.

## Artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/gate-matrix.json` | Machine-readable gate matrix |
| `fixtures/radar-operations/live-inventory.json` | Sanitized staging live inventory + MTD costs + provenance |
| `fixtures/radar-operations/capture-manifest.json` | Exact allowed method inventory (pre-dispatch) |
| `fixtures/radar-operations/capture-log.json` | Per-call commands/paths/versions/timestamps/hashes |
| `fixtures/radar-operations/contract.json` | Frozen acceptance contract |
| `fixtures/radar-operations/findings.md` | Human findings rollup |
| `scripts/lib/radar-operations-azure-capture.js` | Capture guards + RED tests + live capture |
| `scripts/capture-radar-operations-staging-readonly.js` | Read-only capture CLI |
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
| G09 | Cost controls | `absent` |

Full evidence paths, line ranges, live refs, and gaps live in `gate-matrix.json`.

## Semantic corrections (vs merged 16A)

1. **G09 = cost controls** (not “cost anomaly detection”). Budgets are **threshold** controls; anomaly detection is a **separate** control.
2. **16B** = `16B_staging_rg_cost_budget_threshold` — **budget-threshold partial progress only**; does not implement anomaly detection.
3. **Notification acceptance** requires **real delivery proof** (received email/webhook delivery id). `Enabled` configuration alone fails the drill.
4. **Diagnostic settings** absence is qualified to an **explicit sampled allowlist** (staff-api/pg/kv/appinsights/logs × both RGs) — not an exhaustive RG claim.
5. **Workspace-based App Insights:** component `retentionInDays=90` is not effective analytics retention alone; linked LAW retention (**30d**) governs.
6. **Provenance:** capture manifest + tool refuse production/secret/DB/mutation surfaces **before dispatch**; every call records command/REST path/API version/timestamp/response hash.

## Live cost snapshot (MonthToDate ActualCost, USD)

Re-captured read-only via Cost Management query (no budgets mutated):

| Resource group | MTD total (USD) |
|----------------|----------------:|
| `wh-staging-rg` | 65.12 |
| `luna-sunset-staging-rg` | 16.91 |
| **Combined** | **82.03** |

Service breakdowns and exact floats are frozen in `live-inventory.json#costs_mtd` / `contract.json#costs_mtd_usd_frozen`.

## Live monitor / alert / diagnostic inventory (sanitized)

- **Metric alerts:** none on either RG
- **Activity log alerts:** none on either RG
- **Scheduled query rules:** none on either RG
- **Budgets:** none on either RG
- **Action groups:** `Application Insights Smart Detection` on `wh-staging-rg` (ARM role receivers only; 0 email/SMS/webhook); none on Sunset
- **Diagnostic settings (sampled allowlist only):** none on sampled staff-api/pg/kv/appinsights/logs (both RGs)
- **ACA env logging:** both envs `logsDestination=log-analytics`
- **Retention:** LAW 30 days; App Insights workspace-based **effective analytics retention 30 days** (component field 90 days is not effective alone)
- **Staff API ACA:** Wolfhouse `minReplicas=0` `maxReplicas=1` `probes=[]`; Sunset `minReplicas=1` `maxReplicas=1` `probes=null`
- **Jobs:** Sunset `hold-expiry` cron `15 * * * *`; `sch-obs` Manual
- **Postgres backups:** 7-day retention, geo-redundant disabled (all three flexible servers)
- **Public healthz:** both staging hostnames HTTP 200 `status=ok` without dependency readiness fields (config flags ≠ PG/Stripe/Redis probes)

## Critical gaps

1. **G03 — actionable tenant-aware alerts absent** (critical): no metric/query alerts; no tenant-aware notify path.
2. **G09 — cost controls absent** (high): MTD cost known; budget threshold and anomaly detection both absent; no delivery proof path.
3. **G02 — readiness partial** (high): `/healthz` is not dependency-aware; live ACA probes empty.
4. **G07 — restore drill unproven** despite runbook text and 7-day PG backups.

## Selected Slice 16B (selection only — do not implement in 16A2)

**ID:** `16B_staging_rg_cost_budget_threshold`
**Gate:** `G09_cost_controls`
**Progress class:** `budget_threshold_partial_progress_only`
**Does not implement:** `anomaly_detection`

### Budget-notification acceptance (16B)

1. Consumption budget on `wh-staging-rg` with amount ≥ measured MTD baseline and ≥1 notification threshold (e.g. 80% / 100%).
2. Same for `luna-sunset-staging-rg`.
3. Action group has a non-ARM ops receiver (email or webhook); no secrets in git.
4. **Real notification delivery proof** (test notification received/delivered) — Enabled configuration alone fails.
5. Secret-free fixture + verifier prove budget names/scopes/thresholds.
6. Diff excludes Staff API / Hermes / DB schema / guest-payment runtime behavior changes.

### Anomaly-detection acceptance (separate — not 16B)

1. Cost Management anomaly alert (or equivalent) with delivery proof — remains absent; out of scope for 16B.

### Final controlled drill (16B)

`16B_DRILL_budget_threshold_notify` — create budgets; prove thresholds; prove **notification delivery**; re-list budgets read-only; prove no container restart/deploy/DB write; leave anomaly detection unmet.

### Final controlled drill (16A2)

`16A_DRILL_ledger_freeze_read_only` — freeze provenance-corrected ledger from clean master; offline verify; push branch; no PR/merge; Azure GET + CostManagement query only within allowlisted scope.

## Gates

```bash
npm run verify:radar-slice16a-operations-gate-ledger
npm run verify:sunset-staging-iac-secret-scan
npm run verify:migration-integrity
npm run verify:sunset-staging-iac-diff-check
git diff --check 5a8b08d395e11c51baf928b918016d5dd5bb4afe..HEAD
```

## Zero-mutation proof

16A2 adds ledger documentation, secret-free fixtures, capture manifest/tool, and a strengthened read-only deterministic verifier only. It must not change `scripts/staff-query-api.js`, Hermes runtime, `database/`, or staging Bicep templates. Live Azure work was inventory + cost query within the two staging resource groups only.
