# Phase 25g — Owner plan-and-execute

**Status:** IMPLEMENTED  
**Date:** 2026-06-08  
**Scope:** Plan owner BI questions, validate, execute read-only SQL, return rows

---

## 1. Purpose

Stage **25f** added dry-run planning (`POST /staff/owner/sql/plan`). Stage **25g** adds a separate **plan-and-execute** path for staging and future Owner Command Center use:

```
owner question → plan (template-first / AI) → validate → execute read-only → rows
```

Natural-language owner answers are deferred to **25h**.

---

## 2. Routes

| Route | Executes SQL? | Notes |
|-------|---------------|-------|
| `POST /staff/owner/sql/plan` | **No** | Always `no_query_executed: true` (25f unchanged) |
| `POST /staff/owner/sql/plan-and-execute` | **Yes**, when valid | Operator+ auth |

### Plan-and-execute body

```json
{
  "client_slug": "wolfhouse-somo",
  "question": "Who hasn't settled up?",
  "max_rows": 50,
  "timeout_ms": 3000
}
```

### Blocked response (HTTP 200, `success: false`)

When `execute_ready` is false or validation fails — no SQL runs:

```json
{
  "success": false,
  "execution": { "success": false, "skipped": true, "reason": "..." },
  "no_query_executed": true
}
```

### Success response (HTTP 200, `success: true`)

```json
{
  "success": true,
  "planner_source": "template_match",
  "plan": { ... },
  "validation": { "valid": true },
  "execution": {
    "success": true,
    "rows": [ ... ],
    "row_count": 12,
    "read_only": true,
    "no_write_performed": true
  },
  "no_query_executed": false
}
```

---

## 3. Modules

| Module | Role |
|--------|------|
| `scripts/lib/owner-sql-planner.js` | Plan + validate (dry-run capable) |
| `scripts/lib/owner-sql-plan-execute.js` | Orchestration: plan → execute when valid |
| `scripts/lib/owner-readonly-sql.js` | Validator + READ ONLY executor (25d) |
| `scripts/lib/owner-data-catalog.js` | Catalog + templates (25e) |

---

## 4. Safety

- Invalid / unsupported plans **never** call `executeOwnerReadOnlySql`
- Executor re-validates SQL before running
- Column policy blocks `raw_payload`, `SELECT *`, sensitive columns (25e.2)
- READ ONLY transaction + statement timeout
- No WhatsApp sends, Stripe, Meta, n8n in this slice
- Plan route remains dry-run only

---

## 5. AI prompt (25g)

Planner prompt includes a **safe guest message example** using allowlisted `guest_message_events` columns only. Requests for raw/internal payloads should return `mode: unsupported`.

---

## 6. Verifier

```bash
npm run verify:luna-agent-phase25-owner-plan-execute
```

---

## 7. Next — 25h

- Natural owner answer formatter over rows + plan context
- Optional Owner WhatsApp Command Center wiring (plan-and-execute behind auth)
