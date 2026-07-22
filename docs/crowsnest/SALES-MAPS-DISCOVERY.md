# Crowsnest Sales Google Maps discovery (Chapter 8)

Provider-specific **Google Maps discovery adapter shell** behind the Chapter 7 discovery contract. **Dry-run / test-fixture only** — no live Google Maps.

## Why

Chapter 7 shipped the provider-neutral discovery contract and manual adapter. Operators still needed a Maps-shaped adapter that normalizes place-like results, preserves place ID / search-area provenance, enforces Northern Spain scope, and reuses dedup preview + explicit import — without coupling core Sales to a Google SDK or live HTTP.

## Behavior

1. Authenticated operator opens protected `/sales/discovery`.
2. Manual proposal path (Chapter 7) remains available.
3. **Maps dry-run** section searches local sample place fixtures (city / category / query within Northern Spain).
4. `POST /sales/discovery/maps/preview` normalizes Maps-like places into `crowsnest.sales.discovery.v1` proposals, shows place ID + search area, runs **deduplication preview** per candidate, and never creates prospects.
5. Visible UI states clearly: **Sample / dry-run data only — not live Google Maps results.**
6. Explicit `POST /sales/discovery/maps/import` re-resolves the selected `place_id` from the fixture catalog, creates one prospect via existing intake, and appends audit `discovery_proposal_imported` with Maps dry-run provenance. Never auto-creates from search.

## Contract / adapter

| Piece | Role |
|-------|------|
| `search(criteria)` | DiscoverySourceAdapter — fixture catalog only |
| `normalizeMapsPlace` | Maps-like place → ProposedProspect |
| Provenance | `source_name=google_maps_dry_run`, exact `place_id`, search area |
| Northern Spain scope | ES + allowlisted pilot cities; out-of-scope places discarded |
| Rate controls | `dry_run_only`, `auto_create_prospects: false`, `live_provider_search_allowed: false` |
| Dedup | Existing `previewDiscoveryDeduplication` (domain, then name/location) |

Modules:

- `scripts/lib/crowsnest/crowsnest-sales-discovery-maps.js`
- Fixtures: `fixtures/crowsnest-sales-maps-discovery/`
- Orchestration: `previewMapsDiscoverySearch` / `importMapsDiscoveryCandidate` in `crowsnest-sales.js`

## Persistence / safety

- **No new discovery migration or tables** in this chapter.
- **No** Google Maps HTTP, Places API, API keys, `@googlemaps` / `googleapis` SDK, scraping, or network fetch.
- Preview is read-only against existing Sales prospects when the store is available.
- Explicit import reuses Chapter 1 `createProspect` + append-only audit.
- HTML escapes operator-visible Maps candidate fields.
- Out-of-scope cities (e.g. Madrid, Barcelona) are rejected or discarded from results.

## Verify

```bash
npm run verify:crowsnest-sales-maps-discovery
```

Focused companion gates:

```bash
npm run verify:crowsnest-sales-discovery-contract
npm run verify:crowsnest-sales-outreach-drafts
npm run verify:crowsnest-sales
```

## Out of scope

Live Google Maps / Places API, API keys, discovery_runs / discovery_candidates schema, Azure/Docker/infra, auth/role changes, CRM writes, outreach send, Apollo, AI generation, recovery/ledger changes, commit/push from this worktree.
