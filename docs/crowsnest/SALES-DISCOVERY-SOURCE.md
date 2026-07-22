# Crowsnest Sales discovery source contract (Chapter 7)

Provider-neutral **discovery source contract** and **manual-source adapter** for future lead discovery. Preview and explicit operator import only — no live providers.

## Why

Chapters 1–6 shipped durable prospects, evidence, qualification, review queue, CRM preview, and outreach drafts. Before Google Maps or any directory provider (Chapter 8), operators needed a stable domain contract: normalized proposed prospects, provenance, rate/quality controls, and an import-review path that does not couple core workflow to a vendor SDK.

## Behavior

1. Authenticated Crowsnest operator opens protected `/sales/discovery`.
2. Operator enters **one** manual proposal: business name and/or website, optional location (city / country code), category, and source reference note.
3. `POST /sales/discovery/preview` normalizes the proposal (`crowsnest.sales.discovery.v1`), shows quality/completeness signals, and runs a **deduplication preview** against existing prospects (domain first, then name/location fingerprint).
4. Copy states clearly: **Preview only — no prospect has been created.**
5. Explicit `POST /sales/discovery/import` creates a prospect via existing intake and appends audit `discovery_proposal_imported` (with location/category/source reference in audit detail). Never auto-creates from search.

## Contract

| Piece | Role |
|-------|------|
| `ProposedProspect` | `business_name`, `website_url`, `location`, `category`, `source_reference` |
| Provenance | source name, external id, retrieved_at, request reference, status, limitations, confidence, correlation id |
| Rate controls | `max_proposals_per_adapt: 1`, `auto_create_prospects: false`, no live provider search |
| Quality controls | require name or website; field bounds; completeness signals (not a lead score) |
| `LeadSourceAdapter` / `DiscoverySourceAdapter` | Future `search(criteria) -> ProposedProspect[]` — not implemented live in this chapter |

Modules:

- `scripts/lib/crowsnest/crowsnest-sales-discovery-contract.js`
- `scripts/lib/crowsnest/crowsnest-sales-discovery-manual.js` (`SOURCE_NAME = manual`)

## Persistence / safety

- **No new discovery migration or tables** in this chapter.
- Preview is read-only against existing Sales prospects when the store is available.
- Explicit import reuses Chapter 1 `createProspect` + append-only audit.
- No Google Maps, Apollo, web search, HubSpot, CRM writes, outreach delivery, AI research, Azure deploy, or ledger calls.
- HTML escapes operator-visible discovery fields.

## Verify

```bash
npm run verify:crowsnest-sales-discovery-contract
```

Focused companion gates (unchanged chapters):

```bash
npm run verify:crowsnest-sales-outreach-drafts
npm run verify:crowsnest-sales-hubspot-adapter
npm run verify:crowsnest-sales
```

## Out of scope

Live Maps/Apollo/web-search adapters, discovery_runs / discovery_candidates schema, Azure/Docker/infra, auth/role changes, CRM writes, outreach send, AI generation, recovery/ledger changes, commit/push from this worktree.
