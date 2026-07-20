# RADAR Slice 16O — Operations gate ledger (Stripe webhook error minimization source-partial)

**Status:** source partial progress only (zero live deploy / mutation; privacy drill open)
**Master basis:** `3e94498321cd26e64394984a5926d7a583226692`
**Branch:** `radar/slice-16o-stripe-webhook-error-minimization`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”

## Outcome

Add **source-only fail-closed generic public error responses** for `POST /staff/stripe/webhook` Stripe SDK load failure and signature verification failure. Preserve HTTP status classes and internal audit observability, but replace client-visible concatenated `e.message` with stable generic codes/messages. **Do not deploy.** G08 remains `partial` (16O webhook error minimization + prior 16K healthz source-partial). Live deploy and privacy drill remain **open**.

## Artifacts

| Path | Role |
|------|------|
| `scripts/lib/stripe-webhook-public-errors.js` | Frozen public bodies + allowlisted audit reasons |
| `scripts/staff-query-api.js` | Webhook SDK/signature failure paths wire generic bodies |
| `scripts/verify-radar-slice16o-stripe-webhook-error-minimization.js` | Offline RED/GREEN + real-listener verifier |
| `fixtures/radar-operations/slice16o-expected-contract.json` | Frozen independent contract |
| `npm run verify:radar-slice16o-stripe-webhook-error-minimization` | Gate |

## Bounded contract

| Bound | Value |
|-------|--------|
| SDK unavailable | HTTP 500 `{success:false,code:stripe_webhook_unavailable,retryable:true}` — no raw error |
| Missing / malformed / constructEvent throw | HTTP 400 `{success:false,code:invalid_stripe_signature,message:Invalid Stripe webhook signature}` |
| Forbidden public fields | stack, exception class, parser details, signature, webhook secret, event payload, tenant config, raw `error` text |
| Internal audit | allowlisted `reason` only: `sdk_load_failed` / `signature_verification_failed`; never raw error/stack/signature/body |
| Preserved | signature-before-routing/DB; `STRIPE_WEBHOOK_SKIP_VERIFY=false`; tenant binding; 16M claim txn; ignored/unmatched; request ID header |
| Out of scope | live deploy; privacy drill; migration; skip_verify/tenant/16M/ignored behavior changes |

## Verdict counts

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven` | 0 | Control fully evidenced end-to-end (incl. live deploy + drill) |
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
| G05 | Retry / replay safety | `partial` (16M event-id claim source-partial; deploy/replay/DLQ open) |
| G06 | Scaling / capacity | `partial` (16L capacity-pressure source still partial) |
| G07 | Rollback / incident runbooks | `partial` |
| G08 | Retention / privacy | `partial` (16O webhook error + 16K healthz source-partial) |
| G09 | Cost controls | `partial` (16B budget-threshold source still partial) |

## G08 semantics (truthful)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| Public `/healthz` minimization (source) | `partial` | 16K — `{status:ok,service:staff-api}` |
| Public Stripe webhook error minimization (source) | `partial` | 16O — generic SDK/signature failure bodies |
| LAW retention 30d / App Insights 90d | proven live | unchanged |
| Live deploy of minimized bodies | `open` | Not claimed |
| Log-retention / PII redaction proof | `open` | Not claimed |
| Privacy drill (live webhook + healthz) | `open` | Not claimed |

## Slice 16O progress

**ID:** `16O_stripe_webhook_error_minimization`
**Gate:** `G08_retention_privacy`
**Progress class:** `source_partial_progress_only`
**Does not implement:** live deploy, privacy drill

### Still open

- Live deploy of Staff API image with minimized Stripe webhook error bodies
- End-to-end privacy drill proving live public webhook error bodies match generic contract on Wolfhouse + Sunset

## Prior partial progress retained

- **16M** `16M_stripe_webhook_event_id_claim` on G05 — source-partial event-id claim (not deployed)
- **16L** `16L_staff_api_capacity_pressure_alerts` on G06 — source-partial capacity alerts (not deployed)
- **16K** `16K_staff_api_healthz_minimization` on G08 — source-partial healthz (not deployed)
- **16J** `16J_staff_api_request_correlation` on G01 — source-partial correlation (not deployed)
- **16I** `16I_staff_api_readiness_dependencies` on G02 — source-partial readiness (not deployed)
- **16H** `16H_staff_api_metric_alerts` on G03 — source-partial metric alerts (not deployed)
- **16B** `16B_staging_rg_cost_budget_threshold` on G09 — budget-threshold source-partial (not deployed)

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16O. Database, Hermes staging, staging Bicep, and 16H metric-alert module must remain unchanged vs master basis. Staff API Stripe webhook public-error helper + wiring are intentional 16O ownership.
