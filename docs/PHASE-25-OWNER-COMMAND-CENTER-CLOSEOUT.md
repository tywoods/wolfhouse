# Phase 25 — Owner Command Center (closeout)

**Status:** PASS (local verifiers + staging hosted proofs)  
**Closeout commit (25j gate):** `601e92c`  
**Staging baseline revision:** `wh-staging-staff-api--stage25j-owner-perms3`  
**Staging baseline image:** `whstagingacr.azurecr.io/wh-staff-api:0b41bff-stage25j-owner-perms3`  
**Date:** 2026-06-08

---

## 1. Scope

Phase 25 delivers the **Owner Command Center**: owner/operator business intelligence via allowlisted owner WhatsApp and the Staff Portal **Command Center** tab — read-only SQL, natural answers, and role-gated Owner Insights.

**In scope:**

- Generic `staff_phone_access` allowlist (multi-client, not Wolfhouse hard-coded)
- Owner WhatsApp routing to Command Center (plan-and-execute + registry fallback)
- Read-only SQL validator/executor with client scoping
- Owner data catalog + approved templates
- Template-first SQL planner + AI fallback (dry-run plan route)
- Plan-and-execute orchestrator + natural answer formatter
- Staff Portal Command Center UI (Operations + Owner Insights)
- Owner/admin permission gate for Owner Insights (25j)

**Out of scope (explicitly deferred):**

- **Stage 26 — guest-facing AI intake** (generative guest replies, extraction, booking writes from LLM)
- Live owner WhatsApp sends (dry-run respected; explicit go/no-go required)
- Owner BI audit log
- Transfer/payout work
- Stripe, Meta webhook, n8n changes

---

## 2. Architecture

```
Allowlisted owner phone (staff_phone_access)
    │
    ▼
luna-meta-whatsapp-inbound-process.js
    │  non-allowlisted → guest flow (unchanged)
    ▼
luna-owner-whatsapp-inbound.js  ──► plan-and-execute first
    │                                  registry fallback (operational)
    ▼
owner-sql-plan-execute.js
    │
    ├─► owner-sql-planner.js      (template-first + AI fallback)
    ├─► owner-readonly-sql.js     (validate + execute SELECT-only)
    ├─► owner-data-catalog.js     (tables, columns, templates)
    └─► owner-command-center-answer.js  (natural answers, € guard)

Staff Portal Command Center tab
    │
    ├─► Operations  → POST /staff/ask-luna           (operator+)
    └─► Owner Insights → POST /staff/owner/sql/plan-and-execute  (owner/admin only)
```

**Key modules:**

| Module | Role |
|--------|------|
| `scripts/lib/staff-phone-access.js` | Generic allowlist lookup (phone + client_slug → role) |
| `scripts/lib/luna-owner-whatsapp-inbound.js` | Owner WhatsApp Command Center handler |
| `scripts/lib/owner-readonly-sql.js` | SELECT-only validator/executor, read-only transaction |
| `scripts/lib/owner-data-catalog.js` | Approved tables/columns/templates |
| `scripts/lib/owner-sql-planner.js` | Template-first planner + AI fallback; plan route never executes |
| `scripts/lib/owner-sql-plan-execute.js` | Plan → validate → execute orchestrator |
| `scripts/lib/owner-command-center-answer.js` | Natural answer formatter (AI + deterministic € fallback) |
| `scripts/lib/staff-portal-clients.js` | `canUseOwnerInsights()` portal permission helper |
| `scripts/staff-query-api.js` | Command Center UI, API routes, auth gates |

---

## 3. Role model

| Surface | operator | admin | owner |
|---------|----------|-------|-------|
| **Operations** (Staff Portal `/staff/ask-luna`) | ✓ | ✓ | ✓ |
| **Owner Insights** (plan / plan-and-execute) | ✗ | ✓ | ✓ |
| **Owner WhatsApp Command Center** | — | — | ✓ via `staff_phone_access` |

- **Portal session:** `staff_users.role` + `canUseOwnerInsights()` (owner/admin only for Owner Insights).
- **WhatsApp:** `staff_phone_access.role = owner` — separate auth surface; not tied to portal login email.
- **Future:** promote Ty/Ale/Cami portal emails to `staff_users.role = owner` when portal logins exist.

---

## 4. Wolfhouse owner rows (staging)

Seeded in `staff_phone_access` (25b):

| Name | Phone | Role |
|------|-------|------|
| Ty | +491726422307 | owner |
| Ale | +34610057658 | owner |
| Cami | +34650616794 | owner |

---

## 5. Safety (proven across 25b–25j)

- **No write SQL** — SELECT-only; blocked INSERT/UPDATE/DELETE
- **Read-only transaction** — `BEGIN READ ONLY` + `statement_timeout`
- **client_slug scoped** — every query must filter by client
- **LIMIT + timeout** enforced on execute path
- **raw_payload blocked** — validator rejects sensitive column access
- **SELECT * blocked** — star-select rejected by catalog + validator
- **metadata columns blocked** where disallowed by catalog
- **Non-allowlisted phones** stay on guest WhatsApp path unchanged
- **Owner messages** do not create guest bookings, payments, or handoffs
- **Plan route** (`POST /staff/owner/sql/plan`) never executes SQL
- **No Stripe / no n8n / no Meta webhook changes** in Phase 25 slices
- **WhatsApp sends** remain dry-run gated (`WHATSAPP_DRY_RUN`)

---

## 6. Phase chain + commits

| Phase | Commit | Summary |
|-------|--------|---------|
| **25a** | `d45e920` | Design lock — Owner Command Center; Stage 26 guest AI deferred |
| **25b** | `aab480b` | `staff_phone_access` table/helper/CLI; Ty/Ale/Cami seeded |
| **25c** | `893c0b7` | Owner WhatsApp → Command Center; guest path unchanged |
| **25d** | `97429db` | Read-only SQL validator/executor |
| **25e** | `31cb8b5` | Owner data catalog + approved templates |
| **25e.2** | `0bc8d6c` | Column safety; enum alignment (`paid`, `cancelled`) |
| **25f** | `c8ec73b` | SQL planner dry-run (template-first + AI; no execute on plan route) |
| **25g** | `6e8fd65` | Plan-and-execute read-only orchestrator |
| **25h** | `a1c1ef9` | Natural answers; owner WhatsApp plan-execute first |
| **25i** | `957f9e3` | Staff Portal Command Center UI (Operations + Owner Insights) |
| **25j** | `601e92c` | Owner Insights owner/admin gate; operator blocked |

### Hosted proof anchors

| Proof | Result |
|-------|--------|
| 25b.1 staging owner seed | PASS |
| 25c.1 owner WhatsApp dry-run routing | PASS |
| 25d.1 SQL validator/executor | PASS |
| 25e.2 column safety | PASS |
| 25g plan-and-execute | PASS |
| 25h natural answers + owner WhatsApp dry-run | PASS |
| 25i Command Center UI | PASS |
| 25j owner/admin gate | PASS |

---

## 7. Useful owner questions proven

| Question | Expected |
|----------|----------|
| Who hasn't settled up? | Natural answer from `outstanding_balances` template |
| How much revenue this month? | Natural answer with € formatting |
| Which package is most popular? | Template/aggregate answer |
| List recent guest messages for Wolfhouse | Safe AI fallback on `guest_message_events` (no raw_payload) |
| Show raw_payload from messages | **Blocked** safely — no query executed |

---

## 8. Current staging baseline

| Item | Value |
|------|-------|
| Revision | `wh-staging-staff-api--stage25j-owner-perms3` |
| Image | `whstagingacr.azurecr.io/wh-staff-api:0b41bff-stage25j-owner-perms3` |
| `/healthz` | **200 PASS** |
| Operator Owner Insights | Hidden + `403 owner_insights_forbidden` |
| Admin Owner Insights | Visible + plan-and-execute **200** |
| Operations (operator) | `/staff/ask-luna` **200** |

---

## 9. Known caveats / deferred

1. **Audit log** for owner BI queries — deferred by product choice.
2. **Live owner WhatsApp send** — still requires explicit go/no-go; dry-run only in proofs.
3. **Richer row preview table** in Owner Insights UI — optional enhancement.
4. **Portal owner logins** — promote Ty/Ale/Cami emails to `staff_users.role = owner` when ready.
5. **Transfer/payout work** — separate from Command Center BI.
6. **Stage 26 guest AI intake** — explicitly deferred (generative guest replies, extraction).

---

## 10. Next steps

| Priority | Item |
|----------|------|
| Optional | Owner BI audit log |
| When approved | Live owner WhatsApp send proof |
| UX | Owner Insights row preview table (top N rows) |
| Product | Transfers / payout reporting |
| Stage 26 | Guest-facing AI intake (design + implementation) |

---

## 11. Verifier

```bash
npm run verify:luna-agent-phase25-closeout
```

Focused downstream (run by closeout verifier):

- `verify:luna-agent-phase25-owner-permissions`
- `verify:luna-agent-phase25-command-center-ui`
- `verify:luna-agent-phase25-owner-command-center-answer`
- `verify:luna-agent-phase25-owner-plan-execute`
- `verify:luna-agent-phase25-owner-whatsapp-router`
- `verify:luna-agent-phase25-owner-readonly-sql`
- `verify:luna-agent-phase25-owner-data-catalog`
- `verify:luna-agent-phase25-staff-phone-access`
