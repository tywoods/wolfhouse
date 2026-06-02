# Stage 8 — Client-Ready Staging Roadmap (Luna Front Desk)

**Status:** IN PROGRESS — 8.0 roadmap DONE, 8.1 UX plan DONE, 8.2 visual polish DONE, 8.5 demo data plan DONE, **8.6 demo data seeded DONE (2026-06-02, 28/28 proof PASS)**. Slices 8.3–8.4, 8.7–8.13 not started.
**Parent plan:** [`PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md`](PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md) — production hardening + pilot workstreams.
**Builds on:** [`PHASE-7.3F-DNS-CUSTOM-DOMAIN-STAGING.md`](PHASE-7.3F-DNS-CUSTOM-DOMAIN-STAGING.md) (custom domain + TLS DONE), [`PHASE-7.7-CAMI-REVIEW-DASHBOARD-PLAN.md`](PHASE-7.7-CAMI-REVIEW-DASHBOARD-PLAN.md) (Cami review dashboard), [`PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md`](PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md) (pilot gates).
**Pilot decision:** Remains **NO_GO**. Stage 8 makes the staging prototype *presentable*; it does not unlock any live gate.

> **Safety scope.** Stage 8 is about polish, demo data, and shadow-mode walkthrough readiness — nothing more. All dangerous live paths stay disabled by hardcoded safety flags: `STAFF_ACTIONS_ENABLED=false`, `WHATSAPP_DRY_RUN=true`, `STRIPE_WEBHOOK_SKIP_VERIFY=false`, `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`, all n8n workflows inactive. No live WhatsApp, no live Stripe, no autonomous send, no staff writes, no production domains, no Sunset onboarding.

---

## 1. Where we are entering Stage 8

| Capability | State entering Stage 8 |
|---|---|
| `staff-staging.lunafrontdesk.com` | LIVE over HTTPS, Azure managed cert (`SniEnabled`) — Stage 7.3f |
| Staff login page | DONE — branded Luna Front Desk form, redirect, error display |
| Logout | DONE — `window.doLogout` fix (Stage 7.3e-fix) |
| Staff UI after login | Accessible; `/staff/intents` returns 35 |
| Conversation inbox | Exists (Stage 7.7c) |
| Needs Human / handoff queue | Exists (Stage 7.7f) |
| Luna draft copy / manual-send flow | Exists (Stage 7.7j) |
| Booking context drawer | Exists (Stage 7.7i) |
| Bed calendar (read-only) | Exists (Stage 7.7h) |
| Safe bed reassignment backend | Proven local (7.7k1–k8); UI editing NOT enabled |
| Manual booking creation | Planned (7.7m); NOT implemented |
| Query Tools | Present and developer-facing on the dashboard |
| Cami/Ale accounts | NOT created |
| Demo/staging data | NOT seeded for presentation |
| Azure Staff API | Live; n8n main+worker healthy; 11 workflows imported inactive; no credentials |

**Stage 8 problem statement:** the system *works* but does not yet *look ready to show a client*. A first-time viewer would land on a sparse dashboard with developer Query Tools visible and little demo data to make the views legible. Stage 8 closes that gap — for a shadow-mode demo only.

---

## 2. Stage 8 objective

Make Luna Front Desk feel **ready to show Ale/Cami** as a polished staging demo — a clean, legible, on-brand shadow-mode control center populated with safe demo data — **while keeping every live-operation gate closed**.

Success = Ty can open `staff-staging.lunafrontdesk.com`, log in (or hand Cami/Ale their own login), and walk through the full shadow-mode review loop on a dashboard that looks intentional, not like a developer console — with zero risk of an accidental send, write, or live action.

---

## 3. Stage 8 pillars

### Pillar 1 — Client-ready UI polish
- Soft Luna Front Desk design language (warm neutral palette, rounded cards, calm typography — consistent with the existing login page).
- Cleaner dashboard layout: clear primary navigation, sensible default landing view (inbox), consistent spacing/cards.
- Better bed calendar readability: legible room/bed rows, date headers, color legend, hover/labels modelled on the Wolfhouse Excel planning calendar.
- Better booking drawer: organized sections (guest, booking, payment, rooming, add-ons, handoff), clear hierarchy.
- **Query Tools hidden or moved** to an admin/dev area, not shown on first view.
- No rough developer/debug surfaces visible on the default staff view.

### Pillar 2 — Real staff experience
- Login page DONE; logout DONE.
- Cami/Ale accounts created (planned slice 8.8 — creation deferred to its own task).
- Role display in the banner (viewer/operator/admin/owner) so staff see who they are.
- Friendly empty states ("No conversations yet", "No open handoffs") instead of blank panels.
- Clear, persistent shadow-mode messaging ("Staging / shadow mode — staff actions disabled") so no one mistakes the demo for live.

### Pillar 3 — Demo / staging data
- Enough **safe, synthetic** conversations/bookings to make the dashboard understandable.
- **No production guest data**; all demo data clearly fake (obvious test names/phones, `client_id`-scoped).
- Demo handoffs (a few open / stale / urgent) so the Needs Human queue is legible.
- Demo bed calendar blocks so the calendar shows realistic occupancy.
- Demo Luna drafts so the review/edit/copy loop is demonstrable.
- Demo booking contexts (payment status, rooming, add-ons) behind a few conversations.
- Seed must be **idempotent, reversible, and isolated** (own demo client/tenant scope or clearly-marked demo rows; never touch real Wolfhouse rows).

### Pillar 4 — Cami workflow readiness (shadow mode, end-to-end)
Cami can, with zero autonomous action and zero protected-table mutation:
- Review a conversation from the inbox.
- Read the full message thread.
- See Luna's draft reply; edit or compose a fresh reply; copy it for manual WhatsApp send.
- See full booking context beside the conversation.
- See the handoff / Needs Human queue.
- See the bed calendar.
- **No accidental send** (copy-only; no live send button).
- **No writes exposed** unless explicitly approved in a later gated task.

### Pillar 5 — Manual booking creation roadmap
- Keep **planned** (per 7.7m); not built in the first demo.
- **Not required** before the first shadow demo to Ale/Cami.
- **Required** before Luna Front Desk can replace the spreadsheet/manual booking workflow.
- Stage 8 only documents where it sits; implementation is a separate gated track.

### Pillar 6 — Safety / ops gates
- Backup/restore drill documented and executed (slice 8.9; design from 7.4).
- Monitoring/alerting minimum setup (slice 8.10; design from 7.5).
- Durable audit-log plan confirmed (staff reads/actions already audited; verify retention/visibility).
- `STAFF_ACTIONS_ENABLED` stays `false`.
- `WHATSAPP_DRY_RUN` stays `true`.
- Workflows stay inactive except explicitly approved, clearly-scoped staging tests.

### Pillar 7 — DNS / domain polish
- `staff-staging.lunafrontdesk.com` DONE (7.3f).
- `n8n-staging.lunafrontdesk.com` — optional, later (not needed for the staff demo).
- `webhook-staging.lunafrontdesk.com` — optional, later.
- Production domains (apex / `www`) — NOT configured in Stage 8.

### Pillar 8 — Multi-client / productization awareness
- Wolfhouse remains **client #1**.
- Sunset (surf shop, board/wetsuit rentals) remains **client #2, later** — do **not** build in Stage 8.
- During Stage 8, **identify** (document only) Wolfhouse-specific assumptions baked into UI/labels/data that would need removing before Sunset (e.g. "beds/rooms" vocabulary, surf-house package names, lodging-only inventory model).
- Do **not** overbuild multi-client abstraction yet; capture a "Sunset readiness debt" list and move on.

---

## 4. Stage 8 implementation slices

| Slice | Name | Type | Summary |
|---|---|---|---|
| **8.0** | Roadmap | docs | This document. |
| **8.1** | Dashboard UX cleanup plan | docs | **DONE (2026-06-02)** — [`STAGE-8.1-DASHBOARD-UX-CLEANUP-PLAN.md`](STAGE-8.1-DASHBOARD-UX-CLEANUP-PLAN.md). Default landing = "Today / Needs Attention"; sidebar nav (Today · Inbox · Bed Calendar · Bookings · Add-ons · Handoffs · Settings/Admin · Developer Tools admin-only); Query Tools moved to admin/dev-only; canonical Luna design tokens; bed calendar + booking drawer + conversation cleanup specs; 8.2 boundaries. |
| **8.2** | Dashboard visual polish implementation | code | **DONE (2026-06-02)** — Today/Needs Attention default view; Inbox tab; Developer Tools admin-only; natural room sort; switchToTab utility; 59 conversation checks, 43 bed-calendar checks. Azure rev `0000004` (`wh-staff-api:74eed37-8x2`). |
| **8.3** | Bed calendar readability cleanup | code | Improve calendar legibility (rows, headers, legend, labels) — read-only. |
| **8.4** | Booking drawer cleanup | code | Reorganize the booking context drawer into clear sections. |
| **8.5** | Demo/staging data seed plan | docs | **DONE (2026-06-02)** — [`STAGE-8.5-DEMO-DATA-SEED-PLAN.md`](STAGE-8.5-DEMO-DATA-SEED-PLAN.md). 3 scenarios (A: Sofia/needs-human/urgent handoff, B: Marco/payment-pending, C: Lena/confirmed/bed-calendar Jul 16–22); 18 demo rows across 6 tables; JS seed + cleanup + proof scripts planned; `source='stage8_demo'` tag; staging-only safety check. |
| **8.6** | Demo/staging data seed implementation | code/data | **DONE (2026-06-02)** — 18 rows seeded (3 convs, 7 msgs, 3 bookings, 2 booking_beds, 1 handoff, 2 payments + 2 demo rooms + 4 demo beds). Proof 28/28 PASS. `STAFF_ACTIONS_ENABLED=false`, `WHATSAPP_DRY_RUN=true` confirmed. Demo data intentionally retained. |
| **8.7** | Hide/move developer Query Tools | code | Remove Query Tools from default staff view; relocate to admin/dev-only area. |
| **8.8** | Cami/Ale account creation plan | docs | Define accounts, roles, password delivery; creation runs as its own gated task. |
| **8.9** | Backup/restore drill | ops | Execute the 7.4 restore drill against staging; record proof. |
| **8.10** | Monitoring/alerting minimum setup | ops | Minimum Azure Monitor health + error alerting per 7.5. |
| **8.11** | Cami walkthrough script | docs | Step-by-step shadow-mode demo script for Ty to run with Cami/Ale. |
| **8.12** | Ale/Cami demo readiness checklist | docs | The go/no-go checklist for "ready to show" (see §5). |
| **8.13** | Stage 8 closeout / show-to-client decision | docs | Verify §5 checklist; record explicit decision to show (or not). |

> Slice ordering is a recommendation, not a hard dependency chain. 8.1 → 8.2/8.3/8.4 (polish) can proceed in parallel with 8.5 → 8.6 (demo data). 8.7 is independent. 8.8 (account creation) and 8.9/8.10 (ops gates) can run any time after polish lands. 8.11–8.13 are the final readiness gate.

---

## 5. "Ready to show Ale/Cami" checklist

| # | Item | Source slice |
|---|---|---|
| 1 | `staff-staging.lunafrontdesk.com` works over HTTPS | 7.3f (DONE) |
| 2 | Real login page works | 7.3e (DONE) |
| 3 | Cami/Ale accounts created | 8.8 |
| 4 | Dashboard visually polished enough to present | 8.2 |
| 5 | Fake/demo data present | 8.6 |
| 6 | No empty / confusing dashboard on first view | 8.2 + 8.6 |
| 7 | Cami workflow works end-to-end in shadow mode | Pillar 4 / 8.x |
| 8 | Signout works | 7.3e-fix (DONE) |
| 9 | Staff writes disabled (unless explicitly approved) | safety flag |
| 10 | WhatsApp dry-run on | safety flag |
| 11 | Live Stripe disabled | safety flag |
| 12 | n8n workflows inactive (or approved staging-only) | n8n state |
| 13 | Backups / monitoring minimum gates documented | 8.9 + 8.10 |
| 14 | Ty has a walkthrough script | 8.11 |

Stage 8 is "show-ready" only when **all 14** are satisfied and recorded in slice 8.13.

---

## 6. What is NOT part of Stage 8

- Production launch.
- Live WhatsApp send.
- Live Stripe / real payments.
- Autonomous (non-staff-approved) sends.
- Onboarding Sunset (or any second client).
- Full multi-client platform / admin console.
- Full n8n → code engine extraction.
- Production billing / subscription model.
- Enabling staff write actions or editable bed reassignment in the UI (remains behind 7.7k8 gates + Cami/Ale written sign-off).
- Manual booking creation implementation (planned, separate track).

---

## 7. Gates still closed after Stage 8

Even when Stage 8 is complete and Luna Front Desk has been shown to Ale/Cami in shadow mode, the following remain closed and require their own explicit approvals:

- Pilot GO decision (all 81 gates in [`PHASE-7.6`](PHASE-7.6-PILOT-READINESS-GO-NO-GO-CHECKLIST.md)).
- Production DNS / domains.
- Live WhatsApp, live Stripe.
- Staff write actions / editable reassignment in UI.
- Workflow activation (beyond approved staging-only tests).
- Airtable cutover.
- Sunset onboarding / multi-client productization.

---

## 8. Next recommended slice

**Stage 8.2 — Dashboard visual polish implementation** (code): apply the Luna design tokens, build the "Today / Needs Attention" landing view from existing read-only data, re-group navigation, move Query Tools to admin/dev-only, and add UI verifier checks — per [`STAGE-8.1-DASHBOARD-UX-CLEANUP-PLAN.md`](STAGE-8.1-DASHBOARD-UX-CLEANUP-PLAN.md). Visual/HTML/CSS only; no writes, no live paths.
