# Phase 25f — Owner AI SQL planner (dry-run)

**Status:** IMPLEMENTED (planner + validate route; no execution)  
**Date:** 2026-06-07  
**Scope:** Plan owner BI questions against catalog + validator — **no SQL execution until 25g**

---

## 1. Purpose

Owner Command Center can answer broad business questions. Stage **25f** adds an **AI SQL planner** that:

- Reads the **owner data catalog** and **approved templates**
- Prefers **template_match** for common owner questions
- Falls back to **AI** (`luna-ai-provider`) when no template matches
- Always runs **`validateOwnerReadOnlySql`** (including 25e.2 column policy)
- Returns **`no_query_executed: true`** — never calls `executeOwnerReadOnlySql`

Stage **25g** will execute plans when `execute_ready` is true.

---

## 2. Module

`scripts/lib/owner-sql-planner.js`

| Export | Role |
|--------|------|
| `planOwnerSqlQuestion({ client_slug, question, role?, env?, aiCaller? })` | Full dry-run plan + validation |
| `buildOwnerSqlPlannerPrompt({ client_slug, question, catalog? })` | AI system/user prompt |
| `validateOwnerSqlPlan(plan, { client_slug })` | Validator wrapper |
| `matchTemplateByQuestion(question)` | Deterministic template id match |

---

## 3. Planner sources

| Source | When |
|--------|------|
| `template_match` | Question matches approved template keywords |
| `ai` | No template match; OpenAI/Anthropic configured |
| `fallback` | No match and AI unavailable |

---

## 4. Template-first mapping (examples)

| Question pattern | Template |
|------------------|----------|
| Who owes / hasn't settled up | `outstanding_balances` |
| Revenue this month | `revenue_summary_by_month` |
| Arrivals tomorrow | `arrivals_tomorrow` |
| Most popular package | `package_popularity` |
| Add-on revenue | `addon_revenue` |
| Bookings by source | `bookings_by_source` |

---

## 5. Response shape

```json
{
  "success": true,
  "planner_source": "template_match",
  "question": "Which package is most popular?",
  "client_slug": "wolfhouse-somo",
  "plan": {
    "mode": "template",
    "template_id": "package_popularity",
    "sql": "SELECT ...",
    "params": ["wolfhouse-somo"],
    "explanation": "...",
    "expected_result": "package_code, booking_count",
    "confidence": 0.92
  },
  "validation": {
    "valid": true,
    "reason": "passed_validator",
    "blocked_reason": null
  },
  "execute_ready": true,
  "no_query_executed": true,
  "read_only": true,
  "no_write_performed": true
}
```

- **`execute_ready`**: plan passed validator (safe for 25g execute)
- **`no_query_executed`**: always `true` in 25f

---

## 6. API route

`POST /staff/owner/sql/plan` (operator+ session auth)

Body:

```json
{
  "client_slug": "wolfhouse-somo",
  "question": "Which package is most popular?"
}
```

Does **not** call `/staff/owner/sql/execute`.

---

## 7. Prompt rules (AI path)

- Use approved templates when possible
- Catalog tables/columns only
- Never `raw_payload`, `metadata`, `normalized`, `session_state`, provider IDs
- Never `SELECT *`
- Always `client_slug = $1`
- Always `LIMIT` for row-returning queries
- Never write data
- JSON response only

---

## 8. Explicit non-goals (25f)

- No SQL execution (`executeOwnerReadOnlySql`)
- No WhatsApp sends or routing changes
- No Stripe / Meta / n8n
- No booking/payment writes
- No guest WhatsApp behavior changes
- No broad Staff Portal UI changes

---

## 9. Verification

```bash
npm run verify:luna-agent-phase25-owner-sql-planner
npm run verify:luna-agent-phase25-owner-data-catalog
npm run verify:luna-agent-phase25-owner-readonly-sql
npm run verify:luna-ai-provider
```

---

## 10. Next: Stage 25g

When `execute_ready === true`, call `executeOwnerReadOnlySql` with `plan.sql` and `plan.params` — still read-only, still validated.
