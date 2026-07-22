# Crowsnest Sales review queue (Chapter 4)

Protected **operating review queue** for authenticated Crowsnest operators over persisted Luna Sales prospects.

## Why

Chapters 1–3 shipped durable prospects, fixture/manual evidence, Admin lifecycle decisions, qualification assessments, and append-only audit. Operators still needed a **volume-friendly queue** that lists prospects in truthful buckets, with a simple server-side filter — without inventing AI priority scores or claiming CRM/outreach/discovery work.

## Behavior

1. Authenticated Crowsnest operator opens `/sales/review` (linked from Sales intake).
2. Queue lists persisted prospects in operating buckets:
   - **Ready for review** — has evidence and no current qualification
   - **Needs more research** — latest qualification is `needs_more_research`
   - **Qualified** — latest qualification is `qualified`
   - **Not qualified** — latest qualification is `not_qualified`
3. Each row shows business name, website when present, latest qualification state, evidence count, most recent activity, and a safe link to prospect detail.
4. Ordering is deterministic: **newest actionable first** (ready / needs_more_research before settled buckets; then by most recent activity). No invented scores or AI priority.
5. Server-side `GET` filter `?state=` supports `all` / `actionable` / `needs_more_research` / `qualified` / `not_qualified` (HTML form, no JavaScript required). Auth is preserved.
6. Empty filters show an honest empty state. Copy states that **operators decide**; this chapter does not claim HubSpot sync, outreach, or external discovery.

## Persistence / safety

- Reuses the Chapter 1 Sales store (`CROWSNEST_SALES_DATABASE_URL`, schema `luna_sales`).
- Bounded **read-only** SQL via `listReviewQueueSummaries` (schema-qualified `luna_sales.*`); no new migration.
- Production without the dedicated DSN **fails closed** on review-queue reads (HTTP **503** / `sales_store_misconfigured`).
- Store outages map to HTTP **503** / `sales_unavailable` without leaking DSN, SQL, or credentials.
- Queue HTML escapes business names, websites, and other operator-visible fields.

## Verify

```bash
npm run verify:crowsnest-sales-review-queue
npm run verify:crowsnest-sales-qualification
npm run verify:crowsnest-sales-research
npm run verify:crowsnest-sales-durable
npm run verify:crowsnest-sales
npm run verify:crowsnest-auth
```

## Out of scope

Live migration apply, Azure/Docker/infra, auth/role changes, HubSpot/Maps/Apollo, automatic/live AI scoring or research, outreach, contact enrichment, owner assignment UI beyond existing fields, recovery/ledger changes.
