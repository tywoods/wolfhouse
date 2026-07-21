# RADAR Slice 16AD — Operations gate ledger (G02 sampled restart continuity evidence)

**Status:** evidence-only reconciliation (zero deploy / live mutation by this slice; G02 remains partial)
**Master basis:** `137b14a0b3efc689ba749340a97ab4e9bc220edc`
**Branch:** `radar/slice-16ad-g02-sampled-restart-continuity-evidence`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Builds on:** 16I readiness + 16W/16Y lifecycle + 16X traffic-shed + 16Z SIGTERM + 16AA SIGINT + 16AB `/readyz=503` + 16AC organic restart alerts
**This slice does not deploy:** Azure/LAW/public **read-only** verification only

## Outcome (16AD)

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

### 16AD_g02_sampled_restart_continuity_evidence

Concurrent sampled revision-restart continuity — **this tip**. Sampling-resolution claim after WH warmup exclusion only. G02 stays partial.

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

## Slice 16AD artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16ad-g02-sampled-restart-continuity-evidence.json` | Locked evidence + lock_hash |
| `fixtures/radar-operations/slice16ad-expected-contract.json` | Contract |
| `scripts/lib/radar-slice16ad-g02-sampled-restart-continuity-evidence.js` | Locks |
| `scripts/verify-radar-slice16ad-g02-sampled-restart-continuity-evidence.js` | Strict RED/GREEN verifier |

## Still open

1. Absolute/continuous zero downtime / between-sample / sub-second interruption — **not claimed**
2. Cold-start availability — **not claimed** (WH warmup timeouts remain real)
3. G01-A live Meta→Hermes→Staff correlated read path
4. Human inbox receipt — **not claimed**
5. Unique causality beyond platform alert fields — **not claimed**
6. Requests 5xx alert firing — **not claimed**
7. Production — forbidden
8. Raising any gate verdict to `proven`
