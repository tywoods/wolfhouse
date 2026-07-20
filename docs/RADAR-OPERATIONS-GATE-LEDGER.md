# RADAR Slice 16Q — Operations gate ledger (readiness-failure drill harness source-partial)

**Status:** source partial progress only (harness shipped; **no live apply** in this slice)
**Master basis:** `06b7a3f2173863afa81bfc557cd31cbd3e80d6c1`
**Branch:** `radar/slice-16q-readiness-failure-drill-harness`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”

## Outcome

Ship a **fail-closed operator harness** for a controlled ACA **database-readiness failure** and **exact restoration** (source only). Default mode is dry-run. Live mutation requires explicit `--tenant wolfhouse|sunset` plus `--apply` plus `--confirm` with the exact token `RADAR-16Q-READINESS-FAILURE-DRILL` (library apply also requires exact confirm). Pins staging subscription/account/tenant/resource ID/RG/app/FQDN, env `WOLFHOUSE_DATABASE_URL`, and **exact** image `…:594247f12a823e9b90140c56eb8645b057e1fd37` (not substring). Does **not** claim the live dependency-failure traffic-shed drill is proven.

## Harness contract (locked)

| Item | Value |
|------|-------|
| Azure identity | subscription `6dfa56e7-…`; account `ty@wolfhouse.io`; AAD tenant lock pin; per-tenant resource ID/RG/app/FQDN; `--subscription` on every `az` |
| Tenants | `wolfhouse` → `wh-staging-rg` / `wh-staging-staff-api` / `staff-staging.lunafrontdesk.com`; `sunset` → `luna-sunset-staging-rg` / `luna-sunset-staging-staff-api` / `sunset-staging.lunafrontdesk.com` |
| Database env | `WOLFHOUSE_DATABASE_URL` (secretRef only at baseline) |
| Image pin | **exact** full image string (SHA `594247f12a823e9b…`); substring match refused |
| Failure inject | change **only** that env from secretRef → unreachable non-secret PostgreSQL DSN |
| Mutation | every update marks **mutation-attempted before spawn**; cancellable async subprocess + hard timeout |
| Capture | complete `properties.template` + ingress traffic revision/label/weight → temp **outside** repo; pre-revision name set |
| Trap | abort on signal; block further forward mutation; await restoration before exit |
| Observe | set-difference new revision only; revision-show + replica-list with explicit fields (no defaults); continuous traffic + `/healthz`/`/readyz` poll |
| Restore | unconditional `finally` after any mutation attempt; bounded retries; traffic restore if drifted; clear restoration-required only after exact template/traffic/image/secretRef/endpoint verify |
| Secrets / errors | never read/print secret values; evidence/errors allowlisted categories only |

## Artifacts

| Path | Role |
|------|------|
| `scripts/lib/radar-slice16q-readiness-failure-drill-harness.js` | Locks + pure helpers + orchestrator |
| `scripts/radar-slice16q-readiness-failure-drill.js` | Operator CLI (default dry-run) |
| `scripts/verify-radar-slice16q-readiness-failure-drill-harness.js` | Offline RED/GREEN |
| `fixtures/radar-operations/slice16q-expected-contract.json` | Independent contract |
| `npm run verify:radar-slice16q-readiness-failure-drill-harness` | Gate |

## Verdict counts

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven` | 0 | Control fully evidenced end-to-end (incl. full drills) — **none** |
| `partial` | 9 | Some code and/or live evidence; gaps remain |
| `absent` | 0 | No safe control evidenced |
| **total** | **9** | Matrix gates |

## Matrix (summary)

| ID | Gate | Verdict / progress |
|----|------|-------------------|
| G01 | Correlation / structured logs | `partial` / source_partial (completion logging open) |
| G02 | Readiness / dependencies | `partial` / **partial_live_proven** healthy path (16P) + **16Q harness source-partial**; live failure drill open |
| G03 | Actionable tenant-aware alerts | `partial` / **partial_live_proven** (AG test API only) |
| G04 | Webhook / payment / worker backlog | `partial` |
| G05 | Retry / replay safety | `partial` / source_partial (16M event-id claim / stripe_event_id; real-PG open) |
| G06 | Scaling / capacity | `partial` / source_partial (16L capacity-pressure CpuPercentage/MemoryPercentage; organic fire open) |
| G07 | Rollback / incident runbooks | `partial` / **partial_live_proven** (revision rollback/rollforward) |
| G08 | Retention / privacy | `partial` / **partial_live_proven** (deploy + malformed/missing/oversize) |
| G09 | Cost controls | `partial` / **partial_live_proven** (AG test API only; anomaly absent) |

## Explicitly not claimed

- Live `--apply` execution of the readiness-failure drill
- Live dependency-failure traffic-shed
- Production
- Secret values
- human inbox receipt
- organic metric alert firing
- abrupt paths / retention/search
- real-PG contention
- completion logging

## Slice 16Q progress

**ID:** `16Q_readiness_failure_drill_harness`
**Primary gate:** `G02_readiness_dependencies`
**Progress class:** `source_partial_progress_only`
**Does not implement:** live apply / dependency-failure traffic-shed proven

### Still open

- Approved live `--apply` on Wolfhouse staging
- Approved live `--apply` on Sunset staging
- closeReadinessPool lifecycle integration
- Any `proven` gate verdict

## Prior partial progress retained

- **16O** `16O_stripe_webhook_error_minimization` — live deploy + partial privacy via 16P
- **16M** `16M_stripe_webhook_event_id_claim` — source-partial
- **16L** `16L_staff_api_capacity_pressure_alerts` — source-partial
- **16K** `16K_staff_api_healthz_minimization` — health observed via 16P
- **16J** `16J_staff_api_request_correlation` — source-partial
- **16I** `16I_staff_api_readiness_dependencies` — healthy path via 16P; failure drill harness via 16Q (not executed)
- **16H** `16H_staff_api_metric_alerts` — AG test API via 16P
- **16B** `16B_staging_rg_cost_budget_threshold` — AG test API via 16P; anomaly absent
- **16P** `16P_live_drill_evidence_reconciliation` — partial/live-proven evidence only

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16Q. Database, Hermes staging, Staff API runtime, readiness lib, and staging Bicep must remain unchanged vs master basis `06b7a3f`.
