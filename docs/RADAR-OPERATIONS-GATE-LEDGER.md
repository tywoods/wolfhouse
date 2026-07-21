# RADAR Slice 16V — Operations gate ledger (G01 central capability boundary freeze)

**Status:** audit-only capability-boundary freeze (zero runtime change / live calls; G01 remains partial)
**Master basis:** `d904481de6ef8e7ad65d84241577796cbb5ad1c4`
**Branch:** `radar/slice-16v-capability-boundary-freeze`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Builds on:** 16U correlation design freeze + 16S live completion evidence + 16J/16R

## Outcome

Freeze the **central capability boundary** required before any G01-A dry-run:

- One fail-closed decision point: `decideCapability`
- **Permit** genuine read dispatch
- **Deny** every WhatsApp send and every Staff/DB/Stripe mutation
- Decision must occur **before** Meta Graph / Staff HTTP / DB pool / Stripe SDK / queue / session-store acquisition
- Unknown or unclassified adapters **deny**

Independently pinned adapter inventory (complete for active Hermes guest turns):

| Class | Count |
|-------|------:|
| WhatsApp send | 18 |
| Staff/DB/Stripe mutation | 23 |
| Read dispatch (permitted) | 15 |
| **Total** | **56** |

Categories covered for sends and mutations: direct, queued, mirror, handoff, booking/payment, reset/error/fallback, future tool-registration (+ session for mutations).

**16U provenance retained:** live Caddy `/whatsapp/*`→`:8092` (`hermes-sunset-luna`), `/wolfhouse/*`→`:8090` (`hermes-luna`); tracked Caddy **stale** evidence, not authority; single-message `wamid` / coalesced ordered immutable **source-wamid** set (no invented parent); G01-A=`meta_hermes_staff_correlated_read_path`; G01-B=`tenant/payment/booking/session` metadata only (no inbound trace/wamid); genuine Stripe Checkout **cannot be exercised without mutation**; Hermes still omits `X-Request-Id`; independent same-ID probes are not E2E.

**Dry-run** (`G01_CORRELATION_DRY_RUN`, phrase `RADAR-16U-CORRELATION-DRY-RUN`) remains **not implementable yet** — audit boundary is frozen; runtime apply of `decideCapability` is still required. **This slice does not implement runtime, execute live, or deploy.** G01 verdict stays `partial`. G02–G09 unchanged. Proven count remains 0.

## Artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16v-adapter-inventory.json` | Independently pinned send/mutation/read inventory |
| `fixtures/radar-operations/slice16v-capability-boundary-freeze.json` | Boundary + later owner freeze |
| `fixtures/radar-operations/slice16v-expected-contract.json` | Frozen 16V contract |
| `scripts/lib/radar-slice16v-capability-boundary-freeze.js` | Locks + decideCapability classifiers |
| `scripts/verify-radar-slice16v-capability-boundary-freeze.js` | Offline RED/GREEN verifier |
| `npm run verify:radar-slice16v-capability-boundary-freeze` | Gate |

## Later implementation owner (not created in 16V; separate from deploy/evidence)

| Role | Module | Symbol | Tests |
|------|--------|--------|-------|
| Primary (Hermes) | `docker/hermes-staging/wolfhouse/capability_boundary.py` | `decide_capability` | `docker/hermes-staging/wolfhouse/test_capability_boundary.py` |
| Staff defense-in-depth | `scripts/lib/g01-capability-boundary.js` | `decideCapability` | `scripts/verify-g01-capability-boundary.js` |

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
| G01 | Correlation / structured logs | `partial` (16S LAW + **16U provenance** + **16V boundary freeze**; G01-A live open) |
| G02–G09 | (unchanged) | `partial` as prior |

## G01 semantics (truthful)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| Request correlation (header + ALS) | `partial` | 16J source |
| Request-completion log | `partial` | 16R + 16S live LAW |
| Live deploy / LAW delivery/search/retention | `live_proven` | via 16S @ `1bf9695` |
| Correlation drill **design** | `audit_frozen` | 16U retained |
| **Central capability boundary** | `audit_frozen` | 16V inventory + `decideCapability` shape |
| Capability boundary **runtime** | `not_implemented` | Later owner not wired |
| Correlation drill **live G01-A** | `open` | Needs runtime boundary then Hermes `X-Request-Id` |
| Dry-run mode | `not_implementable_yet` | Blocked on capability_boundary_runtime_apply |
| G01-B join today | `metadata_only` | 16U truth retained |

## Slice 16V progress

**ID:** `16V_central_capability_boundary_audit_freeze`
**Gate:** `G01_correlation_structured_logs`
**Progress class:** `audit_only_capability_boundary_freeze`
**Does not implement:** runtime `decideCapability` wiring, dry-run switch, trace/`X-Request-Id`, live drill, any gate proven, G02–G09 changes

### Still open (smallest follow-on = 16W)

1. **16W:** wire `decide_capability` / `decideCapability` at frozen hooks using the pinned inventory — **no** deploy/evidence
2. After runtime boundary: Hermes mint `trace_id` + send `X-Request-Id` on `_post_bot`
3. Hard-disabled `G01_CORRELATION_DRY_RUN` (phrase `RADAR-16U-CORRELATION-DRY-RUN`)
4. Live G01-A read-only evidence freeze

### Explicitly not claimed

- Runtime capability boundary wired
- Dry-run implementable today
- Dispersed env checks as sole control
- Post-acquisition denial
- Mutable capability state
- Trace / deploy / live evidence
- Live drill executed / any gate `proven`
- Production

## Prior partial progress retained

- **16U** `16U_correlation_design_freeze` live Caddy + provenance + G01-A/B honesty — retained (`audit_frozen`); dry-run phrase `RADAR-16U-CORRELATION-DRY-RUN` still reserved and not implementable yet
- **16S** `16S_request_completion_log_live_evidence` dual-staging completion-log delivery/search/retention @ SHA `1bf9695` — retained (`partial_live_proven`)
- **16R** / **16J** correlation + completion source — retained
- **16P** / **16O** G08 webhook error minimization (invalid_stripe_signature / stripe_webhook_unavailable / malformed / oversize) — retained; does **not claim** human inbox receipt or organic metric alert firing
- **16M** G05 event-id claim / `stripe_event_id` — retained
- **16L** G06 capacity-pressure / CpuPercentage — retained
- **16K** / **16I** / **16H** / **16B** — retained

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation. No live HTTP. Database, Hermes, Staff API runtime, correlation/completion helpers, and staging IaC unchanged vs master `d904481`. Audit fixtures + ledger/matrix/findings/contract + verifiers only. Later owner modules are **specified but not created**. End-to-end G01-A live evidence remains open (not claimed). G01 partial/runtime unchanged. Explicitly does **not claim** human inbox, organic metric fire, or production.
