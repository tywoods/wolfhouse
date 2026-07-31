# Staff API Decomposition Architecture Plan

> **For Hermes:** This is an architecture and sequencing artifact. Do not implement more than one approved slice at a time.

**Goal:** Decompose `scripts/staff-query-api.js` incrementally while preserving URL/API contracts, router-owned authorization, mutation authority, tenant isolation, generated `/staff/ui` behavior, and rollbackability.

**Architecture:** Treat Staff API as the host process and route/auth composition root, not as a rewrite target. Harden its generated-browser boundary first, freeze the vertical and identity/scope contracts second, and extract only cohesive behavior after those contracts are proven.

**Tech stack:** Node.js, request-time generated HTML/JavaScript, PostgreSQL, Azure Container Apps, offline verifier scripts, VM/fake-DOM tests, selective cooked `/staff/ui` tests.

---

## 1. Status and evidence

- Exact base: `77f06aeb2fa662cb59e4d79df631dbd329140c13`.
- `scripts/staff-query-api.js`: **49,207 lines**.
- Browser files directly matching `scripts/browser/sunset-*.js`: **17**.
- Server files directly matching `scripts/lib/sunset-*.js`: **58**. A broader recursive filename predicate `*sunset*.js` returns **63** and is not the inventory used here.
- Schedule functions: **234** column-zero / **235** indentation-tolerant.
- `pathname ===` checks: **158**.
- `require('./lib/…')` lines: **167**.
- Existing browser classification: **2 generic platform + 12 surf-school vertical + 3 Sunset compatibility adapters**.
- Primary analyst: Cursor read-only report.
- Architecture review: Sea Dog **BLOCK**, corrections incorporated below.
- Generated-browser review: Deckhand **PASS Slice 1**; ADR remains blocked until the frozen contracts below are accepted.
- No implementation, deployment, database, Azure, secret, or live-data action has occurred.

## 2. Host responsibility map

| Approximate range | Owner responsibility | Decomposition posture |
|---:|---|---|
| 1–120 | dotenv, auth/Meta fail-closed boot, Fortress seams | Shared host bootstrap; preserve load/exit behavior |
| 123–854 | module composition and PG wrapping | Composition root; do not turn into a generic service locator |
| 855–1959 | environment gates, auth session, HTTP helpers, intents/query, Stripe landings | Shared host/platform, but preserve public vs authenticated boundaries |
| 1960–2630 | Ask Luna and owner SQL | Separate operator surface; extraction candidate only after route contract inventory |
| 2630–9483 | lodging booking preview/move/edit/cancel/services/cash/payment links | Write-critical lodging vertical; high-risk later track |
| 9483–13642 | Luna/bot routes, pause and dry-runs | Shared bot surface with tenant-binding constraints |
| 13642–15680 | Meta/Stripe ingress, payment-link creation, manual booking create | External ingress/write critical; do not combine with browser decomposition |
| 15681–39832 | `buildUiHtml`: portal HTML/CSS/browser IIFE and module injection | Generated-browser host; first hardened seam |
| 39834–39906 | `/staff/ui`, login HTML, static assets | Router/auth remains authoritative |
| 39907–47148 | Admin, Schedule, Customers, Inbox, Calendar, Tour Ops and remaining handlers | Existing libs plus residual SQL; extract by cohesive route family only |
| 47149–49001 | central router | Stable route/auth composition point during initial decomposition |
| 49003–49207 | server factory, listen/readiness/shutdown/test seams | Shared lifecycle authority; preserve `require.main` and Fortress gates |

This map is architectural, not permission to move every range.

## 3. Frozen compatibility and security boundaries

These are mandatory for the initial decomposition window.

### 3.1 Stable URL and request contracts

- Preserve existing `/staff/schedule/*` paths, methods, query names, body fields, response shapes, and status behavior.
- Preserve `/staff/ui`, auth/login, bot, webhook, waiver, customer, inbox, and lodging route contracts unless a separately approved route-contract slice says otherwise.
- Internal extraction must remain invisible to current staff, Luna, browser, and automation callers.

### 3.2 Router-owned authentication and authorization

- The central router remains the sole route/auth composition point during the initial slices.
- Existing role minimums remain exact: viewer reads and operator mutations where currently enforced.
- Imported handlers and write modules do not implicitly own or replace router authorization.
- Authorization may move only in a separate security-reviewed route-adapter slice that proves identical checks before the old path is removed.

### 3.3 Public versus authenticated routing

- Public waiver/form routing remains explicitly separate from normal authenticated staff routing.
- Do not absorb the public waiver route into a generic Schedule package.
- Staff waiver actions and public waiver form handling remain separate authority classes.

### 3.4 Mutation ownership

- Existing Sunset Schedule write/quote/delete/Stripe-link owners remain authoritative.
- Existing lodging booking edit/move/cancel/payment owners remain authoritative.
- Browser drawers present intent; they do not become write authority.
- No extraction may duplicate writes, validation, idempotency, Stripe truth, or SQL transaction boundaries.

### 3.5 Tenant and location identity/scope

- Server code remains authoritative for tenant and location validation.
- `isSunsetLocationId` and `resolveRentalOfferingLocationScope` remain fail-closed safety gates.
- Sunset requires a recognized Sunset location where currently required.
- Non-Sunset clients must not acquire Sunset location scope.
- SQL/defaulting authority stays server-side.
- Any browser catalog is presentation data only, never authorization.
- Unknown or mismatched client/location combinations fail closed.
- Host→client allowlists, per-image `DEFAULT_CLIENT_SLUG`, bot principal binding, and golden no-send remain intact.

### 3.6 Infrastructure boundary

- Crowsnest remains a separate entrypoint and must not import Staff API.
- Captain retains Azure resource ownership, identity, RBAC, DNS, deployment, and migration authority.
- This architecture plan creates no infrastructure work.

## 4. Generated-browser ownership

- `buildUiHtml` is the request-time generated `/staff/ui` host.
- `scripts/browser/*` files are source owners; cooked HTML is a generated consumer, not a second owner.
- Schedule injection has **14** canonical markers in fixed order:
  1. money-parse
  2. rental-availability
  3. portal-module
  4. drawer-view-ui
  5. drawer-edit-ui
  6. drawer-actions
  7. drawer-controller
  8. day-ops-board-ui
  9. forecast-cards-ui
  10. view-grid-ui
  11. runtime
  12. navigation-ui
  13. row-normalizer
  14. data-loader
- Production has all 14; the architecture verifier currently lists only 12.
- `injectAtMarker` is intentionally permissive for partial fixture callers.
- Strict production validation must be a separate API and must not alter partial-fixture semantics.

## 5. Test taxonomy

| Test class | What it proves | Limit |
|---|---|---|
| Source/architecture checks | file presence, marker order, frozen APIs | Does not prove cooked HTML |
| Partial hand-built injection fixtures | isolated module compatibility | Must remain permissive; not production-template evidence |
| Fake-DOM/VM behavior | local handlers and state transitions | Not real layout/browser lifecycle |
| Offline `buildUiHtmlForOfflineTest` | actual production cook path without server listen | Dual-gated seam; should be used for Slice 1 |
| Spawned `/staff/ui` tests | request-time generated HTML through HTTP | Often open-auth test process; still not authenticated staging |
| Authenticated Playwright/staging | full browser/runtime acceptance | Not required for behavior-neutral Slice 1; required when later UI behavior changes |
| Startup/readiness gates | load/listen/shutdown behavior | Must preserve `require.main` and readiness lifecycle |

Do not count assertions as quality. Record which boundary each verifier actually exercises.

## 6. Approved first slices

Only one slice may be implemented and reviewed at a time.

### Slice 1 — Strict production full-template injection

**Status:** Architecturally approved by Sea Dog and Deckhand; not implemented.

**Objective:** Prevent production `/staff/ui` from silently omitting a Schedule module while preserving partial test fixtures.

**Likely files:**
- `scripts/lib/sunset-schedule-browser-source.js`
- `scripts/staff-query-api.js`
- `scripts/verify-sunset-schedule-architecture.js`
- Existing focused partial/full cook verifiers only as required

**Required behavior:**
- Publish one canonical ordered list of all 14 marker constants.
- Add `injectSunsetSchedulePortalModuleStrict` or equivalent explicit strict wrapper.
- Strict wrapper asserts every marker exists before injection and optionally asserts none remain afterward.
- Keep `injectSunsetSchedulePortalModule` and `injectAtMarker` permissive for intentional partial callers.
- Wire strict mode only at production `buildUiHtml`’s final injection call.
- Expand architecture coverage from 12 to all 14 markers in exact order.

**RED proof:**
- A production-shaped 13-marker template currently succeeds silently; strict test must fail before implementation.
- Architecture verifier must expose missing money-parse and rental-availability coverage.

**GREEN proof:**
- Full 14-marker template succeeds and embeds all module bodies.
- Removing any marker causes strict mode to throw with the missing marker identity.
- The same incomplete input remains accepted by the permissive function.
- Offline production `buildUiHtmlForOfflineTest` cooks successfully through strict mode.
- Existing partial create/drawer fixtures remain green.
- Money parser remains externally injected and cooked regex behavior remains valid.
- Startup smoke confirms requiring the module does not begin listening.

**Minimum gates:**
- `node scripts/verify-sunset-schedule-architecture.js`
- Focused drawer-actions, drawer-edit, edit-parity, create-course, create-private, and create-footer verifiers that use partial injects
- `node scripts/verify-sunset-rendered-ui-price-hotfix.js`
- Staff API startup smoke

**Stop conditions:**
- Any shared permissive helper becomes fail-closed.
- Any partial fixture breaks because strict mode was wired globally.
- Money-parse moves into the template literal or cooked regex corrupts.
- Diff touches Schedule routes, roles, waiver routing, mutation handlers, tenant/location gates, DB, Azure, or deployment files.
- Production HTML lacks a marker; fix the template rather than weakening strictness.

**Rollback:** One code revert restores the old production injector. No DB or infrastructure rollback.

### Slice 2 — Architecture Decision Record: vertical package and authority contract

**Status:** Documentation-only candidate. Previously blocked; this plan incorporates Sea Dog’s required boundaries and requires Captain approval before implementation or Client Maker use.

**Objective:** Define what a reusable surf-school package is allowed to own without moving code.

The ADR must state:
- Platform, surf-school vertical, Sunset compatibility, and tenant-configuration ownership.
- Stable Schedule URL and request contracts.
- Central router ownership of auth/role composition during initial decomposition.
- Exact mutation owners and prohibition on duplicate write authority.
- Public waiver separation.
- Server-owned tenant/location identity binding, SQL scope, defaults, and fail-closed mismatch behavior.
- Browser catalogs are presentation only.
- Existing Sunset compatibility gates remain until a separately verified adapter replaces them.
- Client Maker/FACTORY may inventory the package after the contract is approved, but may not activate or provision it from this slice.

**Stop conditions:** Any ADR text implies free-form browser locations, removal of server gates, moved authorization, changed URLs, Crowsnest integration, or implementation disguised as documentation.

### Slice 3 — Optional hygiene after the ADR

Choose only one after explicit review:
- Centralize the **seven literal** `const SUNSET_CLIENT_SLUG = 'sunset'` assignments if no circular dependency is introduced. Two additional files assign `SUNSET_CLIENT_SLUG` from the existing `SUNSET_ADMIN_CLIENT` authority and are not counted as duplicate literals; or
- Remove Sunset’s location dual mirror only if the ADR chose a server-owned catalog projection, while preserving server validation.

This slice does not itself make Client Maker runtime-ready.

## 7. Deferred decomposition tracks

Do not schedule these automatically from residual LOC:

1. Residual Schedule IIFE helpers—high implicit-global and UI lifecycle coupling.
2. Lodging booking edit/move/cancel/payment surface—write-critical and transaction-sensitive.
3. Portal shell and tabs—shared authenticated product surface.
4. Router dispatch extraction—only after handler ownership is stable; router remains auth composition authority.
5. FACTORY browser inventory—after the vertical package ADR, not before.
6. Admin helper single-source emission—separate generated-browser parity slice.

Before any deferred extraction, identify one concrete behavior, mutable-state owner, exact callers, cooked/live test boundary, and rollback point. Do not use line-count reduction as acceptance.

## 8. Worker and review protocol

- **Primary mapper:** responsibility ranges, routes, handlers, startup effects, existing owners.
- **Sea Dog:** adversarial coupling, write/tenant authority, false genericization, extraction ordering.
- **Deckhand:** generated `/staff/ui`, marker/full-versus-partial fixtures, cooked script and startup proof.
- **Captain:** final compatibility/security/operations approval and branch/PR ownership.
- Coding workers may work only on one approved slice in an isolated branch/worktree.
- Shared files have one writer at a time; merges and deployments are serial.
- No deployment until a merged exact-SHA branch passes repository/deploy preflight and operator explicitly approves deployment.

## 9. Questions and decisions

Resolved engineering default:
- Preserve existing `/staff/schedule/*` URLs and router-owned authorization during initial decomposition. Monshies does not need to choose between internal security designs.

Future questions only when their slice is imminent:
- Which runtime catalog representation should the approved ADR project to browsers?
- Which single concrete Schedule or lodging behavior justifies the first real extraction after Slice 1–3?
- When should FACTORY inventory the vertical browser package?

Do not ask these prematurely or infer answers from file names.

## 10. Completion definition for this architecture job

- Responsibility and authority map reviewed.
- Sea Dog and Deckhand findings incorporated.
- Captain returns PASS on this exact plan or material BLOCK evidence is resolved.
- Plan is committed separately from any runtime implementation.
- Slice 1 receives its own later branch, tests, review, merge, and optional staging deployment.
