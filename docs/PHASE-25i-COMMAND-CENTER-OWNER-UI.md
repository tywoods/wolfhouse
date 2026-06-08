# Phase 25i — Command Center Owner BI UI

**Status:** IMPLEMENTED  
**Date:** 2026-06-08  
**Scope:** Staff Portal Command Center tab with Operations + Owner Insights

---

## 1. Naming

- Tab label: **Command Center** (replaces user-facing “Luna” / “Ask Luna” tab label)
- Internal tab id remains `tab-ask-luna`; API routes unchanged (`/staff/ask-luna`)

---

## 2. Sections

| Section | Route | Purpose |
|---------|-------|---------|
| **Operations** | `POST /staff/ask-luna` | Existing operational questions (arrivals, cleaning, etc.) |
| **Owner Insights** | `POST /staff/owner/sql/plan-and-execute` | Owner BI templates + validated read-only SQL |

---

## 3. Owner Insights UI

- Question input + **Ask Owner Insights** button
- Example chips: outstanding balances, revenue, package popularity, recent messages
- Displays: natural `answer`, `row_count`, `planner_source`, `template_id`, read-only badges
- Details accordion: validation, limited flag, SQL summary (not full SQL by default)
- Blocked questions show safe explanation (e.g. raw_payload)

---

## 4. Role visibility

Owner Insights requires **owner** or **admin** portal role (Phase 25j). Operators see a denial message; Operations remains operator+.

---

## 5. Safety

- Read-only plan-and-execute only
- No WhatsApp sends from UI
- No audit log in this slice (deferred)

---

## 6. Currency

Owner answer formatter prefers **€ / EUR**; AI answers containing `$` are rejected to deterministic € fallback.

---

## 7. Verifier

```bash
npm run verify:luna-agent-phase25-command-center-ui
```

---

## 8. Next — 25j (done)

See `docs/PHASE-25j-OWNER-INSIGHTS-PERMISSIONS.md` — owner/admin gate for Owner Insights.
