# RADAR Slice 16D — Operations gate ledger (Staff API request correlation source-partial)

**Status:** source partial progress only (zero live deploy / mutation / log-query claim)
**Master basis:** `acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b`
**Branch:** `radar/slice-16d-staff-request-correlation`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”

## Outcome

Establish **safe request correlation at the Staff API HTTP boundary** (source only). For every request: accept only a strict bounded `X-Request-Id` or generate a cryptographically random ID; return it on the response; propagate via AsyncLocalStorage without changing handler signatures; emit exactly one structured completion event. **Do not deploy.** G01 remains `partial` — deployment and log-query proof stay open.

## Artifacts

| Path | Role |
|------|------|
| `scripts/lib/staff-api-request-correlation.js` | ID accept/generate, ALS, route class, completion event |
| `scripts/staff-query-api.js` | HTTP boundary wire + authoritative tenant bind |
| `scripts/lib/radar-slice16d-staff-request-correlation.js` | Locks |
| `scripts/verify-radar-slice16d-staff-request-correlation.js` | RED/GREEN offline verifier |
| `fixtures/radar-operations/slice16d-expected-contract.json` | Event/context contract |
| `npm run verify:radar-slice16d-staff-request-correlation` | Gate |

## Event / context contract

**Header:** `X-Request-Id` — accept `^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$` (8–128 ASCII) else generate 32-char hex.

**Propagation:** `AsyncLocalStorage` (no handler signature changes).

**Completion event** (`staff_api_http_request_complete`), exactly once:

| Field | Rule |
|-------|------|
| `correlation_id` | Accepted or generated ID |
| `method` | HTTP method |
| `route_class` | Normalized low-cardinality path (IDs collapsed) |
| `status` | HTTP status |
| `duration_ms` | Elapsed |
| `client_slug` / `location_id` | Only when bound from already-authoritative runtime |
| `error_class` | Status/abort class — never message/stack |

**Must not include:** raw URL/query/body/headers, guest data, credentials, tokens, stack, error message.

Preserves existing response/error bodies and streaming (no body buffering).

## Verdict counts

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven` | 0 | Control fully evidenced end-to-end (incl. live deploy + log query) |
| `partial` | 8 | Some code and/or live evidence; gaps remain |
| `absent` | 1 | No safe control evidenced (G03) |
| **total** | **9** | Matrix gates |

## Matrix (summary)

| ID | Gate | Verdict |
|----|------|---------|
| G01 | Correlation / structured logs | `partial` (source-partial via 16D) |
| G02 | Readiness / dependencies | `partial` |
| G03 | Actionable tenant-aware alerts | `absent` |
| G04 | Webhook / payment / worker backlog | `partial` |
| G05 | Retry / replay safety | `partial` |
| G06 | Scaling / capacity | `partial` |
| G07 | Rollback / incident runbooks | `partial` |
| G08 | Retention / privacy | `partial` |
| G09 | Cost controls | `partial` (16B budget-threshold source) |

## Prior slice 16B (still partial)

**ID:** `16B_staging_rg_cost_budget_threshold` on **G09_cost_controls** — budget-threshold source only; not anomaly detection; deploy + notification delivery still open.

## Slice 16D progress

**ID:** `16D_staff_api_request_correlation`

**Gate:** `G01_correlation_structured_logs`

**Progress class:** `source_partial_progress_only`

### Still open

1. Live deploy of Staff API image with correlation middleware
2. Log Analytics / App Insights query proof of completion events
3. End-to-end Meta → Hermes → Staff API → Stripe correlation

### Final controlled drill (remaining)

`16D_DRILL_correlation_log_query` — after approved deploy: known `X-Request-Id` traffic; prove one completion event per request in LAW/App Insights with `route_class` (not raw URL) and no secret/guest leakage; prove concurrent requests do not bleed context.

## Gates

```bash
npm run verify:radar-slice16d-staff-request-correlation
npm run verify:radar-slice16a-operations-gate-ledger
npm run verify:radar-slice16b-staging-cost-budgets
npm run verify:staff-auth-api
npm run verify:fortress-slice15j3-payment-uuid-callback-tenant-acl
npm run verify:sunset-staging-iac-secret-scan
npm run verify:migration-integrity
npm run verify:sunset-staging-iac-diff-check
git diff --check acf3397dda44b1a9132f7dcbe9a8b059ecee0b1b..HEAD
```

## Zero-live / zero-runtime proof

16D changes Staff API correlation source only. Live deploy is out of scope. No Azure mutating calls. No guest/payment/production actions. Database schema, Hermes staging, and staging main Bicep must remain untouched.
