# Crowsnest Sales qualification policy (Chapter 3)

Transparent, **operator-controlled** qualification assessment on the existing Sales prospect detail page.

## Why

Chapters 1–2 shipped durable prospects, fixture research, manual evidence, Admin lifecycle decisions, and append-only audit. Operators still needed an explicit **qualification policy** decision — separate from approve/reject lifecycle — that cites evidence already on the prospect, without inventing AI scores or CRM sync.

## Behavior

1. Authenticated Crowsnest operator opens `/sales/prospects/:id`.
2. Existing fixture research and manual evidence remain visible.
3. Operator records a qualification via `POST /sales/prospects/:id/qualification` with:
   - decision: `qualified` | `not_qualified` | `needs_more_research`
   - short rationale (bounded)
   - one or more `evidence_ids` that already belong to that prospect
4. Detail page shows the **latest** assessment (decision, rationale, evidence links), a **history** of prior assessments, and the append-only audit trail (`qualification_assessed`).

This chapter does **not** claim automatic AI scoring, hidden scores, external research, HubSpot syncing, Maps/Apollo, or outreach.

## Schema

Migration: `database/migrations/044_luna_sales_qualification.sql`

| Column | Role |
|--------|------|
| `decision` | `qualified` / `not_qualified` / `needs_more_research` |
| `rationale` | Operator rationale (required, bounded) |
| `evidence_ids` | JSON array of `luna_sales.research_jobs.id` values on the prospect |
| `reviewer_id` | Operator actor |
| `created_at` | Assessment timestamp |

Assessments are append-oriented (new rows; latest = newest `created_at`).

## Persistence / safety

- Uses the Chapter 1 Sales store (`CROWSNEST_SALES_DATABASE_URL`, schema `luna_sales`).
- Production without the dedicated DSN **fails closed** on qualification mutations.
- Store outages map to HTTP **503** / `sales_unavailable` without leaking DSN, SQL, or credentials.
- Evidence references that do not belong to the prospect are rejected.
- Detail HTML escapes decision, rationale, and evidence labels.

## Verify

```bash
npm run verify:crowsnest-sales-qualification
npm run verify:crowsnest-sales-research
npm run verify:crowsnest-sales-durable
npm run verify:crowsnest-sales
```

## Out of scope

Live migration apply, Azure/Docker/infra, auth/role changes, HubSpot/Maps/Apollo, automatic/live AI scoring or research, outreach, contact enrichment, recovery/ledger changes.
