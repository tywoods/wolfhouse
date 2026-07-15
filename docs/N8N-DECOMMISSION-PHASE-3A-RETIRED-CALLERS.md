# n8n Decommission — Phase 3A: Retired Callers

**Date:** 2026-07-15  
**Branch:** `feat/n8n-decommission-retired-callers`  
**Scope:** Remove the retired Wolfhouse Apps Script → n8n Cloud manual-entries caller from the repo. No Azure, Meta, Stripe, Airtable, or production changes.

## Operator evidence (established before this change)

| Fact | Status |
|------|--------|
| `tywoods.app.n8n.cloud` workspace | **Absent** (“No workspace here”) |
| Wolfhouse Google Sheet / Manual Entries flow | **No longer used** — replaced by Staff Portal Booking Calendar |
| Airtable automations posting to n8n Cloud | **Not running** |
| Staging Meta inbound | **Hermes** (`lunabox.lunafrontdesk.com/whatsapp/webhook`) |
| Azure n8n Container Apps | **Absent** |

## What this phase retires

Removed in-repo Apps Script integration that hardcoded:

`https://tywoods.app.n8n.cloud/webhook/wolfhouse-manual-entries-queue`

Former paths:

- `apps-script/code.gs`
- `apps-script/ManualBookingDialog.html`
- `apps-script/UpdateManualBookingDialog.html`

## Replacement owner

**Staff Portal Booking Calendar** (Staff API manual booking / bed calendar flows) owns staff booking entry. Do not reintroduce Sheet → n8n Cloud UrlFetch.

## Still unknown (do not assume)

- Production Meta WhatsApp `phone_number_id` / callback ownership
- Stripe **live**-mode webhook endpoint inventory

Those remain open from Phase 2 attestation and are out of scope for 3A.

## Historical documentation

PHASE/STAGE docs, `docs/webhook-map.md`, `docs/airtable-automations.md`, and related migration notes remain in the repo as **historical evidence** for later archival. This phase does not bulk-delete or rewrite them.

## Guard

`node scripts/verify-n8n-retired-callers.js` fails if executable/runtime code reintroduces Cloud hosts, active n8n webhook URLs, or new `N8N_*` runtime dependencies (with an allowlist for docs, migration helpers, and `no_n8n` / `calls_n8n:false` safety assertions).
