# Crowsnest Sales outreach drafts (Chapter 6)

Protected **outreach draft workspace** for CRM-ready Luna Sales prospects. Internal drafts only — nothing is sent.

## Why

Chapters 1–5 shipped durable prospects, evidence, qualification, review queue, and CRM-ready marking. Operators still needed a place to compose a single current outreach draft (subject, body, channel, next-step note) with revision history — without wiring SMTP, WhatsApp, LinkedIn, HubSpot, or any send path.

## Behavior

1. Authenticated Crowsnest operator opens prospect detail (`/sales/prospects/:id`).
2. When the prospect is **CRM-ready** (manual Chapter 5 mark present), the operator can open `/sales/prospects/:id/outreach-draft`.
3. Operator manually creates or edits **one current draft** with:
   - subject
   - body
   - channel: `email` / `linkedin` / `other`
   - clear next-step note
4. Copy states clearly: **draft only — no message has been sent**.
5. Each save appends a revision (history newest-first) and appends audit `outreach_draft_saved` with actor + timestamps.
6. Detail and review queue show truthful **draft ready** (CRM-ready / eligible) and **draft present** (a draft exists) indicators — never delivery/sent status.

This chapter does **not** claim SMTP, WhatsApp, LinkedIn, HubSpot API, send endpoints, webhooks, auto-generation, or automatic send.

## Schema

Migration: `database/migrations/046_luna_sales_outreach_drafts.sql`

| Column | Role |
|--------|------|
| `prospect_id` | Prospect owning the draft |
| `revision_number` | Monotonic per prospect (latest = current) |
| `subject` / `body` / `channel` / `next_step_note` | Manual draft fields |
| `author_id` | Operator actor |
| `created_at` | Revision timestamp |

Revisions are append-oriented (new rows; current draft = newest `revision_number`).

## Persistence / safety

- Uses the Chapter 1 Sales store (`CROWSNEST_SALES_DATABASE_URL`, schema `luna_sales`).
- Production without the dedicated DSN **fails closed** on draft mutations and draft workspace reads that require the store.
- Store outages map to HTTP **503** / `sales_unavailable` without leaking DSN, SQL, or credentials.
- Draft HTML escapes subject, body, next-step note, channel, and other operator-visible fields.
- No SMTP client, WhatsApp/LinkedIn/HubSpot SDK or HTTP, no send route, no webhooks, no AI draft generation.

## Verify

```bash
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

Live migration apply, Azure/Docker/infra, auth/role changes, real outreach delivery, SMTP/WhatsApp/LinkedIn/HubSpot API, send endpoints, webhooks, AI generation, recovery/ledger changes.
