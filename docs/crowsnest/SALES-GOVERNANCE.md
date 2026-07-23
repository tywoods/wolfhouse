# Crowsnest Sales scale and governance (Chapter 11)

Protected **read-only governance page** for authenticated Crowsnest operators. Documents Luna Sales workflow safeguards, human-approval rules, data retention/ownership, external integration state, and action-boundary audit summary.

## Why

Chapters 1–10 shipped durable prospects through analytics. Operators still needed a single **scale and governance** surface that states the hard boundaries: human approval at every gate, no automatic CRM writes, no automatic outreach, no external provider calls from automation, and no roles changes.

## Behavior

1. Authenticated Crowsnest operator opens `/sales/governance` (linked from Sales intake, review queue, and analytics).
2. Page shows **workflow safeguards** — intake/evidence, qualification, CRM-ready, outreach drafts, discovery import, review decision — each marked human-approval required.
3. **Human-approval rules** state explicitly: no automatic CRM writes, no automatic outreach, no external provider calls, no roles changes, operator gates, append-only audit.
4. **Data retention and ownership** notes cover schema `luna_sales`, dedicated `CROWSNEST_SALES_DATABASE_URL` (never `WOLFHOUSE_DATABASE_URL`), operator ownership, and append-only audit.
5. **External integration state** lists HubSpot/CRM (preview only), Google Maps (dry-run fixtures), Apollo/enrichment (manual only), outreach delivery (drafts only), live AI research (not connected) — all `write_enabled: false` / not automatic.
6. **Action boundary audit summary** lists allowed manual/operator-triggered audited actions versus forbidden automatic actions (CRM write, outreach send, external calls, roles changes).
7. Copy states clearly: **read-only governance** — operators decide; nothing auto-writes to CRM, auto-sends outreach, calls external providers, or changes roles.

## Persistence / safety

- Pure policy surface from `getSalesGovernance()` — no new migration, no Sales store writes, no external HTTP.
- Route accepts **GET/HEAD only**; POST/PUT/PATCH/DELETE return **405**.
- Auth-protected like other Sales UI routes; unauthenticated browsers redirect to `/login`.
- HTML escapes governance field text.
- Does **not** introduce a roles system or mutate auth accounts.

## Verify

```bash
npm run verify:crowsnest-sales-governance
npm run verify:crowsnest-sales-analytics
npm run verify:crowsnest-sales-review-queue
npm run verify:crowsnest-sales-durable
npm run verify:crowsnest-sales
npm run verify:crowsnest-auth
```

## Out of scope

Live migration apply, Azure/Docker/infra, auth/role changes, HubSpot/Maps/Apollo/live AI wiring, outreach send, automatic remediation, commit/push from this worktree.
