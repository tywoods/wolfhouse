# RADAR Slice 16U — Operations gate ledger (G01 correlation design freeze)

**Status:** audit-only design freeze (zero runtime change / live calls; G01 remains partial)
**Master basis:** `87121456db90a9f80ff8b3679596bc49c235cbfc`
**Branch:** `radar/slice-16u-correlation-design-freeze`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Builds on:** 16S live completion evidence + 16J/16R correlation
**Replaces deferred:** independent same-ID multi-ingress probe harness concept (not causal E2E)

## Outcome

Freeze an **authoritative live staging call graph** and a **genuine non-mutating G01 correlation drill design**. Live Lunabox Caddy authority (captured staging truth; **not** the tracked git Caddy reference):

- `/whatsapp/*` → `localhost:8092` (`hermes-sunset-luna`) — live Meta WhatsApp surface
- `/wolfhouse/*` → `localhost:8090` (`hermes-luna`) — Wolfhouse Luna control/session routes

Tracked `docker/hermes-staging/lunabox-caddyfile.reference` (both paths → `:8090`) is **stale evidence, not authority**. Staff Meta dual-ingress and Stripe webhook are **not** on the active inbound path. Hermes `_post_bot` does **not** send `X-Request-Id` today.

**Message provenance:** a single message uses its `wamid` as `parent_event_id`; a coalesced Sunset burst uses the ordered immutable `source_wamid` set — **no invented single parent**.

Genuine Stripe Checkout create **cannot be exercised without mutation**; therefore G01 E2E is redefined:

- **G01-A (provable target):** Meta → Hermes → Staff `/staff/bot/*` with one immutable `trace_id` on a non-mutating read path (provenance as above).
- **G01-B (business join only):** Stripe Checkout create ↔ webhook via **tenant/payment/booking/session metadata only**. Inbound trace/wamid propagation **does not exist** today — do not overclaim it.

Independent same-ID probes (`/healthz` + Stripe pre-verify sharing a UUID) are **rejected as E2E evidence**. Hard-disabled `G01_CORRELATION_DRY_RUN` is **design-only and not implementable yet** (blocked on a central capability boundary); confirmation phrase `RADAR-16U-CORRELATION-DRY-RUN` is reserved for a later apply slice. **This slice does not implement runtime, execute live, or deploy.** G01 verdict stays `partial`. G02–G09 unchanged. Proven count remains 0.

## Artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16u-call-graph.json` | Authoritative live-path call graph + Caddy authority |
| `fixtures/radar-operations/slice16u-correlation-design-freeze.json` | Design freeze (provenance, G01-A/B, dry-run blocked, 16V) |
| `fixtures/radar-operations/slice16u-expected-contract.json` | Frozen 16U contract |
| `scripts/lib/radar-slice16u-correlation-design-freeze.js` | Locks + evidence classifiers |
| `scripts/verify-radar-slice16u-correlation-design-freeze.js` | Offline RED/GREEN verifier |
| `npm run verify:radar-slice16u-correlation-design-freeze` | Gate |

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
| G01 | Correlation / structured logs | `partial` (16S live-proven delivery/search/retention; **16U design freeze**; G01-A live open) |
| G02–G09 | (unchanged) | `partial` as prior |

## G01 semantics (truthful)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| Request correlation (header + ALS) | `partial` | 16J source |
| Request-completion log | `partial` | 16R + 16S live LAW |
| Live deploy / LAW delivery/search/retention | `live_proven` | via 16S @ `1bf9695` |
| Correlation drill **design** | `audit_frozen` | 16U G01-A/B + live Caddy + provenance |
| Correlation drill **live G01-A** | `open` | Blocked on capability boundary then Hermes `X-Request-Id` |
| Dry-run mode | `not_implementable_yet` | Needs central capability boundary first |
| Stripe as inbound ALS hop | `not_provable` | Cannot exercise genuine Stripe without mutation |
| G01-B join today | `metadata_only` | tenant/payment/booking/session; no inbound trace/wamid |

## Slice 16U progress

**ID:** `16U_correlation_design_freeze`
**Gate:** `G01_correlation_structured_logs`
**Progress class:** `audit_only_design_freeze`
**Does not implement:** runtime instrumentation, dry-run switch, live drill, any gate proven, G02–G09 changes

### Still open (smallest follow-on = 16V)

1. **16V:** audit and freeze a **central capability boundary** denying every WhatsApp send and Staff/DB/Stripe mutation while permitting real read dispatch — **no** trace implementation, deploy, or evidence capture
2. After 16V: Hermes mint `trace_id` + send `X-Request-Id` on `_post_bot`
3. After capability boundary: hard-disabled `G01_CORRELATION_DRY_RUN` (phrase `RADAR-16U-CORRELATION-DRY-RUN`)
4. Live G01-A read-only evidence freeze

### Explicitly not claimed

- Independent same-ID probes as E2E
- Stripe Checkout without mutation
- Single ALS spanning Meta → Stripe webhook
- Tracked Caddy reference as live ingress authority
- Invented single parent for coalesced Sunset burst
- Inbound trace/wamid payment propagation as current
- Dry-run implementable today
- Live drill executed / any gate `proven`
- Human inbox receipt / organic metric alert firing / production

## Prior partial progress retained

- **16S** `16S_request_completion_log_live_evidence` dual-staging completion-log delivery/search/retention @ SHA `1bf9695` — retained (`partial_live_proven`)
- **16R** / **16J** correlation + completion source — retained
- **16P** / **16O** G08 webhook error minimization — retained
- **16M** G05 event-id claim / **16L** G06 capacity-pressure / **16K** / **16I** / **16H** / **16B** — retained

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation. No live HTTP. Database, Hermes, Staff API runtime, correlation/completion helpers, and staging IaC unchanged vs master `87121456`. Audit fixtures + ledger/matrix/findings/contract only. End-to-end G01-A live evidence remains open (not claimed). G01 partial/runtime unchanged.
