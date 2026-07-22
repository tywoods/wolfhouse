# Crowsnest Sales durable store (Chapter 1 / Slice 1)

Durable persistence for Luna Sales Slice 1 prospects, fixture/manual research jobs, and append-only audit events.

## Why

The deployed Sales Slice 1 kept prospects, research, and audit **in memory**. A Crowsnest restart lost operator work. This slice adds a dedicated PostgreSQL schema and a Crowsnest-owned repository adapter so the existing manual intake → fixture research → review → operator decision → append-only audit loop survives restart.

## Environment

| Variable | Required | Notes |
|----------|----------|-------|
| `CROWSNEST_SALES_DATABASE_URL` | **Yes in production** | Dedicated DSN for the Sales store. |
| `NODE_ENV=production` | — | Without `CROWSNEST_SALES_DATABASE_URL`, Sales **mutations fail closed** (HTTP 503 / `sales_store_misconfigured`). |
| _(non-production / test)_ | — | If the dedicated DSN is absent, Crowsnest may use an **explicit in-memory fallback** for local/dev/test only. |

**Never** reuse or expose `WOLFHOUSE_DATABASE_URL` (or generic `DATABASE_URL`) at Sales runtime. Those credentials must not be read by the Sales adapter.

## Schema

Migration: `database/migrations/042_luna_sales_schema.sql`

- Schema: `luna_sales`
- Tables: `prospects`, `research_jobs`, `audit_events`
- UUID primary keys, timestamptz columns, lifecycle/source/status `CHECK` constraints, supporting indexes

## Least-privilege / schema-scoped SQL assumptions

Role provisioning and Azure secret wiring are **out of band** for this slice. Assumptions for the dedicated credential:

1. `USAGE` on schema `luna_sales` only (no need for Wolfhouse `public` booking tables).
2. `SELECT, INSERT, UPDATE` on `luna_sales.prospects` and `luna_sales.research_jobs`.
3. `SELECT, INSERT` only on `luna_sales.audit_events` (**append-only** — no `UPDATE` / `DELETE`).
4. Application SQL always qualifies `luna_sales.*` and must not rely on `search_path`.
5. Bounded pool lifecycle owned by Crowsnest (`max` 4); close via `closeSalesStore()`.

## Modules

| Path | Role |
|------|------|
| `scripts/lib/crowsnest/crowsnest-sales-store.js` | Config validation, memory / postgres / fail-closed repositories, pool lifecycle |
| `scripts/lib/crowsnest/crowsnest-sales.js` | Domain intake / fixture research / decision / audit orchestration |
| `scripts/verify-crowsnest-sales-durable.js` | Deterministic offline contract verifier (no live DB) |

## Atomic create + unavailable handling

Postgres `createProspectBundle` writes prospect + fixture research + initial audit events in one transaction (`BEGIN`/`COMMIT`/`ROLLBACK`). A mid-bundle failure leaves no partial durable rows.

Database connection/query failures on Sales reads/mutations map to HTTP **503** / `sales_unavailable` (retryable) with a safe operator message. Responses must not leak DSN, SQL, credentials, or provider internals. No retry infrastructure is included in this slice.

The in-memory non-production fallback keeps its sequential write path unchanged.

## Verify

```bash
npm run verify:crowsnest-sales-durable
npm run verify:crowsnest-sales
```

## Out of scope (this slice)

Migration application, live DB access, Azure secret changes, deployment, HubSpot, Maps, Apollo, live AI research, outreach, roles, contact enrichment, Staff API, auth, Docker/infra.
