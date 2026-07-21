# RADAR Slice 16AE — Operations gate ledger (G01 central capability boundary freeze)

**Status:** audit-only capability-boundary freeze (zero runtime change / live calls; G01 remains partial; 16AD G02 evidence retained)
**Master basis:** `0a2fb08486b835dd45a4fc904e3dd152702bea6f`
**Branch:** `radar/slice-16ae-g01-capability-boundary-freeze`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Builds on:** 16U correlation design freeze + 16S live completion evidence + 16J/16R; tip after 16AD sampled continuity
**This slice does not deploy:** no Azure/Hermes/Staff runtime mutation; no dry-run activation

## Outcome (16AE)

Freeze the **central capability boundary** required by 16U before any G01-A dry-run can exist (16U candidate label was `16V_candidate_central_capability_boundary_audit_freeze`; sequenced here as **16AE**):

- One fail-closed decision point: `decideCapability`
- **Permit** genuine read dispatch
- **Deny** every WhatsApp send and every Staff/DB/Stripe mutation
- Decision must occur **before** Meta Graph / Staff HTTP / DB pool / Stripe SDK / queue / session-store acquisition
- Inventory lookup by adapter ID; exact allowed-tenant **and** allowed-location binding; effect/class from pinned entry (caller spoof ignored); non-empty canonical `turn_id`; one immutable frozen per-turn **boundary object** binding **tenant+location+adapter** (rejects missing/mismatched repeated context)
- Unknown, missing, cross-tenant, cross-location, missing-turn, bypass, context-tamper, or cross-decision drift paths **deny**

**Identity rule** `ADAPTER_IDENTITY_REGISTERED_TOOL_ROUTE_OR_UNIQUE_EXTERNAL_ACQUISITION`: one adapter per registered active Hermes tool primary staff route **or** unique external acquisition site; producer/path duplicates that converge before acquisition collapse. Completeness = **source_derived_exact_set_comparison** (independently enumerate capability IDs from actual registrations + acquisition sites, then bidirectional exact-set equality vs a **separate frozen specification** — not a self-reported `complete` flag and not circular expected-set constants).

Source-derived exact-set inventory (active Hermes guest turns, Wolfhouse + Sunset):

| Class | Count |
|-------|------:|
| WhatsApp send | 4 |
| Staff/DB/Stripe mutation | 21 |
| Read dispatch (permitted) | 18 |
| **Total** | **43** |

Includes previously omitted Sunset reads (`full-day-addon`, `private-lesson`, `joinable-courses`) and pause-gate automation check; classifies Sunset write-on-read tools (`payment-status` reconcile, `waiver-link` ensure) as mutations; removes unreachable `booking-dry-run`; collapses Graph/provider producer duplicates.

**16U provenance retained:** live Caddy `/whatsapp/*`→`:8092` (`hermes-sunset-luna`), `/wolfhouse/*`→`:8090` (`hermes-luna`); tracked Caddy **stale** evidence, not authority; single-message `wamid` / coalesced ordered immutable **source-wamid** set (no invented parent); G01-A=`meta_hermes_staff_correlated_read_path`; G01-B=`tenant/payment/booking/session` metadata only (no inbound trace/wamid); genuine Stripe Checkout **cannot be exercised without mutation**; Hermes still omits `X-Request-Id`; independent same-ID probes are not E2E.

**Dry-run** (`G01_CORRELATION_DRY_RUN`, phrase `RADAR-16U-CORRELATION-DRY-RUN`) remains **not implementable yet** and **not activatable** — audit boundary is frozen; runtime apply of `decideCapability` is still required (**16AF**). **This slice does not implement runtime, execute live, deploy, or add trace headers.** G01 verdict stays `partial`. G02–G09 unchanged (16AD G02 sampled continuity retained). Proven count remains 0.

## Artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16ae-adapter-inventory.json` | Source-derived send/mutation/read inventory |
| `fixtures/radar-operations/slice16ae-frozen-capability-ids.json` | Separate frozen capability-ID specification |
| `fixtures/radar-operations/slice16ae-capability-boundary-freeze.json` | Boundary + later owner freeze |
| `fixtures/radar-operations/slice16ae-expected-contract.json` | Frozen 16AE contract |
| `scripts/lib/radar-slice16ae-g01-capability-boundary-freeze.js` | Locks + decideCapability classifiers |
| `scripts/verify-radar-slice16ae-g01-capability-boundary-freeze.js` | Offline RED/GREEN verifier |
| `npm run verify:radar-slice16ae-g01-capability-boundary-freeze` | Gate |

## Later implementation owner (not created in 16AE; separate from deploy/evidence)

| Role | Module | Symbol | Tests |
|------|--------|--------|-------|
| Primary (Hermes) | `docker/hermes-staging/wolfhouse/capability_boundary.py` | `decide_capability` | `docker/hermes-staging/wolfhouse/test_capability_boundary.py` |
| Staff defense-in-depth | `scripts/lib/g01-capability-boundary.js` | `decideCapability` | `scripts/verify-g01-capability-boundary.js` |

**Next smallest implementation owner:** `16AF_candidate_capability_boundary_runtime_apply` — wire `decide_capability` / `decideCapability` at the frozen hooks using the pinned inventory; still no deploy/live evidence/trace headers.

## Verdict counts

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven` | 0 | Full E2E close — not met |
| `partial` | 9 | Code and/or live evidence; gaps remain |
| `absent` | 0 | No safe control evidenced |
| **total** | **9** | Matrix gates |

## Matrix (summary)

| ID | Gate | Verdict |
|----|------|---------|
| G01 | Correlation / structured logs | `partial` (16S LAW + **16U provenance** + **16AE boundary freeze**; G01-A live open) |
| G02 | Readiness / dependencies | `partial` (**16AD** sampled restart continuity retained; absolute zero-downtime / cold-start / production open) |
| G03–G09 | (unchanged) | `partial` as prior |

## G01 semantics (truthful)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| Request correlation (header + ALS) | `partial` | 16J source |
| Request-completion log | `partial` | 16R + 16S live LAW |
| Live deploy / LAW delivery/search/retention | `live_proven` | via 16S @ `1bf9695` |
| Correlation drill **design** | `audit_frozen` | 16U retained |
| **Central capability boundary** | `audit_frozen` | 16AE inventory + `decideCapability` shape |
| Capability boundary **runtime** | `not_implemented` | Later owner not wired (16AF) |
| Correlation drill **live G01-A** | `open` | Needs runtime boundary then Hermes `X-Request-Id` |
| Dry-run mode | `not_implementable_yet` / `not_activatable` | Blocked on capability_boundary_runtime_apply |
| G01-B join today | `metadata_only` | 16U truth retained |

## G02 semantics (truthful — retained from 16AD)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| Concurrent sampled restart continuity | `live_proven_16AD` | sampling resolution after WH warmup exclusion |
| Absolute/continuous zero downtime | `open` / `not claimed` | between-sample / sub-second not claimed |
| Cold-start availability | `open` / `not claimed` | WH warmup timeouts remain real |
| Production | `open` / forbidden | intentionally untouched |

## Slice 16AE progress

**ID:** `16AE_g01_capability_boundary_freeze`
**Gate:** `G01_correlation_structured_logs`
**Progress class:** `audit_only_capability_boundary_freeze`
**Does not implement:** runtime `decideCapability` wiring, dry-run switch, trace/`X-Request-Id`, live drill, any gate proven, G02–G09 changes

### Still open (smallest follow-on = 16AF)

1. **16AF:** wire `decide_capability` / `decideCapability` at frozen hooks using the pinned inventory — **no** deploy/evidence/trace
2. After runtime boundary: Hermes mint `trace_id` + send `X-Request-Id` on `_post_bot`
3. Hard-disabled `G01_CORRELATION_DRY_RUN` (phrase `RADAR-16U-CORRELATION-DRY-RUN`)
4. Live G01-A read-only evidence freeze

### Explicitly not claimed

- Runtime capability boundary wired
- Dry-run implementable / activatable today
- Dispersed env checks as sole control
- Post-acquisition denial
- Mutable capability state / context tamper
- Trace / deploy / live evidence
- Live drill executed / any gate `proven`
- Production
- Score inflation on G01–G09


## Overclaim lock (retained)

16P/16AC **do not claim** human inbox receipt, organic metric alert as inbox proof, or end-to-end gate close. Production intentionally untouched.

## Retained slices (not overclaimed)

### 16AD_g02_sampled_restart_continuity_evidence

Concurrent sampled revision-restart continuity — retained under 16AE tip. Sampling-resolution claim after WH warmup exclusion only. G02 stays partial.

### 16AC_organic_restart_alert_evidence

Organic Azure Monitor RestartCount alerts fired/resolved/unsuppressed both staging apps (`actionStatus.isSuppressed=false`); temporally associated with 16AA SIGINT; human inbox / unique-causality / 5xx open. G02/G03 stay partial.

### 16AB_g02_serving_readyz_503_body_path_evidence

Serving-revision `/readyz=503` `{status:not-ready}` on isolated fail revisions; public healthy stayed 200; `observed_at=unavailable_in_command_transcript`. Azure cannot recreate historical localhost 503/body. G02 stays partial.

### 16AA_g02_live_sigint_lifecycle_evidence

Dual-staging live SIGINT drill evidence — retained. Provenance split (A)/(B): operator-observed `az containerapp exec` + `kill -INT 1` + ClusterExecFailure exit 137 (**az containerapp exec transport/process-termination disconnect only** — not an application failure; **not proof of** application/Node process native exit status, shell code, signal encoding, or ACA restart reason) + post-drill `/readyz=200`. Independent Azure/ACR/LAW class B: **Independent LAW allowlisted record — not 137 —** evidences `original_signal=SIGINT` and pool/server cleanup; bounded inclusive drill query windows WH `12:08:00Z→12:09:00Z` / Sunset `12:09:00Z→12:10:00Z`; other revision-lifetime records disclosed (WH SIGTERM `11:16:20.3631884Z` etc.) — revision-lifetime count is not one. Serving `/readyz=503` closed via 16AB; organic restart alerts via 16AC; concurrent sampled continuity via 16AD tip. G02 stays partial.

### 16Z_g02_live_sigterm_lifecycle_evidence

Dual-staging live SIGTERM drill evidence — retained. LAW exactly one allowlisted SIGTERM completion each tenant in declared drill query windows (WH restart `11:15:18Z` window cardinality); post-restart recovery samples were **not** concurrent continuity (closed via 16AD tip). G02 stays partial.

### 16Y_readiness_shutdown_completion_log

Source observability for readiness shutdown completion — retained.

### 16X_g02_lifecycle_deploy_traffic_shed_live_evidence

Dual-staging exact-SHA `2dcda08` deploy + Activating traffic-shed drill — retained with (A)/(B) provenance.

### 16W_readiness_shutdown_lifecycle

Source wiring of `closeReadinessPool` on SIGTERM/SIGINT — retained.

### 16S_request_completion_log_live_evidence

Dual-staging LAW delivery/search/retention @ SHA `1bf9695` — retained. Meta→Hermes E2E still open as G01-A.

### 16U_correlation_design_freeze

Audit-only G01 design freeze — live Caddy `/whatsapp/*` → **8092** (`hermes-sunset-luna`); `/wolfhouse/*` → `:8090` (`hermes-luna`). Tracked Caddy reference is **stale** evidence, not live authority. **G01-A** Meta→Hermes→Staff open. **Independent same-ID probes are not E2E evidence.** Genuine Stripe Checkout **cannot be exercised without mutation**; G01-B is **tenant/payment/booking/session metadata only**. Dry-run phrase **`RADAR-16U-CORRELATION-DRY-RUN`** reserved; **not implementable yet** (blocked on **central capability boundary**). Coalesced burst provenance uses ordered immutable **source-wamid** set.

### 16P_live_drill_evidence_reconciliation (retained)

Bounded operator-observed facts @ image **594247f** — retained. **Does not claim** human inbox / organic metric alert as inbox proof / production / end-to-end gate close.

### 16O / G05 / G06 / G08 (retained partials)

- **16O** — Stripe webhook error minimization (G08 partial).
- **G05** — 16M Stripe webhook event-id claim (source partial; live drill open).
- **G06** — 16L Staff API capacity-pressure alerts (source partial; alert fire open).
- **G08** — 16O/16P webhook error minimization + privacy drill partial; abrupt/retention/search open.

## G02 semantics (truthful after 16AD)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| /readyz + dedicated max-1 pool | `source_partial` | 16I |
| ACA probes | `live_present` | verified on serving revisions |
| Healthy-path live health/ready | `live_proven` | 16P + later |
| closeReadinessPool lifecycle source | `source_closed_16W` | SIGTERM/SIGINT CLI main |
| Shutdown completion log source | `source_closed_16Y` | one JSON record per shutdown |
| Live lifecycle image deploy | `live_proven_16X` / `95dc363 via 16Z/16AA/16AB` | exact SHA both tenants |
| Dependency-failure traffic-shed drill | `live_proven_16X` | Activating never latestReady |
| SIGTERM live cleanup telemetry | `live_proven_16Z` | LAW drill-window cardinality |
| SIGINT live cleanup telemetry | `live_proven_16AA` | LAW drill-window cardinality |
| Serving-revision /readyz=503 path | `live_proven_16AB` | isolated fail local 503 |
| Organic restart metric alert firing | `live_proven_16AC` | fired/resolved/unsuppressed |
| Concurrent sampled restart continuity | `live_proven_16AD` | sampling resolution after WH warmup exclusion |
| Absolute/continuous zero downtime | `open` / `not claimed` | between-sample / sub-second not claimed |
| Cold-start availability | `open` / `not claimed` | WH warmup timeouts remain real |
| Production | `open` / forbidden | intentionally untouched |

## Prior partial progress retained

- **16AD** `16AD_g02_sampled_restart_continuity_evidence` concurrent sampled restart continuity — retained (`partial_live_proven`); absolute zero-downtime / cold-start / production open
- **16AC** organic RestartCount alerts — retained; inbox open
- **16AB** / **16AA** / **16Z** / **16Y** / **16X** / **16W** G02 lifecycle chain — retained
- **16U** `16U_correlation_design_freeze` live Caddy + provenance + G01-A/B honesty — retained (`audit_frozen`); dry-run phrase `RADAR-16U-CORRELATION-DRY-RUN` still reserved and not implementable yet
- **16S** `16S_request_completion_log_live_evidence` dual-staging completion-log delivery/search/retention @ SHA `1bf9695` — retained (`partial_live_proven`)
- **16R** / **16J** correlation + completion source — retained
- **16P** / **16O** G08 webhook error minimization — retained
- **16M** G05 event-id claim / `stripe_event_id` — retained
- **16L** G06 capacity-pressure / CpuPercentage — retained
- **16K** / **16I** / **16H** / **16B** — retained
