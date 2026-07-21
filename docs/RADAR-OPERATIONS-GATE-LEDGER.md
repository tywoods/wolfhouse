# RADAR Slice 16Z — Operations gate ledger (G02 live SIGTERM lifecycle evidence)

**Status:** evidence-only reconciliation (zero deploy / live mutation by this slice; G02 remains partial)
**Master basis:** `95dc3634ac6aaa6de495d22f5f5d8cd0a955df97`
**Branch:** `radar/slice-16z-g02-live-sigterm-evidence`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Builds on:** 16W lifecycle source + 16X deploy/traffic-shed live + 16Y shutdown completion source
**This slice does not deploy:** Azure/ACR/LAW read-only verification only

## Outcome (16Z)

Reconcile the completed dual-staging **live SIGTERM lifecycle drill** with mandatory provenance split:

| Class | Source | Covers |
|-------|--------|--------|
| **A** | Operator drill transcript (contemporaneous) | Restart windows WH `11:15:18Z→11:15:21Z` / Sunset `11:17:30Z→11:17:33Z`; **post-restart** 31× `/healthz=200`+`/readyz=200` pairs ~every 2s (WH `11:15:22→11:16:25Z`, Sunset `11:17:35→11:18:38Z`) |
| **B** | Independently reverified Azure/ACR/LAW @ `2026-07-21T11:42:38Z` | Digests WH `sha256:a9677f75…` rev `--0000519` / Sunset `sha256:8a0b1647…` rev `--0000279`; LAW exactly one `staff_api_readiness_shutdown_completion` each (WH `11:16:20.3631884Z`, Sunset `11:18:04.1610218Z`); allowlisted JSON SIGTERM/pool ok/server ok/`failures []`/`completion true`; probes; public-current 200 |

**Explicitly not covered by A:** concurrent restart continuity; zero downtime during restart.

## Truthful disposition

**Proves (live):** SIGTERM cleanup telemetry delivered to LAW (exactly one allowlisted completion each tenant) + post-restart recovery `/healthz`+`/readyz=200` both staging tenants on exact SHA `95dc363`.

**Does not prove:** SIGINT live; serving-revision `/readyz=503`; zero downtime during restart / concurrent restart continuity; organic metric alerts; human inbox; production; **full G02**.

**G02 verdict stays `partial`.** 16X traffic-shed and 16Y completion-log source retained.

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
| G02 | Readiness / dependencies | `partial` (**16Z** SIGTERM LAW + post-restart recovery live; **16X** traffic-shed; **16Y** completion source; SIGINT /readyz=503 / zero-downtime-during-restart still open) |
| G03–G09 | (unchanged) | `partial` as prior |

## Retained slices (not overclaimed)

### 16Z_g02_live_sigterm_lifecycle_evidence

Dual-staging live SIGTERM drill evidence — **this tip**. Provenance split (A)/(B). G02 stays partial.

### 16Y_readiness_shutdown_completion_log

Source observability for readiness shutdown completion — retained. Live SIGTERM drill closed via 16Z (SIGINT live still open).

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

## G02 semantics (truthful after 16Z)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| /readyz + dedicated max-1 pool | `source_partial` | 16I |
| ACA probes | `live_present` | verified on serving revisions |
| Healthy-path live health/ready | `live_proven` | 16P + 16X final + 16Z post-restart |
| closeReadinessPool lifecycle source | `source_closed_16W` | SIGTERM/SIGINT CLI main |
| Shutdown completion log source | `source_closed_16Y` | one JSON record per shutdown |
| Live lifecycle image deploy | `live_proven_16X` / `95dc363 via 16Z` | exact SHA both tenants |
| Dependency-failure traffic-shed drill | `live_proven_16X` | Activating never latestReady |
| SIGTERM live cleanup telemetry | `live_proven_16Z` | LAW exactly one allowlisted completion each |
| Post-restart recovery | `live_proven_16Z` | 31× healthz/readyz 200 post-restart (not concurrent continuity) |
| SIGINT live lifecycle behavior | `open` | not exercised |
| Serving-revision /readyz=503 path | `open` | fail rev never served traffic |
| Zero downtime during restart | `open` / `not claimed` | samples are post-restart only |

## Slice 16Z artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16z-g02-live-sigterm-evidence.json` | Locked evidence + lock_hash |
| `fixtures/radar-operations/slice16z-expected-contract.json` | Contract |
| `scripts/lib/radar-slice16z-g02-live-sigterm-evidence.js` | Locks |
| `scripts/verify-radar-slice16z-g02-live-sigterm-evidence.js` | Strict RED/GREEN verifier |

## Still open

1. **SIGINT** `closeReadinessPool` live behavior on a deployed revision
2. Serving-revision `/readyz=503` body path
3. Zero downtime during restart / concurrent restart continuity — **not claimed** (16Z samples are post-restart recovery only)
4. G01-A live Meta→Hermes→Staff correlated read path
5. Human inbox / organic metric fire — **not claimed**
6. Production — forbidden
7. Raising any gate verdict to `proven`
