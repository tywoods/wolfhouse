# RADAR Slice 16AA — Operations gate ledger (G02 live SIGINT lifecycle evidence)

**Status:** evidence-only reconciliation (zero deploy / live mutation by this slice; G02 remains partial)
**Master basis:** `fd333b22c984bad1abe387da456b6fbf87396c13`
**Branch:** `radar/slice-16aa-g02-live-sigint-evidence`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Builds on:** 16W lifecycle source + 16X deploy/traffic-shed live + 16Y shutdown completion source + 16Z SIGTERM live
**This slice does not deploy:** Azure/ACR/LAW read-only verification only

## Outcome (16AA)

Reconcile the completed dual-staging **live SIGINT lifecycle drill** with mandatory provenance split:

| Class | Source | Covers |
|-------|--------|--------|
| **A** | Operator drill transcript (contemporaneous) | `az containerapp exec` into exact replicas WH `wh-staging-staff-api--0000519-7f6f87fbcc-fbqwq` / Sunset `luna-sunset-staging-staff-api--0000279-dbb57db7-zzx8n`; command `kill -INT 1`; ClusterExecFailure **exit 137** disconnect (expected after process termination — **not** application failure); post-drill public `/readyz=200` both |
| **B** | Independently reverified Azure/ACR @ `2026-07-21T12:10:51Z`; LAW cardinality reverify @ `2026-07-21T12:11:18Z` | Digests WH `sha256:a9677f75…` rev `--0000519` / Sunset `sha256:8a0b1647…` rev `--0000279` on image SHA `95dc363`; **bounded inclusive drill query windows** — WH `12:08:00Z→12:09:00Z` exactly one completion `12:08:28.6734879Z`; Sunset `12:09:00Z→12:10:00Z` exactly one `12:09:25.9915987Z`; allowlisted JSON SIGINT/pool ok/server ok/`failures []`/`completion true`; other revision-lifetime records disclosed (WH SIGTERM `11:16:20.3631884Z`, `11:24:48.5525367Z`, `11:47:54.2072273Z`, `12:00:48.8352797Z`; Sunset SIGTERM `11:18:04.1610218Z`) — revision-lifetime count **not** one and may grow; probes; public-current healthz/readyz 200 |

**Explicitly not covered by A:** concurrent restart continuity; zero downtime during restart; treating exit 137 as application failure.

## Truthful disposition

**Proves (live):** SIGINT cleanup telemetry delivered to LAW (**exactly one** allowlisted completion **in each declared drill query window**) + post-drill recovery `/readyz=200` both staging tenants on exact image SHA `95dc363`.

**Does not prove:** serving-revision `/readyz=503`; zero downtime during restart / concurrent restart continuity; organic metric alerts; human inbox; production; **full G02**; unqualified revision-lifetime exactly-one LAW cardinality.

**G02 verdict stays `partial`.** 16Z SIGTERM, 16X traffic-shed, and 16Y completion-log source retained.

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
| G02 | Readiness / dependencies | `partial` (**16AA** SIGINT LAW + post-drill recovery live; **16Z** SIGTERM; **16X** traffic-shed; **16Y** completion source; /readyz=503 / zero-downtime-during-restart still open) |
| G03–G09 | (unchanged) | `partial` as prior |

## Retained slices (not overclaimed)

### 16AA_g02_live_sigint_lifecycle_evidence

Dual-staging live SIGINT drill evidence — **this tip**. Provenance split (A)/(B). G02 stays partial.

### 16Z_g02_live_sigterm_lifecycle_evidence

Dual-staging live SIGTERM drill evidence — retained. SIGINT live closed via 16AA.

### 16Y_readiness_shutdown_completion_log

Source observability for readiness shutdown completion — retained. Live SIGTERM via 16Z; live SIGINT via 16AA.

### 16X_g02_lifecycle_deploy_traffic_shed_live_evidence

Dual-staging exact-SHA `2dcda08` deploy + Activating traffic-shed drill — retained with (A)/(B) provenance.

### 16W_readiness_shutdown_lifecycle

Source wiring of `closeReadinessPool` on SIGTERM/SIGINT — retained.

### 16S_request_completion_log_live_evidence

Dual-staging LAW delivery/search/retention @ SHA `1bf9695` — retained. Meta→Hermes E2E still open as G01-A.

### 16U_correlation_design_freeze

Audit-only G01 design freeze — live Caddy `/whatsapp/*` → **8092** (`hermes-sunset-luna`); `/wolfhouse/*` → `:8090` (`hermes-luna`). Tracked Caddy reference is **stale** evidence, not live authority. **G01-A** Meta→Hermes→Staff open. **Independent same-ID probes are not E2E evidence.** Genuine Stripe Checkout **cannot be exercised without mutation**; G01-B is **tenant/payment/booking/session metadata only**. Dry-run phrase **`RADAR-16U-CORRELATION-DRY-RUN`** reserved; **not implementable yet** (blocked on **central capability boundary**). Coalesced burst provenance uses ordered immutable **source-wamid** set.

### 16P_live_drill_evidence_reconciliation (retained)

Bounded operator-observed facts @ image **594247f** — retained. **Does not claim** human inbox / organic alert / production.

### 16O / G05 / G06 / G08 (retained partials)

- **16O** — Stripe webhook error minimization (G08 partial).
- **G05** — 16M Stripe webhook event-id claim (source partial; live drill open).
- **G06** — 16L Staff API capacity-pressure alerts (source partial; alert fire open).
- **G08** — 16O/16P webhook error minimization + privacy drill partial; abrupt/retention/search open.

## G02 semantics (truthful after 16AA)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| /readyz + dedicated max-1 pool | `source_partial` | 16I |
| ACA probes | `live_present` | verified on serving revisions |
| Healthy-path live health/ready | `live_proven` | 16P + 16X final + 16Z post-restart + 16AA post-drill |
| closeReadinessPool lifecycle source | `source_closed_16W` | SIGTERM/SIGINT CLI main |
| Shutdown completion log source | `source_closed_16Y` | one JSON record per shutdown |
| Live lifecycle image deploy | `live_proven_16X` / `95dc363 via 16Z/16AA` | exact SHA both tenants |
| Dependency-failure traffic-shed drill | `live_proven_16X` | Activating never latestReady |
| SIGTERM live cleanup telemetry | `live_proven_16Z` | LAW exactly one allowlisted completion **in each declared drill query window** (not revision-lifetime) |
| Post-restart recovery | `live_proven_16Z` | 31× healthz/readyz 200 post-restart (not concurrent continuity) |
| SIGINT live cleanup telemetry | `live_proven_16AA` | LAW exactly one allowlisted completion **in each declared drill query window** (not revision-lifetime) |
| Post-drill recovery | `live_proven_16AA` | public /readyz=200 (not concurrent continuity) |
| Serving-revision /readyz=503 path | `open` | fail rev never served traffic |
| Zero downtime during restart | `open` / `not claimed` | samples are post-drill/post-restart only |

## Slice 16AA artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16aa-g02-live-sigint-evidence.json` | Locked evidence + lock_hash |
| `fixtures/radar-operations/slice16aa-expected-contract.json` | Contract |
| `scripts/lib/radar-slice16aa-g02-live-sigint-evidence.js` | Locks |
| `scripts/verify-radar-slice16aa-g02-live-sigint-evidence.js` | Strict RED/GREEN verifier |

## LAW cardinality (locked)

| Window | Bounds (inclusive) | Exact drill completion |
|--------|--------------------|------------------------|
| WH | `2026-07-21T12:08:00Z` → `2026-07-21T12:09:00Z` | `2026-07-21T12:08:28.6734879Z` SIGINT |
| Sunset | `2026-07-21T12:09:00Z` → `2026-07-21T12:10:00Z` | `2026-07-21T12:09:25.9915987Z` SIGINT |

Windows abut at `12:09:00Z` (interiors non-overlapping). Query start/end are inclusive. Source refs: digests/probes `az_containerapp_acr_law_query_public_curl_readonly_2026-07-21T12:10:51Z`; LAW windows `az_monitor_log_analytics_query_readonly_bounded_drill_windows_2026-07-21T12:11:18Z`.

**Other revision-lifetime records known at review (not 16AA drill completions):** WH `11:16:20.3631884Z`, `11:24:48.5525367Z`, `11:47:54.2072273Z`, `12:00:48.8352797Z` (SIGTERM); Sunset `11:18:04.1610218Z` (SIGTERM). Revision-lifetime count is **not** one and may continue growing due to scaling/restarts. Claim is limited to exactly one in each declared drill window — **do not claim lifetime cardinality**.

## Still open

1. Serving-revision `/readyz=503` body path
2. Zero downtime during restart / concurrent restart continuity — **not claimed** (16AA post-drill `/readyz` only; 16Z samples are post-restart recovery only)
3. G01-A live Meta→Hermes→Staff correlated read path
4. Human inbox / organic metric fire — **not claimed**
5. Production — forbidden
6. Raising any gate verdict to `proven`
