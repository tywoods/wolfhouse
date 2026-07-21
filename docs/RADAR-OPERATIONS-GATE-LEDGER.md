# RADAR Slice 16AB — Operations gate ledger (G02 serving /readyz=503 body-path evidence)

**Status:** evidence-only reconciliation (zero deploy / live mutation by this slice; G02 remains partial)
**Master basis:** `c43b4a14d14d5618d99e0e969b4f39784a526722`
**Branch:** `radar/slice-16ab-g02-readyz503-evidence`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Builds on:** 16I readiness + 16W lifecycle + 16X traffic-shed + 16Y completion source + 16Z SIGTERM + 16AA SIGINT
**This slice does not deploy:** Azure/ACR/public read-only verification only

## Outcome (16AB)

Reconcile the completed dual-staging **serving-revision /readyz=503 body-path drill** with mandatory provenance split:

| Class | Source | Covers |
|-------|--------|--------|
| **A** | Operator drill transcript (contemporaneous) | Temporary Multiple mode; 100% public traffic pinned to known healthy revision; isolated min=1/max=1 fail revisions `wh-staging-staff-api--g02503` / `luna-sunset-staging-staff-api--g02503` on exact image SHA `95dc363` with dummy unreachable literal `WOLFHOUSE_DATABASE_URL` (**value not recorded**); `az containerapp exec` into exact replicas `wh-staging-staff-api--g02503-66667d8476-r2jzv` / `luna-sunset-staging-staff-api--g02503-58d5745f7c-fhnqt`; local Node HTTP GET `http://127.0.0.1:3036/readyz` → exact status **503** + body `{status:not-ready}`; public healthy `/readyz` stayed **200**; cleanup exited exec, deactivated fail revisions, created healthy restores, restored Single mode + 100% traffic. **`observed_at=unavailable_in_command_transcript`** — no exact transcript timestamp was captured; do not invent one |
| **B** | Independently reverified Azure/ACR/public @ `2026-07-21T12:43:09Z` | Digests WH `sha256:a9677f75…` / Sunset `sha256:8a0b1647…` on image SHA `95dc363`; restores `wh-staging-staff-api--g02503r` (min0/max1) + `luna-sunset-staging-staff-api--g02503r` (min1/max1) Healthy / latestReady / 100%; fail revisions inactive / Stopped / replicas=0 / traffic=0; Single mode; public-current healthz/readyz 200 both. Fail replica names **not recoverable** from Azure when stopped (empty replica list) |

**Explicitly not covered by A:** concurrent sampled continuity; zero downtime during restart; fail revision receiving public traffic; invented transcript timestamp; DSN/secret value disclosure; Azure-derived historical localhost 503.

### Claim ownership (locked)

| Observation | Owner | Proves | Does not prove |
|-------------|-------|--------|----------------|
| Localhost `/readyz` 503 + `{status:not-ready}` | Class A transcript | Serving failed revision emits bounded generic 503 body both tenants | Concurrent continuity; zero-downtime; public fail traffic; organic alerts; production; full G02 |
| Traffic isolation (Multiple + 100% healthy pin) | Class A transcript | Public healthy revision remained selected; fail isolated | Concurrent continuity; zero-downtime |
| Final Single/restore Healthy/100% / fail inactive | Class B Azure | Exact SHA digests + restore/fail final metadata + public current 200 | Historical localhost 503/body or traffic sequence |

## Truthful disposition

**Proves (live):** Deployed serving failed revision emits bounded generic `/readyz` **503** `{status:not-ready}` on both staging tenants while public healthy revision remained selected (isolated; fail not public traffic), on exact image SHA `95dc363`, with final restore Healthy/latestReady/100% and fail inactive/Stopped/0.

**Does not prove:** concurrent sampled continuity; zero downtime during restart; organic metric alerts; human inbox; production; **full G02**. Azure cannot recreate historical localhost 503/body or traffic sequence.

**G02 verdict stays `partial`.** Remaining gaps: zero-downtime-during-restart / concurrent continuity; organic alerts; production policy. Prior 16AA SIGINT, 16Z SIGTERM, 16X traffic-shed, and 16Y completion-log source retained.

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
| G02 | Readiness / dependencies | `partial` (**16AB** serving `/readyz=503` body path live; **16AA** SIGINT; **16Z** SIGTERM; **16X** traffic-shed; **16Y** completion source; zero-downtime-during-restart / organic alerts / production still open) |
| G03–G09 | (unchanged) | `partial` as prior |

## Retained slices (not overclaimed)

### 16AB_g02_serving_readyz_503_body_path_evidence

Dual-staging serving-revision `/readyz=503` body-path drill evidence — **this tip**. Provenance split (A)/(B). G02 stays partial.

### 16AA_g02_live_sigint_lifecycle_evidence

Dual-staging live SIGINT drill evidence — retained. Provenance split (A)/(B): operator-observed `az containerapp exec` + `kill -INT 1` + ClusterExecFailure exit 137 (**az containerapp exec transport/process-termination disconnect only** — not an application failure; **not proof of** application/Node process native exit status, shell code, signal encoding, or ACA restart reason) + post-drill `/readyz=200`. Independent Azure/ACR/LAW class B: **Independent LAW allowlisted record — not 137 —** evidences `original_signal=SIGINT` and pool/server cleanup; bounded inclusive drill query windows WH `12:08:00Z→12:09:00Z` / Sunset `12:09:00Z→12:10:00Z`; other revision-lifetime records disclosed (WH SIGTERM `11:16:20.3631884Z` etc.) — revision-lifetime count is not one. Serving `/readyz=503` closed via 16AB tip. G02 stays partial.

### 16Z_g02_live_sigterm_lifecycle_evidence

Dual-staging live SIGTERM drill evidence — retained.

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

Bounded operator-observed facts @ image **594247f** — retained. **Does not claim** human inbox / organic alert / production.

### 16O / G05 / G06 / G08 (retained partials)

- **16O** — Stripe webhook error minimization (G08 partial).
- **G05** — 16M Stripe webhook event-id claim (source partial; live drill open).
- **G06** — 16L Staff API capacity-pressure alerts (source partial; alert fire open).
- **G08** — 16O/16P webhook error minimization + privacy drill partial; abrupt/retention/search open.

## G02 semantics (truthful after 16AB)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| /readyz + dedicated max-1 pool | `source_partial` | 16I |
| ACA probes | `live_present` | verified on serving revisions |
| Healthy-path live health/ready | `live_proven` | 16P + 16X final + 16Z/16AA post-drill + 16AB public current |
| closeReadinessPool lifecycle source | `source_closed_16W` | SIGTERM/SIGINT CLI main |
| Shutdown completion log source | `source_closed_16Y` | one JSON record per shutdown |
| Live lifecycle image deploy | `live_proven_16X` / `95dc363 via 16Z/16AA/16AB` | exact SHA both tenants |
| Dependency-failure traffic-shed drill | `live_proven_16X` | Activating never latestReady |
| SIGTERM live cleanup telemetry | `live_proven_16Z` | LAW exactly one allowlisted completion **in each declared drill query window** |
| Post-restart recovery | `live_proven_16Z` | post-restart samples only (not concurrent continuity) |
| SIGINT live cleanup telemetry | `live_proven_16AA` | LAW exactly one allowlisted completion **in each declared drill query window** |
| Post-drill recovery | `live_proven_16AA` | public /readyz=200 (not concurrent continuity) |
| Serving-revision /readyz=503 path | `live_proven_16AB` | isolated fail revision local 503 `{status:not-ready}` both tenants; public healthy remained selected |
| Zero downtime during restart | `open` / `not claimed` | concurrent sampled continuity not claimed |

## Slice 16AB artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16ab-g02-readyz503-evidence.json` | Locked evidence + lock_hash |
| `fixtures/radar-operations/slice16ab-expected-contract.json` | Contract |
| `scripts/lib/radar-slice16ab-g02-readyz503-evidence.js` | Locks |
| `scripts/verify-radar-slice16ab-g02-readyz503-evidence.js` | Strict RED/GREEN verifier |

## Still open

1. Zero downtime during restart / concurrent sampled continuity — **not claimed**
2. G01-A live Meta→Hermes→Staff correlated read path
3. Human inbox / organic metric fire — **not claimed**
4. Production — forbidden
5. Raising any gate verdict to `proven`
