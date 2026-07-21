# RADAR Slice 16U — Operations gate ledger (G01 correlation design freeze)

**Status:** audit-only design freeze (zero runtime change / live calls; G01 remains partial)
**Master basis:** `87121456db90a9f80ff8b3679596bc49c235cbfc`
**Branch:** `radar/slice-16u-correlation-design-freeze`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Builds on:** 16S live completion evidence + 16J/16R correlation
**Replaces deferred:** independent same-ID multi-ingress probe harness concept (not causal E2E)

## Outcome

Freeze an **authoritative active staging call graph** and a **genuine non-mutating G01 correlation drill design**. Active Meta ingress is Hermes on Lunabox (`https://lunabox.lunafrontdesk.com/whatsapp/webhook` → `hermes-luna:8090` for Wolfhouse; Sunset `hermes-sunset-luna:8092`). Staff Meta dual-ingress and Stripe webhook are **not** on the active inbound path. Hermes `_post_bot` does **not** send `X-Request-Id` today. Genuine Stripe Checkout create **cannot be exercised without mutation**; therefore G01 E2E is redefined:

- **G01-A (provable target):** Meta → Hermes → Staff `/staff/bot/*` with one immutable `trace_id` + `parent_event_id=wamid` on a non-mutating read path.
- **G01-B (business join only):** Stripe Checkout create ↔ webhook via metadata/business IDs — not the same inbound ALS.

Independent same-ID probes (`/healthz` + Stripe pre-verify sharing a UUID) are **rejected as E2E evidence**. Design specifies hard-disabled `G01_CORRELATION_DRY_RUN` (confirmation `RADAR-16U-CORRELATION-DRY-RUN` for later apply). **This slice does not implement runtime, execute live, or deploy.** G01 verdict stays `partial`. G02–G09 unchanged. Proven count remains 0.

## Artifacts

| Path | Role |
|------|------|
| `fixtures/radar-operations/slice16u-call-graph.json` | Authoritative active-path call graph |
| `fixtures/radar-operations/slice16u-correlation-design-freeze.json` | Design freeze (instrumentation, dry-run, evidence schema) |
| `fixtures/radar-operations/slice16u-expected-contract.json` | Frozen 16U contract |
| `scripts/lib/radar-slice16u-correlation-design-freeze.js` | Locks + evidence classifier |
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
| Correlation drill **design** | `audit_frozen` | 16U G01-A/B + dry-run design |
| Correlation drill **live G01-A** | `open` | Needs Hermes `X-Request-Id` propagate + dry-run suppress |
| Stripe as inbound ALS hop | `not_provable` | Cannot exercise genuine Stripe without mutation |

## Slice 16U progress

**ID:** `16U_correlation_design_freeze`
**Gate:** `G01_correlation_structured_logs`
**Progress class:** `audit_only_design_freeze`
**Does not implement:** runtime instrumentation, dry-run switch, live drill, any gate proven, G02–G09 changes

### Still open (smallest follow-on)

1. Hermes mint `trace_id` + send `X-Request-Id` on `_post_bot`
2. Hard-disabled `G01_CORRELATION_DRY_RUN` WhatsApp-send suppress
3. Live G01-A read-only evidence freeze

### Explicitly not claimed

- Independent same-ID probes as E2E
- Stripe Checkout without mutation
- Single ALS spanning Meta → Stripe webhook
- Live drill executed / any gate `proven`
- Human inbox receipt / organic metric alert firing / production

## Prior partial progress retained

- **16S** `16S_request_completion_log_live_evidence` dual-staging completion-log delivery/search/retention @ SHA `1bf9695` — retained (`partial_live_proven`)
- **16R** / **16J** correlation + completion source — retained
- **16P** / **16O** G08 webhook error minimization — retained
- **16M** G05 event-id claim / **16L** G06 capacity-pressure / **16K** / **16I** / **16H** / **16B** — retained

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation. No live HTTP. Database, Hermes, Staff API runtime, correlation/completion helpers, and staging IaC unchanged vs master `87121456`. Audit fixtures + ledger/matrix/findings/contract only. End-to-end G01-A live evidence remains open (not claimed).
