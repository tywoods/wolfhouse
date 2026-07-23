# Project Clear Deck — Crowsnest Sales UX Reset

> Execute with Cursor Auto one named slice at a time. Stop after each slice for independent review. Do not combine slices or add Sales capabilities.

**Goal:** Make Crowsnest Sales an operator-first pipeline: see current work, understand the one next action, complete the existing human-approved workflow, and avoid the current wall of forms, navigation, and repeated caveats.

**Architecture:** Presentation-only work in `scripts/lib/crowsnest/crowsnest-page.js` and narrow deterministic verifier updates. Preserve `scripts/crowsnest-api.js` routes and every Sales domain/store/migration behavior. Keep server-rendered HTML/CSS, existing Crowsnest tokens, no new dependencies, migrations, integrations, network calls, automation, or credentials.

## Scope fence

Do not change:
- `scripts/lib/crowsnest/crowsnest-sales.js` decision rules, validation, audit semantics, or workflow gates;
- `scripts/lib/crowsnest/crowsnest-sales-store.js`, `luna_sales` schema, or migrations `042`–`047`;
- authenticated-operator access, POST actions, form field names, safe 400/403/404/405/503 behavior, HTML escaping, no-store headers, or HEAD behavior;
- preview-only CRM, draft-only outreach, manual contacts, preview-first discovery, and all no-auto-send/no-auto-write rules.

## Source evidence

- `/sales` currently combines disclaimer, four equal-weight links, raw prospect list, full intake form, and another safety box: `scripts/lib/crowsnest/crowsnest-page.js:1459+`.
- Detail renders research, contacts, qualification, CRM, outreach, admin decision, and audit as a long continuous set of cards: `scripts/lib/crowsnest/crowsnest-page.js:1646+`.
- Sales has 12 styled `.safety` blocks; important local warnings are diluted by repeated global text.
- Existing workflow surfaces that must remain: `/sales`, prospect detail/decision/evidence/contacts/qualification/CRM/outreach, review, analytics, governance, and manual/Maps-preview discovery routes.

## Target journey

```text
Sales cockpit → action queue → prospect workspace
  Overview → Research → Qualification → CRM review → Draft outreach
```

## Named slices

### A — North Star Baseline

**Purpose:** Create a presentation contract before visual changes.

**Allowed files:** `scripts/verify-crowsnest-sales.js`, new `scripts/verify-crowsnest-sales-ux.js` if needed, `scripts/verify-crowsnest.js` only for registration.

**TDD:** First add failing checks that require a cockpit heading, visible add-prospect action, action/pipeline region, preserved current routes/POST actions, and contextual safety copy. Then make no renderer change until RED is recorded.

**Verify:** base Sales, durable, research, qualification, HubSpot-preview, outreach drafts, contact enrichment, plus `git diff --check`.

**Exit:** Contract lists all preserved routes/actions and reliably fails against current UI intent.

### B — Sales Cockpit

**Purpose:** Make `/sales` answer “what do I do next?” instead of showing everything at once.

**Files:** `scripts/lib/crowsnest/crowsnest-page.js` (`renderSalesMain`, `renderProspectListItems`, Sales CSS); `scripts/crowsnest-api.js` only if it must pass existing read-only data already available—no store/query/domain changes.

**TDD acceptance:** add failing checks for stage counts based only on truthfully available records, next-action/attention list, compact prospects, primary **Add prospect**, and secondary grouped navigation (Work / Tools / Monitor / Reference). The default view must not show the long intake form.

**Implementation:** retain `POST /sales/prospects`, `business_name`, and `website_url`. Use `/sales?mode=add` or a narrow presentation route only if it preserves that POST. Promote Review queue; demote Analytics/Governance/Discovery.

**Exit:** A first-screen cockpit with one obvious next action; no invented priorities, scores, or data.

### C — Prospect Flight Deck

**Purpose:** Recompose one prospect into a lifecycle workspace, without modifying any action.

**Files:** `scripts/lib/crowsnest/crowsnest-page.js` (`renderSalesDetailMain` and display helpers); extract a narrow renderer module only if it reduces duplication.

**TDD acceptance:** compact identity/status header; truthful derived next-step copy; lifecycle-order sections (Overview, Research, Qualification, CRM review, Draft outreach); current errors/forms/endpoints unchanged; contacts and complete audit still available but visually secondary.

**Implementation:** use existing domain gates only: evidence before qualification, latest qualified assessment before CRM-ready, CRM-ready before outreach draft. Never add a send/sync/AI-score action.

**Exit:** An operator can identify status and next permitted action without reading historical/audit detail.

### D — Quiet Supporting Rooms

**Purpose:** Give each supporting route one job, one consistent Sales subnavigation, and concise action-adjacent warnings.

**Files:** `scripts/lib/crowsnest/crowsnest-page.js` review/analytics/governance/discovery/CRM/outreach renderers and focused presentation contracts only.

**Acceptance:**
- Review: filter and actionable queue; preserve all six filter values and domain ordering.
- Discovery: manual proposal primary; Maps explicitly sample/dry-run; preview and import remain separate POSTs.
- Analytics: factual read-only indicators with no remediation controls.
- Governance: detailed safeguards live here.
- CRM/outreach: one local badge (“Preview only” / “Draft only”) next to the action; no repeated page-wide caveats.

**Exit:** No supporting page is a duplicate navigation wall or safety-text wall.

### E — Polished Hull

**Purpose:** Apply a calm, consistent responsive visual hierarchy.

**Files:** Sales-specific CSS in `scripts/lib/crowsnest/crowsnest-page.js`; UX verifier.

**TDD acceptance:** stable structural hooks for cockpit, action cards, status chips, workspace header, subnavigation, and narrow-screen fallback.

**Rules:** use existing `--sand`, `--sea`, `--navy` tokens; no new component library or design system. Verify headings, labels, focus, errors, non-colour-only status, and desktop/narrow layouts locally after automated checks pass.

**Exit:** Sales is visually scannable and keyboard-usable, without hiding essential data.

### F — Sea Trial

**Purpose:** Final scope and behavior proof.

Run all Sales suites in `package.json` (base, durable, research, qualification, review queue, HubSpot preview, outreach, discovery contract, Maps discovery, contacts, analytics, governance), `verify:crowsnest-auth`, `verify:crowsnest`, JS syntax checks, and `git diff --check`.

Document—not mask—the existing outreach verifier false positive if it remains: its static `HUBSPOT_*` pattern currently flags the benign `hubspot_crm` governance identifier despite no send/HTTP wiring. Do not fix that unrelated verifier during this UX reset.

**Exit:** Only Sales presentation/tests/docs changed; all true workflow behavior is unchanged and verified.

## Definition of done

- Sales opens to a useful cockpit, not an all-in-one form page.
- One prospect page communicates the current stage and next allowed action.
- Safety boundaries are preserved but visible where they affect a decision.
- Every route/action, audit, durable persistence, approval gate, and no-auto-send/no-auto-write rule remains intact.
- No AI usage, Spyglass, Staff API, database, provider, payment, or guest-flow work is mixed into this branch.
