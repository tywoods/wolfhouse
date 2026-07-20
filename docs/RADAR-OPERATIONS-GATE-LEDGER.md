# RADAR Slice 16S — Operations gate ledger (request-completion delivery/search/retention evidence)

**Status:** partial/live-proven evidence only (zero deploy / live mutation by this slice; E2E correlation drill remains open)
**Master basis:** `1bf9695264250680c41c3e7f82baba97300001a0`
**Branch:** `radar/slice-16s-request-log-live-evidence`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Builds on:** 16R `16R_staff_api_request_completion_log` + 16J correlation

## Outcome

Record **operator-observed dual-staging 16R delivery / search / retention evidence** into a redacted, lock-hashed fixture. Exact Staff API image SHA `1bf9695264250680c41c3e7f82baba97300001a0` on Wolfhouse revision `wh-staging-staff-api--0000517` and Sunset revision `luna-sunset-staging-staff-api--0000277` (latest=latestReady; public `/healthz` 200). ACA env `logsDestination=log-analytics`. LAW workspaces `wh-staging-logs` (customerId `43ae26dd-4a82-4a91-b744-5e1f94a2ae8f`, retention 30) and `luna-sunset-staging-logs` (customerId `552489bf-8e57-48df-8413-6e775caaa7d0`, retention 30). Independently queried `ContainerAppConsoleLogs_CL` by supplied request IDs yields exactly one bounded `staff_api_request_completion` each (`route=/healthz`, `status_code=200`, `status_class=2xx`, `duration_ms=5`, `outcome=completed`) at `2026-07-20T23:32:38.0049767Z` (WH `aaaaaaaa-bbbb-4ccc-8ddd-16a000000001`) and `2026-07-20T23:32:54.8551295Z` (Sunset `aaaaaaaa-bbbb-4ccc-8ddd-16a000000002`, tenant `sunset`). **Do not deploy.** G01 upgrades to `partial_live_proven` but remains verdict `partial` because the end-to-end Meta → Hermes → Staff API → Stripe correlation drill is still open. G02–G09 scores unchanged. Matrix proven-count remains 0.

## Artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16s-request-log-live-evidence.json` | Redacted canonical evidence + lock_hash |
| `fixtures/radar-operations/slice16s-expected-contract.json` | Frozen 16S contract |
| `scripts/lib/radar-slice16s-request-log-live-evidence.js` | Slice locks |
| `scripts/verify-radar-slice16s-request-log-live-evidence.js` | Offline RED/GREEN verifier |
| `npm run verify:radar-slice16s-request-log-live-evidence` | Gate |

## Verdict counts

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven` | 0 | Control fully evidenced end-to-end (incl. E2E drill) — not met |
| `partial` | 9 | Some code and/or live evidence; gaps remain |
| `absent` | 0 | No safe control evidenced |
| **total** | **9** | Matrix gates |

## Matrix (summary)

| ID | Gate | Verdict |
|----|------|---------|
| G01 | Correlation / structured logs | `partial` (`partial_live_proven` via 16S; E2E drill open) |
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
| Live deploy (exact SHA) | `live_proven` | WH `0000517` / Sunset `0000277` @ `1bf9695` |
| Azure stdout / LAW delivery | `live_proven` | `ContainerAppConsoleLogs_CL` |
| Searchable query | `live_proven` | by supplied request ID; match_count=1 |
| Retention policy | `live_proven` | LAW retention 30 both workspaces |
| Controlled E2E correlation drill | `open` | Meta → Hermes → Staff → Stripe **not claimed** |

## Slice 16S progress

**ID:** `16S_request_completion_log_live_evidence`
**Gate:** `G01_correlation_structured_logs`
**Progress class:** `partial_live_proven_evidence_only`
**Does not implement:** E2E Meta→Hermes→Staff→Stripe drill, concurrent isolation, abort/error LAW outcomes, any gate verdict=proven, G02–G09 score changes, deploy by this slice

### Still open (explicit remaining item before a full G01 close)

- End-to-end Meta → Hermes → Staff API → Stripe correlation drill

### Explicitly not claimed

- Concurrent isolation proof in LAW
- Abort/error completion outcomes searchable in LAW
- Human inbox receipt / organic metric alert firing / production
- Raising any gate verdict to `proven`

## Prior partial progress retained

- **16R** source completion logging (schema/emission) — retained; live follow-on is 16S
- **16P** live-drill evidence reconciliation — partial/live-proven on selected gates
- **16O** `16O_stripe_webhook_error_minimization` on G08 — webhook error body minimization retained
- **16M** `16M_stripe_webhook_event_id_claim` on G05 — source-partial event-id claim retained
- **16L** `16L_staff_api_capacity_pressure_alerts` on G06 — source-partial capacity-pressure alerts retained
- **16K** `16K_staff_api_healthz_minimization` on G08
- **16J** `16J_staff_api_request_correlation` on G01 — source-partial correlation
- **16I** / **16H** / **16B** — prior partials retained

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16S. Database, Hermes staging, Staff API runtime, completion-log helper, staging Bicep, and metric-alert/budget modules must remain unchanged vs master basis `1bf9695`. Evidence fixtures + ledger/matrix only.
