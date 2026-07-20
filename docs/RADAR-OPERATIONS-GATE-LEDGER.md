# RADAR Slice 16K — Operations gate ledger (Staff API /healthz minimization source-partial)

**Status:** source partial progress only (zero live deploy / mutation; log-retention / privacy drill open)
**Master basis:** `0d7340865d34804562c0e955a6276cfeff90560d`
**Branch:** `radar/slice-16k-healthz-minimization`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”

## Outcome

Minimize the **public Staff API `/healthz`** response for privacy and operational safety (source only): stable generic schema `{ status: "ok", service: "staff-api" }` with `Cache-Control: no-store`. No tenant / product-internal / provider / model / key / config / stage / note fields. Keep `/healthz` DB-independent HTTP 200. Do **not** alter `/readyz` or authenticated diagnostics (`GET /staff/ask-luna/ai-status`). **Do not deploy.** G08 remains `partial` (healthz source-partial only) — live deploy, log-retention/PII proof, and privacy drill stay open.

## Artifacts

| Path | Role |
|------|------|
| `scripts/lib/staff-api-healthz.js` | Frozen public schema + handler |
| `scripts/staff-query-api.js` | Real-router `/healthz` + `/` wire |
| `scripts/lib/radar-slice16k-staff-api-healthz.js` | Locks |
| `scripts/verify-radar-slice16k-staff-api-healthz.js` | Offline RED/GREEN verifier |
| `fixtures/radar-operations/slice16k-expected-contract.json` | Frozen independent contract |
| `npm run verify:radar-slice16k-staff-api-healthz` | Gate |

## Bounded contract

| Bound | Value |
|-------|--------|
| Path | `/healthz` (and `/` alias) |
| Body | `{ status: "ok", service: "staff-api" }` only |
| Status | `200` |
| Cache-Control | `no-store` (via `sendJSON`) |
| DB | none |
| Forbidden | auth_enabled, stage, stormglass, luna_ai, note, tenant/client, provider/model/key/config |
| Diagnostics | authenticated `GET /staff/ask-luna/ai-status` (unchanged) |
| Must preserve | `/readyz`; authenticated diagnostics |

## Verdict counts

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven` | 0 | Control fully evidenced end-to-end (incl. live deploy + privacy drill) |
| `partial` | 9 | Some code and/or live evidence; gaps remain |
| `absent` | 0 | No safe control evidenced |
| **total** | **9** | Matrix gates |

## Matrix (summary)

| ID | Gate | Verdict |
|----|------|---------|
| G01 | Correlation / structured logs | `partial` (16J correlation source still partial) |
| G02 | Readiness / dependencies | `partial` (16I readiness source still partial) |
| G03 | Actionable tenant-aware alerts | `partial` (16H metric-alert source still partial) |
| G04 | Webhook / payment / worker backlog | `partial` |
| G05 | Retry / replay safety | `partial` |
| G06 | Scaling / capacity | `partial` |
| G07 | Rollback / incident runbooks | `partial` |
| G08 | Retention / privacy | `partial` (16K healthz source-partial; deploy/retention/drill open) |
| G09 | Cost controls | `partial` (16B budget-threshold source still partial) |

## G08 semantics (truthful)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| Public `/healthz` minimization | `partial` | Generic schema in source; not deployed |
| LAW retention | proven (live) | 30d both RGs |
| App Insights retention | proven (live) | 90d both RGs |
| Live deploy of minimized healthz | `open` | Not claimed |
| Log retention / PII redaction proof | `open` | Not claimed |
| Privacy drill | `open` | `16K_DRILL_healthz_privacy_live_prove` |

## Slice 16K progress

**ID:** `16K_staff_api_healthz_minimization`
**Gate:** `G08_retention_privacy`
**Progress class:** `source_partial_progress_only`
**Does not implement:** live deploy, log-retention/PII proof, privacy drill

### Still open

- Live deploy of Staff API image with minimized `/healthz`
- Log retention / PII redaction proof for ops telemetry
- End-to-end privacy drill on Wolfhouse + Sunset staging

## Prior partial progress retained

- **16J** `16J_staff_api_request_correlation` on G01 — source-partial correlation (not deployed)
- **16I** `16I_staff_api_readiness_dependencies` on G02 — source-partial readiness (not deployed)
- **16H** `16H_staff_api_metric_alerts` on G03 — source-partial metric alerts (not deployed)
- **16B** `16B_staging_rg_cost_budget_threshold` on G09 — budget-threshold source-partial (not deployed)

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16K. Database, Hermes staging, and staging Bicep must remain unchanged vs master basis. Staff API public `/healthz` body minimization is intentional 16K ownership.
