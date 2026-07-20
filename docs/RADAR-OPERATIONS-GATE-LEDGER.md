# RADAR Slice 16A — Operations gate ledger

**Status:** audit only (zero live mutation / deploy / restart / DB-secret read / guest-payment action / production query)
**Master basis:** `28a30a688baa637e1bcb549d9b585cb5917942d1` (merged 16A)
**Branch (merged):** `radar/slice-16a-gate-ledger`
**Azure read-only scope:** `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”

## Deferred / superseding slices

| Slice | Branch | Policy | Role |
|-------|--------|--------|------|
| **16A2** | `radar/slice-16a2-ledger-provenance` @ `9d98590109c99f53a2d03b59d488373d9f9377d1` | **deferred — do not merge / do not modify** | Mixed capture implementation + shared verifier constants; superseded |
| **16A3** | `radar/slice-16a3-capture-contract` | design freeze (this doc section below) | Independent exact Azure evidence-capture **contract** only |
| **16A4** (planned) | — | not started | Bounded capture **implementation** that loads the 16A3 method-spec |

### Corrected G09 budget-vs-anomaly semantics (preserved from 16A2 into 16A3)

Merged 16A still names the gate `G09_cost_anomaly_detection` in historical fixtures. The corrected semantics (frozen forward by 16A3; do not lose) are:

1. **G09 = cost controls** (`G09_cost_controls`) — not anomaly detection alone.
2. **Budgets are threshold controls**, not anomaly detection.
3. **Separate acceptances:** budget-notification vs anomaly-detection.
4. **Selected 16B** = `16B_staging_rg_cost_budget_threshold` with progress class `budget_threshold_partial_progress_only`.
5. **16B does not implement** anomaly detection.
6. **Notification acceptance** requires **real delivery proof**; `Enabled` configuration alone fails.

A later ledger remediation slice may rewrite merged 16A matrix/contract naming; until then, treat the corrected semantics above as authoritative for 16B selection language.

## RADAR 16A3 — Azure evidence-capture contract (design freeze)

**Master basis:** `5a8b08d395e11c51baf928b918016d5dd5bb4afe`

**Outcome:** freeze a data-only exact capture contract that supersedes unmerged 16A2. No runtime behavior change. No live/network calls in 16A3.

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16a3-contract.json` | Freeze contract + bounded 16A4 owner |
| `fixtures/radar-operations/slice16a3-method-spec.json` | Per-method command/REST/version/body/retry/fallback + complete manifest hash |
| `fixtures/radar-operations/slice16a3-attempt-log.schema.json` | One record per physical dispatch attempt (incl. failures) |
| `fixtures/radar-operations/slice16a3-hash-policy.json` | Independently recomputable artifact + manifest hashes |
| `fixtures/radar-operations/slice16a3-adversarial-cases.json` | RED fixtures (substitution, listKeys, restart, path/version/body, hidden retry/fallback, missing failure, shared-constant drift) |
| `fixtures/radar-operations/slice16a3-sample-artifacts/` | Synthetic sanitized responses + GREEN attempt log |
| `fixtures/radar-operations/slice16a3-findings.md` | Human rollup |
| `scripts/verify-radar-slice16a3-azure-capture-contract.js` | Offline verifier (spec + artifacts only; **no** capture-impl import) |
| `npm run verify:radar-slice16a3-azure-capture-contract` | Gate |

**Frozen method/attempt semantics:** each `method_id` binds exact executable `command` and/or REST `method`/`path`/`api_version`/`body` entries in `bindings[]` (no free URL/body/name placeholders), plus per-method `allowed_resource_names` and `allowed_sampled_diagnostic_resource_ids`, allowed subscription/RGs/hosts, explicit `retry_policy` + `fallback_policy`. Attempt logs must conform to the closed whole-log schema: unique contiguous ordered IDs, bounded attempts, exact retryable classes and fallback chain, **one row per physical dispatch** (including failures/retries/fallbacks), outcome-conditional error/response/hash fields, `additionalProperties=false`. Hidden retries/fallbacks and missing failure records are defects. RED cases are one-field mutations of schema-valid GREEN controls. `complete_manifest_sha256` covers every frozen spec/schema/policy/owner/adversarial/artifact-index byte; per-response `response_sha256` recomputes via frozen canonical JSON + SHA-256.

**Bounded replacement implementation owner:** `16A4_azure_capture_implementation` → `scripts/lib/radar-operations-azure-capture.js` + `scripts/capture-radar-operations-staging-readonly.js`, must load `slice16a3-method-spec.json`, must not be imported by the verifier, ancestry = clean master after 16A3 (not deferred 16A2).

```bash
npm run verify:radar-slice16a3-azure-capture-contract
git diff --check 5a8b08d395e11c51baf928b918016d5dd5bb4afe..HEAD
```

---

## Outcome (merged 16A)

Code- and live-evidence-backed frozen RADAR operations gate ledger across logging, readiness, alerts, webhook/worker backlog, retry/replay, scaling, rollback/incident runbooks, retention/privacy, and cost anomaly detection. Exactly one Slice 16B gate is **selected** (not implemented).

## Artifacts (merged 16A)

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

> **Naming note:** historical merged-16A label above. Authoritative corrected semantics = **cost controls** with budget-threshold ≠ anomaly detection (see Deferred / superseding slices).

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
2. **G09 — cost controls absent** (high): MTD cost known; budget threshold and anomaly detection both absent; no delivery proof path. (Historical 16A text said “cost anomaly detection”; corrected semantics preserved above.)
3. **G02 — readiness partial** (high): `/healthz` is not dependency-aware; live ACA probes empty.
4. **G07 — restore drill unproven** despite runbook text and 7-day PG backups.

## Selected Slice 16B (selection only — do not implement in 16A)

**Historical merged-16A ID:** `16B_staging_rg_cost_budget_anomaly` on `G09_cost_anomaly_detection`

**Corrected selection language (authoritative):** `16B_staging_rg_cost_budget_threshold` on `G09_cost_controls`, progress class `budget_threshold_partial_progress_only`, does **not** implement anomaly detection.

### Acceptance criteria (finite) — budget-threshold partial progress

1. Consumption budget on `wh-staging-rg` with amount ≥ measured MTD baseline and ≥1 notification threshold (e.g. 80% / 100%).
2. Same for `luna-sunset-staging-rg`.
3. Action group has a non-ARM ops receiver (email or webhook); no secrets in git.
4. **Real notification delivery proof** (received email/webhook delivery id). Enabled configuration alone fails.
5. Secret-free fixture + verifier prove budget names/scopes/thresholds.
6. Diff excludes Staff API / Hermes / DB schema / guest-payment runtime behavior changes.

### Anomaly-detection acceptance (separate — not 16B)

Cost Management anomaly alert (or equivalent) with delivery proof remains absent; out of scope for 16B.

### Final controlled drill (16B)

`16B_DRILL_budget_threshold_notify` — create budgets + confirm thresholds + prove **notification delivery**; re-list budgets read-only; prove no container restart/deploy/DB write; leave anomaly detection unmet.

### Final controlled drill (16A)

`16A_DRILL_ledger_freeze_read_only` — freeze ledger from clean master; offline verify; push branch; no PR/merge; Azure GET + CostManagement query only.

### Final controlled drill (16A3)

`16A3_DRILL_capture_contract_freeze` — freeze data-only capture contract from clean master; offline verify; push branch; no PR/merge; no live Azure calls.

## Gates

```bash
npm run verify:radar-slice16a3-azure-capture-contract
npm run verify:radar-slice16a-operations-gate-ledger
npm run verify:sunset-staging-iac-secret-scan
npm run verify:migration-integrity
npm run verify:sunset-staging-iac-diff-check
git diff --check 5a8b08d395e11c51baf928b918016d5dd5bb4afe..HEAD
```

## Zero-mutation proof

16A adds ledger documentation, secret-free fixtures, and a read-only deterministic verifier only. 16A3 adds capture-contract documentation, secret-free fixtures, and an independent offline verifier only. Neither must change `scripts/staff-query-api.js`, Hermes runtime, `database/`, or staging Bicep templates. 16A3 must not perform live Azure work.
