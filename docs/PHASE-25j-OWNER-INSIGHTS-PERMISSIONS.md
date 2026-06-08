# Phase 25j — Owner Insights Permissions

**Status:** IMPLEMENTED  
**Date:** 2026-06-08  
**Scope:** Gate Owner Insights to owner/admin portal sessions

---

## 1. Permission split

| Command Center section | Minimum portal role |
|------------------------|---------------------|
| **Operations** | operator+ (viewer+ for read routes) |
| **Owner Insights** | **owner** or **admin** only |

Plain **operator** and **viewer** sessions cannot call owner BI routes or see the Owner Insights form.

---

## 2. Helper

`canUseOwnerInsights(user)` in `scripts/lib/staff-portal-clients.js`:

- Resolves role via `resolveStaffRole` (includes `portal_admin_emails` promotion)
- Returns `true` only for `owner` or `admin`
- Does **not** use `staff_phone_access` (WhatsApp owner allowlist is a separate auth surface)

---

## 3. API gate

`POST /staff/owner/sql/plan` and `POST /staff/owner/sql/plan-and-execute`:

- Require authenticated session with `canUseOwnerInsights`
- Forbidden response: HTTP **403** `{ success: false, error: "owner_insights_forbidden" }`

`POST /staff/owner/sql/validate` and `POST /staff/owner/sql/execute` remain **operator+** (testing foundation unchanged).

`GET /staff/auth/session` includes `can_use_owner_insights: boolean` for UI gating.

---

## 4. UI gate

- **Operations** — always shown to logged-in operator+
- **Owner Insights** — form hidden when `can_use_owner_insights` is false; shows: *Owner Insights requires owner access.*
- `oiAsk()` blocks client-side and handles 403 safely (no broken buttons)

---

## 5. Role inventory

Portal roles (migration 009 `staff_users.role`):

| Role | Rank | Owner Insights |
|------|------|----------------|
| viewer | 1 | No |
| operator | 2 | No |
| admin | 3 | Yes |
| owner | 4 | Yes |

### Staging test users (fixture `scripts/fixtures/stage7.2c-auth-seed.sql`)

| Email | Role | Owner Insights |
|-------|------|----------------|
| `operator.stage72c@example.test` | operator | **Blocked** |
| `admin.stage72c@example.test` | admin | **Allowed** |
| `viewer.stage72c@example.test` | viewer | Blocked |

Wolfhouse WhatsApp owners (Ty, Ale, Cami) remain `owner` in `staff_phone_access` for Command Center WhatsApp — independent of portal login.

### Portal owner setup follow-up

To give Ty/Ale/Cami Owner Insights in the Staff Portal, create or promote `staff_users` rows with `role = 'owner'` for their login emails. No migration required — role column already supports `owner`.

---

## 6. Safety

- Read-only SQL/planner behavior unchanged
- No WhatsApp sends, Stripe, Meta, n8n
- Guest WhatsApp flow untouched

---

## 7. Verifier

```bash
npm run verify:luna-agent-phase25-owner-permissions
```

---

## 8. Stage 25 closeout

With 25j, Phase 25 Owner Command Center is feature-complete for pilot:

- WhatsApp owner routing (25c)
- Read-only SQL + catalog (25d–25e)
- Planner dry-run (25f)
- Plan-and-execute (25g)
- Natural answers + WhatsApp wiring (25h)
- Staff Portal UI (25i)
- Owner/admin permission gate (25j)

**Recommended post-closeout:**

- Promote Wolfhouse owner portal logins (`staff_users.role = owner`)
- Optional audit log for owner BI queries
- Richer row preview in Owner Insights UI
- Live WhatsApp send gate review when approved
