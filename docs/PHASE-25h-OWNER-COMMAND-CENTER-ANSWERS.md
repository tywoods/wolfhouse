# Phase 25h — Owner Command Center natural answers

**Status:** IMPLEMENTED  
**Date:** 2026-06-08  
**Scope:** Natural answers from owner SQL results + owner WhatsApp plan-execute routing

---

## 1. Purpose

Stage **25g** returned raw SQL execution rows. Stage **25h** adds:

1. **Natural answer formatter** — plan + rows → concise WhatsApp-friendly text
2. **AI formatter** with deterministic fallback
3. **Owner WhatsApp routing** — allowlisted owners try plan-and-execute first, registry fallback second

Natural-language polish without guest side effects. Live WhatsApp still governed by `WHATSAPP_DRY_RUN` and send env.

---

## 2. Module

`scripts/lib/owner-command-center-answer.js`

| Export | Role |
|--------|------|
| `formatOwnerCommandCenterAnswer(...)` | AI + fallback formatter |
| `formatOwnerCommandCenterFallback(...)` | Deterministic only |

Behavior:

- Currency from cents (`€150`)
- Top 5–8 rows when many results
- Empty: *"I didn't find any matching records."*
- Blocked: *"I can't answer that from the allowed owner data."*
- AI must not invent numbers or expose SQL/raw_payload

---

## 3. Plan-and-execute response (25g enhanced)

`POST /staff/owner/sql/plan-and-execute` now includes:

```json
{
  "answer": "...",
  "answer_format_source": "ai",
  "row_count": 10,
  "no_write_performed": true
}
```

`POST /staff/owner/sql/plan` remains dry-run only (no answer execution path change).

---

## 4. Owner WhatsApp routing

`scripts/lib/luna-owner-whatsapp-inbound.js`:

1. Allowlisted owner text → **plan-and-execute** first
2. Success → formatted answer as `suggested_reply`
3. Blocked/unsupported → **Staff Ask Luna registry** fallback (ops questions)
4. Preserves: `owner_luna_route`, `guest_flow_skipped`, `staff_phone_access`
5. No `booking_write_preview`, no booking/payment writes

Guest (non-allowlisted) flow unchanged.

---

## 5. Verifier

```bash
npm run verify:luna-agent-phase25-owner-command-center-answer
```

---

## 6. Next — 25i

- Owner Command Center UI panel (optional)
- Richer answer templates per template_id
- Owner WhatsApp live-send gate review (when approved)
