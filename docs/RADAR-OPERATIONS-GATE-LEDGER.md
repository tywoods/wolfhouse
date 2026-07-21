# RADAR Slice 16Y — Operations gate ledger (G02 readiness-shutdown completion log)

**Status:** source-partial observability only (zero deploy / live mutation by this slice; G02 remains partial)
**Master basis:** `798a5f26e9aa0376e2993b7d590fc818dfa171f7`
**Branch:** `radar/slice-16y-shutdown-completion-log`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Builds on:** 16W lifecycle source + 16X deploy/traffic-shed live evidence
**This slice does not deploy:** source observability only (no live mutation)

## Outcome (16Y)

Add **one bounded non-sensitive structured completion record** for every Staff API readiness shutdown:

| Field | Rule |
|-------|------|
| `event` | `staff_api_readiness_shutdown_completion` |
| `original_signal` | `SIGTERM` \| `SIGINT` |
| `pool_close_result` | `ok` \| `rejected` \| `timeout` \| `throw` |
| `server_close_result` | `ok` \| `rejected` \| `timeout` \| `throw` \| `already_closed` |
| `failure_classes` | bounded 16W enum array |
| `completion` | always `true` |

Emitted **after** bounded pool/server results are known and **before** listeners detach / native re-signal. Production default logger emits **exactly one JSON line to stdout**; injected logger remains supported and non-throwing. Same/repeated/mixed signals emit exactly one record; logger throw cannot block detach or native termination; terminate throw cannot duplicate the record.

**Forbids:** PID, secrets, tokens, URLs, error messages/stacks, timing guesses.

## Truthful disposition

**Proves (source):** shutdown completion observability wired into 16W lifecycle; offline RED/GREEN including real-child SIGTERM/SIGINT success and pool/server failure classifications; secret/token rejection.

**Does not prove:** live SIGTERM/SIGINT `closeReadinessPool` behavior on a deployed revision; organic metric alerts; human inbox; production; serving-revision `/readyz=503` body path; **full G02**.

**G02 verdict stays `partial`.** 16X deploy + traffic-shed remain live-proven; **SIGTERM live lifecycle evidence remains open** until deployment/drill.

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
| G02 | Readiness / dependencies | `partial` (**16X** deploy + traffic-shed live; **16Y** shutdown completion source; SIGTERM live open) |
| G03–G09 | (unchanged) | `partial` as prior |

## Retained slices (not overclaimed)

### 16Y_readiness_shutdown_completion_log

Source observability for readiness shutdown completion — **this tip**. Live SIGTERM evidence still open.

### 16X_g02_lifecycle_deploy_traffic_shed_live_evidence

Dual-staging exact-SHA `2dcda08` deploy + Activating traffic-shed drill — retained with explicit **(A)/(B) provenance**: class A operator-observed transcript (g02fail Activating ≥90s @ 5s never latestReady + prior public continuity); class B independently reverified Azure read-only digests/revisions/secretRef/probes/traffic/public-current. SIGTERM live still open.

### 16W_readiness_shutdown_lifecycle

Source wiring of `closeReadinessPool` on SIGTERM/SIGINT — retained. Semantics preserved by 16Y.

### 16S_request_completion_log_live_evidence

Dual-staging LAW delivery/search/retention @ SHA `1bf9695` (WH `--0000517`, Sunset `--0000277`) — retained. Meta→Hermes E2E still open as G01-A.

### 16U_correlation_design_freeze

Audit-only G01 design freeze — live Caddy `/whatsapp/*` → **8092** (`hermes-sunset-luna`); `/wolfhouse/*` → `:8090` (`hermes-luna`). Tracked Caddy reference is **stale** evidence, not live authority. **G01-A** Meta→Hermes→Staff open. **Independent same-ID probes are not E2E evidence.** Genuine Stripe Checkout **cannot be exercised without mutation**; G01-B is **tenant/payment/booking/session metadata only**. Dry-run phrase **`RADAR-16U-CORRELATION-DRY-RUN`** reserved; **not implementable yet** (blocked on **central capability boundary**). Coalesced burst provenance uses ordered immutable **source-wamid** set.

### 16P_live_drill_evidence_reconciliation (retained)

Bounded operator-observed facts @ image **594247f** — **partial_live_proven** for healthy health/ready and webhook generic bodies. **Does not claim** human inbox receipt, organic metric alert firing, or production.

### 16O / G05 / G06 / G08 (retained partials)

- **16O** — Stripe webhook error minimization (G08 partial).
- **G05** — 16M Stripe webhook event-id claim (source partial; live drill open).
- **G06** — 16L Staff API capacity-pressure alerts (source partial; alert fire open).
- **G08** — 16O/16P webhook error minimization + privacy drill partial; abrupt/retention/search open.

## G02 semantics (truthful after 16Y)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| /readyz + dedicated max-1 pool | `source_partial` | 16I |
| ACA probes | `live_present` | verified on restore revisions |
| Healthy-path live health/ready | `live_proven` | 16P + 16X final 200 |
| closeReadinessPool lifecycle source | `source_closed_16W` | SIGTERM/SIGINT CLI main |
| Shutdown completion log source | `source_closed_16Y` | one JSON record per shutdown |
| Live lifecycle image deploy | `live_proven_16X` | exact SHA `2dcda08` both tenants |
| Dependency-failure traffic-shed drill | `live_proven_16X` | Activating never latestReady |
| SIGTERM live lifecycle behavior | `open` | not exercised; needs deploy/drill with 16Y log |
| Serving-revision /readyz=503 path | `open` | fail rev never served traffic |

## Slice 16Y artifacts

| Path | Role |
|------|------|
| `scripts/lib/staff-api-readiness-shutdown-completion-log.js` | Bounded record builder/emitter |
| `scripts/lib/staff-api-readiness-lifecycle.js` | Emit after pool/server; before detach |
| `scripts/verify-radar-slice16y-shutdown-completion-log.js` | Independent RED/GREEN verifier |
| `fixtures/radar-operations/slice16y-expected-contract.json` | Contract |

## Still open

1. **SIGTERM/SIGINT** `closeReadinessPool` live behavior on a deployed revision (now observable via 16Y completion log once deployed)
2. Serving-revision `/readyz=503` body path (optional alternate to Activating shed)
3. G01-A live Meta→Hermes→Staff correlated read path
4. Human inbox / organic metric fire — **not claimed**
5. Production — forbidden
6. Raising any gate verdict to `proven`
