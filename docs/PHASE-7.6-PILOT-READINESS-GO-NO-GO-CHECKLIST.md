# Stage 7.6 — Pilot Readiness Go/No-Go Checklist

**Status:** PLANNING / CHECKLIST DEFINED (2026-06-01). No live operation approved. No pilot phase started. **7.3d updated 2026-06-01:** Azure staging deployed and login proven — relevant A/C gates updated to IMPLEMENTATION_PROVEN where infra is confirmed live. Final pilot decision remains NO_GO. **F8-CAL-EDIT updated 2026-06-01:** editable calendar staging gate checklist defined (7.7k8 — 17 gates, UI conditions, 6 approval phases, hard no-go conditions); edit controls not wired; all K8-G gates NOT_STARTED.
**Parent plan:** [`PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md`](PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md) — Workstream K (pilot soak) + Go/No-Go checklist.
**Consolidates gates from:** 7.1 (env/secrets) · 7.2 (auth) · 7.3 (staging/TLS) · 7.4 (backup/restore) · 7.5 (monitoring/alerting) + Cami dashboard, shadow-mode, payment, WhatsApp, client config, and staff training.

> **This document is the single pre-pilot gate.** No gate may be assumed. Every gate requires evidence, an owner, a date, and a recorded decision. Pilot begins in **shadow/co-pilot mode only** (Phase 1). No autonomous sends, no live payments, no autonomous actions until the appropriate later phase gate is explicitly passed.

---

## 1. Objective

- Consolidate all Stage 7 go/no-go conditions into **one decision document** that Ty and Ale/Cami step through before any live operation is approved.
- Provide a **single source of truth** for pilot readiness — not a checklist scattered across 5 design docs.
- Each gate has: status, owner, evidence, date, and a decision.
- Pilot begins in **Phase 1 (shadow/co-pilot mode)** only — no autonomous action until a later phase gate.

---

## 2. Decision states

| State | Meaning |
|---|---|
| `NOT_STARTED` | Gate not yet evaluated or work not begun |
| `BLOCKED` | Gate evaluated; a hard dependency is missing; cannot proceed |
| `PARTIAL` | Some work done; specific items outstanding; document what remains |
| `PASS` | Gate fully satisfied with evidence; approved to continue |
| `WAIVED_WITH_REASON` | Gate intentionally skipped; reason, risk, and owner recorded; must be time-limited |
| `NO_GO` | Gate fails; pilot must stop or must not start |
| `GO_SHADOW_ONLY` | Phase 1 approved; Luna drafts, staff approve/send manually; no autonomous action |
| `GO_LIMITED_LIVE_SEND` | Phase 2/3 approved; narrow autonomous send categories permitted after explicit gate |
| `GO_LIMITED_PAYMENT` | Phase 4 approved; test-mode payment links permitted in pilot after explicit gate |
| `GO_FULL_PILOT` | All phases approved; monitored live pilot under close observation |

**Current expected state (after Stage 7.6 design only):** all gates are `NOT_STARTED` or `PARTIAL (design)`. No `GO_*` state is granted by this document. The checklist is the tool — the sign-offs fill it in.

---

## 3. Sign-off ownership

| Role | Person | Responsibility |
|---|---|---|
| **Technical owner** | Ty | Infrastructure, deployment, secrets, monitoring, auth, backup/restore, emergency toggles |
| **Staff / operations** | Cami | Staff dashboard, handoff workflow, review process, day-to-day ops readiness |
| **Business owner** | Ale | Config/prices confirmed, policy decisions, owner-approval gates (live send, live payment) |
| **Final pilot decision** | Ty + Ale + Cami | All three must agree before any pilot phase advances |

No single person can advance a `GO_*` decision without all three sign-offs (or an explicit `WAIVED_WITH_REASON` recorded by the waiving owner).

---

## 4. Evidence format (per gate)

Each gate in §5 follows this structure:

```
Status:     [ NOT_STARTED | BLOCKED | PARTIAL | PASS | WAIVED_WITH_REASON | NO_GO ]
Owner:      [ name ]
Evidence:   [ commit / doc link / screenshot / log line / test result / drill record ]
Date:       [ YYYY-MM-DD ]
Notes:      [ anything relevant ]
Decision:   [ hold / proceed ]
```

---

## 5. Readiness checklist

### Section A — Environment / Secrets (from Stage 7.1)

*Reference: [`PHASE-7.1-ENV-SECRETS-INVENTORY.md`](PHASE-7.1-ENV-SECRETS-INVENTORY.md)*

| # | Gate | Status | Owner | Evidence | Date | Decision |
|---|---|---|---|---|---|---|
| A1 | Local / staging / production environments fully separated (separate DB, secrets, n8n) | PARTIAL (staging deployed; DNS/custom TLS pending) | Ty | 7.1 doc + 7.3 topology + 7.3d deployment proof | 2026-06-01 | Hold — DNS/custom TLS not yet configured |
| A2 | No shared database across environments | IMPLEMENTATION_PROVEN | Ty | Azure Postgres separate instances (`wh-staging-pg-app`, `wh-staging-pg-n8n`) provisioned and running | 2026-06-01 | Hold — verify no prod data present |
| A3 | `WHATSAPP_DRY_RUN` explicitly set and `true` in staging | IMPLEMENTATION_PROVEN | Ty | Hardcoded in `main.bicep`; confirmed by 7.3c/7.3d; `WHATSAPP_DRY_RUN=true` | 2026-06-01 | Proceed (staging) |
| A4 | `STAFF_ACTIONS_ENABLED=false` by default in staging | IMPLEMENTATION_PROVEN | Ty | Hardcoded in `main.bicep`; confirmed by 7.3c/7.3d; `STAFF_ACTIONS_ENABLED=false` | 2026-06-01 | Proceed (staging) |
| A5 | `STRIPE_WEBHOOK_SKIP_VERIFY=false` in staging | IMPLEMENTATION_PROVEN | Ty | Hardcoded in `main.bicep`; confirmed by 7.3c/7.3d | 2026-06-01 | Proceed (staging) |
| A6 | No `sk_live_*` Stripe key in staging or local | IMPLEMENTATION_PROVEN | Ty | No live Stripe key imported; no credentials imported into n8n; 7.3d confirms | 2026-06-01 | Proceed (staging) |
| A7 | Key Vault / secrets store configured; no secrets in repo | IMPLEMENTATION_PROVEN | Ty | Azure Key Vault provisioned; all secrets injected via KV secret refs; no secrets in repo (7.3c scaffold audit PASS) | 2026-06-01 | Hold — verify KV entries complete |
| A8 | `N8N_ENCRYPTION_KEY` is unique ≥32-char value from Key Vault (not placeholder) | NOT_STARTED | Ty | KV entry must be confirmed externally | — | Hold |
| A9 | `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` in staging | IMPLEMENTATION_PROVEN | Ty | Hardcoded in `main.bicep`; confirmed by 7.3c/7.3d | 2026-06-01 | Proceed (staging) |

### Section B — Auth / Staff Accounts (from Stage 7.2)

*Reference: [`PHASE-7.2-AUTH-STAFF-ACCOUNTS-PLAN.md`](PHASE-7.2-AUTH-STAFF-ACCOUNTS-PLAN.md)*

| # | Gate | Status | Owner | Evidence | Date | Decision |
|---|---|---|---|---|---|---|
| B1 | Per-user staff accounts implemented (email/password + hashed, migration 009 applied) | NOT_STARTED | Ty | Migration 009 applied; `staff_users` table exists | — | Hold |
| B2 | Viewer / operator / admin roles defined and enforced server-side | NOT_STARTED | Ty | Auth middleware in place; role matrix tested | — | Hold |
| B3 | Cami account created (admin + operator role) | NOT_STARTED | Ty + Cami | Account created; first login confirmed | — | Hold |
| B4 | Ale account created (admin + owner role) | NOT_STARTED | Ty + Ale | Account created; first login confirmed | — | Hold |
| B5 | Secure HTTP-only session cookies on HTTPS | NOT_STARTED | Ty | Verified via browser dev tools on staging HTTPS | — | Hold |
| B6 | `STAFF_OPERATOR_TOKEN` rejected / not set in staging | NOT_STARTED | Ty | Staging env verified; token path local-only | — | Hold |
| B7 | Staff write endpoint requires authenticated operator/admin (not open) | NOT_STARTED | Ty | Auth middleware test; anonymous POST returns 401 | — | Hold |
| B8 | Audit rows include `staff_user_id` + role for all writes | NOT_STARTED | Ty | Write → audit log check shows actor | — | Hold |

### Section C — Staging / TLS (from Stage 7.3)

*Reference: [`PHASE-7.3-STAGING-DEPLOYMENT-TLS-PLAN.md`](PHASE-7.3-STAGING-DEPLOYMENT-TLS-PLAN.md)*

| # | Gate | Status | Owner | Evidence | Date | Decision |
|---|---|---|---|---|---|---|
| C1 | Azure staging deployed (Container Apps, Postgres, Redis, Key Vault) | IMPLEMENTATION_PROVEN | Ty | 3× Container Apps running (wh-staging-staff-api, wh-staging-n8n-main, wh-staging-n8n-worker all Succeeded); 7.3d proof | 2026-06-01 | Proceed (staging) |
| C2 | HTTPS reachable on `staff-staging.<domain>`; cert valid | PARTIAL (Azure FQDN only) | Ty | Staff API reachable over Azure HTTPS FQDN; custom domain / managed cert on lunafrontdesk.com not yet configured | 2026-06-01 | Hold — DNS/CNAME + managed cert bind needed |
| C3 | `GET /staff/ui` returns 200 over HTTPS | IMPLEMENTATION_PROVEN | Ty | `/staff/ui` accessible over Azure HTTPS FQDN after login; 7.3d proof | 2026-06-01 | Proceed (staging) |
| C4 | `GET /staff/intents` returns registry JSON | IMPLEMENTATION_PROVEN | Ty | `/staff/intents` returns `total: 35`; 7.3d proof | 2026-06-01 | Proceed (staging) |
| C5 | `GET /staff/query` returns data from staging DB | NOT_STARTED | Ty | Not yet verified against staging DB | — | Hold |
| C6 | n8n staging reachable at `n8n-staging.<domain>` over HTTPS | PARTIAL (Azure FQDN only) | Ty | n8n reachable at Azure HTTPS FQDN `/home`; custom domain not yet configured | 2026-06-01 | Hold — DNS/CNAME needed |
| C7 | `WEBHOOK_URL` / `N8N_WEBHOOK_URL` set to staging HTTPS host (not localhost) | NOT_STARTED | Ty | n8n settings not yet verified | — | Hold |
| C8 | All n8n workflows inactive on fresh staging deploy | IMPLEMENTATION_PROVEN | Ty | 11 workflows imported, all `active=false`; 7.3d proof | 2026-06-01 | Proceed (staging) |
| C9 | Stripe test keys only in staging (verified in n8n credentials) | IMPLEMENTATION_PROVEN | Ty | No credentials imported; no live Stripe key present; 7.3d confirms | 2026-06-01 | Proceed (staging) |

### Section D — Backup / Restore (from Stage 7.4)

*Reference: [`PHASE-7.4-BACKUP-RESTORE-ROLLBACK-PLAN.md`](PHASE-7.4-BACKUP-RESTORE-ROLLBACK-PLAN.md)*

| # | Gate | Status | Owner | Evidence | Date | Decision |
|---|---|---|---|---|---|---|
| D1 | Azure Postgres automated backup configured for staging app DB (≥ 7-day retention) | NOT_STARTED | Ty | Azure portal — backup policy screenshot | — | Hold |
| D2 | Azure Postgres automated backup configured for staging n8n DB | NOT_STARTED | Ty | Azure portal — backup policy screenshot | — | Hold |
| D3 | Workflow export snapshot taken before any activation window | NOT_STARTED | Ty | Dated export in `n8n/exports/staging/` | — | Hold |
| D4 | **Restore drill completed** and documented in drill log (`PHASE-7.4 §4.1`) | NOT_STARTED | Ty | Drill log entry: steps 1–7 passed; time-to-restore recorded | — | **REQUIRED before pilot** |
| D5 | Migration rollback strategy confirmed for all applied migrations | PARTIAL (design) | Ty | `PHASE-7.4 §5` catalogue complete for 001–008; 009 pending | 2026-05-31 | Hold — 009 not yet written |
| D6 | Emergency toggles drilled at least once in staging | NOT_STARTED | Ty | Record of toggle drill (flip `WHATSAPP_DRY_RUN`, `STAFF_ACTIONS_ENABLED`, deactivate workflow) | — | **REQUIRED before pilot** |

### Section E — Monitoring / Alerting (from Stage 7.5)

*Reference: [`PHASE-7.5-MONITORING-ALERTING-PLAN.md`](PHASE-7.5-MONITORING-ALERTING-PLAN.md)*

| # | Gate | Status | Owner | Evidence | Date | Decision |
|---|---|---|---|---|---|---|
| E1 | Azure Monitor P0/P1 alert rules active (API 5xx, DB connectivity, backup failure) | NOT_STARTED | Ty | Azure Monitor alert rules screenshot | — | Hold |
| E2 | n8n failure alert path active (`automation_errors` monitor or notification workflow) | NOT_STARTED | Ty | Test alert fired; notification received | — | Hold |
| E3 | Stripe webhook failure alert configured | NOT_STARTED | Ty | Stripe Dashboard + Azure Monitor | — | Hold |
| E4 | WhatsApp send failure alert configured | NOT_STARTED | Ty | n8n error workflow or Azure Monitor | — | Hold |
| E5 | DB backup failure alert configured | NOT_STARTED | Ty | Azure Monitor backup alert | — | Hold |
| E6 | Durable audit log confirmed (Log Analytics / DB table receiving rows) | NOT_STARTED | Ty | Test write → row appears in Log Analytics within 60 s | — | Hold |
| E7 | Business-state monitors running: stuck confirmation + urgent handoff > SLA | NOT_STARTED | Ty | Scheduled query or staff UI; last-run evidence | — | Hold |
| E8 | Named P0/P1 response owner confirmed and reachable (Ty); Cami/Ale notified of P0 path | NOT_STARTED | Ty + Cami + Ale | Contact list confirmed; staff WhatsApp group set up | — | Hold |

### Section F — Cami Review Dashboard

*Reference: [`PHASE-7.7-CAMI-REVIEW-DASHBOARD-PLAN.md`](PHASE-7.7-CAMI-REVIEW-DASHBOARD-PLAN.md) (design). Dashboard is read-only by default; send/edit/resolve deferred behind later gates.*

| # | Gate | Status | Owner | Evidence | Date | Decision |
|---|---|---|---|---|---|---|
| F1 | **Conversation inbox** visible to Cami (guest, latest message, language, status, needs_human, handoff reason, booking code, last activity, priority) | IMPLEMENTATION_PROVEN | Ty + Cami | Inbox view (7.7c) shows fixture conversations; Cami can access | 2026-06-01 | Hold |
| F2 | **Conversation detail** visible (full message thread, latest guest message, route/intent, staff notes, takeover status, **inline reply composer**) | IMPLEMENTATION_PROVEN | Ty + Cami | Conversation detail (7.7d) loads message history; composer is present and editable | 2026-06-01 | Hold |
| F3 | **Luna draft review** visible and clearly labelled as DRAFT — NOT SENT; **Cami can edit the draft and compose a custom reply inline** | IMPLEMENTATION_PROVEN | Ty + Cami | Shadow-mode dry-run (7.7j); draft_available=true; editable textarea pre-filled with Luna draft; copy confirmed | 2026-06-01 | Hold |
| F4 | **Booking context** visible (dates, guest count, package, room/bed assignment, payment/hold/confirmation status) + add-ons (lessons/yoga/rentals/dinners/transfers) | IMPLEMENTATION_PROVEN | Ty + Cami | Context panels (7.7i) load in calendar block drawer with booking/payments/rooming/handoff/addons sections | 2026-06-01 | Hold |
| F5 | **Handoff queue** visible (open/stale/urgent, reason, assigned staff, SLA); resolve action deferred until write gate | IMPLEMENTATION_PROVEN | Ty + Cami | Handoff queue view (7.7f); resolve button absent until auth/TLS + 6.9 route | 2026-06-01 | Hold |
| F6 | **Bed calendar grid** available (rooms/beds down side, dates across top, booking_beds as date-span blocks, status by color/label, arrivals/departures clear) — **or** explicit Cami/Ale-approved written deferral (gate F7-CAL) | IMPLEMENTATION_PROVEN | Ty + Cami + Ale | Read-only calendar render (7.7h/7.7i) modelled on Wolfhouse Excel planning calendar; **hard requirement** | 2026-06-01 | Hold |
| F7 | **Copy/review/inline-reply workflow** understood by Cami: open conversation → read thread → see Luna draft → edit inline → copy → send manually via WhatsApp; **approve/send button visible but disabled**; Cami can take over without the bot interfering; **staff takeover / return-to-Luna status visible** | IMPLEMENTATION_PROVEN | Cami + Ty | 7.7j PASS: copy reads textarea value after edits; "Copied — send manually in WhatsApp"; shadow-mode checklist present; disabled approve/send; audit success; delta=0 | 2026-06-01 | Hold |
| F7-CAL | Bed calendar **deferral** (only if F6 calendar grid is not shipped at launch) | NOT_STARTED | Cami + Ale | Written deferral recorded with reason, risk, and time limit; both sign off | — | Hold |
| F8 | **Basic safe booking edit path** designed (audited, gated, overlap-guarded, paid→handoff, rollback defined) — **or** explicit deferral | DESIGN_DONE | Ty + Cami | **Safe bed reassignment design complete (7.7k, §5a of dashboard plan)**: allowed v1 = same-range bed→bed move only; hard blockers, warning cases, in-transaction overlap guard, audit + rollback all specified. **Write NOT implemented/enabled.** | 2026-06-01 | Hold |
| F8-CAL-EDIT | **Editable bed calendar is NOT required for shadow-mode Phase 1** unless Cami/Ale explicitly require it. Read-only calendar (F6) + reassignment write-gate design (F8) suffice for Phase 1. | DESIGN_DONE | Ty + Cami + Ale | Backend locally proven (7.7k1–7.7k7 PASS); staging gate checklist defined (7.7k8: 17 gates, UI gate conditions, 6 approval phases, hard no-go conditions — see `PHASE-7.7-CAMI-REVIEW-DASHBOARD-PLAN.md §Stage 7.7k8`); **edit controls not wired; staging gate NOT_STARTED; all 17 K8-G gates not passed; Cami/Ale written sign-off (K8-G16) not given** | 2026-06-01 | Hold — not blocking Phase 1 |
|| F9 | **Manual booking creation from dashboard** designed (required fields, modes A–D, safety requirements, UI flow, implementation slices 7.7m1–7.7m7) — **NOT required for shadow-pilot Phase 1; required before the spreadsheet / manual-entry CLI tool is retired** | DESIGN_DONE | Ty + Cami + Ale | Manual booking creation design complete (7.7m / §5b of dashboard plan): modes A–D, overlap guard, audit, rollback strategy, UI flow defined; write NOT implemented or enabled; existing spreadsheet + CLI tool (scripts/manual-entry-postgres.js) remains primary path for new bookings until 7.7m7 Cami/Ale sign-off | 2026-06-01 | Hold — not blocking Phase 1 |

### Section G — Guest / Luna Shadow-Mode

*Reference: Stage 3y Mode A proven ([`PHASE-3y-SHADOW-COPILOT-PLAN.md`](PHASE-3y-SHADOW-COPILOT-PLAN.md))*

| # | Gate | Status | Owner | Evidence | Date | Decision |
|---|---|---|---|---|---|---|
| G1 | Real inbound WhatsApp messages can be received safely (webhook verified, `WHATSAPP_DRY_RUN=true`) | NOT_STARTED | Ty | Meta webhook registered on staging number; test ping received; dry-run on | — | Hold |
| G2 | Luna can draft replies (LLM call fires, draft captured in execution log) | NOT_STARTED | Ty | n8n execution shows draft without WA send | — | Hold |
| G3 | Staff (Cami) approves and sends manually via WhatsApp (not via bot) | NOT_STARTED | Cami | Cami sends approved message directly; bot does not resend | — | Hold |
| G4 | No autonomous payment links issued in shadow mode | NOT_STARTED | Ty | CPS workflow inactive; no `checkout_url` sent to guest | — | Hold |
| G5 | No autonomous booking confirmations in shadow mode | NOT_STARTED | Ty | Send Confirmation workflow inactive; no `confirmation_sent_at` set | — | Hold |
| G6 | No autonomous cancellations, refunds, or room moves | NOT_STARTED | Ty | Cancel/Reassign workflows inactive; no automated writes | — | Hold |
| G7 | All drafts and actions logged (audit row per draft, per handoff) | NOT_STARTED | Ty | Audit log shows draft entries for each shadow-mode message | — | Hold |

### Section H — Payment / Stripe

*Reference: Stage 3d proven; Stage 7.9 gate pending*

| # | Gate | Status | Owner | Evidence | Date | Decision |
|---|---|---|---|---|---|---|
| H1 | Stripe test-mode checkout verified end-to-end in staging | NOT_STARTED | Ty | Execution log: CPS → test session → webhook → payment_events row | — | Hold |
| H2 | Webhook signature verification on in staging (`STRIPE_WEBHOOK_SKIP_VERIFY=false`) | NOT_STARTED | Ty | Container App env; test webhook delivery returns 200 | — | Hold |
| H3 | Idempotent webhook handling verified (duplicate event does not double-insert) | NOT_STARTED | Ty | Send same event ID twice; `payment_events` row count unchanged on 2nd | — | Hold |
| H4 | No live Stripe key until explicit Stage 7.9 approval | NOT_STARTED | Ty + Ale | Key Vault entry confirmed `sk_test_*`; Ale sign-off recorded | — | Hold |
| H5 | Refund/cancellation policy documented and confirmed with Ale | NOT_STARTED | Ale | `wolfhouse-somo.baseline.json` `cancellation.refund_policy` confirmed | — | Hold |
| H6 | Payment failure alert configured and tested | NOT_STARTED | Ty | Alert fires on simulated webhook failure | — | Hold |

### Section I — WhatsApp / Live-Send

*Reference: Stage 7.8 gate pending*

| # | Gate | Status | Owner | Evidence | Date | Decision |
|---|---|---|---|---|---|---|
| I1 | `WHATSAPP_DRY_RUN=true` confirmed in staging at all times (until 7.8 gate) | NOT_STARTED | Ty | Container App env; execution log shows dry_run=true | — | Hold |
| I2 | Meta access token valid and verified (test/sandbox number) | NOT_STARTED | Ty | Token expiry checked in Meta app console; webhook verified | — | Hold |
| I3 | Inbound webhook verified (Meta hub-challenge received 200) | NOT_STARTED | Ty | Meta app console webhook status | — | Hold |
| I4 | Live-send explicitly disabled until Stage 7.8 owner-approval gate | NOT_STARTED | Ty + Ale | No `WHATSAPP_DRY_RUN=false` allowed without 7.8 gate sign-off | — | Hold |
| I5 | Allowed auto-send categories documented (shadow mode only for Phase 1) | NOT_STARTED | Ty + Cami + Ale | Defined in pilot soak plan (Phase 1 = zero auto sends) | — | Hold |

### Section J — Client Config / Business Rules

*Reference: [`config/clients/wolfhouse-somo.baseline.json`](../config/clients/wolfhouse-somo.baseline.json)*

| # | Gate | Status | Owner | Evidence | Date | Decision |
|---|---|---|---|---|---|---|
| J1 | Packages and prices confirmed by Ale/Cami; `pricing_status=confirmed` on pilot items | NOT_STARTED | Ale + Cami | `global_pricing_status` updated to `confirmed`; sign-off recorded | — | Hold |
| J2 | Deposit rules confirmed (€200 standard / €100 custom-or-short-stay) | NOT_STARTED | Ale | `payment.deposit_rule` confirmed; `pricing_status=confirmed` | — | Hold |
| J3 | Cancellation / date-change / refund policy confirmed | NOT_STARTED | Ale | `cancellation` section confirmed; refund mechanism agreed | — | Hold |
| J4 | Add-ons confirmed: lessons, yoga, rentals (wetsuit/board), dinners/meals, transfers | NOT_STARTED | Ale + Cami | `service_addons.service_catalog` entries confirmed; `pricing_status=confirmed` per item | — | Hold |
| J5 | Lesson reminder config confirmed (manual scheduling, two daily slots) | NOT_STARTED | Cami | `service_addons.lesson_scheduling` confirmed | — | Hold |
| J6 | Cleaning/housekeeping rules confirmed | NOT_STARTED | Cami | `property.housekeeping` and `operations.check_in/out_time` confirmed | — | Hold |
| J7 | Staff handoff rules confirmed (reason codes, escalation paths, WhatsApp target) | NOT_STARTED | Cami | `handoff` section confirmed; `handoff_whatsapp_target` secret set | — | Hold |
| J8 | Closed months confirmed (December, January, February) | PASS | Ale | `property.closed_months` in baseline.json confirmed | 2026-05-29 | Proceed |

### Section K — Staff Training

| # | Gate | Status | Owner | Evidence | Date | Decision |
|---|---|---|---|---|---|---|
| K1 | Cami has reviewed and can use the staff dashboard (read-only query, handoff queue) | NOT_STARTED | Cami | Walkthrough completed; Cami confirms she can navigate independently | — | Hold |
| K2 | Ale has reviewed the owner sign-off points (config gate, live-send gate, payment gate) | NOT_STARTED | Ale | Walkthrough completed; Ale confirms she understands each gate | — | Hold |
| K3 | Handoff workflow understood: guest → bot hands off → Cami sees in queue → resolves | NOT_STARTED | Cami | Dry-run of handoff flow from test guest message to resolution | — | Hold |
| K4 | Emergency stop understood: Cami knows to call Ty; Ty knows how to flip `WHATSAPP_DRY_RUN` | NOT_STARTED | Ty + Cami | Emergency toggle drill completed; Cami has Ty contact | — | Hold |
| K5 | What Luna can / cannot do explained and understood | NOT_STARTED | Cami + Ale | Briefing completed; Luna capability list shared (shadow → autonomous path) | — | Hold |
| K6 | Pilot escalation process understood (P0 → Ty → Ale/Cami WhatsApp group) | NOT_STARTED | Ty + Cami + Ale | Group set up; protocol confirmed | — | Hold |

---

## 6. Pilot phases

| Phase | Name | What's allowed | Prerequisite gates | Owner approval |
|---|---|---|---|---|
| **Phase 0** | Staging internal testing | Ty + internal tooling only; no real guests | A1–A9, C1–C9, D1–D3 | Ty only |
| **Phase 1** | Shadow / co-pilot mode | Real inbound → Luna drafts → Cami approves/sends manually; **zero autonomous action** | All A–E, G1–G7, H1–H2, I1–I3, J1–J8, K1–K6 | **Ty + Cami + Ale** |
| **Phase 2** | Staff-approved sends | Narrow category of auto-replies after Cami-review (e.g. closed-month response); no payment, no confirmation | Phase 1 stable for ≥ 1 week; Stage 7.8 gate opened for limited category | **Ty + Ale** |
| **Phase 3** | Limited safe auto-replies | Bot sends narrow pre-approved responses autonomously (non-financial); everything else still shadow | Phase 2 stable; categories explicitly listed and approved | **Ty + Ale** |
| **Phase 4** | Limited payment links | Test-mode Stripe checkout links in pilot; no live Stripe | Phase 3 stable; H1–H6 all PASS; Stage 7.9 explicit approval | **Ty + Ale** |
| **Phase 5** | Broader monitored pilot | Most intents autonomous; live Stripe (after 7.9 gate); close monitoring | All prior phases stable; full monitoring + alerting; Airtable cutover reviewed (Stage 7.10) | **Ty + Ale + Cami** |

**Current state:** Phase 0 not started. No phase approved. This document defines the checklist; sign-offs fill it in when the work is done.

---

## 7. Hard no-go conditions

These conditions block **all phases**. No waiver is possible.

| Condition | Phase blocked |
|---|---|
| No HTTPS on staff UI/API | Phase 1+ |
| No per-user auth for staff UI | Phase 1+ |
| No backup/restore drill completed and documented | Phase 1+ |
| No P0/P1 alerting active | Phase 1+ |
| No Cami dashboard (inbox, conversation detail, Luna draft, booking context, handoff queue) | Phase 1+ |
| No inline reply composer (Cami cannot edit Luna draft / compose reply / copy for manual send) | Phase 1+ |
| No bed calendar grid AND no Cami/Ale-approved written deferral (gate F7-CAL) | Phase 1+ |
| No owner-approved business rules (packages/prices/policy) | Phase 1+ |
| `WHATSAPP_DRY_RUN=false` before live-send gate (Stage 7.8) | Phase 1+ |
| `STAFF_ACTIONS_ENABLED=true` without auth + TLS | Phase 1+ |
| Live Stripe key (`sk_live_*`) in staging | Phase 1–4 |
| Any n8n workflow active that was not explicitly approved for that window | Phase 1+ |
| Emergency toggles not documented and drilled | Phase 1+ |
| Audit log not durable (file-only) | Phase 1+ |

---

## 8. Current state summary (as of Stage 7.3d — 2026-06-01)

| Section | Gates | PASS / IMPL_PROVEN | PARTIAL | NOT_STARTED | Blocker count |
|---|---|---|---|---|---|
| A — Env/secrets | 9 | 6 (A2–A7, A9 impl proven) | 1 (A1: DNS/TLS pending) | 1 (A8: KV encryption key) | 2 (DNS/TLS, A8) |
| B — Auth | 8 | 0 | 0 | 8 | 8 (auth not built) |
| C — Staging/TLS | 9 | 6 (C1, C3, C4, C8, C9 impl proven) | 2 (C2: custom domain pending; C6: custom domain pending) | 1 (C5, C7) | 3 (DNS/custom domain, WEBHOOK_URL, query verify) |
| D — Backup/restore | 6 | 0 | 1 | 5 | 2 required before pilot |
| E — Monitoring | 8 | 0 | 0 | 8 | 8 (not configured) |
| F — Cami dashboard | 10 | 0 | 2 | 8 | 8 (staging not deployed on custom domain; F1–F8 impl proven locally; F8-CAL-EDIT staging gate defined (7.7k8); F9 design done, not blocking Phase 1) |
| G — Shadow mode | 7 | 0 | 0 | 7 | 7 (staging needed first) |
| H — Payment/Stripe | 6 | 0 | 0 | 6 | 1 hard (no live key) |
| I — WhatsApp | 5 | 0 | 0 | 5 | 1 hard (dry-run must stay on) |
| J — Client config | 8 | 1 | 0 | 7 | 7 (owner sign-off needed) |
| K — Staff training | 6 | 0 | 0 | 6 | 6 (staging first) |
| **Total** | **82** | **1** | **4** | **77** | **Phase 1 requires all except F9 (F9 = spreadsheet retirement gate, deferred)** |

**Overall pilot status:** `NOT_STARTED` → checklist defined. No phase approved. Staging deployed (7.3d) but multiple hard gates remain (auth, DNS/TLS, backup, monitoring, Cami/Ale accounts).

---

## 9. Go / No-Go decision record

*(To be filled in when each section reaches PASS)*

| Section | Status | Owner sign-off | Date | Decision |
|---|---|---|---|---|
| A — Env/secrets | PARTIAL (A2–A7, A9 impl proven; A1 DNS/TLS pending; A8 KV encryption key) | Ty | 2026-06-01 | Hold — DNS/TLS + A8 remaining |
| B — Auth | NOT_STARTED | — | — | Hold |
| C — Staging/TLS | PARTIAL (C1, C3, C4, C8, C9 impl proven; C2/C6 DNS pending; C5/C7 not verified) | Ty | 2026-06-01 | Hold — custom domain + WEBHOOK_URL needed |
| D — Backup/restore | PARTIAL (design) | — | — | Hold — drill required |
| E — Monitoring | NOT_STARTED | — | — | Hold |
| F — Cami dashboard | PARTIAL (F1–F8 impl proven locally; F8-CAL-EDIT staging gate defined 7.7k8; F9 design done 2026-06-01) | Ty + Cami | 2026-06-01 | Hold — staging required |
| G — Shadow mode | NOT_STARTED | — | — | Hold |
| H — Payment/Stripe | NOT_STARTED | — | — | Hold |
| I — WhatsApp | NOT_STARTED | — | — | Hold |
| J — Client config | PARTIAL (J8 PASS) | Ale (J8 only) | 2026-05-29 | Hold — 7 items remain |
| K — Staff training | NOT_STARTED | — | — | Hold |
| **Final pilot decision** | **NOT_STARTED** | — | — | **NO_GO — all sections must PASS** |
