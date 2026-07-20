# RADAR Slice 16J — Operations gate ledger (Staff API request correlation source-partial)

**Status:** source partial progress only (zero live deploy / mutation / delivery / search / retention / drill claim)
**Master basis:** `d9d297e8d28b499316fdcb89ff7954ebb4cdae06`
**Branch:** `radar/slice-16j-request-correlation`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Supersedes:** deferred 16D (`radar/slice-16d-staff-request-correlation` @ `4478ac2` — do not merge)

## Outcome

Add **Staff API request correlation at the HTTP boundary** (source only): AsyncLocalStorage middleware accepts `X-Request-Id` only as strict UUIDv4 (normalize lowercase) else `crypto.randomUUID()`; sets response header before route handling; exposes `getRequestContext` / `requestId`; emits at most one minimal synchronous structured completion JSON record via the existing process logger (`console`) with `request_id`, trusted-ingress `tenant_slug`, `method`, normalized `route`, `status`, and ceil-bucketed `duration_ms` (5ms). **No async log queue. No signal/shutdown ownership. Do not deploy.** G01 remains `partial` — delivery, search, retention, and drill stay open.

## Artifacts

| Path | Role |
|------|------|
| `scripts/lib/staff-api-request-correlation.js` | UUIDv4 accept/generate, ALS, sync completion |
| `scripts/staff-query-api.js` | Real-router HTTP boundary wire |
| `scripts/lib/radar-slice16j-staff-request-correlation.js` | Locks |
| `scripts/verify-radar-slice16j-staff-request-correlation.js` | Offline RED/GREEN verifier |
| `fixtures/radar-operations/slice16j-expected-contract.json` | Frozen independent contract |
| `npm run verify:radar-slice16j-staff-request-correlation` | Gate |

## Bounded contract

| Bound | Value |
|-------|--------|
| Header | `X-Request-Id` |
| Accept | UUIDv4 canonical (any hex case) → normalize lowercase |
| Reject / generate | non-UUIDv4, oversize, undersize, array/ambiguous → `crypto.randomUUID()` |
| Propagation | `AsyncLocalStorage`; `getRequestContext` / `requestId` |
| Tenant | trusted ingress binding (`DEFAULT_CLIENT_SLUG` / construction options) only; omit if absent |
| Route | normalized template / pathname **without** query |
| Completion | at most one sync JSON line via `console`; no queue / flush / signal handlers |
| `duration_ms` | ceil to **5ms** bucket |
| Must not log | URL query, headers, body, phone/email/name, tokens, stack/error text |

## Verdict counts

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven` | 0 | Control fully evidenced end-to-end (incl. live deploy + log query) |
| `partial` | 9 | Some code and/or live evidence; gaps remain |
| `absent` | 0 | No safe control evidenced |
| **total** | **9** | Matrix gates |

## Matrix (summary)

| ID | Gate | Verdict |
|----|------|---------|
| G01 | Correlation / structured logs | `partial` (source-partial via 16J) |
| G02 | Readiness / dependencies | `partial` (16I readiness source still partial) |
| G03 | Actionable tenant-aware alerts | `partial` (16H metric-alert source still partial) |
| G04 | Webhook / payment / worker backlog | `partial` |
| G05 | Retry / replay safety | `partial` |
| G06 | Scaling / capacity | `partial` |
| G07 | Rollback / incident runbooks | `partial` |
| G08 | Retention / privacy | `partial` |
| G09 | Cost controls | `partial` (16B budget-threshold source still partial) |

## G01 semantics (truthful)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| Request ID middleware | `partial` | UUIDv4 accept/generate + ALS + response header |
| Structured completion record | `partial` | Sync console JSON; at-most-once; no delivery guarantee |
| Async log queue | absent (intentional) | Out of scope for 16J (deferred 16D ownership removed) |
| Signal/shutdown flush | absent (intentional) | Out of scope for 16J |
| Live deploy | `open` | Not claimed |
| LAW/App Insights delivery + search | `open` | Not claimed |
| Retention | `open` | Not claimed |
| Correlation drill | `open` | `16J_DRILL_correlation_log_query` |

## Slice 16J progress

**ID:** `16J_staff_api_request_correlation`
**Gate:** `G01_correlation_structured_logs`
**Progress class:** `source_partial_progress_only`
**Does not implement:** async log queue, signal/shutdown ownership, live deploy, delivery/search/retention proof, e2e drill

### Still open

- Live deploy of Staff API image with correlation middleware
- Log Analytics / App Insights delivery + search proof
- Retention policy for completion records
- End-to-end Meta → Hermes → Staff API → Stripe correlation drill

## Prior partial progress retained

- **16I** `16I_staff_api_readiness_dependencies` on G02 — source-partial readiness (not deployed)
- **16H** `16H_staff_api_metric_alerts` on G03 — source-partial metric alerts (not deployed)
- **16B** `16B_staging_rg_cost_budget_threshold` on G09 — budget-threshold source-partial (not deployed)

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16J. Database, Hermes staging, and staging Bicep must remain unchanged vs master basis. Staff API correlation middleware is intentional 16J ownership.
