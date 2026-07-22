# Crowsnest Sales analytics and monitoring (Chapter 10)

Protected **read-only analytics dashboard** for authenticated Crowsnest operators over persisted Luna Sales records.

## Why

Chapters 1–9 shipped durable prospects, evidence, qualification, review queue, CRM preview, outreach drafts, discovery adapters, and manual contacts. Operators still needed a **truthful pipeline monitor** — counts, recent activity, and data-quality notes — without inventing AI/agent scores, external calls, writes, or automatic remediation.

## Behavior

1. Authenticated Crowsnest operator opens `/sales/analytics` (linked from Sales intake).
2. Dashboard shows **pipeline counts** derived only from durable store reads:
   - Prospects
   - Evidence records (research jobs)
   - Qualification states (`qualified` / `not_qualified` / `needs_more_research` / `unassessed`)
   - CRM-ready marks
   - Drafts present (prospects with a current outreach draft)
   - Contact candidates
3. **Recent activity** lists newest append-only audit events (bounded), with action, actor, timestamp, and prospect link when known.
4. **Data-quality alerts** are informational only (for example: missing website, no evidence, CRM-ready without draft, CRM-ready without contact). Operators decide; nothing is auto-fixed or auto-sent.
5. Copy states clearly: **read-only monitoring from persisted Sales records** — no AI/agent scores, no external provider calls, no writes, no automatic actions.

## Persistence / safety

- Reuses the Chapter 1 Sales store (`CROWSNEST_SALES_DATABASE_URL`, schema `luna_sales`).
- Bounded **read-only** SQL via `listAnalyticsSummaries` (+ existing audit reads); no new migration.
- Production without the dedicated DSN **fails closed** on analytics reads (HTTP **503** / `sales_store_misconfigured`).
- Store outages map to HTTP **503** / `sales_unavailable` without leaking DSN, SQL, or credentials.
- Dashboard HTML escapes business names and other operator-visible fields.
- Route accepts **GET/HEAD only**; POST/PUT/PATCH/DELETE return **405**.

## Verify

```bash
npm run verify:crowsnest-sales-analytics
npm run verify:crowsnest-sales-contact-enrichment
npm run verify:crowsnest-sales-review-queue
npm run verify:crowsnest-sales-durable
npm run verify:crowsnest-sales
npm run verify:crowsnest-auth
```

## Out of scope

Live migration apply, Azure/Docker/infra, auth/role changes, HubSpot/Maps/Apollo/live AI, outreach send, automatic remediation or alerts delivery (email/Slack/webhooks), commit/push from this worktree.
