# RADAR Slice 16W — Operations gate ledger (G02 readiness shutdown lifecycle)

**Status:** source-partial runtime (lifecycle wiring only; G02 remains partial)
**Master basis:** `d904481de6ef8e7ad65d84241577796cbb5ad1c4`
**Branch:** `radar/slice-16w-readiness-shutdown-lifecycle`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Builds on:** 16I readiness pool + 16P healthy-path live evidence + 16U G01 design freeze
**Does not deploy:** no live mutation, no production, no probe/SQL/readyz contract changes

## Outcome (16W)

Wire **`closeReadinessPool`** into the real Staff API graceful-shutdown lifecycle for the **shared Wolfhouse + Sunset staging runtime**:

- **SIGTERM / SIGINT** → await **`closeReadinessPool()`** (exactly once) → **`server.close()`** → process exit (CLI main only).
- Factory reuse in tests must not install duplicate process listeners.
- **Does not** compose **`closePgPool`**, alter readiness SQL, `/readyz` bodies, ACA probes, secrets, DB, or production.

**G02 verdict stays `partial`.** Lifecycle **source gap closed**; **controlled dependency-failure traffic-shed drill** remains open.

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
| G01 | Correlation / structured logs | `partial` (16S live + **16U** design freeze; G01-A live open) |
| G02 | Readiness / dependencies | `partial` (**16W** lifecycle source; dependency-failure drill open) |
| G03–G09 | (unchanged) | `partial` as prior |

## Retained slices (not overclaimed)

### 16S_request_completion_log_live_evidence

Dual-staging LAW delivery/search/retention @ SHA `1bf9695` — retained. Meta→Hermes E2E still open as G01-A.

### 16U_correlation_design_freeze

Audit-only G01 design freeze — live Caddy authority, provenance, G01-A/B. **Independent same-ID probes are not E2E evidence.** Genuine Stripe Checkout **cannot be exercised without mutation**; G01-B is metadata-only today. Dry-run **not implementable yet**.

### 16U_correlation_design_freeze (retained)

Live Lunabox Caddy: `/whatsapp/*` → `:8092` (`hermes-sunset-luna`); `/wolfhouse/*` → `:8090` (`hermes-luna`). Tracked Caddy reference is **stale** evidence. **G01-A** Meta→Hermes→Staff open. **Independent same-ID probes are not E2E.** Stripe Checkout **cannot be exercised without mutation**; G01-B is **tenant/payment/booking/session metadata only**. Dry-run phrase **`RADAR-16U-CORRELATION-DRY-RUN`** reserved; **not implementable yet** (blocked on **central capability boundary**). Coalesced burst provenance uses ordered immutable **source-wamid** set.

### 16P_live_drill_evidence_reconciliation (retained)

Bounded operator-observed facts @ image **594247f** — **partial_live_proven** for healthy health/ready and webhook generic bodies. **Does not claim** human inbox receipt, organic metric alert firing, or production.

### G05 / G06 / G08 (retained partials)

- **G05** — 16M Stripe webhook **event-id claim** (source partial; live drill open).
- **G06** — 16L Staff API **capacity-pressure** alerts (source partial; alert fire open).
- **G08** — 16O/16P **webhook error minimization** + privacy drill partial; abrupt/retention/search open.

## G02 semantics (truthful after 16W)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| /readyz + dedicated max-1 pool | `source_partial` | 16I |
| ACA probes | `source_partial` | unchanged by 16W |
| Healthy-path live health/ready | `live_proven` | 16P @ 594247f |
| **closeReadinessPool lifecycle** | **`source_closed_16W`** | SIGTERM/SIGINT CLI main |
| Live lifecycle deploy | `open` | follow-on deploy |
| Dependency-failure traffic-shed drill | `open` | 16I_DRILL |

## Slice 16W artifacts

| Path | Role |
|------|------|
| `scripts/lib/staff-api-readiness-lifecycle.js` | Shutdown owner |
| `scripts/staff-query-api.js` | CLI-main attach |
| `scripts/verify-radar-slice16w-readiness-shutdown-lifecycle.js` | RED/GREEN gate |

## Still open

1. Approved **deploy** of lifecycle-wired image to Wolfhouse + Sunset staging
2. **16I_DRILL:** controlled Postgres failure → traffic shed without restart loop
3. G01-A live Meta→Hermes→Staff correlated read path
4. Human inbox / organic metric fire — **not claimed**
5. Production — forbidden
