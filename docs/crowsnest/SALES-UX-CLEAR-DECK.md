# Crowsnest Sales UX — Project Clear Deck

Presentation-only contract for making Sales an operator-first cockpit. Domain routes, POST actions, field names, durable store behavior, and no-auto-send / no-auto-write safety rules stay intact.

## North-star journey

```text
Sales cockpit → action queue → prospect workspace
  Overview → Research → Qualification → CRM review → Draft outreach
```

## Slice A contract (verifier)

`npm run verify:crowsnest-sales-ux` asserts:

1. **Target UX**:
   - Sales cockpit heading / `sales-cockpit` hook
   - Visible primary **Add prospect** action
   - Action / pipeline region
   - Default `/sales` does **not** render the full intake form until explicit add mode (`mode=add` / equivalent)
   - Contextual local safety badges for CRM (**Preview only**), outreach (**Draft only**), and discovery (sample / dry-run) — not deleted claims

2. **Preserved contracts** (must keep passing):
   - Existing Sales GET routes: `/sales`, `/sales/review`, `/sales/analytics`, `/sales/discovery`, prospect detail, CRM preview, outreach draft
   - Existing POST form actions and field names (`business_name`, `website_url`, evidence/contacts/qualification/decision/outreach/discovery fields)
   - CRM / outreach / discovery safety claim language retained in source

## Slice B — Sales cockpit

Default `GET /sales` is an operator home screen:

- **Sales cockpit** heading with primary **Add prospect** → `/sales?mode=add`
- Pipeline stage counts from existing `lifecycle_status` values only (no invented scores)
- Attention / action queue for actionable statuses already used in Sales (`ready_for_review`, `needs_more_research`)
- Compact prospect cards; truthful empty states
- Secondary navigation grouped as **Work** (Review queue, Prospect intake), **Tools** (Discovery), **Monitor** (Analytics), **Reference** (Governance)
- Concise cockpit safety statement; full intake form only on explicit `mode=add` (same `POST /sales/prospects` + `business_name` / `website_url`) with back-to-cockpit link

## Slice C — Prospect Flight Deck

Prospect detail is a lifecycle workspace (presentation only):

- Compact identity / status header (`sales-workspace-header`) with one truthful **Next step** from existing state only (evidence → qualification → CRM-ready → outreach draft)
- Sections in order: **Overview** → **Research** → **Qualification** → **CRM review** → **Draft outreach**
- All current evidence, contact, qualification, CRM-ready, outreach-draft, admin decision, and audit data/actions remain reachable; validation errors stay next to their forms
- Contacts, Admin status decision, and audit are visually secondary (`<details>` / `sales-workspace-secondary`); Admin decision behavior unchanged
- Direct CRM preview / outreach links and safety source claims preserved
- Local Preview only / Draft only / discovery badges live on their supporting rooms (Slice D), not on detail

## Slice D — Quiet Supporting Rooms

Each supporting route has one job, shared Sales secondary navigation, and concise action-adjacent warnings:

- **Review** — filter + actionable queue; all six filter values and domain ordering unchanged
- **Discovery** — manual proposal primary; Maps explicitly sample/dry-run; preview and import remain separate POSTs
- **Analytics** — factual read-only indicators; no remediation controls
- **Governance** (`#sales-governance` on cockpit) — detailed policy / safeguards
- **CRM preview** — local classed **Preview only** badge/context beside primary action/state
- **Outreach** — local classed **Draft only** badge/context nearby
- No fresh page-wide disclaimer walls on supporting rooms; no client-side JS

## Slice E — Polished Hull

Calm, consistent responsive visual hierarchy (presentation CSS + semantic hooks only):

- Structural hooks: `sales-cockpit-grid`, `sales-action-card`, `sales-status-chip`, existing workspace header / secondary nav
- Status chips carry visible lifecycle text (not colour alone); action queue cards are visually distinct from the prospect list
- One-column CSS fallback for cockpit grid, pipeline, and secondary nav; desktop expands at `min-width: 720px`; essential regions are not hidden at narrow widths
- Keyboard-visible `:focus-visible` on links and Sales form controls; semantic headings and labelled intake/filter controls
- Existing `--sand` / `--sea` / `--navy` tokens only — no new design system, client JS, or animations

## Verify

```bash
npm run verify:crowsnest-sales-ux
npm run verify:crowsnest-sales
npm run verify:crowsnest
```

## Out of scope

Sea Trial (Slice F), sales domain/store/discovery modules, migrations, credentials, provider integrations, AI-usage work, commit/push/deploy.
