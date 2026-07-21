# RADAR Slice 16T — Operations gate ledger (E2E correlation-drill harness)

**Status:** source-partial harness only (zero deploy / live drill by this slice; E2E correlation drill remains open)
**Master basis:** `87121456db90a9f80ff8b3679596bc49c235cbfc`
**Branch:** `radar/slice-16t-e2e-correlation-drill`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Builds on:** 16S `16S_request_completion_log_live_evidence` + 16J/16R correlation + 16O Stripe pre-verify errors

## Outcome

Ship a **staging-only, dry-run-default** Meta → Hermes → Staff API → Stripe **correlation-drill harness** for G01. Trace Wolfhouse and Sunset staging boundaries from synthetic Meta-shaped ingress through Hermes, Staff API, and Stripe test-mode using existing staging test endpoints and request-correlation mechanisms. Harness accepts only `--tenant wolfhouse|sunset`. Live probes require `--apply` plus exact confirmation `RADAR-16T-CORRELATION-DRILL`. Hard-locks staging hosts, tenant, phone/runtime binding, Staff API app, Stripe test mode, subscription, and current master/image SHA `87121456`. Generates one correlation ID and evaluates bounded redacted hop evidence for same-ID propagation; fail-closes if any boundary cannot preserve the ID without a guest/payment mutation. **Do not execute the live drill in this slice.** G01 retains `partial_live_proven` (via 16S) with harness progress `source_partial`; live E2E drill remains open. G02–G09 scores unchanged. Matrix proven-count remains 0. Prior G05 event-id claim (16M) and G06 capacity-pressure alerts (16L) source-partial progress retained.

## Artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16t-boundary-map.json` | Traced Wolfhouse+Sunset boundary map |
| `fixtures/radar-operations/slice16t-expected-contract.json` | Frozen 16T contract |
| `scripts/lib/radar-slice16t-e2e-correlation-drill.js` | Slice locks + dry-run/apply/evidence core |
| `scripts/run-radar-slice16t-e2e-correlation-drill.js` | CLI harness (dry-run default) |
| `scripts/verify-radar-slice16t-e2e-correlation-drill.js` | Offline RED/GREEN verifier |
| `npm run verify:radar-slice16t-e2e-correlation-drill` | Gate |
| `npm run run:radar-slice16t-e2e-correlation-drill` | Dry-run / gated apply runner |

## Verdict counts

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven` | 0 | Control fully evidenced end-to-end (incl. live E2E drill) — not met |
| `partial` | 9 | Some code and/or live evidence; gaps remain |
| `absent` | 0 | No safe control evidenced |
| **total** | **9** | Matrix gates |

## Matrix (summary)

| ID | Gate | Verdict |
|----|------|---------|
| G01 | Correlation / structured logs | `partial` (`partial_live_proven` via 16S; **16T harness source-partial**; live E2E drill open) |
| G02 | Readiness / dependencies | `partial` (16I + 16P healthy path) |
| G03 | Actionable tenant-aware alerts | `partial` (16H + 16P AG test) |
| G04 | Webhook / payment / worker backlog | `partial` |
| G05 | Retry / replay safety | `partial` (16M source still partial) |
| G06 | Scaling / capacity | `partial` (16L source still partial) |
| G07 | Rollback / incident runbooks | `partial` (16P rollforward) |
| G08 | Retention / privacy | `partial` (16K/16O + 16P) |
| G09 | Cost controls | `partial` (16B + 16P AG test) |

## G01 semantics (truthful)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| Request correlation (header + ALS) | `partial` | 16J source |
| Request-completion log (source) | `partial` | 16R finish/close/error exactly-once |
| Live deploy (exact SHA) | `live_proven` | WH `0000517` / Sunset `0000277` @ `1bf9695` (16S) |
| Azure stdout / LAW delivery | `live_proven` | `ContainerAppConsoleLogs_CL` (16S) |
| Searchable query | `live_proven` | by supplied request ID; match_count=1 (16S) |
| Retention policy | `live_proven` | LAW retention 30 both workspaces (16S) |
| E2E correlation-drill harness | `source_partial` | 16T dry-run-default CLI + fail-closed evidence evaluator |
| Controlled E2E correlation drill (live) | `open` | Meta → Hermes → Staff → Stripe **not executed / not claimed** |

## Slice 16T progress

**ID:** `16T_e2e_correlation_drill_harness`
**Gate:** `G01_correlation_structured_logs`
**Progress class:** `source_partial_progress_only`
**Confirmation (live only):** `RADAR-16T-CORRELATION-DRILL`
**Does not implement:** live drill execution, evidence freeze of live hops, Hermes→Staff bot X-Request-Id forward, any gate verdict=proven, G02–G09 score changes, deploy by this slice

### Still open (explicit remaining item before a full G01 close)

- End-to-end Meta → Hermes → Staff API → Stripe correlation drill (**live**):  
  `node scripts/run-radar-slice16t-e2e-correlation-drill.js --tenant wolfhouse|sunset --apply --confirm RADAR-16T-CORRELATION-DRILL`  
  then freeze bounded redacted evidence (follow-on slice)

### Explicitly not claimed

- Live drill executed or proven
- Concurrent isolation proof in LAW
- Abort/error completion outcomes searchable in LAW
- Human inbox receipt / organic metric alert firing / production
- Raising any gate verdict to `proven`

## Prior partial progress retained

- **16S** `16S_request_completion_log_live_evidence` dual-staging completion-log delivery/search/retention @ SHA `1bf9695` — retained
- **16R** source completion logging — retained
- **16P** live-drill evidence reconciliation — retained
- **16O** Stripe webhook error minimization — retained
- **16M** G05 event-id claim — source-partial retained
- **16L** G06 capacity-pressure alerts — source-partial retained
- **16K** / **16J** / **16I** / **16H** / **16B** — prior partials retained

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16T. No live drill execution. Database, Hermes staging/sunset, Staff API runtime, correlation/completion helpers, staging Bicep, and metric-alert/budget modules must remain unchanged vs master basis `87121456`. Harness + ledger/matrix/findings/contract only.
