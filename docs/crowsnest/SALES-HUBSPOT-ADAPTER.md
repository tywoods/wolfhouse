# Crowsnest Sales CRM sync preview (Chapter 5)

Provider-neutral **CRM sync preview** and manual **ready for CRM review** marking for currently qualified Luna Sales prospects. No CRM provider writes.

## Why

Chapters 1–4 shipped durable prospects, evidence, qualification, review queue, and append-only audit. Operators still needed a truthful preview of what a future CRM write would become — one Company and zero-or-more Contacts under the accepted mapping — plus a manual readiness mark for the review queue, without calling any CRM provider.

## Behavior

1. Authenticated Crowsnest operator opens prospect detail (`/sales/prospects/:id`).
2. When the latest qualification is `qualified`, the operator can:
   - open protected CRM preview at `/sales/prospects/:id/crm-preview`
   - `POST /sales/prospects/:id/crm-ready` to mark ready for CRM review
3. Preview shows exactly:
   - **one Company** with lifecycle stage `Lead` and Company property `Luna Sales Status = Qualified Prospect`
   - **zero-or-more Contacts** (none until contact candidates exist)
   - **no Deal**
4. Copy states clearly: **preview only — no CRM record has been sent**.
5. Mark-ready requires latest qualification `qualified`, stores an append-oriented mark linked to that assessment (evidence/reason traceability), and appends audit `crm_review_ready_marked`.
6. Review queue gains bucket/filter `crm_ready` (“Ready for CRM review”) for prospects that are marked ready and still currently qualified.

This chapter does **not** claim live CRM writes, HubSpot SDK/HTTP/env keys, automatic sync, outreach, contact enrichment, or Deal creation.

## Schema

Migration: `database/migrations/045_luna_sales_crm_review.sql`

| Column | Role |
|--------|------|
| `prospect_id` | Prospect marked ready |
| `qualification_assessment_id` | Durable link to the qualified assessment (rationale + evidence refs) |
| `reviewer_id` | Operator actor |
| `created_at` | Mark timestamp |

Marks are append-oriented (new rows; latest = newest `created_at`).

## Persistence / safety

- Uses the Chapter 1 Sales store (`CROWSNEST_SALES_DATABASE_URL`, schema `luna_sales`).
- Production without the dedicated DSN **fails closed** on CRM-ready mutations and preview reads that require the store.
- Store outages map to HTTP **503** / `sales_unavailable` without leaking DSN, SQL, or credentials.
- Preview and detail HTML escape company names, rationale, evidence ids, and other operator-visible fields.
- Domain terms stay provider-neutral (`Company`, `Contact`, `Deal`, lifecycle stage). No HubSpot client, HTTP calls, or `HUBSPOT_*` env keys.

## Verify

```bash
npm run verify:crowsnest-sales-hubspot-adapter
npm run verify:crowsnest-sales-review-queue
npm run verify:crowsnest-sales-qualification
npm run verify:crowsnest-sales-research
npm run verify:crowsnest-sales-durable
npm run verify:crowsnest-sales
npm run verify:migration-integrity
```

## Out of scope

Live migration apply, Azure/Docker/infra, auth/role changes, HubSpot/Maps/Apollo SDK or HTTP, automatic CRM writes, outreach, contact enrichment, recovery/ledger changes.
