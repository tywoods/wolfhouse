# Phase 3c.d — Conversation / message / current-hold state

**Status:** Proposal / discovery — see [`PHASE-3c-d-PROPOSAL.md`](PHASE-3c-d-PROPOSAL.md). **No implementation yet.**

**Parents:** [`PHASE-3c-PROPOSAL.md`](PHASE-3c-PROPOSAL.md) · [`PHASE-3c-c.md`](PHASE-3c-c.md) · [`PROJECT-STATE.md`](PROJECT-STATE.md)

---

## Goal

Plan how Main tracks **conversations**, **messages**, and **current hold** so Phase **3c.e** can wire PG hold + Ensure SQL without breaking the Booking State Resolver or duplicating holds.

---

## Substeps (planned)

| Substep | Deliverable | Status |
|---------|-------------|--------|
| **3c.d** | This proposal | Done (doc) |
| **3c.d.1** | Conversation/message field inventory report | Not started |
| **3c.d.2** | `db:report:main-conversation-state` (SELECT-only) | Not started |
| **3c.d.3** | PG conversation upsert CLI (optional) | Deferred |
| **3c.d.4** | Sign-off + PROJECT-STATE update | Not started |

---

## Commands (when implemented)

```powershell
# 3c.d.1 (planned)
npm run db:report:main-conversation-inventory

# 3c.d.2 (planned)
npm run db:report:main-conversation-state -- --phone=+353300000001
```

Docker tools profile — same pattern as [`PHASE-3c-c.md`](PHASE-3c-c.md).

---

## Out of scope

- `build-main-local-stripe.js` / Main JSON changes (**3c.e**)
- Postgres writes (until approved substep)
- `payments` / `payment_events`
- Airtable / Sheets / webhooks

---

## Next

Run **3c.d.1** per [`PHASE-3c-d-PROPOSAL.md`](PHASE-3c-d-PROPOSAL.md) §7.
