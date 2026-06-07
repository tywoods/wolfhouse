# Phase 25d — Owner read-only SQL safety layer

**Status:** IMPLEMENTED (validator + executor foundation)  
**Date:** 2026-06-07  
**Scope:** Safe read-only SQL for Owner Command Center BI — **no AI planner yet**

---

## 1. Purpose

Owner Command Center can answer broad business questions, but **AI must not get direct unrestricted DB access**.

Stage 25d adds a **validator and executor** that Staff API uses before any owner BI SQL runs:

- **SELECT-only** (read-only `WITH ... SELECT` allowed)
- **Client-scoped** (`client_slug` filter required)
- **Allowlisted tables** only
- **LIMIT** and **statement timeout** enforced
- **READ ONLY** transaction wrapper

Stage **25e** adds the curated owner **data catalog**. Stage **25f+** adds AI SQL planning that must pass this validator.

---

## 2. Module

`scripts/lib/owner-readonly-sql.js`

| Export | Role |
|--------|------|
| `normalizeOwnerSql(sql)` | Strip comments, collapse whitespace for validation |
| `validateOwnerReadOnlySql({ sql, client_slug, allowedTables?, maxLimit? })` | Hard reject unsafe SQL |
| `executeOwnerReadOnlySql(pg, { client_slug, sql, params?, maxRows?, maxLimit?, timeoutMs? })` | Validate then run in read-only tx |

---

## 3. Validation rules

### Allowed

- Single `SELECT` statement
- `WITH ... SELECT` when CTEs are read-only (no write CTEs)
- `client_slug = $1` with `params[0] === client_slug`
- `client_slug = '<exact client_slug>'` literal (must match request slug)
- `LIMIT` up to `maxLimit` (default **100**); missing `LIMIT` is **appended** safely

### Blocked

- `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE`, `COPY`
- `GRANT`, `REVOKE`, `VACUUM`, `ANALYZE`, `CALL`, `DO`, `EXECUTE`
- `SELECT ... INTO` (blocked via `INTO` keyword)
- Multi-statement SQL (`;` with more SQL after first statement)
- Comments hiding blocked keywords (comments stripped before checks)
- Tables outside allowlist
- Missing or mismatched `client_slug` filter
- `LIMIT` above maximum

---

## 4. Allowed tables (25d foundation)

- `bookings`
- `payments`
- `booking_beds`
- `booking_service_records`
- `rooms`
- `beds`
- `conversations`
- `messages`
- `guest_message_events`

**Not included:** `staff_phone_access`, secrets, auth/session tables, migrations metadata, raw env.

Stage **25e** expands this into a versioned owner data catalog with column policies.

---

## 5. Executor behavior

1. Run `validateOwnerReadOnlySql`
2. `BEGIN READ ONLY`
3. `SET LOCAL statement_timeout = <timeoutMs>` (default **3000**)
4. Execute query (append `LIMIT` if validator added one)
5. `COMMIT` (or `ROLLBACK` on error)
6. Cap returned rows to `maxRows` (default **100**)

Response shape:

```json
{
  "success": true,
  "rows": [],
  "row_count": 0,
  "limited": false,
  "sql_summary": "...",
  "elapsed_ms": 12,
  "read_only": true,
  "no_write_performed": true
}
```

---

## 6. Test routes (staging/dev)

Authenticated **operator+** session (TODO: tighten to owner/admin in Owner Portal slice):

| Route | Method | Purpose |
|-------|--------|---------|
| `/staff/owner/sql/validate` | POST | Validation only |
| `/staff/owner/sql/execute` | POST | Validate + execute |

Body:

```json
{
  "client_slug": "wolfhouse-somo",
  "sql": "SELECT booking_code FROM bookings WHERE client_slug = $1 LIMIT 10",
  "params": ["wolfhouse-somo"]
}
```

These routes are **not** a Staff Portal UI feature — foundation testing only.

---

## 7. Explicitly out of scope (25d)

- AI SQL planner
- Owner Portal UI
- WhatsApp routing changes
- WhatsApp sends
- Stripe / booking / payment writes
- Meta webhook / n8n changes
- Production DB cutover

---

## 8. Next: Stage 25e

**Owner data catalog** — curated tables/columns, sensitive field masking, example queries, and registry version for AI planner binding.

---

## 9. Verifier

```bash
npm run verify:luna-agent-phase25-owner-readonly-sql
```
