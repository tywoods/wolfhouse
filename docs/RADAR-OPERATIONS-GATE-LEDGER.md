# RADAR Slice 16X — Operations gate ledger (G02 lifecycle deploy + traffic-shed drill evidence)

**Status:** partial/live-proven evidence only (zero deploy / live mutation by this slice; G02 remains partial)
**Master basis:** `2dcda08008fe951565560cefafe37f1a78b0791a`
**Branch:** `radar/slice-16x-g02-live-evidence`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Builds on:** 16I readiness + 16W lifecycle source + 16P healthy-path live evidence
**This slice does not deploy:** evidence reconciliation only (no live mutation)

## Provenance split (mandatory)

| Class | `source_type` | What it covers | Recoverability |
|-------|---------------|----------------|----------------|
| **(A)** | `operator_drill_transcript_contemporaneous_observation` | 0..90s/5s Activating samples; public `/healthz`+`/readyz` continuity during fail; fail env intent; min replicas | **Not** Azure-reconstructible. Observation window start/end = `fail_revision_created_utc` + transcript duration/offsets only |
| **(B)** | `azure_readonly_independently_reverified` | ACR digests; images; base/restore revisions; timelines; final ready/health/traffic/secretRef; probes; public-**current** | Independently reverified at `2026-07-21T10:33:28Z` |

**Non-recoverability:** Azure read-only APIs cannot recreate or replay historical sample arrays or contemporaneous public continuity; a later live probe timeout must not rewrite class-A historical 200s.

## Outcome (16X)

Record **operator-completed dual-staging G02 lifecycle deploy + controlled dependency-failure traffic-shed drill** into a redacted, lock-hashed fixture with explicit **(A)/(B)** provenance:

| Fact | Class | Wolfhouse | Sunset |
|------|-------|-----------|--------|
| Image SHA / ACR digest | B | `2dcda08` / `sha256:53682837…` | same SHA / `sha256:3c702217…` |
| Base healthy rev | B | `--0000518` | `--0000278` |
| Fail rev + unreachable DSN intent | A (+ name in B) | `--g02fail` min=1 host `127.0.0.1` | same pattern |
| Fail Activating ≥90s @ 5s never latestReady | A | window `10:18:42`→`10:20:12`Z | `10:23:26`→`10:24:56`Z |
| Public continuity during fail | A | prior `/healthz=200` + `/readyz=200` every sample | same |
| Restore / secretRef / traffic / probes / public-current | B | `--g02restore`; `wolfhouse-database-url`; 100%; probes present; public 200 @ verify UTC | `--g02restore`; `sunset-database-url`; same |

Independent Azure verify UTC (class B): `2026-07-21T10:33:28Z`.

## Truthful disposition

**Proves:** lifecycle-wired image deploy @ exact SHA; controlled dependency-failure **traffic shed** (failed revision stayed Activating, never latestReady, while prior kept serving); exact-SHA restore with correct secretRef; failed revision deactivated; no production scope.

**Does not prove:** live SIGTERM/SIGINT `closeReadinessPool` behavior; organic metric alerts; human inbox; production; serving-revision `/readyz=503` body path; **full G02**.

**G02 verdict stays `partial`.** Drill + deploy are live-proven; SIGTERM live lifecycle and serving `/readyz=503` remain open.

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
| G02 | Readiness / dependencies | `partial` (**16X** deploy + traffic-shed live; SIGTERM live open) |
| G03–G09 | (unchanged) | `partial` as prior |

## Retained slices (not overclaimed)

### 16W_readiness_shutdown_lifecycle

Source wiring of `closeReadinessPool` on SIGTERM/SIGINT — retained. **Live SIGTERM behavior still open** after 16X.

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

## G02 semantics (truthful after 16X)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| /readyz + dedicated max-1 pool | `source_partial` | 16I |
| ACA probes | `live_present` | verified on restore revisions |
| Healthy-path live health/ready | `live_proven` | 16P + 16X final 200 |
| closeReadinessPool lifecycle source | `source_closed_16W` | SIGTERM/SIGINT CLI main |
| Live lifecycle image deploy | `live_proven_16X` | exact SHA `2dcda08` both tenants |
| Dependency-failure traffic-shed drill | `live_proven_16X` | Activating never latestReady |
| SIGTERM live lifecycle behavior | `open` | not exercised by this drill |
| Serving-revision /readyz=503 path | `open` | fail rev never served traffic |

## Slice 16X artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16x-g02-live-evidence.json` | Lock-hashed evidence |
| `scripts/verify-radar-slice16x-g02-live-evidence.js` | Independent RED/GREEN verifier |
| `fixtures/radar-operations/slice16x-expected-contract.json` | Contract |

## Still open

1. **SIGTERM/SIGINT** `closeReadinessPool` live behavior on a deployed revision
2. Serving-revision `/readyz=503` body path (optional alternate to Activating shed)
3. G01-A live Meta→Hermes→Staff correlated read path
4. Human inbox / organic metric fire — **not claimed**
5. Production — forbidden
6. Raising any gate verdict to `proven`
