# RADAR Slice 16E — Operations gate ledger (Staff API ACA traffic rollback source-partial)

**Status:** source partial progress only (zero live rollback / traffic mutation / restore-drill claim)
**Master basis:** `acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b`
**Branch:** `radar/slice-16e-staff-api-rollback-runbook`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; apps `wh-staging-rg/wh-staging-staff-api`, `luna-sunset-staging-rg/luna-sunset-staging-staff-api`
**Classifier policy:** absence of evidence is `absent`, never “safe”

## Outcome

Add a **fail-closed, staging-only Azure Container Apps Staff API traffic-weight rollback runbook/preflight** for both staging Staff APIs. **Do not execute it.** Require explicit current and target revision names, immutable full-SHA target image, healthy target revision, and human confirmation token. Plan traffic change only after read-only preflight proves the target belongs to the same app/RG, is active/healthy, image matches SHA, and the current traffic snapshot is captured. Rollback mode changes **traffic weights only** — never image/env/secrets/scaling/DB/restart/delete — and emits a secret-free rollback record plus exact restore plan.

## Artifacts

| Path | Role |
|------|------|
| `docs/RADAR-16E-STAFF-API-ROLLBACK-RUNBOOK.md` | Operator-facing contract |
| `scripts/lib/radar-slice16e-staff-api-rollback.js` | Locks + evaluate + RED/GREEN helpers |
| `scripts/preflight-radar-slice16e-staff-api-rollback.js` | Exact sub/RG/app preflight (no Azure calls) |
| `scripts/verify-radar-slice16e-staff-api-rollback.js` | Offline 16E verifier |
| `fixtures/radar-operations/slice16e-expected-contract.json` | Frozen contract |
| `fixtures/radar-operations/slice16e-rollback-plans.json` | Secret-free GREEN plans |
| `npm run verify:radar-slice16e-staff-api-rollback` | Gate |

## Verdict counts

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven` | 0 | Control fully evidenced end-to-end (incl. live rollback + restore) |
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
| G07 | Rollback / incident runbooks | `partial` (source-partial via 16E) |
| G08 | Retention / privacy | `partial` |
| G09 | Cost controls | `partial` (16B budget-threshold source) |

## Prior slice 16B (still partial)

**ID:** `16B_staging_rg_cost_budget_threshold` on **G09_cost_controls** — budget-threshold source only; not anomaly detection; deploy + notification delivery still open.

## Slice 16E progress

**ID:** `16E_staff_api_aca_traffic_rollback_runbook`

**Gate:** `G07_rollback_incident_runbooks`

**Progress class:** `source_partial_progress_only`

### Still open

1. Live rollback execute on either staging Staff API
2. Live restore (reapply prior traffic weights) proof
3. PHASE-7.4 Postgres restore drill evidence

### Final controlled drill (remaining)

`16E_DRILL_live_rollback_restore` — after approved operator action: capture live revision/traffic inventory; run 16E preflight; with human confirmation set target=100 traffic only; verify health; restore prior weights; prove no image/env/secret/scaling/DB/restart/delete; leave PG restore drill unmet.

## Gates

```bash
npm run verify:radar-slice16a-operations-gate-ledger
npm run verify:radar-slice16b-staging-cost-budgets
npm run verify:radar-slice16e-staff-api-rollback
npm run verify:sunset-staging-iac-secret-scan
npm run verify:migration-integrity
npm run verify:sunset-staging-iac-diff-check
git diff --check acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b..HEAD
```

## Zero-live / zero-runtime proof

16E adds rollback runbook, preflight, fixtures, and verifiers only. It must not change `scripts/staff-query-api.js`, Hermes runtime, `database/`, or staging main Bicep. Live rollback is hard-disabled. No Azure mutating calls in this slice.
