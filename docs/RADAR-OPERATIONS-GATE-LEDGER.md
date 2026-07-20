# RADAR Slice 16I — Operations gate ledger (Staff API readiness source-partial)

**Status:** source partial progress only (zero live deploy / mutation / failure-drill / lifecycle-integration claim)
**Master basis:** `d922099cc1eec1596ef4c67f265c8b6c5e6bc81e`
**Branch:** `radar/slice-16i-readiness-replacement`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Supersedes:** deferred 16C (`radar/slice-16c-staff-api-readiness` @ `0a2c0ac` — do not merge)

## Outcome

Add **dependency-aware Staff API readiness** (`GET /readyz`) via a dedicated max-1 Postgres pool (public pg 8.21 options only) and declare ACA Startup/Liveness/Readiness probes in Wolfhouse + Sunset staging Bicep. This is **source partial progress only**. It does **not** add a signal/shutdown framework, does **not** deploy, does **not** prove the readiness failure drill, and leaves **lifecycle integration** of `closeReadinessPool` **open**.

## Artifacts

| Path | Role |
|------|------|
| `scripts/lib/staff-api-readiness.js` | Dedicated readiness pool + `/readyz` handler |
| `scripts/staff-query-api.js` | Real router wire (`/readyz` before `/healthz`) |
| `infra/azure/staging/main.bicep` | Wolfhouse ACA probes |
| `infra/azure/sunset-staging/main.bicep` | Sunset ACA probes (drift-gated identical) |
| `scripts/verify-radar-slice16i-staff-api-readiness.js` | Offline RED/GREEN verifier |
| `fixtures/radar-operations/slice16i-expected-contract.json` | Frozen independent contract |
| `fixtures/radar-operations/slice16i-probe-contract.json` | Frozen probe + bounded-pool contract |
| `npm run verify:radar-slice16i-staff-api-readiness` | Gate |

## Verdict counts

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven` | 0 | Control fully evidenced end-to-end (incl. live drill) |
| `partial` | 9 | Some code and/or live evidence; gaps remain |
| `absent` | 0 | No safe control evidenced |
| **total** | **9** | Matrix gates |

## Matrix (summary)

| ID | Gate | Verdict |
|----|------|---------|
| G01 | Correlation / structured logs | `partial` |
| G02 | Readiness / dependencies | `partial` (source-partial via 16I) |
| G03 | Actionable tenant-aware alerts | `partial` (16H metric-alert source still partial) |
| G04 | Webhook / payment / worker backlog | `partial` |
| G05 | Retry / replay safety | `partial` |
| G06 | Scaling / capacity | `partial` |
| G07 | Rollback / incident runbooks | `partial` |
| G08 | Retention / privacy | `partial` |
| G09 | Cost controls | `partial` (16B budget-threshold source still partial) |

## G02 semantics (truthful)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| `/healthz` | unchanged | Static liveness; DB-independent |
| `/readyz` | `partial` | Dedicated max-1 pool; fixed `SELECT 1`; generic 200/503 bodies |
| Pool bounds | locked | `connectionTimeoutMillis=1500`, `statement_timeout=1500`, `query_timeout=2000`; max op bound 3500ms |
| ACA probes (source) | `partial` | Startup+Liveness `/healthz`; Readiness `/readyz`; period 10s > 3500ms bound |
| Signal/shutdown framework | absent (intentional) | Out of scope for 16I |
| `closeReadinessPool` | exposed | Explicit idempotent close; lifecycle integration **open** |
| Live deploy | `open` | Not claimed |
| Failure drill | `open` | `16I_DRILL_readiness_failure_traffic_shed` |

## Bounded pool / probe contract

- **Pool:** `max: 1`; public pg 8.21 options only; no `Promise.race`, `AbortController`, private fields, custom cancellation, or application-pool use.
- **Success:** `release()` healthy; **error:** `release(err)` once (destroy path).
- **Probe interval:** readiness `periodSeconds: 10` (10000ms) **exceeds** max operation bound (3500ms) so repeated probes cannot accumulate.

## Slice 16I progress

**ID:** `16I_staff_api_readiness_dependencies`
**Gate:** `G02_readiness_dependencies`
**Progress class:** `source_partial_progress_only`
**Does not implement:** live deploy, failure drill, signal/shutdown framework, closePgPool composition

### Still open

- Live deploy of Staff API image + ACA probe template
- Controlled readiness failure drill (traffic shed without restart loops)
- Live probe inventory no longer empty/null
- Lifecycle integration of `closeReadinessPool`

## Prior partial progress retained

- **16H** `16H_staff_api_metric_alerts` on G03 — source-partial metric alerts (not deployed)
- **16B** `16B_staging_rg_cost_budget_threshold` on G09 — budget-threshold source-partial (not deployed)

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16I. Database and Hermes staging sources must remain unchanged vs master basis. Staff API + staging Bicep probe wiring are intentional 16I ownership.
