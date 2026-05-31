# Stage 7 — Production Hardening + Pilot Deployment Plan

**Status:** PLANNING (2026-05-31) — Stage 7.0 plan DONE · Stage 7.1 env/secrets inventory DONE · Stage 7.2 auth/staff-accounts design DONE · Stage 7.3 staging deployment + TLS design DONE · Stage 7.4 backup/restore + rollback plan DONE · Stage 7.5 monitoring + alerting plan DONE · Stage 7.6 pilot readiness go/no-go checklist DONE. No implementation; no pilot approved; live operation NOT approved.
**Prerequisites:** Stage 4 CLOSE WITH DEFERRALS (`6cd9a21`). Stage 5 SoT cleanup CLOSE WITH DEFERRALS (`ae545a2`). Stage 6 CLOSED WITH DEFERRALS (`f7813d3`).
**Scope:** Prepare Wolfhouse for a controlled pilot. Harden the local/dev proof into a deployable staging/pilot setup. Keep live WhatsApp / live Stripe / autonomous sends **disabled** until explicit go/no-go gates pass.

> This is a planning document only. It approves **nothing** for live operation. Every live capability (real WhatsApp send, live Stripe, autonomous confirmation, UI write controls) remains gated behind explicit owner approval and the go/no-go checklist below.

---

## Objective

Take the proven local/dev system (guest dry-run, SoT cleanup, staff assistant) and make it **safely deployable and operable** for a controlled Wolfhouse pilot, without enabling any dangerous live path before its gate passes.

Stage 7 succeeds when:
- There is a clear local / staging / production separation with isolated data and secrets.
- A production-grade auth model exists for any staff write surface (today's operator token is local/dev only).
- TLS, deployment, monitoring, backups, and rollback are defined and drilled.
- A pilot soak plan with explicit go/no-go gates exists and is agreed with the owner (Ale/Cami).
- Live WhatsApp, live Stripe, and Airtable cutover each have a written gate that is **not yet passed**.

**Non-goals for Stage 7:** turning on live operation, removing Airtable, full multi-client production scale, owner analytics dashboard. Those are gated or deferred.

---

## Current baseline (what Stage 7 starts from)

| Capability | State entering Stage 7 |
|---|---|
| Guest assistant (Luna) | Dry-run proven (Stage 4); `WHATSAPP_DRY_RUN=true` |
| Source of truth | Postgres schemas + cleanup proven (Stage 5); Airtable still bridge |
| Staff assistant | CLI + read-only HTTP API + read-only UI + token-gated write endpoint (Stage 6), local/dev only |
| Payments | Stripe **test** mode; webhook owns payment truth; no live keys |
| WhatsApp | Dry-run; no real send approved |
| Auth | None in production; operator token local/dev only (`STAFF_OPERATOR_TOKEN`) |
| Deployment | Local docker compose (`infra/docker-compose.local.yml`); no staging/prod |
| Workflows | Inactive by default; activated only per approved test |

---

## Stage 7 workstreams

### A. Environment separation

- **Three environments:** `local`, `staging`, `production`. No shared data across them.
- **Separate databases:** distinct Wolfhouse app DB + n8n internal DB per environment. No prod data in local/staging.
- **Separate n8n instances/workflows:** staging and production each have their own n8n; workflows imported per environment, **inactive by default**.
- **Separate Stripe keys:** `sk_test_*` for local/staging; `sk_live_*` only in production and only after the Live Stripe gate (J) passes.
- **Separate WhatsApp channels:** test number / sandbox for staging; real business number only after the Live WhatsApp gate (I) passes.
- **Config:** per-environment `.env` (never committed); secrets via a secrets manager (C), not files.

### B. Auth and staff accounts

- **Today:** `STAFF_OPERATOR_TOKEN` single shared token, `STAFF_ACTIONS_ENABLED` flag — **local/dev only, never production**.
- **Production requirement before any UI write or remote write:** real authentication (per-user accounts, hashed credentials or SSO), session/token management, and role-based authorization.
- **Roles (minimum):** `viewer` (read-only queries), `operator` (resolve handoffs, mark add-ons), `admin` (config, user management).
- **`staff_directory`:** real staff users mapped to roles; approved-staff allowlist enforced server-side.
- **Gate:** No staff **write** surface (UI button or remote API write) is enabled until production auth + TLS are in place. The operator token must not be reused as production auth.

### C. TLS / deployment

- **HTTPS everywhere:** no plaintext for staff UI, API, or webhooks in staging/production.
- **Domain/subdomain:** dedicated subdomain for staff surface and for n8n webhooks (e.g. `staff.*`, `hooks.*`).
- **Deployment target:** containerized (compose → managed host / Azure per [`azure-n8n-hosting-plan.md`](azure-n8n-hosting-plan.md) when approved). Reproducible from `infra/`.
- **Secrets management:** environment secrets (DB, Stripe live, WhatsApp tokens, `N8N_ENCRYPTION_KEY`) stored in a managed secret store, injected at deploy, never committed. `STRIPE_WEBHOOK_SKIP_VERIFY=false` in production (must verify signatures).

### D. Monitoring and alerting

Alert on:
- **Workflow failures** (n8n execution errors, stuck executions).
- **API errors** (staff query/write API 5xx, elevated 4xx).
- **Payment webhook failures** (Stripe webhook non-200, signature failures, missing payment truth).
- **WhatsApp send failures** (Graph API errors once live).
- **Stuck handoffs** (open `staff_handoffs` beyond SLA; unresolved escalations).
- **Health checks** for DB, n8n, redis, staff API.

### E. Backups and restore

- **Postgres backups:** scheduled automated backups of the Wolfhouse app DB (and n8n internal DB) in staging/production; retention policy defined.
- **Restore drill:** documented and **executed at least once** in staging before pilot — prove a backup actually restores.
- **Migration rollback:** every migration (007/008 and future) has a tested down/rollback path or a documented forward-fix; no destructive migration without a rollback plan.

### F. Audit logs

- **Query/action logs:** the existing `logs/staff-query-log.jsonl` pattern promoted to durable, queryable storage in staging/production (not just a local file).
- **Guest-message action logs:** record bot actions (route decisions, payment links issued, confirmations) for traceability.
- **Admin actions:** auth events, role changes, config edits, write actions (who/what/when), tamper-evident where feasible.

### G. Data privacy / retention

- **Guest data:** inventory of personal data stored (name, phone, email, messages); documented purpose and access.
- **WhatsApp conversation data:** retention window defined; not retained indefinitely without reason.
- **Deletion/export basics:** ability to export and delete a guest's data on request (GDPR-style baseline), even if manual at pilot.

### H. Airtable cutover plan

- **Critical-path exit condition:** Airtable may stop being critical path only when the staff surface (UI/API/reports) covers **all** use cases Airtable currently serves for daily ops.
- **Parity checklist:** enumerate every Airtable daily-ops use case and map to a Postgres/staff-surface equivalent before cutover.
- **Dual-write soak:** run Postgres-authoritative with Airtable mirror for a soak window; compare drift (existing drift reports) before removing Airtable.
- **Rollback:** ability to fall back to Airtable if cutover reveals gaps. Cutover is a first-class, reversible event — not a one-way switch.

### I. Live WhatsApp gate

- **Before any real send:** `WHATSAPP_DRY_RUN=true` stays the default; real send requires explicit owner approval + verified WhatsApp Business credentials.
- **Shadow/co-pilot first:** reuse Stage 3y Mode A — bot drafts, staff approve & send manually — before any autonomous send.
- **Requirements:** message-template approval, opt-in/consent posture, send-failure alerting (D), rate/cost awareness.

### J. Live Stripe gate

- **Test-mode soak:** extended run in Stripe test mode covering deposit, balance, full-pay, refund/cancel scenarios.
- **Webhook idempotency:** prove idempotent handling of duplicate/replayed webhooks (deferred fixture from Stage 5.3) before live keys.
- **Payment truth:** Stripe Webhook Handler remains the **only** writer of `payments`/`payment_events`; signature verification on (`STRIPE_WEBHOOK_SKIP_VERIFY=false`).
- **Refund/cancellation policy:** documented and agreed with owner before live charges.

### K. Pilot soak plan (staged enablement)

Progressive, each step gated:
1. **Staff-only / read-only:** staff use queries/reports/UI against real (or realistic) data. No writes, no sends.
2. **Shadow mode:** Luna drafts on real inbound; staff approve/send manually (Stage 3y Mode A). No autonomous action.
3. **Limited automation:** narrow, low-risk automated replies/actions behind feature flags; everything else handed off.
4. **Monitored live mode:** broader automation under close monitoring, with incident/rollback (L) ready.

### L. Incident / rollback plan

Fast levers, documented and drilled:
- **Disable Luna sends:** flip `WHATSAPP_DRY_RUN=true` (or kill switch) to stop all real sends immediately.
- **Disable payment links:** stop issuing new Stripe checkout sessions.
- **Revert workflows:** deactivate affected n8n workflows; restore last known-good import.
- **Staff takeover:** all in-flight conversations fall back to human handling.
- **Comms:** who is notified, who decides, where the runbook lives.

### M. Client onboarding checklist (Wolfhouse pilot)

Before pilot go-live, confirm with owner (Ale/Cami):
- [ ] Packages and prices verified for the pilot season.
- [ ] Lesson / dinner / transfer / rental config confirmed.
- [ ] Cleaning / housekeeping rules confirmed (if surfaced).
- [ ] Staff users + roles confirmed (B).
- [ ] Reminder / confirmation message templates approved.
- [ ] Cancellation / refund policy confirmed (J).
- [ ] Escalation / handoff routing confirmed.

---

## Implementation slices

| Slice | Name | Scope | Status |
|---|---|---|---|
| 7.0 | Planning | This document | DONE |
| 7.1 | Environment / secrets inventory | Enumerate local/staging/prod env vars, secrets, integration keys; secrets-manager plan | **DONE** — [PHASE-7.1-ENV-SECRETS-INVENTORY.md](PHASE-7.1-ENV-SECRETS-INVENTORY.md) |
| 7.2 | Auth model + staff accounts | Roles, `staff_directory`, production auth design; operator token scoped to local/dev | **DONE (design)** — [`PHASE-7.2-AUTH-STAFF-ACCOUNTS-PLAN.md`](PHASE-7.2-AUTH-STAFF-ACCOUNTS-PLAN.md) |
| 7.3 | Staging deployment plan | HTTPS, domain, deploy target, reproducible from `infra/`; staging stands up with workflows inactive | **DONE (design)** — [`PHASE-7.3-STAGING-DEPLOYMENT-TLS-PLAN.md`](PHASE-7.3-STAGING-DEPLOYMENT-TLS-PLAN.md) |
| 7.4 | Backup/restore + migration rollback | Automated backups; restore drill executed in staging; rollback paths for migrations | **DONE (design)** — [`PHASE-7.4-BACKUP-RESTORE-ROLLBACK-PLAN.md`](PHASE-7.4-BACKUP-RESTORE-ROLLBACK-PLAN.md) |
| 7.5 | Monitoring / error alerting | Failure/error/webhook/send/stuck-handoff alerts; health checks | **DONE (design)** — [`PHASE-7.5-MONITORING-ALERTING-PLAN.md`](PHASE-7.5-MONITORING-ALERTING-PLAN.md) |
| 7.6 | Pilot checklist + go/no-go gates | Finalize go/no-go; owner sign-off process | **DONE (checklist defined)** — [`PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md`](PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md) |
| 7.7 | Shadow / co-pilot live inbound | Stage 3y Mode A on real inbound; staff approve/send manually; no autonomous action | PENDING (gated) |
| 7.8 | Limited live send approval | First narrow real WhatsApp sends behind flag + approval | PENDING (gated) |
| 7.9 | Limited live payment approval | First live Stripe behind test-soak + idempotency + approval | PENDING (gated) |
| 7.10 | Airtable cutover readiness review | Parity checklist, dual-write soak, drift review, rollback | PENDING (gated) |
| 7.11 | Multi-client readiness baseline | Confirm `client_id` isolation + config seam holds for a 2nd client (no live) | PENDING |

---

## Go / No-Go checklist (all must hold before any live operation)

- [ ] All n8n workflows **inactive by default**, except the explicitly approved pilot workflow(s).
- [ ] `WHATSAPP_DRY_RUN=true` remains the default until the Live WhatsApp gate (I) passes with owner approval.
- [ ] `STAFF_ACTIONS_ENABLED=false` by default; enabled only with production auth + TLS in place.
- [ ] Production **auth + TLS present** before any staff write surface (UI button or remote write).
- [ ] **Backups verified** (automated + retention) and a **restore drill executed** in staging.
- [ ] **Rollback tested** (incident levers in L drilled; migration rollback paths proven).
- [ ] **Audit logs verified** durable and queryable (query/action, guest-message, admin actions).
- [ ] **Staff training done** (operators know the tools and the takeover/incident process).
- [ ] **Ale/Cami approval** for packages/prices/policy/config (onboarding checklist M complete).
- [ ] **No live Stripe** until the Live Stripe gate (J) passes with explicit approval.
- [ ] **No real confirmation sends** until explicit approval (Live WhatsApp gate I).
- [ ] **Stripe signature verification on** in production (`STRIPE_WEBHOOK_SKIP_VERIFY=false`).

---

## Product roadmap mapping

| Stage 7 workstream(s) | Master roadmap pillar |
|---|---|
| C, D, E, F, G, L | **13 — Production Hardening** |
| A, 7.11 | **8 — Multi-Client Config System** |
| M | **9 — Client Onboarding System** |
| H (Airtable cutover), future integrations | **10 — PMS / Integration Layer** (partially planned) |
| B (roles/admin) | **14 — Multi-Client Admin** (planned) |
| K, 7.8–7.11 | **15 — Productization / Scale** (planned) |

---

## Deferrals (remain deferred at end of Stage 7 planning)

- Live WhatsApp send (gated, I).
- Live Stripe / live guest payments (gated, J).
- Autonomous confirmation/cancellation sends (gated, K).
- UI write controls (gated on B + C).
- Airtable removal as critical path (gated, H).
- Full multi-client production scale, billing/subscription model.
- Owner analytics dashboard.
- PMS/channel-manager integrations beyond planning.

---

## Stage 7 planning closeout (2026-05-31)

**Planning status:** CLOSED WITH DESIGN DONE (slices 7.0–7.6). **Implementation status:** NOT STARTED. **Pilot decision:** NO_GO — all 79 gates in [`PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md`](PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md) must PASS before any live operation.

### Planning closeout matrix

| Slice | Name | Status | Doc | Implementation still pending | Hard gate before pilot |
|---|---|---|---|---|---|
| **7.0** | Production hardening + pilot plan | **DESIGN DONE** | [`PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md`](PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md) | Nothing — this is the plan | — |
| **7.1** | Environment / secrets inventory | **DESIGN DONE** | [`PHASE-7.1-ENV-SECRETS-INVENTORY.md`](PHASE-7.1-ENV-SECRETS-INVENTORY.md) | Azure Key Vault provisioned; staging env vars set; `.env.example` placeholders added ✓ | Gates A1–A9 in 7.6 |
| **7.2** | Auth model + staff accounts | **DESIGN DONE** | [`PHASE-7.2-AUTH-STAFF-ACCOUNTS-PLAN.md`](PHASE-7.2-AUTH-STAFF-ACCOUNTS-PLAN.md) | Migration 009 (`staff_users`/`auth_sessions`) not created; auth middleware not built; login/logout not implemented; staff accounts not created | Gates B1–B8 in 7.6 |
| **7.3** | Staging deployment + TLS | **DESIGN DONE** | [`PHASE-7.3-STAGING-DEPLOYMENT-TLS-PLAN.md`](PHASE-7.3-STAGING-DEPLOYMENT-TLS-PLAN.md) | Azure Container Apps not created; DNS not configured; TLS not active; staging Postgres not provisioned; Key Vault not provisioned | Gates C1–C9 in 7.6 |
| **7.4** | Backup / restore + rollback | **DESIGN DONE** | [`PHASE-7.4-BACKUP-RESTORE-ROLLBACK-PLAN.md`](PHASE-7.4-BACKUP-RESTORE-ROLLBACK-PLAN.md) | Backup not configured; restore drill not executed; emergency toggles not drilled; migration 009 rollback pending migration creation | Gates D1–D6 in 7.6 |
| **7.5** | Monitoring / alerting | **DESIGN DONE** | [`PHASE-7.5-MONITORING-ALERTING-PLAN.md`](PHASE-7.5-MONITORING-ALERTING-PLAN.md) | Azure Monitor alerts not created; n8n error workflow not built; business-state queries not scheduled; audit log not wired to Log Analytics | Gates E1–E8 in 7.6 |
| **7.6** | Pilot readiness go/no-go checklist | **DESIGN DONE** | [`PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md`](PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md) | 76 of 79 gates NOT_STARTED; pilot decision recorded as NO_GO | All 79 gates must PASS |

### What Stage 7 planning has achieved

- All production-hardening areas identified and documented (env, auth, TLS, backup, monitoring, pilot phases).
- Azure Container Apps confirmed as the staging/production deployment target (aligned with [`azure-n8n-hosting-plan.md`](azure-n8n-hosting-plan.md)).
- Auth model chosen: per-user email/password + hashed passwords + secure session cookies for staging/pilot; operator token scoped to local/dev only.
- Backup/restore strategy defined: Azure Postgres automated backups; restore drill required before pilot.
- Monitoring and alerting strategy defined: 7-category scope; P0–P3 model; 10 runbooks.
- Pilot readiness checklist created: 79 gates, 11 sections, 5 pilot phases, hard no-go conditions.
- **Live operation remains blocked and is not approved by any of these docs.**

### What is NOT done (implementation pending)

- No Azure resources created (Container Apps, Postgres, Redis, Key Vault, Azure Monitor).
- No staging deployment, DNS, TLS, or domain configured.
- No production auth implemented (migration 009 not created; middleware not built; no login/logout).
- No staff accounts created (no Cami or Ale accounts).
- No restore drill executed.
- No monitoring or alerts configured.
- No Cami review dashboard (conversation inbox, draft review, handoff queue UI).
- No live WhatsApp send (dry-run only; `WHATSAPP_DRY_RUN=true`).
- No live Stripe (test mode only; no `sk_live_*`).
- No Airtable cutover.
- Slices 7.7–7.11 not started (shadow/co-pilot live, live send, live payment, Airtable cutover, multi-client readiness).

### Recommended first implementation tasks

| Priority | Task | Why first |
|---|---|---|
| 1 | **7.2b — Migration 009** (`staff_users` / `auth_sessions` schema) | Auth schema is the foundation — everything else (login, sessions, role enforcement) depends on it. Small, safe, additive, follows the existing migration pattern. |
| 2 | **7.2c — Auth middleware scaffold** (local static proof) | Can be done without staging; proves the session + role enforcement works locally before any deploy. |
| 3 | **7.3b — Azure resource plan/scaffold** | Once auth schema exists, Azure resource creation unblocks staging deploy. Key Vault and Postgres must exist before migration 009 can be applied to staging. |
| 4 | **Cami review dashboard (plan → build)** | Highest priority from a Wolfhouse operations standpoint — Cami cannot do meaningful shadow-mode review without a dashboard that shows draft, context, and handoff queue. Gates F1–F7 in 7.6. |
| 5 | **7.4c — Restore drill** | Requires staging DB to exist (depends on 7.3b); execute after first successful staging deploy. |

**Recommended first prompt:** `7.2b — migration 009 staff auth schema`. It is a self-contained, local, docs + migration task that unlocks all downstream auth work and can be written, verified, and committed without touching Azure.

---

## Next recommended prompt

```
Use Sonnet. Static implementation + local proof. Minimize API use.

Task: Stage 7.2b — migration 009 staff auth schema.

Goal: Create database/migrations/009_auth_staff_users.sql following
the existing migration conventions (idempotent CREATE TABLE IF NOT
EXISTS, CHECK constraints, set_updated_at trigger, UUID PKs). Define
staff_users and auth_sessions tables as designed in PHASE-7.2-AUTH-
STAFF-ACCOUNTS-PLAN.md. Apply to local dev DB. Run a static verifier.
Do not build auth middleware or login in this task.
```
