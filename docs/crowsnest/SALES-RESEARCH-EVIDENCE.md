# Crowsnest Sales research evidence (Chapter 2)

Protected **manual research evidence** workspace on the existing Sales prospect detail page.

## Why

Chapter 1 shipped durable prospects, a fixture research packet, operator decisions, and append-only audit. Operators still needed a way to attach **dated, prospect-scoped manual notes** (source label/URL, summary, factual notes, limitations, confidence) without inventing live AI crawls or external research providers.

## Behavior

1. Authenticated Crowsnest operator opens `/sales/prospects/:id`.
2. Fixture research from intake remains visible and unchanged.
3. Operator submits manual evidence via `POST /sales/prospects/:id/evidence`.
4. Evidence is validated/bounded, stored as `luna_sales.research_jobs` rows with `source='manual'`, listed **newest-first**, and audited as `research_evidence_recorded` (append-only) with the operator actor.

This chapter does **not** claim live website crawls, automated AI qualification, HubSpot, Maps, Apollo, outreach, contact enrichment, or discovery integrations.

## Schema

Migration: `database/migrations/043_luna_sales_research_evidence.sql`

Minimal extension of existing `luna_sales.research_jobs` (no parallel evidence table):

| Column | Role |
|--------|------|
| `job_label` | Source label |
| `source_url` | Source URL (new in 043) |
| `summary` | Short summary |
| `facts` | Factual notes (JSON array) |
| `limitations` | Limitations (JSON array) |
| `confidence` | `low` / `medium` / `high` (new in 043; empty allowed for fixture rows) |
| `source` | `fixture` or `manual` |
| `created_at` | Evidence date |

## Persistence / safety

- Uses the Chapter 1 Sales store (`CROWSNEST_SALES_DATABASE_URL`, schema `luna_sales`).
- Production without the dedicated DSN **fails closed** on evidence mutations.
- Store outages map to HTTP **503** / `sales_unavailable` without leaking DSN, SQL, or credentials.
- Detail HTML escapes all operator-entered evidence fields.

## Verify

```bash
npm run verify:crowsnest-sales-research
npm run verify:crowsnest-sales-durable
npm run verify:crowsnest-sales
```

## Out of scope

Live migration apply, Azure/Docker/infra, auth/role changes, HubSpot/Maps/Apollo, automatic/live AI research, outreach, contact enrichment, discovery integrations.
