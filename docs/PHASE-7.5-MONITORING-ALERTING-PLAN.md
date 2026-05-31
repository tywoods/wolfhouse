# Stage 7.5 — Monitoring and Error Alerting Plan

**Status:** PLANNING / DESIGN DONE (2026-05-31). No implementation; no alerts configured; no Azure Monitor resources created.
**Parent plan:** [`PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md`](PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md) — Workstream D (monitoring and alerting).
**Depends on:** [`PHASE-7.3-STAGING-DEPLOYMENT-TLS-PLAN.md`](PHASE-7.3-STAGING-DEPLOYMENT-TLS-PLAN.md) (Azure Monitor/App Insights topology), [`PHASE-7.4-BACKUP-RESTORE-ROLLBACK-PLAN.md`](PHASE-7.4-BACKUP-RESTORE-ROLLBACK-PLAN.md) (emergency toggles + incident runbook).
**Scope:** Monitoring scope, severity model, alert destinations, health checks, runbooks, ownership, and go/no-go gate. Covers staff API/UI, n8n workflows, WhatsApp/Meta, Stripe, Postgres/Redis, business-state monitors, and audit log gaps.

> This is a design document only. Nothing is implemented, configured, or deployed. No Azure resources are created. No alerts fire. No live operation is approved.

---

## 1. Objective

- No pilot or staging operation without **basic monitoring and alerting** in place.
- **Detect failures before staff or guests are impacted** — failures should not be discovered by a confused guest or a missed payment.
- **Define who responds**, how fast, and what emergency toggle or runbook applies.
- **Ensure audit logs are durable** enough to investigate incidents after the fact.

Entry criterion for pilot (gate §9): all P0/P1 alert paths must be active; all emergency toggles documented and drilled (per [`PHASE-7.4 §7`](PHASE-7.4-BACKUP-RESTORE-ROLLBACK-PLAN.md)).

---

## 2. Monitoring scope

### A. Staff API/UI health

| Signal | What to detect | Severity |
|---|---|---|
| HTTP 5xx rate on `/staff/*` | API failure / crash | P1 |
| HTTP 5xx on `POST /staff/handoff/:id/resolve` | Write endpoint failure | P1 |
| API response latency > 5 s | Degraded performance | P2 |
| `GET /staff/intents` non-200 | Registry unavailable | P1 |
| `GET /staff/query` non-200 | Query surface down | P1 |
| `GET /staff/ui` non-200 | Staff browser UI unreachable | P2 |
| Auth/session rejection spike (once 7.2 implemented) | Auth failure / mis-config | P1 |
| `STAFF_ACTIONS_ENABLED=true` without TLS | Danger config | P0 |
| Audit log write failure (JSONL or durable store) | Audit gap — writes invisible | P1 |

### B. n8n workflow health

| Signal | What to detect | Severity |
|---|---|---|
| Main workflow (`Wolfhouse Booking Assistant - Main`) failure | Guest messages not processed | P0 |
| `Send Confirmation` workflow failure | Confirmations not sent | P0 |
| `Stripe Webhook Handler` failure | Payment truth not recorded | P0 |
| `Create Payment Session` failure | Payment links not created | P0 |
| Cancel/Assign/Reassign workflow failure | Bed ops blocked | P1 |
| Any workflow unexpectedly active outside test window | Active-state drift | P1 |
| Schedule node firing unexpectedly (disabled nodes running) | Run drift / rogue execution | P1 |
| `automation_errors` table: new open rows | Execution error logged | P1 |
| n8n worker queue depth > threshold | Worker overload / stuck | P2 |
| n8n executor count stalled (no executions completing) | Worker hung | P1 |

### C. WhatsApp / Meta

| Signal | What to detect | Severity |
|---|---|---|
| Graph API call returning non-200 from a send node | Message not delivered | P0 (if live) / P1 (if staging) |
| Rate-limit errors (429 from Meta) | Sending paused by Meta | P0 (if live) |
| WhatsApp token auth error (401/403) | Expired or revoked token | P0 (if live) |
| Inbound webhook non-200 response from n8n (Meta retries) | Inbound messages not processed | P0 |
| `WHATSAPP_DRY_RUN=false` in staging or unexpected env | Live send from staging | **P0 — danger** |
| `WHATSAPP_DRY_RUN` env var unset | Ambiguous send state | P1 |

### D. Stripe

| Signal | What to detect | Severity |
|---|---|---|
| Stripe webhook delivery failure (non-200 from n8n webhook endpoint) | Payment truth not recorded; Stripe retries | P0 |
| Webhook signature verification failure | `STRIPE_WEBHOOK_SKIP_VERIFY=true` in staging/prod, or wrong secret | P0 |
| Duplicate `checkout.session.completed` event processed twice | Idempotency failure | P0 |
| `payment_events` insert failure | Payment ledger broken | P0 |
| `Create Payment Session` returning error or no `checkout_url` | Guest cannot pay | P0 |
| `sk_live_*` key present in staging | Danger config — live charge from staging | **P0 — danger** |
| Stripe Dashboard: unexpected live charges | Unintended real charges | P0 |

### E. Postgres / Redis

| Signal | What to detect | Severity |
|---|---|---|
| App DB connection failure | All Postgres-backed operations down | P0 |
| n8n system DB connection failure | Workflows stop executing | P0 |
| DB storage > 80% capacity | Risk of storage exhaustion | P1 |
| Slow queries (> 2 s average on staff query API) | Performance degradation | P2 |
| Migration failure (non-zero exit from migration script) | Schema mismatch | P1 |
| Azure Postgres backup failure | Backup go/no-go block | P1 |
| Redis queue depth > threshold (n8n queue mode) | Worker backlog growing | P2 |
| Redis connection failure | n8n queue mode stalled | P1 |

### F. Business-state monitors

These are not infrastructure alerts — they are operational queries against the app DB that detect stuck or unhealthy booking/handoff states. Run on a schedule (e.g. nightly or before each shift).

| Monitor | Query target | Threshold | Severity | Owner |
|---|---|---|---|---|
| Stuck `payment_pending` bookings | `bookings` where `payment_status='not_requested'` AND `status='hold'` AND `created_at < NOW() - hold_expiry_minutes` | > 0 | P2 | Dev/ops → staff |
| Expired holds not released | `bookings` where `status='hold'` AND `hold_expires_at < NOW()` | > 0 | P2 | Dev/ops |
| Confirmation pending > 24 h | `bookings` where `send_confirmation=true` AND `confirmation_sent_at IS NULL` AND `updated_at < NOW() - INTERVAL '24h'` | > 0 | P1 | Dev/ops → staff |
| Open urgent handoffs > SLA | `staff_handoffs` where `status IN ('open','assigned')` AND `priority='urgent'` AND `opened_at < NOW() - INTERVAL '2h'` | > 0 | P1 | Staff (Cami) |
| Stale open handoffs > N hours | `staff_handoffs` where `status='open'` AND `opened_at < NOW() - INTERVAL '12h'` | > 0 | P2 | Staff (Cami) |
| `payment_claimed` handoffs open | `staff_handoffs` where `reason_code='payment_claim'` AND `status='open'` | > 0 | P1 | Staff (Cami) |
| Lesson reminder missing schedule (future) | `lesson_requests` without a scheduled slot within N days of check-in | > 0 | P2 | Staff |
| Transfer missing flight info (future) | `add_on_orders` of type `airport_transfer` missing `flight_number` or `arrival_time` | > 0 | P2 | Staff |
| Housekeeping high-turnover date not reviewed (future) | Days with > threshold check-ins+check-outs and no housekeeping record | > 0 | P2 | Staff |

### G. Audit / logging gaps

| Signal | What to detect | Severity |
|---|---|---|
| Staff action (write) with no audit row written | Write with no accountability | P1 |
| Staff query with no audit row | Query surface invisible | P2 |
| `staff-query-log.jsonl` write failing (local/dev) | Audit path broken | P2 |
| Durable audit store (Log Analytics) not receiving rows (staging/prod) | Audit durability gap | P1 |
| `workflow_events` table: no new rows after workflow execution | Observability broken | P2 |
| `automation_errors` table: rows with `resolved=false` > 24 h old | Unresolved errors accumulating | P1 |

---

## 3. Alert severity model

| Level | Definition | Examples | Response time target | Owner | Default action |
|---|---|---|---|---|---|
| **P0** | Live guest or payment at risk; danger config detected | Main workflow down; payment webhook failing; live key in staging; dry-run unexpectedly off; DB down; WhatsApp token expired with live sends enabled | **Immediate** (< 15 min) | Ty (ops) first; Cami/Ale notified | Emergency toggle (per §7 / [`PHASE-7.4 §7`](PHASE-7.4-BACKUP-RESTORE-ROLLBACK-PLAN.md)); stop sends; snapshot DB; escalate |
| **P1** | Staff workflow blocked or significant degradation; audit gap; stale urgent handoff | API 5xx; confirmation stuck; urgent handoff > SLA; auth failure spike; active-state drift; backup failure | **< 1 hour** (during operating hours) | Ty (ops); Cami for operational P1s | Diagnose; apply emergency toggle if needed; notify Cami/Ale |
| **P2** | Degraded / stuck operation; non-urgent backlog accumulating | Slow queries; stale open handoffs; expired holds; lesson reminder missing; high latency | **< 4 hours** / next shift | Ty (ops) or staff | Investigate; fix in next window; no emergency toggle needed |
| **P3** | Informational; trend-watching | Daily digest; execution counts; audit row counts; queue depth | **Daily review** | Ty (ops) | Log; review in daily digest |

---

## 4. Alert destinations

| Channel | Staging | Pilot | Production (later) |
|---|---|---|---|
| **Azure Monitor / Application Insights alerts** | Configure for P0/P1 | Configure for P0/P1 | Full coverage |
| **Email to ops** (Ty) | P0/P1 alerts | P0/P1 alerts | P0/P1 alerts |
| **Email/message to Cami** | P0 + operational P1 (stale handoffs, confirmation stuck) | P0 + operational P1 | P0 + operational P1 |
| **n8n error notification workflow** | Optional: trigger a notification workflow on `automation_errors` new row | Active | Active |
| **Daily staff digest** | Manual review (existing `report:digest` CLI) | Staff UI digest or scheduled report | Automated email digest |
| **Slack / Teams / WhatsApp admin group** (later) | Not required for staging | Recommended for pilot | Required for production |
| **Escalation path** | Ty → Ale | Ty → Ale → escalation decision | Defined runbook |

**Pilot recommendation:** Azure Monitor email alerts for P0/P1 + a shared WhatsApp staff group (Ty + Cami + Ale) for operational notifications. Daily digest via `report:digest` CLI or staff UI. Keep it simple — no external alerting platform dependency for the pilot.

---

## 5. Ownership and response

| Issue type | Primary contact | Can disable Luna sends | Can disable payment links | Can set human takeover | Can resolve handoffs |
|---|---|---|---|---|---|
| Infrastructure / ops (API down, DB failure, env danger) | **Ty** | Yes (env toggle / redeploy) | Yes (env toggle / redeploy) | Yes (deactivate Main workflow) | No (staff role) |
| Operational / guest-facing (stuck confirmation, urgent handoff) | **Cami** | No (must ask Ty) | No (must ask Ty) | Partial (can tell guests manually) | Yes (staff UI / CLI) |
| Business decisions (config change, payment dispute, refund) | **Ale** | No (must ask Ty for technical) | No (must ask Ty for technical) | Partial (owner authority) | Yes (admin role) |
| Finance / payments | **Ale** | No | No | No | No |
| Housekeeping / add-ons (later) | **Cami** / additional staff | No | No | No | Yes (operator role) |

**Emergency contact protocol:**
1. P0 detected → Ty acts immediately on the technical toggle; simultaneously notifies Cami + Ale in the staff WhatsApp group.
2. Ty cannot reach → Ale has owner authority to decide (but may not have technical access); Ty's runbook should be accessible offline.
3. Operational P1 (e.g. stale urgent handoff) → Cami handles via staff UI; notifies Ty if a technical cause is suspected.

---

## 6. Health checks

The following health checks must be executable (manually or automatically) before and during a pilot window.

| Check | Mechanism | Target | Pass condition |
|---|---|---|---|
| Staff API reachable | `GET /staff/intents` → HTTP 200 | `https://staff-staging.<domain>/staff/intents` | 200 + JSON with `intents` key |
| Read-only query | `GET /staff/query?intent=payments.waiting&client=wolfhouse-somo` → HTTP 200 | Same host | 200 + `success: true` |
| Staff UI reachable | `GET /staff/ui` → HTTP 200 | Same host | 200 + HTML response |
| DB connectivity | Staff API connects to Postgres and returns query results | Via the query health check above | Non-empty or empty-but-200 response |
| n8n health (if self-hosted) | `GET https://n8n-staging.<domain>/healthz` or n8n `/api/v1/health` | n8n Container App | 200 OK |
| Workflow active-state check | `GET /api/v1/workflows` in n8n (or a DB query) | All workflows `active=false` except approved | Zero unexpected active workflows |
| Redis health | `redis-cli ping` from the n8n worker container | Azure Cache for Redis | PONG |
| Stripe webhook endpoint | Stripe dashboard → webhook → last delivery status | `POST /webhook/stripe-*` | Most recent delivery 200 |
| WhatsApp webhook verification | Meta app console → webhook status | Active/subscribed | Verified and subscribed |
| `WHATSAPP_DRY_RUN` state | App env check / audit log inspection | Container App env | `true` unless Stage 7.8 gate passed |
| Backup configured | Azure portal → Postgres → Backup policy | Both Postgres servers | Automated backups enabled; retention ≥ 7 days |
| Audit log writable | Staff action → audit row appears in Log Analytics / durable store | Durable audit sink | Row appears within 60 s |

---

## 7. Runbooks

Each runbook follows: **Detection → Immediate action → Emergency toggle → Owner → Recovery verification.**

### 7.1 Staff API down (5xx / unreachable)

- **Detection:** `GET /staff/intents` returns non-200; Azure Monitor alert fires.
- **Immediate action:** check Container App logs (Azure portal / `az containerapp logs`); restart container if crash-looping; check DB connectivity.
- **Emergency toggle:** staff fall back to CLI (`npm run report:digest`) on local dev while API is down.
- **Owner:** Ty.
- **Recovery:** `GET /staff/intents` returns 200; confirm last audit row was written.

### 7.2 n8n workflow failure (Main / Confirmation / Stripe)

- **Detection:** `automation_errors` table has new open row; n8n execution history shows failure; Azure Monitor alert.
- **Immediate action:** deactivate the failing workflow immediately. Do not leave it active in a failing state. Inspect n8n execution log for the failing node.
- **Emergency toggle:** deactivate workflow → all affected operations go to human handling.
- **Owner:** Ty (deactivate); Cami (handle guest manually).
- **Recovery:** fix root cause (credential issue, node logic, config); reimport inactive; activate in a new approved test window; verify one successful execution before resuming pilot.

### 7.3 Stripe webhook failing (non-200 / signature failure)

- **Detection:** Stripe Dashboard → Webhooks → recent deliveries show failures; `payment_events` row count not increasing after a payment.
- **Immediate action:** do **not** disable the webhook endpoint. Check n8n execution log. If signature failure: verify `STRIPE_WEBHOOK_SECRET` matches the Stripe dashboard signing secret. If `STRIPE_WEBHOOK_SKIP_VERIFY=true` in staging/prod: this is a P0 danger config — correct immediately.
- **Emergency toggle:** if endpoint is fundamentally broken, deactivate `Stripe Webhook Handler` (Stripe will retry for 72 h); this gives a window to fix without losing events.
- **Owner:** Ty.
- **Recovery:** verify `payment_events` insert succeeds on next delivery; confirm `payments.status` updated correctly; reconcile any gap period manually.

### 7.4 WhatsApp send failure

- **Detection:** Graph API call returning non-200 in n8n execution log; WhatsApp token/auth error in `automation_errors`.
- **Immediate action (if live sends enabled):** flip `WHATSAPP_DRY_RUN=true` immediately (redeploy or env update) to stop all outbound sends. Guest conversations fall to human handling.
- **Emergency toggle:** `WHATSAPP_DRY_RUN=true` (§7 / [`PHASE-7.4 §7`](PHASE-7.4-BACKUP-RESTORE-ROLLBACK-PLAN.md)).
- **Owner:** Ty; notify Cami.
- **Recovery:** fix token (refresh in Meta console; update Key Vault); verify one dry-run send succeeds before re-enabling; flip `WHATSAPP_DRY_RUN=false` only with owner approval.

### 7.5 DB unavailable

- **Detection:** staff API health check fails with DB connection error; n8n Postgres nodes fail; Azure Monitor DB connectivity alert.
- **Immediate action:** all API requests fail; deactivate n8n workflows (if accessible). Check Azure Postgres server status. Do not attempt migrations during an outage.
- **Emergency toggle:** no application toggle helps — DB is the system of record. Notify Cami/Ale that all ops are paused.
- **Owner:** Ty.
- **Recovery:** once DB restored, verify table counts (bookings/payments/payment_events unchanged vs last known); run health check suite (§6); resume gradually.

### 7.6 Audit log unavailable / not writing

- **Detection:** staff action executed but no row in Log Analytics / audit file; gap in the durable audit store.
- **Immediate action (if staging):** continue operations but log the gap; investigate before pilot.
- **Immediate action (if pilot):** pause write operations (`STAFF_ACTIONS_ENABLED=false`) until audit durability is restored — writes without audit trail violate the go/no-go gate.
- **Owner:** Ty.
- **Recovery:** restore durable log sink (Log Analytics workspace, or `staff_audit` table); verify audit row for a test action appears within 60 s; re-enable writes.

### 7.7 Stuck payment / confirmation not sent

- **Detection:** business-state monitor query (§2-F): `send_confirmation=true` AND `confirmation_sent_at IS NULL` AND `updated_at < NOW() - INTERVAL '24h'`; Cami reports guest hasn't received confirmation.
- **Immediate action:** Cami notifies Ty. Ty checks `send_confirmation` flag and `payment_status` for the booking. If the `Send Confirmation` workflow failed, inspect execution log.
- **Emergency toggle:** manually trigger `Send Confirmation` via direct webhook POST (approved per Stage 3d runbook) with `booking_id` filter.
- **Owner:** Ty (technical trigger); Cami (guest comms).
- **Recovery:** confirm `confirmation_sent_at` set; `send_confirmation=false`; guest received message (dry-run: check draft).

### 7.8 Urgent handoff stale > SLA

- **Detection:** business-state monitor: urgent handoffs open > 2 h; Cami's staff UI shows unresolved urgent items.
- **Immediate action:** Cami reviews and resolves via staff UI or CLI. If handoff involves payment/refund, escalate to Ale.
- **Emergency toggle:** none needed — this is operational, not technical.
- **Owner:** Cami (operational); Ale (if payment decision needed).
- **Recovery:** handoff resolved; `status=resolved`, `resolved_at` set; `resolution_summary` written.

### 7.9 Accidental live-send risk (dry-run off unexpectedly)

- **Detection:** `WHATSAPP_DRY_RUN` env var missing or `false` in staging; Azure Monitor env check alert; real wamid appearing in execution logs outside a live-send gate.
- **Immediate action:** P0. Immediately redeploy Container App with `WHATSAPP_DRY_RUN=true`. Inspect last N executions to assess scope. Notify Cami/Ale.
- **Emergency toggle:** `WHATSAPP_DRY_RUN=true` (immediate redeploy).
- **Owner:** Ty.
- **Recovery:** confirm env var set correctly in Azure Container App settings; verify next execution dry-runs; document the incident; determine if real messages were sent and whether guests need follow-up.

### 7.10 Wrong environment / secrets detected

- **Detection:** `sk_live_*` Stripe key in staging env; `WOLFHOUSE_DATABASE_URL` pointing to production DB from staging; `N8N_ENCRYPTION_KEY` is the placeholder value in production.
- **Immediate action:** P0. Stop all operations immediately. Do not proceed with any data writes. Correct the env var via Key Vault + redeploy.
- **Emergency toggle:** deactivate all n8n workflows before correcting, to prevent any automated action on the wrong data.
- **Owner:** Ty.
- **Recovery:** verify correct env vars after redeploy via health check (§6); confirm no live charges or real messages occurred; document gap.

---

## 8. Go / No-Go gate for pilot

**Pilot is blocked if any of the following is true:**

| Block condition | Resolved by |
|---|---|
| No staff API health check configured and passing | §6 + Azure Monitor alert on `GET /staff/intents` |
| No n8n failure alert path (P0/P1) | §3-B + `automation_errors` monitor + Azure Monitor |
| No Stripe webhook failure alert | §3-D + Stripe dashboard webhook monitor + Azure Monitor |
| No WhatsApp send failure alert | §3-C + execution log monitor + Azure Monitor |
| No DB backup failure alert | §3-E + Azure Postgres backup monitoring |
| No durable audit log (file-only is not pilot-grade) | §2-G + §3-G + Log Analytics wired |
| No stuck handoff / payment monitor | §2-F — at least `confirmation_pending > 24h` and `urgent handoff > SLA` queries running |
| No ops owner assigned (Ty) and no backup contact (Ale) | §5 — named + contactable |
| Emergency toggles not documented AND drilled | [`PHASE-7.4 §7`](PHASE-7.4-BACKUP-RESTORE-ROLLBACK-PLAN.md) + §7 runbooks executed once in staging |

---

## 9. Planned future verifier (Stage 7.6+ or pre-pilot)

**`scripts/verify-monitoring-readiness.js`** — not implemented; requires explicit approval.

When built, it should:
- Confirm required docs (`PHASE-7.5-MONITORING-ALERTING-PLAN.md`) exist.
- Check that alert-related env vars or Azure resource IDs are set (e.g. `ALERT_WEBHOOK_URL`, `LOG_ANALYTICS_WORKSPACE_ID` if defined).
- Run the health check queries from §6 against the configured DB and API endpoint.
- Verify `WHATSAPP_DRY_RUN` is explicitly set and `true` (unless Stage 7.8 gate passed).
- Verify `STRIPE_WEBHOOK_SKIP_VERIFY` is not `true` in staging/production context.
- Verify `sk_live_*` key is not set outside the production context.
- Run the business-state stuck-state queries from §2-F and report counts.
- Exit 0 = monitoring-ready; Exit 1 = gap detected.

---

## 10. Implementation slices (future — gated, not started)

| Slice | Name | Scope | Status |
|---|---|---|---|
| 7.5a | Monitoring design | This document | **DONE** |
| 7.5b | Azure Monitor alert rules (P0/P1) | Create alert rules for API 5xx, DB connectivity, backup failure, dry-run danger config | PENDING |
| 7.5c | n8n error notification workflow | n8n workflow that fires on `automation_errors` new row and sends a notification | PENDING |
| 7.5d | Business-state monitor queries | Implement §2-F queries as scheduled CLI or staff query registry intents | PENDING |
| 7.5e | Durable audit log wiring | Promote `staff-query-log.jsonl` → Log Analytics / `staff_audit` table | PENDING |
| 7.5f | Health check suite automation | Automate §6 checks as a pre-pilot/pre-activation checklist script | PENDING |
| 7.5g | Daily staff digest automation | Scheduled `report:digest` or staff UI digest on a timer | PENDING |
| 7.5h | `verify-monitoring-readiness.js` (optional) | Implement §9 static + runtime checks if approved | DEFERRED / OPTIONAL |

Each slice is a separate approved task. None are started here.
