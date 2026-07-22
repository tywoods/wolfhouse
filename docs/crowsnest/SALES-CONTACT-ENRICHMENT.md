# Crowsnest Sales contact enrichment (Chapter 9)

Protected **manual contact records** on the existing Sales prospect detail page. No Apollo or other external enrichment.

## Why

Chapters 1–8 shipped durable prospects, evidence, qualification, review queue, CRM preview, outreach drafts, and discovery adapters. Operators still needed a place to capture **named contact candidates** (name, role, optional email/phone/LinkedIn, source, confidence) with provenance — without wiring Apollo, auto-find, CRM writes, or outreach send.

## Behavior

1. Authenticated Crowsnest operator opens `/sales/prospects/:id`.
2. Operator submits a manual contact via `POST /sales/prospects/:id/contacts`.
3. Required fields: full name, role, source, confidence (`low` / `medium` / `high`).
4. Optional fields: email, phone, LinkedIn URL (validated when present).
5. Contacts are prospect-scoped, listed **newest-first**, and append-audited as `contact_candidate_recorded` with the operator actor.
6. CRM sync preview (`/sales/prospects/:id/crm-preview`) includes stored contact candidates as Contacts under the accepted Company + Contacts mapping (still preview only — no CRM record has been sent).

Copy states clearly: **Manual contact records only — no Apollo lookup, no auto-find, no CRM write, no message sent.**

This chapter does **not** claim Apollo (or other enrichment providers), auto-find, CRM writes, outreach send, or retention/deletion automation.

## Schema

Migration: `database/migrations/047_luna_sales_contact_candidates.sql`

| Column | Role |
|--------|------|
| `prospect_id` | Prospect owning the contact |
| `full_name` / `role` | Required identity |
| `email` / `phone` / `linkedin_url` | Optional channels |
| `source` | Manual provenance label |
| `confidence` | `low` / `medium` / `high` |
| `author_id` | Operator actor |
| `created_at` | Record timestamp |

Rows are append-oriented (new inserts; listing = newest `created_at` first).

## Persistence / safety

- Uses the Chapter 1 Sales store (`CROWSNEST_SALES_DATABASE_URL`, schema `luna_sales`).
- Production without the dedicated DSN **fails closed** on contact mutations.
- Store outages map to HTTP **503** / `sales_unavailable` without leaking DSN, SQL, or credentials.
- Detail HTML escapes name, role, email, phone, LinkedIn, source, and other operator-visible fields.
- No Apollo client/HTTP/env keys, no auto-find endpoint, no CRM write, no outreach send.

## Verify

```bash
npm run verify:crowsnest-sales-contact-enrichment
npm run verify:crowsnest-sales-outreach-drafts
npm run verify:crowsnest-sales-hubspot-adapter
npm run verify:crowsnest-sales-review-queue
npm run verify:crowsnest-sales-qualification
npm run verify:crowsnest-sales-research
npm run verify:crowsnest-sales-durable
npm run verify:crowsnest-sales
npm run verify:migration-integrity
```

## Out of scope

Live migration apply, Azure/Docker/infra, auth/role changes, Apollo or other enrichment providers, auto-find, CRM writes, outreach send, retention/deletion policy, recovery/ledger changes, commit/push from this worktree.
