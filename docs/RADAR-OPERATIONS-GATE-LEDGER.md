# RADAR Slice 16N — Operations gate ledger (Staff API request completion log source-partial)

**Status:** source partial progress only (zero live deploy / mutation; delivery / search / retention / abrupt-path / drill open)
**Master basis:** `3e94498321cd26e64394984a5926d7a583226692`
**Branch:** `radar/slice-16n-request-completion-log`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Builds on:** 16J `16J_staff_api_request_correlation` (ALS correlation)

## Outcome

Add **safe synchronous normal-completion structured request logs** for Staff API (source only). At the single `createStaffQueryApiHttpServer` boundary: await the existing 16J ALS-wrapped handler and emit exactly one allowlisted JSON record in a `finally` block for normal handler settlement only, using the existing console/process stdout logger. **Do not** attach req/res finish/close/aborted/error listeners, install signals, change exit codes, queue/buffer/flush, or claim capture of abrupt process/socket termination. Existing router catch remains byte-identical. Logger failure is caught and must not alter response/handler rejection or process semantics. **Do not deploy.** G01 remains `partial`.

## Artifacts

| Path | Role |
|------|------|
| `scripts/lib/staff-api-request-completion-log.js` | Allowlisted build/emit/assert helpers |
| `scripts/staff-query-api.js` | createServer await+finally wire |
| `scripts/lib/radar-slice16n-staff-request-completion-log.js` | Slice locks |
| `scripts/verify-radar-slice16n-staff-request-completion-log.js` | Offline RED/GREEN verifier |
| `fixtures/radar-operations/slice16n-expected-contract.json` | Frozen independent contract |
| `npm run verify:radar-slice16n-staff-request-completion-log` | Gate |

## Bounded schema

| Field | Rule |
|-------|------|
| `event` | always `staff_api_request_completed` |
| `request_id` | from ALS (16J) |
| `tenant_slug` | trusted construction binding only (else omit) |
| `method` | allowlisted + uppercased |
| `route` | fail-closed allowlisted static segments only; IDs → `:id`; else `:redacted` or `/:unmatched`; no query/fragment |
| `status_code` | `res.statusCode` bounded integer |
| `duration_ms` | round UP to 5ms; cap 300000 |

## Exclusions (never logged)

URL query, raw URL, headers, body, guest/customer/name/phone/email, auth/cookie/token/key, stack/error text, response body.

## Verdict counts

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven` | 0 | Control fully evidenced end-to-end (incl. live deploy + delivery + drill) |
| `partial` | 9 | Some code and/or live evidence; gaps remain |
| `absent` | 0 | No safe control evidenced |
| **total** | **9** | Matrix gates |

## Matrix (summary)

| ID | Gate | Verdict |
|----|------|---------|
| G01 | Correlation / structured logs | `partial` (16J + 16N source still partial) |
| G02 | Readiness / dependencies | `partial` (16I readiness source still partial) |
| G03 | Actionable tenant-aware alerts | `partial` (16H metric-alert source still partial) |
| G04 | Webhook / payment / worker backlog | `partial` |
| G05 | Retry / replay safety | `partial` (16M event-id claim source-partial; deploy/replay/DLQ open) |
| G06 | Scaling / capacity | `partial` (16L capacity-pressure source still partial) |
| G07 | Rollback / incident runbooks | `partial` |
| G08 | Retention / privacy | `partial` (16K healthz source still partial) |
| G09 | Cost controls | `partial` (16B budget-threshold source still partial) |

## G01 semantics (truthful)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| Request correlation (header + ALS) | `partial` | 16J source |
| Normal-settlement completion log (source) | `partial` | 16N await+finally; allowlisted fields |
| Lifecycle listeners for completion | absent by design | Explicitly not owned |
| Live deploy | `open` | Not claimed |
| Azure stdout / LAW delivery | `open` | Not claimed |
| Searchable query | `open` | Not claimed |
| Retention policy | `open` | Not claimed |
| Abrupt process/socket path coverage | `open` / out of scope | Not claimed |
| Controlled correlation drill | `open` | Not claimed |

## Slice 16N progress

**ID:** `16N_staff_api_request_completion_log`
**Gate:** `G01_correlation_structured_logs`
**Progress class:** `source_partial_progress_only`
**Does not implement:** live deploy, Azure stdout delivery, searchable query, retention, abrupt-path coverage, drill

### Still open

- Live deploy of Staff API image with completion logging
- Azure stdout / LAW / App Insights delivery proof
- Searchable query of completion records
- Retention policy for completion records
- Abrupt process/socket termination path coverage (explicitly out of scope)
- End-to-end Meta → Hermes → Staff API → Stripe correlation drill

## Prior partial progress retained

- **16M** `16M_stripe_webhook_event_id_claim` on G05 — source-partial event-id claim (not deployed)
- **16L** `16L_staff_api_capacity_pressure_alerts` on G06 — source-partial capacity alerts (not deployed)
- **16K** `16K_staff_api_healthz_minimization` on G08 — source-partial healthz (not deployed)
- **16J** `16J_staff_api_request_correlation` on G01 — source-partial correlation (not deployed)
- **16I** `16I_staff_api_readiness_dependencies` on G02 — source-partial readiness (not deployed)
- **16H** `16H_staff_api_metric_alerts` on G03 — source-partial metric alerts (not deployed)
- **16B** `16B_staging_rg_cost_budget_threshold` on G09 — budget-threshold source-partial (not deployed)

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16N. Database, Hermes staging, staging Bicep, and 16H metric-alert module must remain unchanged vs master basis. Staff API completion-log helper + createServer wiring are intentional 16N ownership.
