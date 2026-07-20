# RADAR Slice 16M — Operations gate ledger (Stripe webhook event-id claim source-partial)

**Status:** source partial progress only (zero live deploy / mutation; concurrency / replay operator / DLQ / drill open)
**Master basis:** `49b4ccff673014b28047307514f91a508cc8c497`
**Branch:** `radar/slice-16m-stripe-event-claim`
**Azure scope (locked):** subscription `6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9`; RGs `wh-staging-rg`, `luna-sunset-staging-rg`
**Classifier policy:** absence of evidence is `absent`, never “safe”

## Outcome

Add **source-only fail-closed Stripe webhook event-id claim** before booking-payment and addon_service payment mutations. Use existing `payment_events.stripe_event_id` UNIQUE. Claim inside the same transaction: `INSERT … ON CONFLICT (stripe_event_id) DO NOTHING RETURNING id`; zero rows → rollback + HTTP 200 idempotent; first claim → existing writes → `processed=true` → COMMIT; any failure → full rollback + retryable 500. Privacy-minimized payload only. **Do not deploy.** G05 remains `partial` (event-claim source-partial only).

## Artifacts

| Path | Role |
|------|------|
| `scripts/lib/stripe-webhook-event-claim.js` | Claim / mark-processed / minimized payload helper |
| `scripts/lib/stripe-webhook-payment-truth.js` | Lookup returns owned `hostel_id` (`client_id` alias) |
| `scripts/staff-query-api.js` | Webhook booking + addon paths wire claim-before-mutation |
| `scripts/verify-radar-slice16m-stripe-event-claim.js` | Offline RED/GREEN verifier |
| `fixtures/radar-operations/slice16m-expected-contract.json` | Frozen independent contract |
| `npm run verify:radar-slice16m-stripe-event-claim` | Gate |

## Bounded contract

| Bound | Value |
|-------|--------|
| Paths | `booking_payment`, `addon_service` only |
| Claim SQL | `ON CONFLICT (stripe_event_id) DO NOTHING RETURNING id` |
| Ownership column | `client_id` (001_init `hostel_id`) |
| Duplicate | HTTP 200 `idempotent` `reason=stripe_event_id_already_claimed` |
| Failure | ROLLBACK + HTTP 500 (never ack after partial failure) |
| Payload | allowlisted non-PII identifiers/state only |
| Forbidden | raw Stripe event/session/customer; email/phone/name/addresses/tokens |
| Out of scope | ignored/unmatched/invalid events; DLQ; replay operator; deploy |

## Verdict counts

| Verdict | Count | Meaning |
|---------|------:|---------|
| `proven` | 0 | Control fully evidenced end-to-end (incl. live deploy + concurrency + drill) |
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
| G08 | Retention / privacy | `partial` (16K healthz source still partial) |
| G09 | Cost controls | `partial` (16B budget-threshold source still partial) |

## G05 semantics (truthful)

| Sub-control | Status | Notes |
|-------------|--------|-------|
| Stripe event-id claim before mutations (source) | `partial` | booking + addon paths; same txn |
| Schema UNIQUE `stripe_event_id` | present | 001_init (no new migration) |
| Live deploy of claim path | `open` | Not claimed |
| Live concurrency proof | `open` | Not claimed |
| Replay operator / stuck recovery | `open` | Not claimed |
| DLQ | `open` | Not claimed |
| Controlled replay drill | `open` | Not claimed |
| All event types claimed | out of scope | Ignored/unmatched unchanged |

## Slice 16M progress

**ID:** `16M_stripe_webhook_event_id_claim`
**Gate:** `G05_retry_replay_safety`
**Progress class:** `source_partial_progress_only`
**Does not implement:** live deploy, concurrency proof, replay operator, DLQ, drill

### Still open

- Live deploy of Staff API image with event-id claim
- Live concurrency proof under real Postgres UNIQUE contention
- Replay operator / stuck `processed=false` recovery
- DLQ for unprocessable webhook events
- Controlled replay drill

## Prior partial progress retained

- **16L** `16L_staff_api_capacity_pressure_alerts` on G06 — source-partial capacity alerts (not deployed)
- **16K** `16K_staff_api_healthz_minimization` on G08 — source-partial healthz (not deployed)
- **16J** `16J_staff_api_request_correlation` on G01 — source-partial correlation (not deployed)
- **16I** `16I_staff_api_readiness_dependencies` on G02 — source-partial readiness (not deployed)
- **16H** `16H_staff_api_metric_alerts` on G03 — source-partial metric alerts (not deployed)
- **16B** `16B_staging_rg_cost_budget_threshold` on G09 — budget-threshold source-partial (not deployed)

## Zero-mutation (this slice)

No deploy/restart/DB/secret/guest/payment/production mutation in 16M. Database, Hermes staging, staging Bicep, and 16H metric-alert module must remain unchanged vs master basis. Staff API Stripe webhook claim helper + wiring are intentional 16M ownership.
