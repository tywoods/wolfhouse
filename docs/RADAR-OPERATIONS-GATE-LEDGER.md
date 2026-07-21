# RADAR Slice 16AC — Operations gate ledger (G02/G03 organic restart alert evidence)

**Status:** evidence-only reconciliation (zero deploy / live mutation by this slice; G02 and G03 remain partial)
**Master basis:** `72d8faf74df27a714482ebdefb8f88870d080306`
**Branch:** `radar/slice-16ac-organic-restart-alert-evidence`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Builds on:** 16H metric-alert IaC + 16P AG test API + 16AA SIGINT + 16AB serving `/readyz=503`
**This slice does not deploy:** Azure Monitor / metric alert / action group **read-only** verification only

## Outcome (16AC)

Reconcile **independently discovered organic Azure Monitor RestartCount alert instances** temporally associated with completed **16AA dual-staging SIGINT drills** (Azure read-only @ `2026-07-21T13:07:35Z`).

| Observation | Locked facts |
|-------------|--------------|
| WH alert | `wolfhouse-staff-api-restart-count` → `wh-staging-staff-api`; Metric / Sev2 / Platform; `monitorCondition=Resolved`; start `2026-07-21T12:11:40.2497189Z`; resolved `12:17:59.4591399Z`; `actionStatus.isSuppressed=false` |
| Sunset alert | `sunset-staff-api-restart-count` → `luna-sunset-staging-staff-api`; same types; start `12:12:51.2774974Z`; resolved `12:19:32.3682899Z`; unsuppressed |
| Rules | Enabled; `RestartCount` `Total` `GreaterThan` `0`; eval `PT1M`; window `PT5M`; scoped to exact apps; action group IDs exact tenant ops-budget AGs |
| Action groups | Enabled; receiver name `ops-email` status `Enabled`; **address not recorded** |
| Chronology | Follows 16AA LAW SIGINT WH `12:08:28.6734879Z` / Sunset `12:09:25.9915987Z` — **cautious temporal association** only (not inbox; not unique causality beyond platform fields) |
| Costs | WH `69.3920793568176` USD; Sunset `18.1452292043011` USD; before/after unchanged; **no resources created** this capture |

### Claim ownership (16AC locked)

| Observation | Proves | Does not prove |
|-------------|--------|----------------|
| Organic restart alert instances | Fired + Resolved + unsuppressed action path both staging apps | Human inbox receipt; unique causality beyond platform fields; 5xx alert firing; production; raising G02/G03 to proven |
| Rules + AGs | Enabled exact threshold/window/scope/AG IDs; ops-email Enabled | Receiver address; inbox delivery |
| Chronology vs 16AA | Temporal association with SIGINT restart-producing drills | Unique causality |
| Costs | Locked unchanged MTD + no resources created this capture | CostManagement reverify success on this identity |

## Truthful disposition (16AC)

**Proves (live):** Enabled deployed restart alerts organically fired/resolved and invoked the unsuppressed action path for both staging Staff API apps.

**Does not prove:** human inbox receipt; unique causality beyond platform alert fields; 5xx alert firing; production; zero downtime during restart; raising G02 or G03 to `proven`.

**G02 organic restart alert gap closed; G02 remains partial.** Still open: zero-downtime-during-restart; production.
**G03 organic firing closed; inbox receipt open; G03 remains partial.**

## Outcome (16AB — retained)

Reconcile the completed dual-staging **serving-revision /readyz=503 body-path drill** with mandatory provenance split:

| Class | Source | Covers |
|-------|--------|--------|
| **A** | Operator drill transcript (contemporaneous) | Temporary Multiple mode; 100% public traffic pinned to known healthy revision; isolated min=1/max=1 fail revisions `wh-staging-staff-api--g02503` / `luna-sunset-staging-staff-api--g02503` on exact image SHA `95dc363` with dummy unreachable literal `WOLFHOUSE_DATABASE_URL` (**value not recorded**); `az containerapp exec` into exact replicas `wh-staging-staff-api--g02503-66667d8476-r2jzv` / `luna-sunset-staging-staff-api--g02503-58d5745f7c-fhnqt`; local Node HTTP GET `http://127.0.0.1:3036/readyz` → exact status **503** + body `{status:not-ready}`; public healthy `/readyz` stayed **200**; cleanup exited exec, deactivated fail revisions, created healthy restores, restored Single mode + 100% traffic. **`observed_at=unavailable_in_command_transcript`** — no exact transcript timestamp was captured; do not invent one |
| **B** | Independently reverified Azure/ACR/public @ `2026-07-21T12:43:09Z` | Digests WH `sha256:a9677f75…` / Sunset `sha256:8a0b1647…` on image SHA `95dc363`; restores `wh-staging-staff-api--g02503r` (min0/max1) + `luna-sunset-staging-staff-api--g02503r` (min1/max1) Healthy / latestReady / 100%; fail revisions inactive / Stopped / replicas=0 / traffic=0; Single mode; public-current healthz/readyz 200 both. Fail replica names **not recoverable** from Azure when stopped (empty replica list) |

**Explicitly not covered by A:** concurrent sampled continuity; zero downtime during restart; fail revision receiving public traffic; invented transcript timestamp; DSN/secret value disclosure; Azure-derived historical localhost 503.

### Claim ownership (locked)

| Observation | Owner | Proves | Does not prove |
|-------------|-------|--------|----------------|
| Localhost `/readyz` 503 + `{status:not-ready}` | Class A transcript | Serving failed revision emits bounded generic 503 body both tenants | Concurrent continuity; zero-downtime; public fail traffic; organic alerts; production; raising G02 to proven |
| Traffic isolation (Multiple + 100% healthy pin) | Class A transcript | Public healthy revision remained selected; fail isolated | Concurrent continuity; zero-downtime |
| Final Single/restore Healthy/100% / fail inactive | Class B Azure | Exact SHA digests + restore/fail final metadata + public current 200 | Historical localhost 503/body or traffic sequence |

## Truthful disposition

**Proves (live):** Deployed serving failed revision emits bounded generic `/readyz` **503** `{status:not-ready}` on both staging tenants while public healthy revision remained selected (isolated; fail not public traffic), on exact image SHA `95dc363`, with final restore Healthy/latestReady/100% and fail inactive/Stopped/0.

**Does not prove:** concurrent sampled continuity; zero downtime during restart; organic metric alerts (closed later via 16AC tip for restart alerts only); human inbox; production; raising G02 to proven. Azure cannot recreate historical localhost 503/body or traffic sequence.

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
| G02 | Readiness / dependencies | `partial` (**16AC** organic restart alerts; **16AB** serving `/readyz=503`; **16AA** SIGINT; **16Z** SIGTERM; **16X** traffic-shed; **16Y** completion source; zero-downtime-during-restart / production still open) |
| G03 | Actionable tenant-aware alerts | `partial` (**16AC** organic restart fire/resolve + **16P** AG test API; human inbox still open) |
| G04–G09 | (unchanged) | `partial` as prior |

## Retained slices (not overclaimed)

### 16AC_organic_restart_alert_evidence

Organic restart alert evidence — **this tip**. G02/G03 stay partial.

### 16AB_g02_serving_readyz_503_body_path_evidence

Dual-staging serving-revision `/readyz=503` body-path drill evidence — retained. Provenance split (A)/(B). `observed_at=unavailable_in_command_transcript`. Azure cannot recreate historical localhost 503/body or traffic sequence. G02 stays partial.

### 16AA_g02_live_sigint_lifecycle_evidence

Dual-staging live SIGINT drill evidence — retained. Provenance split (A)/(B): operator-observed `az containerapp exec` + `kill -INT 1` + ClusterExecFailure exit 137 (**az containerapp exec transport/process-termination disconnect only** — not an application failure; **not proof of** application/Node process native exit status, shell code, signal encoding, or ACA restart reason) + post-drill `/readyz=200`. Independent Azure/ACR/LAW class B: **Independent LAW allowlisted record — not 137 —** evidences `original_signal=SIGINT` and pool/server cleanup; bounded inclusive drill query windows WH `12:08:00Z→12:09:00Z` / Sunset `12:09:00Z→12:10:00Z`; other revision-lifetime records disclosed (WH SIGTERM `11:16:20.3631884Z` etc.) — revision-lifetime count is not one. Serving `/readyz=503` closed via 16AB; organic restart alerts via 16AC tip. G02 stays partial.

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

## G02 / G03 semantics (truthful after 16AC)

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
| Organic restart metric alert firing | `live_proven_16AC` | fired/resolved/unsuppressed both tenants; temporally associated with 16AA SIGINT |
| Zero downtime during restart | `open` / `not claimed` | concurrent sampled continuity not claimed |
| AG test notification API email status | `live_proven_16P` | retained |
| Human inbox receipt | `open` / `not claimed` | unproven |
| Requests 5xx alert firing | `open` / `not claimed` | not evidenced by 16AC |

## Slice 16AC artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16ac-organic-restart-alert-evidence.json` | Locked evidence + lock_hash |
| `fixtures/radar-operations/slice16ac-expected-contract.json` | Contract |
| `scripts/lib/radar-slice16ac-organic-restart-alert-evidence.js` | Locks |
| `scripts/verify-radar-slice16ac-organic-restart-alert-evidence.js` | Strict RED/GREEN verifier |

**Does not claim** end-to-end gate close or human inbox delivery.

## Still open

1. Zero downtime during restart / concurrent sampled continuity — **not claimed**
2. G01-A live Meta→Hermes→Staff correlated read path
3. Human inbox receipt — **not claimed** (organic restart fire closed via 16AC; inbox open)
4. Unique causality beyond platform alert fields — **not claimed**
5. Requests 5xx alert firing — **not claimed**
6. Production — forbidden
7. Raising any gate verdict to `proven`
