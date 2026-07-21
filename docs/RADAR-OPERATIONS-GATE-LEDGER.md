# RADAR Slice 16AH — Operations gate ledger (G06 pinnedLookup live-load correction)

**Status:** source-only (no live network / deploy / scale mutation by this tip; G06 remains partial)
**Master basis:** `6c24e9456bd42c7fa1b051bb1308aae8f632b293`
**Branch:** `radar/slice-16ah-g06-live-load-correction`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Builds on:** 16AG bounded load harness source + 16AF capacity-alert live deploy + 16L capacity-pressure source
**This slice does not deploy / does not hit staging:** offline production-shaped RED/GREEN only; prior live attempt recorded as `attempted_not_proof`

## Outcome (16AH)

Correct the G06 bounded load harness so `pinnedLookup` honors Node’s `dns.lookup` callback contract when `options.all===true` (Happy Eyeballs / `autoSelectFamily`):

| Contract | Behavior |
|----------|----------|
| `all=true` | `callback(err, addresses[])` with validated pinned `{address,family}` entries |
| `all=false` | scalar `callback(err, address, family)` retained |
| family filter | exact pins only; miss → `RADAR_LOAD_DNS_PIN_MISS` |
| diagnostics | safe error-code classes only (no messages/hosts/bodies) |

Offline production-shaped RED proves scalar replies under `all=true` fail **before HTTP** with `ERR_INVALID_IP_ADDRESS`. GREEN proves the corrected array contract reaches local fake HTTP.

### Post-16AG live attempt (cautious)

A controlled attempt of profile `16AG_DRILL_dual_staging_readyz_bounded_load` against both exact staging `/readyz` allowlist targets yielded **60/60 error-before-HTTP** while direct pre/post `/readyz` stayed ready. Root-cause class: `pinned_lookup_scalar_under_options_all_true`. Status locked as **`attempted_not_proof`** — **not** load/soak success.

### Claim ownership (16AH locked)

| Observation | Proves | Does not prove |
|-------------|--------|----------------|
| pinnedLookup `all=true` array contract + offline RED/GREEN | Happy Eyeballs callback bug corrected in source | Live staging load/soak success |
| Live attempt `attempted_not_proof` | Cautious record of failed pre-HTTP attempt | Load success; raising G06 verdict |
| G06 stays partial | Score preserved (proven=0 / partial=9 / absent=0) | Raising G06 to `proven` |

## Truthful disposition (16AH)

**Proves (source):** Corrected `pinnedLookup` Node callback contract for `all=true` with offline production-shaped proof; safe error-code class aggregation; prior live attempt classified `attempted_not_proof`.

**Does not prove:** live load/soak success; capacity alert firing/notification; autoscaling; capacity SLO/error budget; backpressure; production; raising G06 to `proven`.

**Pinned-lookup source gap closed; live load/soak success remains open; G06 remains partial.**

## Outcome (16AG — retained)

Land a dependency-free bounded Node load harness for G06 hard-locked to the two exact staging Staff API `/readyz` URLs:

| Target | Role |
|--------|------|
| `https://staff-staging.lunafrontdesk.com/readyz` | Wolfhouse staging readiness |
| `https://sunset-staging.lunafrontdesk.com/readyz` | Sunset staging readiness |

Contract: GET only; no headers/body/auth; no redirects; TLS required; fail-closed on any other target; max duration/concurrency/request budget; **harness-owned absolute run deadline + per-request deadline** (deadline starts before DNS; DNS raced/aborted against remaining budget so missing/late callbacks settle with no request start; abort/destroy actives; settle end/aborted/error/premature-close/trickle); **unexported fixed HTTPS transport** (no caller transport escape); **fail-closed globally-routable DNS pin** (exact pinned address; IANA special-purpose IPv4/IPv6 prefix tables with explicit `globallyReachable` flags + longest-match; permit only globally reachable classifications / ordinary public unicast; rejects multicast and non-global specials including 192.88.99.0/24, 2001:2::/48, 2001:10::/28 while allowing globally reachable 192.0.0.9/32, 192.0.0.10/32, 2001:20::/28); **monotonic internal latency** (transport latency ignored); aggregate counts + p50/p95/p99/max + timeout/error/status classes; **no response bodies**.

Offline fail-closed (http/https/net/DNS sealed) RED/GREEN verifier covers bounds, concurrency, redirects, target escape, latency percentiles, non-2xx, hanging/trickle/abort/close settle, deadline cleanup, DNS private/IANA-special-purpose table-driven reject/allow, hanging/late DNS settle, header/body/auth not sent, and transport escape.

Conservative future drill profile `16AG_DRILL_dual_staging_readyz_bounded_load` is **defined_not_executed** (concurrency=2, max_duration_ms=30000, max_requests=60, request_timeout_ms=4000).

### Claim ownership (16AG locked)

| Observation | Proves | Does not prove |
|-------------|--------|----------------|
| Harness source + offline verifier | Bounded allowlisted `/readyz` load tooling exists with fail-closed escapes | Live staging load/soak execution |
| Future drill profile locked | Conservative parameters ready for a later approved drill | That drill ran; SLO; backpressure; autoscaling |
| G06 stays partial | Score preserved (proven=0 / partial=9 / absent=0) | Raising G06 to `proven` |

## Truthful disposition (16AG)

**Proves (source):** Dependency-free bounded `/readyz` load harness hard-locked to the two staging URLs with offline fake-server accounting proof; future drill profile defined.

**Does not prove:** live load/soak; capacity alert firing/notification; autoscaling; capacity SLO/error budget; backpressure; production; raising G06 to `proven`.

**Load-harness source gap closed; live load/soak remains open; G06 remains partial.**

## Outcome (16AF — retained)

Reconcile live dual-staging readback of the four deployed Staff API capacity-pressure metric alerts and current scale truth @ `2026-07-21T14:30:07Z`:

| Tenant | Alerts (Enabled Sev2) | Criterion | Scale truth |
|--------|----------------------|-----------|-------------|
| Wolfhouse `wh-staging-staff-api` | `wolfhouse-staff-api-cpu-pressure` (CpuPercentage) + `wolfhouse-staff-api-memory-pressure` (MemoryPercentage) | Average >80; PT5M eval / PT15M window; scoped to app; AG `wh-staging-ops-budget-ag` | minReplicas=0 maxReplicas=1 rules=null; latest=latestReady `wh-staging-staff-api--g02503r`; Single / 100% |
| Sunset `luna-sunset-staging-staff-api` | `sunset-staff-api-cpu-pressure` + `sunset-staff-api-memory-pressure` | same | minReplicas=1 maxReplicas=1 rules=null; latest=latestReady `luna-sunset-staging-staff-api--g02503r`; Single / 100% |

Action groups enabled; receiver name `ops-email` status Enabled; **address intentionally not recorded**; notification/inbox delivery **unproven**.

### Claim ownership (16AF locked)

| Observation | Proves | Does not prove |
|-------------|--------|----------------|
| Four capacity alerts Enabled with exact metric/threshold/window/scope/AG | Alert **deployment** gap closed | Alert firing; notification delivery; human inbox |
| Scale truth min/max/rules null + latest=latestReady g02503r | Current bounds/revision identity | Autoscaling; load-driven scale-out; replica mutation by this slice |
| G06 stays partial | Score preserved (proven=0 / partial=9 / absent=0) | Raising G06 to `proven`; load/soak; SLO/error budget; backpressure; production |

## Truthful disposition (16AF)

**Proves (live):** Four capacity-pressure alerts deployed Enabled Sev2 Average >80 PT5M/PT15M on exact Staff API app scopes wired to tenant ops AGs; current scale truth WH min0/max1/rules null and Sunset min1/max1/rules null with latest=latestReady g02503r.

**Does not prove:** capacity alert firing/notification; load/soak; autoscaling; capacity SLO/error budget; backpressure; production; raising G06 to `proven`.

**Alert-deployment gap closed; G06 remains partial** (firing/notification, load/soak, autoscaling, SLO/error budget, backpressure open).

## Outcome (16AD — retained)

Reconcile the completed dual-staging **concurrent sampled revision-restart continuity drill** with mandatory provenance split:

| Class | Source | Covers |
|-------|--------|--------|
| **A** | Operator drill transcript (contemporaneous) | Bounded sequential public `/healthz` + `/readyz` poller (max-time 4s, ~1s cadence) during `az containerapp revision restart`. **WH** samples `0..90` @ `13:21:11Z–13:23:17Z`; samples `0..2` **timeout** during initial scale-from-zero warmup **before restart** — **disclosed and excluded** from the restart-window claim; samples `3..90` all health=200 ready=200; restart command window exact `13:21:47Z–13:21:50Z`; samples `8@47`, `9@48`, `10@49`, `11@50` all both 200. **Sunset** samples `0..90` @ `13:23:39Z–13:25:18Z` all both 200; restart `13:23:54Z–13:23:58Z`; samples `14@54`, `15@56`, `16@57`, `17@58` all both 200 |
| **B** | Independently reverified Azure/LAW/public @ `2026-07-21T13:29:32Z` | LAW SIGTERM completions: WH `13:22:29.3669823Z` revision `wh-staging-staff-api--g02503r` replica `…-9764596b8-mgfw2`; Sunset `13:24:29.7970752Z` revision `luna-sunset-staging-staff-api--g02503r` replica `…-f4d4b7875-dw7cx`; allowlisted payload `original_signal=SIGTERM` pool/server ok `failure_classes=[]` `completion=true`. Both apps **Single / latest / latestReady / 100%**; digests on image SHA `95dc363`; public-current healthz/readyz **200** |

### Claim ownership (16AD locked)

| Observation | Proves | Does not prove |
|-------------|--------|----------------|
| Concurrent poll during restart (after WH warmup exclusion) | No observed public interruption **at this sampling resolution** during declared restart command windows after warmup | Absolute/continuous zero downtime; between-sample proof; no sub-second interruption; cold-start availability; all 91 WH passed; production; raising G02 to proven |
| WH warmup timeouts 0..2 | Disclosed + excluded; cold-start remains real | Restart-window failure; hidden failures |
| LAW SIGTERM + current Azure | Exact timestamps/replicas/payload; Single/latest/latestReady/100%; public current 200 | Historical poll arrays; absolute zero downtime |

## Truthful disposition (16AD)

**Proves (live):** No observed public `/healthz`+`/readyz` interruption at the declared sampling resolution during the declared restart command windows on both staging tenants **after** WH warmup exclusion, with exact LAW SIGTERM cleanup telemetry and final Single/latest/latestReady/100%.

**Does not prove:** absolute/continuous zero downtime; proof between samples; absence of sub-second interruption; cold-start availability (WH warmup timeouts remain real); production; raising G02 to `proven`.

**Concurrent sampled restart continuity gap closed; G02 remains partial** (production intentionally untouched / acceptance policy).

## Outcome (16AC — retained)

Organic Azure Monitor RestartCount alerts fired/resolved/unsuppressed both staging apps; temporally associated with 16AA SIGINT; inbox/unique-causality/5xx open. G02/G03 stay partial.

## Outcome (16AB — retained)

Serving-revision `/readyz=503` `{status:not-ready}` on isolated fail revisions; public healthy stayed 200; `observed_at=unavailable_in_command_transcript`. Azure cannot recreate historical localhost 503/body. G02 stays partial.

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
| G01 | Correlation / structured logs | `partial` (16S live + 16U design freeze; G01-A live open) |
| G02 | Readiness / dependencies | `partial` (**16AD** sampled restart continuity; **16AC** organic restart alerts; **16AB** serving `/readyz=503`; **16AA** SIGINT; **16Z** SIGTERM; **16X** traffic-shed; absolute zero-downtime / cold-start / production still open) |
| G03 | Actionable tenant-aware alerts | `partial` (**16AC** organic restart fire/resolve + **16P** AG test API; human inbox still open) |
| G04–G09 | (unchanged) | `partial` as prior |

## Retained slices (not overclaimed)


### 16AG_g06_bounded_load_harness

Bounded staging `/readyz` load harness — **this tip**. Closes only G06 load-harness **source** gap. Live load/soak execution, alert fire/notification, autoscaling, SLO/error budget, backpressure remain open. Future drill defined_not_executed. G06 stays partial.

### 16AF_g06_capacity_alert_live_evidence

Capacity-alert deploy + scale-truth evidence — retained under 16AG tip. Closes only G06 alert-deployment gap. Firing/notification, load/soak, autoscaling, SLO/error budget, backpressure remain open. G06 stays partial.

### 16AD_g02_sampled_restart_continuity_evidence

Concurrent sampled revision-restart continuity — retained under 16AF tip. Sampling-resolution claim after WH warmup exclusion only. G02 stays partial.

### 16AC_organic_restart_alert_evidence

Organic restart alert evidence — retained. Inbox open. G02/G03 stay partial.

### 16AB_g02_serving_readyz_503_body_path_evidence

Serving-revision `/readyz=503` body-path — retained.

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
- **G06** — **16AH** corrects pinnedLookup Happy Eyeballs `all=true` contract and records prior live attempt as `attempted_not_proof`; **16AG** source-closes bounded load harness; **16AF** live-proves capacity-alert deploy; **16L** source retained; live load/soak success, alert fire/notification, autoscaling, SLO/backpressure open (G06 remains partial).
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

## Slice 16AD artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16ad-g02-sampled-restart-continuity-evidence.json` | Locked evidence + lock_hash |
| `fixtures/radar-operations/slice16ad-expected-contract.json` | Contract |
| `scripts/lib/radar-slice16ad-g02-sampled-restart-continuity-evidence.js` | Locks |
| `scripts/verify-radar-slice16ad-g02-sampled-restart-continuity-evidence.js` | Strict RED/GREEN verifier |


## G06 semantics (truthful after 16AH)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| Capacity-pressure alert IaC (16L) | `source_closed_16L` | CpuPercentage + MemoryPercentage Average >80 |
| Capacity-pressure alert live deploy | `live_proven_16AF` | four alerts Enabled Sev2 PT5M/PT15M exact scopes/AGs |
| Current scale truth | `live_recorded_16AF` | WH min0/max1/rules null; Sunset min1/max1/rules null; g02503r |
| Bounded `/readyz` load harness | `source_closed_16AG` | hard-locked two staging URLs; offline fake-server verifier |
| pinnedLookup Happy Eyeballs `all=true` | `source_corrected_16AH` | validated pinned address array callback contract |
| Future load drill profile | `defined_not_executed_16AG` | conservative concurrency/duration/request budget |
| Post-16AG live load attempt | `attempted_not_proof_16AH` | 60/60 error-before-HTTP; direct `/readyz` stayed ready; not load success |
| Alert fire / notification delivery | `open` / `not claimed` | |
| Live load / soak success proof | `open` / `not claimed` | prior attempt `attempted_not_proof` only |
| Autoscaling | `open` / `not claimed` | rules=null |
| Capacity SLO / error budget | `open` / `not claimed` | |
| Backpressure | `open` / `not claimed` | |
| Production | `open` / forbidden | intentionally untouched |

## Slice 16AH artifacts

| Path | Role |
|------|------|
| `scripts/lib/radar-g06-bounded-load-harness.js` | Harness + pinnedLookup correction + safe error-code classes |
| `scripts/lib/radar-slice16ah-g06-live-load-correction.js` | Locks |
| `scripts/verify-radar-slice16ah-g06-live-load-correction.js` | Offline production-shaped RED/GREEN verifier |
| `fixtures/radar-operations/slice16ah-expected-contract.json` | Contract |

## Slice 16AG artifacts

| Path | Role |
|------|------|
| `scripts/lib/radar-g06-bounded-load-harness.js` | Dependency-free harness |
| `scripts/lib/radar-slice16ag-g06-bounded-load-harness.js` | Locks |
| `scripts/verify-radar-slice16ag-g06-bounded-load-harness.js` | Offline fake-server RED/GREEN verifier |
| `fixtures/radar-operations/slice16ag-expected-contract.json` | Contract |

## Slice 16AF artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16af-g06-capacity-alert-live-evidence.json` | Locked evidence + lock_hash |
| `fixtures/radar-operations/slice16af-expected-contract.json` | Contract |
| `scripts/lib/radar-slice16af-g06-capacity-alert-live-evidence.js` | Locks |
| `scripts/verify-radar-slice16af-g06-capacity-alert-live-evidence.js` | Strict RED/GREEN verifier |

## Still open

1. Capacity alert firing / notification delivery — **not claimed**
2. Live dual-staging `/readyz` load/soak **success** proof — prior attempt **`attempted_not_proof`** (16AH); profile lock **defined_not_executed** (16AG) — **not claimed**
3. Autoscaling (rules=null) — **not claimed**
4. Capacity SLO / error budget — **not claimed**
5. Backpressure — **not claimed**
6. Absolute/continuous zero downtime / between-sample / sub-second interruption — **not claimed**
7. Cold-start availability — **not claimed** (WH warmup timeouts remain real)
8. G01-A live Meta→Hermes→Staff correlated read path
9. Human inbox receipt — **not claimed**
10. Unique causality beyond platform alert fields — **not claimed**
11. Requests 5xx alert firing — **not claimed**
12. Production — forbidden
13. Raising any gate verdict to `proven`
