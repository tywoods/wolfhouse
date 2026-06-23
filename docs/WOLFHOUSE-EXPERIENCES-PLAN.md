# Wolfhouse experiences plan

**Created:** 2026-06-23. Ask (Ale): let staff define "experience packs" (e.g. surf + motocross, surf + grappling) that Luna can talk about, and optionally sell.

**Principle:** Luna only states facts from config/DB, never memory. So "teaching Luna" = putting experiences in the data she reads + (for booking) the quote engine.

## Phase 1 — info experiences (DONE, on branch `captain/wolfhouse-experiences-knowledge`)
- Added `experiences` category to `config/clients/wolfhouse-somo.knowledge.json` (surf+motocross, surf+grappling), EN/IT/ES/DE, **describe + hand off** (no invented price/schedule; added to `unsafe_to_invent`).
- Config-driven: `detectGuestKnowledgeIntent` already matches on each category's `keywords` (no code change). Verified: motocross/grappling/bjj/"otras actividades"/"aktivitäten" all route to `experiences`.
- **Not yet deployed** — Wolfhouse Luna is live. Deploy is a deliberate, confirmed step.

## Phase 2a — portal-editable experiences (self-serve info, no deploy per edit)
Goal: Ale adds/edits experiences in the staff portal; Luna reads them live — same pattern as Sunset admin.
- New entity `tenant_experiences` (or reuse a knowledge table): `name`, `blurb` (multilingual), `schedule_notes`, `keywords[]`, `active`, `bookable` (bool), and the Phase 2b fields.
- Knowledge loader reads **DB-or-config** (mirror `SUNSET_ADMIN_DB_READ_ENABLED`): if DB experiences exist, merge them into the resolved knowledge categories; else fall back to `knowledge.json`.
- Admin write API + a simple portal card editor (reuse the Sunset admin write/gate plumbing).
- Verify: detection still routes guest text → experience; describe+handoff copy intact.

## Phase 2b — bookable experiences (the real engineering)
Goal: flag an experience "bookable", give it a price + package/add-on code, and a guest books it like a normal add-on ("add it, done").
- **Rail choice:** ride the **add-on** rail (flat price, attach to a stay), NOT the weekly-package rail (per-person-per-week + seasons + room supplements). Flat-price experiences fit add-ons cleanly.
- **The blocker:** the add-on catalog is **hardcoded across ~10 modules** — `luna-booking-addons-policy.js` (`extractAddOnsFromText` regex, `INTAKE_TO_QUOTE`, `IN_SCOPE_ADDONS`, `PACKAGE_INCLUDED_SERVICE_CODES`), `guest-addon-pricing.js`, `wolfhouse-quote-calculator.js`, `luna-guest-addon-service-attach.js`, etc. Prices live in `wolfhouse-somo.pricing.json` `add_ons` (good), but detection/mapping/scope are code.
- **Work:** make the add-on catalog **data-driven** — a single source (config/DB) of `{code, label, keywords, price, unit, in_scope, included_in_packages}` that those modules read, instead of hardcoded maps. Then a bookable experience is just a row → Luna detects it, quotes it from config, attaches it, books normally.
- **Sequencing:** (1) extract the add-on catalog to data; (2) point the policy/quote/attach modules at it; (3) experiences-as-add-ons fall out for free. Guard with `verify:guest-addon-pricing`, `verify:luna-n8n-addon-request-dry-run`.
- **Safety:** an experience with no price stays Phase-1 describe+handoff; only `bookable && price` enters the quote path.

## Don't
- Don't sell "bookable" as a quick toggle — 2b is a real refactor (the de-hardcoding lesson again).
- Don't model experiences as weekly packages — wrong pricing shape.

## Also noted
Wolfhouse `verify:luna-golden` is currently red on master (16 deterministic-composer fixtures) — pre-existing, unrelated to experiences; worth a separate look.
