# Crowsnest

**Crowsnest** is the internal dev/operator control portal for Luna Front Desk.

| | |
|---|---|
| **Audience** | Humans who build and operate the platform — initially **Monshies** and **Earthling** only |
| **Not** | Guest-facing, tenant staff portal, or Wolfhouse-specific |
| **Future** | Client onboarding and control: add new Luna Front Desk clients from a frontend |

## What it is

- Internal tooling for platform operators
- Long-term home for onboarding and managing clients (tenants)
- Separate from per-tenant staff portals (Wolfhouse, Sunset, Mirleft, etc.)

## What it is not

- Not a guest WhatsApp or booking surface
- Not the Wolfhouse staff portal (`staff-staging.lunafrontdesk.com`)
- Not Sunset admin or tenant runtime

## Product direction

The first real Crowsnest module is the **AI Usage Panel** for internal Ship operators. Client onboarding remains a later Crowsnest capability; it is not part of Skipper's current platform redesign.

Later, operators may also:

1. Choose a **template** — surf house or surf school
2. Fill in new client information
3. Create the new client/tenant setup from the portal (gated slices; no blind writes)

## VERIFIED CURRENT LIVE BASELINE

**VERIFIED CURRENT LIVE BASELINE** (deployed standalone app with branded login portal): `https://crowsnest.lunafrontdesk.com` on `crowsnest-internal`; browser UI auth via branded session portal (`/login`); legacy Basic Auth retained for compatibility; `/healthz` reports `service: crowsnest`, `stage: portal`, `auth_enabled: true`, `writes_enabled: false`. See [`CROWSNEST-LOCATION-PLAN.md`](CROWSNEST-LOCATION-PLAN.md) and [`CROWSNEST-DEPLOY-PLAN.md`](CROWSNEST-DEPLOY-PLAN.md).

| Item | Status |
|------|--------|
| Dedicated location | `scripts/crowsnest-api.js` + `scripts/lib/crowsnest/` |
| Azure app | Standalone `crowsnest-internal` Container App in `wh-staging-rg` |
| Public URL | `https://crowsnest.lunafrontdesk.com` |
| Static placeholder UI | Skeleton + read-only **Clients** overview + **New client onboarding** form mockup |
| Onboarding mockup | Draft form only — surf house / surf school templates; all fields and buttons disabled; no submit |
| `GET /healthz` (live) | `service: crowsnest`, `stage: portal`, `writes_enabled: false`, `auth_enabled: true`; allowed users Monshies/Earthling |
| Login portal (live) | `GET /login` renders the branded operator sign-in page; `POST /login` issues an in-memory session cookie; `POST /logout` clears it |
| Browser access (live) | Unauthenticated UI requests to `/`, `/crowsnest`, and `/crowsnest/ui` redirect `302` to `/login` with no Basic challenge; legacy Basic Auth still works if supplied |
| Asset route (live) | `/crowsnest/assets/logo.png` serves the bundled logo as `image/png` with long-lived cache headers |
| Writes / DB / Stripe / WhatsApp | **None** |
| Deploy / Azure / domain | Live standalone app with login portal promoted — see location/deploy plans |

The current UI is only a safe shell. The AI Usage Panel has not been implemented yet.

### Slice 3 (adapter only — not integrated)

Offline **AI usage adapter**: maps native OpenAI / Anthropic technical usage fields into validated `crowsnest.ai_usage.v1` events with explicit trusted `client_slug` / `tenant_id`. Pure module + synthetic fixtures + `npm run verify:crowsnest-ai-usage-adapter`. See [`docs/crowsnest/AI-USAGE-ADAPTER.md`](crowsnest/AI-USAGE-ADAPTER.md). No storage, no provider runtime/call-site wiring, no UI panel.

### Slice 2 (contract only — not integrated)

Offline **AI usage event contract** (`crowsnest.ai_usage.v1`): pure validator, sanitized fixtures, and `npm run verify:crowsnest-ai-usage-contract`. See [`docs/crowsnest/AI-USAGE-EVENT-CONTRACT.md`](crowsnest/AI-USAGE-EVENT-CONTRACT.md). No storage, provider wiring, or UI panel in this slice.

### Luna Sales Chapter 9 (manual contact enrichment)

Protected **manual contact candidates** on prospect detail: authenticated operators record name, role, optional email/phone/LinkedIn, source, and confidence via `POST /sales/prospects/:id/contacts`. Contacts are prospect-scoped, newest-first, XSS-escaped, and append-audited as `contact_candidate_recorded`. CRM preview includes stored contacts as Contacts (still preview only). Copy states **manual contact records only — no Apollo lookup, no auto-find, no CRM write, no message sent**. No Apollo/other external enrichment calls, no auto-find, no sending. Migration `047_luna_sales_contact_candidates.sql`. See [`docs/crowsnest/SALES-CONTACT-ENRICHMENT.md`](crowsnest/SALES-CONTACT-ENRICHMENT.md). Verify with `npm run verify:crowsnest-sales-contact-enrichment`.

### Luna Sales Chapter 8 (Google Maps discovery dry-run shell)

Provider-specific **Google Maps discovery adapter shell** behind the Chapter 7 contract: dry-run / local fixtures only. Authenticated operators use `/sales/discovery` Maps dry-run search (Northern Spain scope), preview normalized candidates with exact place ID + search-area provenance and dedup preview, then **explicitly import** one candidate (audited). UI states **sample / dry-run data only**. No live Google Maps HTTP, API key, Google SDK, or scraping; no auto-create; no new discovery migration. See [`docs/crowsnest/SALES-MAPS-DISCOVERY.md`](crowsnest/SALES-MAPS-DISCOVERY.md). Verify with `npm run verify:crowsnest-sales-maps-discovery`.

### Luna Sales Chapter 7 (discovery source contract)

Provider-neutral **discovery source contract** (`crowsnest.sales.discovery.v1`) with a **manual-source adapter only**. Authenticated operators open `/sales/discovery` to enter one proposed prospect (business name/website/location/category/source reference), preview normalization + deduplication (domain, then name/location fingerprint), and optionally **explicitly import** (audited `discovery_proposal_imported`). Preview only — no prospect has been created until import. No Google Maps, Apollo, web search, or external API; no auto-create; no new discovery migration. See [`docs/crowsnest/SALES-DISCOVERY-SOURCE.md`](crowsnest/SALES-DISCOVERY-SOURCE.md). Verify with `npm run verify:crowsnest-sales-discovery-contract`.

### Luna Sales Chapter 6 (outreach drafts)

Protected **outreach draft workspace** for CRM-ready prospects: authenticated operators open `/sales/prospects/:id/outreach-draft` (linked from prospect detail when CRM-ready) to manually create/edit a single current draft (subject, body, channel `email`/`linkedin`/`other`, next-step note). Copy states **draft only — no message has been sent**. Saves append revisions + audit `outreach_draft_saved`. Detail and review queue show truthful **draft ready** / **draft present** indicators (not delivery status). No SMTP, WhatsApp, LinkedIn, HubSpot API, send endpoint, webhooks, or AI generation. Migration `046_luna_sales_outreach_drafts.sql`. See [`docs/crowsnest/SALES-OUTREACH-DRAFTS.md`](crowsnest/SALES-OUTREACH-DRAFTS.md). Verify with `npm run verify:crowsnest-sales-outreach-drafts`.

### Luna Sales Chapter 5 (CRM sync preview / HubSpot adapter boundary)

Protected **CRM sync preview** for currently qualified prospects: authenticated operators open `/sales/prospects/:id/crm-preview` (linked from prospect detail) to see exactly what would become one Company and zero-or-more Contacts under the accepted future mapping — lifecycle `Lead` plus Company property `Luna Sales Status = Qualified Prospect`; no Deal. Copy states preview only — no CRM record has been sent. Manual **Mark ready for CRM review** (`POST .../crm-ready`) requires latest qualification `qualified`, append-audits `crm_review_ready_marked` with qualification evidence/reason traceability, and feeds review-queue bucket/filter `crm_ready`. Provider-neutral domain terms; no HubSpot SDK/HTTP/env keys, no automatic writes, no outreach. Migration `045_luna_sales_crm_review.sql`. See [`docs/crowsnest/SALES-HUBSPOT-ADAPTER.md`](crowsnest/SALES-HUBSPOT-ADAPTER.md). Verify with `npm run verify:crowsnest-sales-hubspot-adapter`.

### Luna Sales Chapter 4 (review queue and operations)

Protected **Sales review queue** at `/sales/review` for authenticated operators. Lists persisted prospects in truthful buckets — Ready for review (evidence, no current qualification), Needs more research, Qualified, Not qualified, Ready for CRM review (Chapter 5) — with business name, website when present, latest qualification, evidence count, most recent activity, and a safe detail link. Deterministic ordering (newest actionable first); no invented scores/AI priority. Server-side `?state=` filter (`all` / `actionable` / `needs_more_research` / `qualified` / `not_qualified` / `crm_ready`) with empty states and an honest note that operators decide. No HubSpot sync writes, outreach, or external discovery claims. Reuses durable store reads (bounded schema-qualified SQL only; Chapter 5 adds CRM readiness marks). See [`docs/crowsnest/SALES-REVIEW-QUEUE.md`](crowsnest/SALES-REVIEW-QUEUE.md). Verify with `npm run verify:crowsnest-sales-review-queue`.

### Luna Sales Chapter 3 (qualification policy)

On the existing prospect detail page, authenticated operators can record a **transparent qualification assessment** (`qualified` / `not_qualified` / `needs_more_research`) with a short rationale and explicit references to evidence already on the prospect. The detail page shows the latest assessment, evidence links, assessment history, and append-only audit (`qualification_assessed`). No hidden score, automatic AI scoring, HubSpot sync, external research, or outreach. Migration `044_luna_sales_qualification.sql`. See [`docs/crowsnest/SALES-QUALIFICATION-POLICY.md`](crowsnest/SALES-QUALIFICATION-POLICY.md). Verify with `npm run verify:crowsnest-sales-qualification`.

### Luna Sales Chapter 2 (research evidence workspace)

On the existing prospect detail page, authenticated operators can record **dated manual research evidence** (source label/URL, summary, factual notes, limitations, confidence). Fixture research is preserved; evidence is prospect-scoped in `luna_sales.research_jobs`, listed newest-first, XSS-escaped in the UI, and append-audited as `research_evidence_recorded`. Extends Chapter 1 via migration `043_luna_sales_research_evidence.sql` (`source_url`, `confidence`). Does **not** claim live AI or external research providers. See [`docs/crowsnest/SALES-RESEARCH-EVIDENCE.md`](crowsnest/SALES-RESEARCH-EVIDENCE.md). Verify with `npm run verify:crowsnest-sales-research`.

### Luna Sales Chapter 1 / Slice 1 (durable store foundation)

Protected **Sales** navigation area: manual website **or** business-name intake → prospect → fixture/manual research packet → review detail → authenticated operator `approved` / `rejected` / `needs_research` decision → append-only audit trail. Persistence uses dedicated schema `luna_sales` via `CROWSNEST_SALES_DATABASE_URL` (never `WOLFHOUSE_DATABASE_URL`). Production without that DSN **fails closed** on Sales mutations; non-production/test may use an explicit in-memory fallback. See [`docs/crowsnest/SALES-DURABLE-STORE.md`](crowsnest/SALES-DURABLE-STORE.md). No HubSpot, Maps, Apollo, live AI research, outreach sending, or roles system. Verify with `npm run verify:crowsnest-sales` and `npm run verify:crowsnest-sales-durable`.

### Luna Sales Slice 1 (in-memory vertical slice — historical)

The first Sales vertical slice shipped in-memory only (restart-lost). Chapter 1 / Slice 1 above replaces that persistence model while keeping the same UI loop.

### Slice 1 (merged and deployed)

**Slice 1 is merged and deployed** — PR [#128](https://github.com/wolfhouse-somo/WH/pull/128); master/image SHA `14a7e3f7f656dd8a7dc11b528b8a645d3feb1210`; ACR build `cb11e`; active healthy revision `crowsnest-internal--0000010` at **100% traffic**. Protected routes: `/` (Spyglass default), `/clients`, `/billing`, `/communications` (aliases `/crowsnest` and `/crowsnest/ui` still render Spyglass). Honest read-only Spyglass shell from in-memory static client data; Billing/Communications placeholders stay **not connected**. No live writes or integrations. Staff API remained `wh-staging-staff-api--0000520` (untouched).

### History (pre-login-portal live shell)

Before the login-portal image was promoted, the public hostname used a browser Basic Auth challenge on `/` and `/healthz` reported `stage: skeleton`. That shell is **historical only** and is no longer the live baseline.

## Ownership boundary

- Crowsnest work stays in `scripts/crowsnest-api.js`, `scripts/lib/crowsnest/`, Crowsnest-specific tests/docs, and its dedicated image/runtime configuration.
- Do not modify Wolfhouse guest flows, tenant Staff API behavior, Sunset, Stripe, WhatsApp, or booking logic for a Crowsnest feature.
- Skipper's redesign is separate. Crowsnest may read stable contracts later, but should not copy or pre-empt Skipper's in-progress architecture.
- The old unpushed `surf_house` archetype branch is reference material only. Revalidate it after the shared redesign settles before reusing any part of it.

Run locally:

```bash
npm run crowsnest:start
# or: CROWSNEST_PORT=3040 node scripts/crowsnest-api.js
curl http://127.0.0.1:3040/healthz
```

### Auth (operator accounts)

Live and local browser access (when auth is enabled) use the branded login portal. Legacy Basic Auth remains accepted for compatibility. **`GET /healthz` is always public** and never includes credentials. Live operator credential distribution is out of scope for this doc.

Preferred configuration is **two independent operator accounts** (Earthling + Monshies). Do not put defaults in production.

| Variable | Default | Notes |
|----------|---------|-------|
| `CROWSNEST_AUTH_REQUIRED` | `false` | Set `true` to require login for normal browser UI access |
| `CROWSNEST_AUTH_EARTHLING_USERNAME` | _(none)_ | Earthling operator username; Azure secret ref `cn-auth-user` (value never in docs). **VERIFIED CURRENT LIVE** multi-account mapping. |
| `CROWSNEST_AUTH_EARTHLING_PASSWORD` | _(none)_ | Earthling operator password; Azure secret ref `cn-auth-pass` (value never in docs). **VERIFIED CURRENT LIVE** multi-account mapping. |
| `CROWSNEST_AUTH_MONSHIES_USERNAME` | _(none)_ | Monshies operator username; Azure secret ref `cn-monshies-user` (value never in docs). **VERIFIED CURRENT LIVE** multi-account mapping. |
| `CROWSNEST_AUTH_MONSHIES_PASSWORD` | _(none)_ | Monshies operator password; Azure secret ref `cn-monshies-pass` (value never in docs). **VERIFIED CURRENT LIVE** multi-account mapping. |
| `CROWSNEST_AUTH_USERNAME` | `admin` (non-production only) | **Legacy single-account fallback only** when none of the four multi-account variables are present. Never combined with multi-account mode. Compatibility behavior only — live production uses the four-variable pairs above. |
| `CROWSNEST_AUTH_PASSWORD` | `admin` (non-production only) | Legacy single-account fallback password (same isolation rules as username). Compatibility behavior only. |
| `CROWSNEST_ALLOWED_USERS` | `Monshies,Earthling` | Informational allow-list in `/healthz` only |

Multi-account rules:

- If **any** of the four `CROWSNEST_AUTH_EARTHLING_*` / `CROWSNEST_AUTH_MONSHIES_*` variables are present, multi-account mode is selected and legacy `CROWSNEST_AUTH_USERNAME` / `CROWSNEST_AUTH_PASSWORD` are ignored.
- Both complete account pairs are required. Missing, blank, or **duplicate** usernames → auth misconfigured (`503` when auth is required). Passwords may not be blank.
- Non-production `admin`/`admin` remains only when neither multi-account nor legacy variables are present.

When `CROWSNEST_AUTH_REQUIRED=true`:

- `GET /login` shows the branded login form
- Valid credentials for **either** operator on `POST /login` → `302` to `/` with an independent opaque `HttpOnly`, `SameSite=Strict` session cookie (`Secure` in production)
- Invalid credentials → the same login page with a generic error and no credential leak
- `POST /logout` clears **that** session cookie/token only and returns to `/login`
- Unauthenticated browser access to protected UI routes redirects to `/login`
- Auth required but credentials empty/missing/invalidly configured → `503` (`Crowsnest auth is not configured`)
- Legacy Basic Auth requests are still accepted on the protected UI routes for compatibility (either configured operator)

Local auth-enabled smoke (multi-account):

```bash
CROWSNEST_AUTH_REQUIRED=true \
CROWSNEST_AUTH_EARTHLING_USERNAME=earthling \
CROWSNEST_AUTH_EARTHLING_PASSWORD=earth-secret \
CROWSNEST_AUTH_MONSHIES_USERNAME=monshies \
CROWSNEST_AUTH_MONSHIES_PASSWORD=mon-secret \
npm run crowsnest:start
curl -i http://127.0.0.1:3040/                      # 302 -> /login
curl -i http://127.0.0.1:3040/login                 # branded form
curl -i -u earthling:earth-secret http://127.0.0.1:3040/crowsnest/ui  # 200
curl -i -u monshies:mon-secret http://127.0.0.1:3040/crowsnest/ui     # 200
curl http://127.0.0.1:3040/healthz                  # 200, auth_enabled:true, no password
```

Legacy single-account smoke (fallback only):

```bash
CROWSNEST_AUTH_REQUIRED=true CROWSNEST_AUTH_USERNAME=admin CROWSNEST_AUTH_PASSWORD=admin npm run crowsnest:start
```

Verify:

```bash
npm run verify:crowsnest
npm run verify:crowsnest-auth
npm run verify:crowsnest-sales
npm run verify:crowsnest-sales-durable
npm run verify:crowsnest-sales-contact-enrichment
npm run verify:crowsnest-ai-usage-contract
npm run verify:crowsnest-ai-usage-adapter
```
