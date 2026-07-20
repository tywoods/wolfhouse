# RADAR Slice 16R — Operations gate ledger (Staff API request-completion log source-partial)

**Status:** source partial progress only (zero live deploy / mutation; delivery / search / retention / drill open)
**Master basis:** `06b7a3f2173863afa81bfc557cd31cbd3e80d6c1`
**Branch:** `radar/slice-16r-request-completion-log`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”
**Builds on:** 16J `16J_staff_api_request_correlation` (ALS correlation)

## Outcome

Add **one bounded Staff API request-completion record per real HTTP request** (source only). Extend existing 16J request context/correlation (no duplicate middleware). At `createStaffQueryApiHttpServer`, inside the ALS wrapper, attach finish/close/error settlement listeners and emit exactly one allowlisted JSON record (`event=staff_api_request_completion`) via the existing console/process stdout logger. Listeners are removed on settle (no lifecycle listener growth). Fields: `request_id`, `method`, `route` (fail-closed template), `status_code`, `status_class`, integer bounded `duration_ms`, `outcome` (`completed`|`client_aborted`|`server_error`), optional trusted `tenant_slug`. Never log headers/query/body/cookies/auth/IP/UA/PII/Stripe signature/payload/secrets/DB errors/exception text/stack. Logger failure must never alter HTTP behavior or recurse. Existing router catch remains byte-identical. Auth/webhook/16M semantics preserved. **Do not deploy.** G01 remains `partial`.

## Artifacts

| Path | Role |
|------|------|
| `scripts/lib/staff-api-request-completion-log.js` | Allowlisted build/attach/emit/assert helpers |
| `scripts/staff-query-api.js` | createServer wire inside 16J ALS |
| `scripts/lib/radar-slice16r-staff-request-completion-log.js` | Slice locks |
| `scripts/verify-radar-slice16r-staff-request-completion-log.js` | Offline RED/GREEN verifier |
| `fixtures/radar-operations/slice16r-expected-contract.json` | Frozen independent contract |
| `npm run verify:radar-slice16r-staff-request-completion-log` | Gate |

## Bounded schema

| Field | Rule |
|-------|------|
| `event` | always `staff_api_request_completion` |
| `request_id` | from ALS (16J supplied/generated UUIDv4) |
| `tenant_slug` | trusted construction binding only (else omit) |
| `method` | allowlisted + uppercased |
| `route` | fail-closed allowlisted static / `:id` / `:redacted` / `:truncated` / `/:unmatched`; no query/fragment |
| `status_code` | `res.statusCode` bounded integer |
| `status_class` | `0xx`–`5xx` from status_code |
| `duration_ms` | integer; ceil to 5ms; cap 300000 |
| `outcome` | `completed` \| `client_aborted` \| `server_error` |

## Exclusions (never logged)

URL query, raw URL, headers, body, guest/customer/name/phone/email, auth/cookie/token/key, IP/UA, Stripe signature/payload/secrets, stack/error text, DB errors, exception text, response body.

## Verdict counts

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven` | 0 | Control fully evidenced end-to-end (incl. live deploy + delivery + drill) |
| `partial` | 9 | Some code and/or live evidence; gaps remain |
| `absent` | 0 | No safe control evidenced |
| **total** | **9** | Matrix gates |

## Matrix (summary)

| ID | Gate | Verdict |
|----|------|---------|
| G01 | Correlation / structured logs | `partial` (16J + 16R source still partial) |
| G02 | Readiness / dependencies | `partial` (16I + 16P healthy path) |
| G03 | Actionable tenant-aware alerts | `partial` (16H + 16P AG test) |
| G04 | Webhook / payment / worker backlog | `partial` |
| G05 | Retry / replay safety | `partial` (16M source still partial) |
| G06 | Scaling / capacity | `partial` (16L source still partial) |
| G07 | Rollback / incident runbooks | `partial` (16P rollforward) |
| G08 | Retention / privacy | `partial` (16K/16O + 16P) |
| G09 | Cost controls | `partial` (16B + 16P AG test) |

## G01 semantics (truthful)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| Request correlation (header + ALS) | `partial` | 16J source |
| Request-completion log (source) | `partial` | 16R finish/close/error exactly-once |
| Lifecycle listener growth | absent by design | Removed on settle |
| Live deploy | `open` | Not claimed |
| Azure stdout / LAW delivery | `open` | Not claimed |
| Searchable query | `open` | Not claimed |
| Retention policy | `open` | Not claimed |
| Controlled correlation drill | `open` | Not claimed |

## Slice 16R progress

**ID:** `16R_staff_api_request_completion_log`
**Gate:** `G01_correlation_structured_logs`
**Progress class:** `source_partial_progress_only`
**Does not implement:** live deploy, Azure stdout delivery, searchable query, retention, drill

### Still open

- Live deploy of Staff API image with completion logging
- Azure stdout / LAW / App Insights delivery proof
- Searchable query of completion records
- Retention policy for completion records
- End-to-end Meta → Hermes → Staff API → Stripe correlation drill

## Prior partial progress retained

- **16P** live-drill evidence reconciliation — partial/live-proven on selected gates
- **16O** `16O_stripe_webhook_error_minimization` on G08
- **16M** `16M_stripe_webhook_event_id_claim` on G05 — source-partial
- **16L** `16L_staff_api_capacity_pressure_alerts` on G06 — source-partial
- **16K** `16K_staff_api_healthz_minimization` on G08
- **16J** `16J_staff_api_request_correlation` on G01 — source-partial correlation
- **16I** / **16H** / **16B** — prior partials retained

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16R. Database, Hermes staging, staging Bicep, and 16H metric-alert module must remain unchanged vs master basis. Staff API completion-log helper + createServer wiring are intentional 16R ownership.
