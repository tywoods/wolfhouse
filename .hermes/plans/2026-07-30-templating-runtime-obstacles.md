# Templating / runtime ownership audit — application obstacles

| Field | Value |
|-------|--------|
| **Date** | 2026-07-30 |
| **Base SHA** | `52160ab7f2a5b1ae92a13702625d5d38168060cf` (`Merge pull request #324 … docs/crowsnest-rg-migration-refresh`) |
| **Scope** | Read-only application/runtime templating audit |
| **Workspace** | `/opt/data/worktrees/WH-grok-templating-analysis` |
| **Out of scope** | Infra/RBAC redesign, Azure calls, secrets/live data, commits, deploys, wholesale rewrite |
| **Captain boundary** | Captain owns infrastructure, identity, RBAC, Crowsnest RG migration execution. This plan uses his docs/verify seams only to flag **application/deployment configuration** coupling. |

---

## 1. Executive recommendation (first 1–3 slices only)

Do **not** rename the `sunset-*` tree, split Staff API, or “genericize” Schedule/Admin in one pass. The current browser pipeline is already modularized at the file level; the residual obstacles are **ownership seams and contracts**, not missing file counts.

| Priority | Slice | Risk | Expected payoff |
|----------|--------|------|-----------------|
| **1** | **Complete marker coverage + strict production/full-template validation** — extend `verify-sunset-schedule-architecture` MARKERS to include `money-parse` + `rental-availability` (present in loaders/HTML today, absent from that verifier list). Add a **separate** strict full-template wrapper or explicit `requireAll` mode used **only** by production `buildUiHtml` / full-template builders. Keep `injectAtMarker` **permissive** (silent skip on missing marker) so verifier fixtures that intentionally inject a partial marker set keep working. | **Low** — offline verifiers + production HTML build path only; no guest/staff behavior change when all production markers are present (validated). Risk is limited to: (a) full-template builders that omit a marker (should fail closed), and (b) any future caller of the new strict path that is not truly full-template. | Prevents silent empty Schedule modules after a bad production edit; closes architecture/source marker hole; **does not** break intentional partial fixture injects. |
| **2** | **Architecture decision (docs only, not code extraction): vertical package contract + runtime tenant/location catalog owner** — before Client Maker / FACTORY UI instantiation, decide and document: (a) what constitutes a reusable vertical UI/runtime package vs Sunset-only surface, and (b) which catalog is the **runtime-consumed** tenant/location owner (server allowlist vs injected browser catalog vs future multi-tenant catalog). Do **not** implement catalog injection or Staff API decomposition in this slice. | **Low** — documentation / decision record only. Product risk only if the written contract contradicts live gates (`isSunsetLocationId`, host allowlist, golden no-send). | Unblocks honest Client Maker planning without moving dual-mirror code underfoot; separates “what to own” from “what to extract.” |
| **3** (optional hygiene) | **Sunset location dual-mirror cleanup** — after the catalog-owner decision in slice 2, optionally inject a small browser catalog from `sunset-school-locations.js` so school switcher buttons + `getSunsetLocation()` allowlist stop hardcoding the same two IDs. Keep server-side `isSunsetLocationId` / `resolveRentalOfferingLocationScope` as the **authoritative safety gate**. **Not** a FACTORY or Staff API decomposition prerequisite. | **Medium** — UI school switcher + location query params; must not accept unknown IDs client-side. | Optional dual-mirror hygiene only. |
| **3b** (optional hygiene) | **Centralize `SUNSET_CLIENT_SLUG` imports** — 7 lib files re-declare `const SUNSET_CLIENT_SLUG = 'sunset'`; re-export once from `sunset-school-locations.js` (already exports it) and require it. No behavior change. | **Low** | Reduces false “many owners” noise; does not unblock FACTORY. |

**Honest risk:** Slice 3 is the only near-term product-surface change. Slices that further extract the remaining **234** `schedule*` functions (column-0 `function schedule…` defs) still living inside the portal IIFE of `staff-query-api.js` are valuable later but are **not** the first move — extraction without an ownership map recreated dual owners historically (payment/waiver/delete UI → consolidated into `drawer-actions`).

**Stop after slice 1–2 if:** any Schedule load, school switch, or drawer payment/waiver path regresses under existing `verify:sunset-schedule-*` / portal smoke gates — or if a strict full-template path is accidentally wired into partial fixture injects.

---

## 2. Completeness validation (programmatic)

Commands run at base `52160ab7…` (results recorded):

```bash
cd /opt/data/worktrees/WH-grok-templating-analysis
git rev-parse HEAD
# → 52160ab7f2a5b1ae92a13702625d5d38168060cf

ls -1 scripts/browser/sunset-*.js | wc -l
# → 17

wc -l scripts/staff-query-api.js
# → 49195 scripts/staff-query-api.js

rg -c '^function schedule' scripts/staff-query-api.js
# → 234

ls -1 scripts/lib/sunset-*.js | wc -l
# → 58

python3 - <<'PY'
from pathlib import Path
import re
src = Path('scripts/lib/sunset-schedule-browser-source.js').read_text()
admin = Path('scripts/lib/sunset-admin-browser-source.js').read_text()
api = Path('scripts/staff-query-api.js').read_text()
owned = set(re.findall(r"browser', '([^']+)'", src + admin))
disk = set(p.name for p in Path('scripts/browser').glob('sunset-*.js'))
print('owned==disk', owned == disk, 'n=', len(disk))
m1 = re.findall(r'/\* INJECT:([a-z0-9-]+) \*/', src)
m2 = re.findall(r'/\* INJECT:([a-z0-9-]+) \*/', api)
print('marker parity', m1 == m2, 'n=', len(m2))
print('silent miss', 'if (idx < 0) return html' in src)
reqs = re.findall(r"require\('\./lib/(sunset-[^']+)'\)", api)
print('require occurrences', len(reqs), 'distinct', len(set(reqs)))
PY
# → owned==disk True n=17
# → marker parity True n=14
# → silent miss True
# → require occurrences 24 distinct 23
```

| Check | Result |
|-------|--------|
| Browser `sunset-*.js` on disk | **17** |
| Referenced by schedule + admin browser-source loaders | **17 / 17** (none orphaned, none missing) |
| Schedule inject markers in loader vs `staff-query-api.js` HTML | **14 / 14** identical ordered list |
| Architecture verifier MARKERS list | **12** of 14 (omits money-parse + rental-availability) — completeness gap in **tests**, not disk |
| Removed payment/waiver/delete browser modules | Intentionally **absent**; `verify-sunset-schedule-drawer-actions.js` asserts absence |
| `staff-query-api.js` size | **49 195** lines (`wc -l`) |
| Portal residual column-0 `function schedule*` defs | **234** (`rg -c '^function schedule'`) — one additional indented `function schedule*` exists (total 235 with `^\s*function schedule`) |
| `scripts/lib/sunset-*.js` | **58** server modules |
| `staff-query-api` direct `require('./lib/sunset-…')` | **24 occurrences / 23 distinct modules** (`sunset-accommodation-admin` required twice) |

**Generated vs source:** Schedule/Admin browser modules are **source owners** under `scripts/browser/`. Runtime HTML is **generated at request time** by `buildUiHtml()` + `injectSunsetSchedulePortalModule()` (markers replaced; no committed cooked HTML copies of those modules). Do **not** count the injected HTML as a second owner.

**Permissive inject is intentional for fixtures:** `injectAtMarker` returns `html` unchanged when a marker is missing (`if (idx < 0) return html`). Production full HTML always carries all 14 markers; several offline verifiers intentionally pass **partial** marker strings into `injectSunsetSchedulePortalModule` (see §5.1 / Step 1). Therefore fail-closed must be a **separate strict path**, not an unconditional change to `injectAtMarker`.

Non-runtime noise: `_work/sunset-schedule-booking-drawer.js`, `_work/sunset-stripe-payment-links.js` **DIFF** from `scripts/lib/*` (SHA mismatch). Treat as **stale work copies**, not owners.

---

## 3. Inventory A — every `scripts/browser/sunset-*.js`

**Injection topology (source of truth):**

1. `buildUiHtml()` in `scripts/staff-query-api.js` (~L15696) builds HTML string.
2. Portal script IIFE opens ~L19929; **14** `/* INJECT:… */` markers ~L19934–19947.
3. `return injectSunsetSchedulePortalModule(html)` ~L39819 reads modules from disk and splices in **fixed order** (`scripts/lib/sunset-schedule-browser-source.js`).
4. Admin path is **template interpolation** (not markers): helpers + equipment models + admin UI ~L26625–26630 via `getSunsetAdminBrowserHelperSource`, `getSunsetEquipmentPricingModelSource`, `getSunsetAdminUiBrowserSource`.
5. Wolfhouse services admin injects beside Sunset admin (`getWolfhouseServicesAdminSource`) — vertical coexistence, not Sunset ownership.

**Required injection order (schedule):**  
money-parse → rental-availability → portal → drawer-view → drawer-edit → drawer-actions → drawer-controller → day-ops → forecast-cards → view-grid → **runtime** → navigation → row-normalizer → data-loader  

Compatibility adapters (`navigation`, `row-normalizer`, `data-loader`) call `SunsetScheduleRuntime.*` and **must** load after runtime. Call-time binding makes pre-runtime module definitions safe if they only *reference* `schedule*` helpers at call time.

**Primary ownership uses five categories only** (one primary per module):  
`generic platform` · `surf-school vertical` · `Sunset runtime compatibility adapter` · `tenant configuration` · `removable`  
Nuance (reusable patterns, pure models, schema assumptions) goes in **Purpose**, not a sixth category.

| Module | Primary ownership | Purpose (evidence) | Callers / injection | Tenant assumptions | Tests (sample) | Confidence |
|--------|-------------------|--------------------|---------------------|--------------------|----------------|------------|
| `sunset-schedule-money-parse.js` | **generic platform** | Browser money parse; strips `€$£` among other noise; kept **out** of template literal so `\\d` is not eaten | Marker `INJECT:sunset-schedule-money-parse`; Node `require` in price verifiers | None (pure parse) | `verify-sunset-create-custom-line`, `verify-sunset-rendered-ui-price-hotfix` | **High** |
| `sunset-rental-duration-model.js` | **generic platform** | Templatable (unit, count) ⇄ `duration_key`; header claims generic hours/days; historical half_day/full_day read aliases only | Admin loader concat **before** equipment model + admin UI; Node require from `tenant-admin-writes`, `tenant-rental-price-resolver` | None (pure model) | `verify-sunset-rental-duration-model`, equipment tab verifiers | **High** |
| `sunset-equipment-pricing-model.js` | **surf-school vertical** | *Pure vertical pattern* (no DOM/network) over rental `tenant_price_rules`, but **not** generic platform: excludes `full_day_equipment_extension`, assumes rental-category / offering-key schema from surf-school pricing | Admin loader after duration model; Node require in model verifier | Vertical offering/schema assumptions | `verify-sunset-equipment-pricing-model` | **High** |
| `sunset-schedule-runtime.js` | **surf-school vertical** | *Sunset / surf-school vertical runtime* containing reusable patterns (rows/load/nav closures, frozen APIs). **Not** generic platform: `fetchDay` hardcodes Sunset endpoint `client=sunset` + `sunsetLocationQuerySuffix()`, and non-Sunset branch uses different `/staff/query` intents | Marker after view-grid; required by shims | Sunset schedule day API + location suffix on Sunset path | `verify-sunset-schedule-architecture` | **High** |
| `sunset-schedule-navigation-ui.js` | **Sunset runtime compatibility adapter** | Thin wrappers → `SunsetScheduleRuntime.nav` (Sunset runtime surface, not free-standing platform) | Marker after runtime | None inherent beyond runtime | `verify-sunset-schedule-navigation-ui`, architecture | **High** |
| `sunset-schedule-row-normalizer.js` | **Sunset runtime compatibility adapter** | Thin wrappers → `SunsetScheduleRuntime.rows` | Marker after navigation | None inherent beyond runtime | `verify-sunset-schedule-row-normalizer`, architecture | **High** |
| `sunset-schedule-data-loader.js` | **Sunset runtime compatibility adapter** | Thin wrappers → `SunsetScheduleRuntime.load` | Marker last | None inherent beyond runtime | `verify-sunset-schedule-data-loader`, architecture | **High** |
| `sunset-schedule-rental-availability.js` | **surf-school vertical** | Canonical offerings `board_rental` / `wetsuit_rental` / `board_and_suit_rental`; `SCHEDULE_FULL_DAY_EQUIPMENT_OFFERING = 'full_day_equipment_extension'` | Marker #2; Node require from `sunset-standalone-rental-projection` + many rental verifiers | Vertical product vocabulary (not per-tenant prices) | `verify-sunset-schedule-rental-availability`, rental hotfixes | **High** |
| `sunset-schedule-portal-module.js` | **surf-school vertical** | Schedule API/data layer (create/quote intents, portal fetch); EUR display strings in quote preview | Marker; requires `getClient`, `getSunsetLocation`, many monolith globals | Location-scoped school ops | `verify-sunset-schedule-portal-module` (+ many verify touch points) | **High** |
| `sunset-schedule-drawer-view-ui.js` | **surf-school vertical** | Read-only drawer presentation; EUR/`€` night and day copy shapes | Marker; requires `isSunsetSurfActive`, school labels | Sunset surf gate in helpers | `verify-sunset-schedule-drawer-view-ui` | **High** |
| `sunset-schedule-drawer-edit-ui.js` | **surf-school vertical** | Edit/create form UI; rental mutual exclusion; `full_day_equipment_extension` legacy component paths; **quote fallback client `'sunset'`** when `getClient` missing; EUR/`€` quote totals | Marker; large (**4665** lines) | Surf rental/lesson domain | `verify-sunset-schedule-drawer-edit-ui`, multi-lessons, accommodation | **High** |
| `sunset-schedule-drawer-actions.js` | **surf-school vertical** | Consolidated payment / waiver / delete mutations (replaced 3 modules) | Marker; `SunsetScheduleDrawerActions` factory | Stripe/waiver staff paths | `verify-sunset-schedule-drawer-actions` (also asserts old modules **removed**) | **High** |
| `sunset-schedule-drawer-controller.js` | **surf-school vertical** | Drawer lifecycle / stale generation | Marker after actions | Uses schedule drawer domain | `verify-sunset-schedule-drawer-controller` | **High** |
| `sunset-schedule-day-ops-board-ui.js` | **surf-school vertical** | Day ops board HTML / equipment prep | Marker; consumes `scheduleResolveRow` | Lesson/rental prep language | `verify-sunset-schedule-day-ops-board-ui` | **High** |
| `sunset-schedule-forecast-cards-ui.js` | **surf-school vertical** | Week/Next-30 forecast cards | Marker | Presentation; data from monolith | `verify-sunset-schedule-forecast-cards-ui` | **High** |
| `sunset-schedule-view-grid-ui.js` | **surf-school vertical** | Day/Week/Next-30 grid orchestration | Marker; delegates to day-ops + forecast | Same | `verify-sunset-schedule-view-grid-ui` | **High** |
| `sunset-admin-ui.js` | **surf-school vertical** | Admin Finance/Pricing UI; `client === 'sunset'` branches; EUR/`€` display helpers | Template inject after models/helpers | Multi-location pricing drafts via `getSunsetLocation` | `verify-sunset-admin*`, finance/equipment verifiers | **High** |

### Ownership counts (browser modules)

| Primary ownership | Count | Modules |
|-------------------|------:|---------|
| generic platform | **2** | money-parse, rental-duration-model |
| surf-school vertical | **12** | equipment-pricing-model (*pure vertical pattern*), runtime (*vertical runtime + reusable patterns*), portal, drawers (4), day-ops, forecast, view-grid, rental-availability, admin-ui |
| Sunset runtime compatibility adapter | **3** | navigation, row-normalizer, data-loader |
| tenant configuration | **0** | (config belongs under `config/clients/` + allowlists; not these JS files) |
| removable | **0** | (old payment/waiver/delete modules already removed and locked absent) |

**17 = 2 + 12 + 3 + 0 + 0.**

---

## 4. Inventory B — material tenant / location / resource literals

**Method:** scanned runtime/config/deploy code for slug/location/RG/host patterns; **classified owners**, not raw hit spam. Broad hit scan produced thousands of matches (e.g. word `crowsnest` in sales fixtures) — those are **not** independent owners. Below are **source owners** and deploy boundaries only.

### 4.1 Legitimate security / deployment boundaries (preserve)

| Literal / mechanism | Owner path | Evidence | Notes |
|---------------------|------------|----------|-------|
| `STAGING_PORTAL_HOST_CLIENT` exact host → client | `scripts/lib/staff-portal-clients.js:25–45` | `sunset-staging.lunafrontdesk.com`→`sunset`; `staff-staging…`→`wolfhouse-somo`; env `DEFAULT_CLIENT_SLUG` first; never trusts arbitrary Host | **Safety allowlist** — do not “config-ize” into free-form host maps without review |
| `DEFAULT_CLIENT_SLUG=sunset` image env | `Dockerfile.luna-sunset-staff-api:8` | Isolated Sunset image | Per-client Staff API runtime (`docs/MULTICLIENT-ARCHITECTURE.md` §4b) |
| Bake `staff-portal-access.sunset-staging.json` → `staff-portal-access.json` | `Dockerfile.luna-sunset-staff-api:24–25` | Clears `all_clients_emails` in image build check | Deploy overlay, not dual runtime logic |
| `resolvePortalDeployClient` + `window.PORTAL_DEFAULT_CLIENT` | `staff-portal-clients.js` + `staff-query-api.js:15711` | Injected at HTML build | Trusted deploy default into browser |
| Golden no-send tool/effect blocklists | `scripts/lib/sunset-golden-no-send-guard.js` | Blocks booking/payment/WhatsApp/email effects | **Safety** — not templating debt |
| Location ID set + SQL defaults | `scripts/lib/sunset-school-locations.js` | `sunset-somo` / `sunset-sardinero`; `isSunsetLocationId`; `resolveRentalOfferingLocationScope` | Gate must remain even if UI becomes config-driven |
| Crowsnest isolation contract | `docs/CROWSNEST-DEPLOY-PLAN.md` Isolation section | Must not import `staff-query-api.js`; staff-staging untouched | Captain-owned runtime separation |

### 4.2 Vertical defaults (surf-school or lodging — keep until vertical plugins exist)

| Literal | Owner | Class |
|---------|-------|-------|
| `SCHEDULE_CANONICAL_RENTAL_OFFERINGS` | `scripts/browser/sunset-schedule-rental-availability.js:13` | Vertical default |
| `SCHEDULE_FULL_DAY_EQUIPMENT_OFFERING = 'full_day_equipment_extension'` | `scripts/browser/sunset-schedule-rental-availability.js:17` | Vertical offering key |
| board/wetsuit/`board_and_suit` write mapping | `scripts/lib/sunset-schedule-booking-writes.js` (many) | Vertical default + write authority |
| `SURF_VERTICALS` set | `scripts/lib/staff-portal-clients.js:15–20` | Vertical classifier |
| `isSunsetSurfActive()` / tab failsafe for portal-home | `staff-query-api.js` ~21163, ~18670–18683 | Vertical UI gate (prevents Wolfhouse flashing Schedule) |
| `MANUAL_BOOKING_PACKAGES_FALLBACK` malibu/uluwatu/waimea | `staff-portal-clients.js:144–149` | Lodging vertical fallback |
| FACTORY archetypes `surf_house` / `surf_school_shop` | `config/archetypes/**`, `docs/FACTORY-CLIENT-PRODUCTIZATION.md` | Template defaults; **not** runtime-loaded (1B–1E) |

### 4.3 Tenant configuration dual-mirror (optional hygiene only — not a decomposition prerequisite)

| Literal | Source owner | Mirror / problem | Class |
|---------|--------------|------------------|-------|
| Location catalog `sunset-somo` / `sunset-sardinero` | **`sunset-school-locations.js`** | Mirrored in HTML school buttons `staff-query-api.js:18613–18615` and `getSunsetLocation()` localStorage allowlist `:21136–21142` | **Sunset dual-mirror hygiene** — optional cleanup after catalog-owner decision (§6 Step 2–3); **not** a FACTORY / Staff API split prerequisite |
| Per-tenant baselines / access | `config/clients/*.baseline.json`, `staff-portal-access*.json`, `clients.json` | Loaded by portal clients / deploy bake | Legitimate config owners |
| `client_slug: sunset` in baselines | `config/clients/sunset.baseline.json` | Runtime gates compare slug strings | Config + gate |

### 4.4 Accidental runtime hardcoding (hygiene / debt)

| Literal | Path | Why debt / classification |
|---------|------|---------------------------|
| `const DEFAULT_CLIENT = 'wolfhouse-somo'` | `staff-query-api.js:860` + browser fallbacks `? … : 'wolfhouse-somo'` (~21323, ~29090) | Second path beside `resolvePortalDeployClient`; OK as last resort but easy to misread as product default for all portals |
| `STAFF_ALLOWLIST_FILE` → `wolfhouse-somo.staff-whatsapp-allowlist.json` | `staff-query-api.js:1050–1052` | Path hardcodes one tenant’s allowlist file |
| `SUNSET_CLIENT_SLUG = 'sunset'` re-declared in **7** libs | `sunset-school-locations`, `sunset-bookable-offerings`, `sunset-schedule-booking-writes`, `sunset-customer-profile-writes`, `sunset-admin-course-join`, `sunset-accommodation-admin`, `sunset-conversation-qa-fixture` | Same constant, many files — hygiene; **gates themselves are legitimate** |
| `client === 'sunset'` string compares in browser admin/schedule | `sunset-admin-ui.js`, portal IIFE helpers | Prefer shared gate helpers; do not delete gates |
| Demo location fallbacks `'sunset-somo'` | portal demo threads `staff-query-api.js:20464+`, `staff-portal-clients.js:134` | Demo-only defaults; low risk if gated by demo/surf profile |

### 4.4b Material **browser** hardcoding (Schedule/Admin modules + portal helpers)

| Literal / pattern | Path (evidence) | Classification |
|-------------------|-----------------|----------------|
| **EUR / `€` display** | `sunset-admin-ui.js` (`adminFormatEuro` / `currency: 'EUR'` defaults); `sunset-schedule-drawer-edit-ui.js` custom-line `€` span + quote total `\u20ac`; `sunset-schedule-portal-module.js` quote total `\u20ac`; `sunset-schedule-drawer-view-ui.js` night/day `€` shapes; portal IIFE also paints `€` rental prices in `staff-query-api.js` | **Vertical display default** (Sunset surf-school / EUR market), not a multi-currency platform. money-parse *accepts* `€$£` as strip noise — that part is generic; **UI defaults to EUR/`€`** are vertical hardcoding |
| **Quote fallback client `'sunset'`** | `sunset-schedule-drawer-edit-ui.js:3032–3034` — `getClient() : 'sunset'` when building `/staff/schedule/bookings/quote?client=` | **Tenant hardcoding in browser quote path** — safe only while Schedule UI is Sunset-gated; wrong if drawer edit is ever reused for another client without `getClient` |
| **`full_day_equipment_extension`** | `sunset-schedule-rental-availability.js:17`; `sunset-equipment-pricing-model.js:26` exclude set; drawer-edit + portal-module component/legacy paths; portal IIFE matching `full_day_equipment_extension` / `__day` in `staff-query-api.js:24779–24792` | **Surf-school vertical offering key** baked into browser + create UI (schema/product vocabulary, not tenant config JSON) |
| **Runtime Sunset endpoint / client / location suffix** | `sunset-schedule-runtime.js` `fetchDay`: `if (client === 'sunset')` → `fetch('/staff/schedule/day?client=sunset&date=' + … + sunsetLocationQuerySuffix())`; non-Sunset uses `/staff/query?client=…` lesson/gear intents | **Sunset vertical runtime adapter inside “runtime” module** — proves runtime is not generic platform; location suffix depends on portal `getSunsetLocation` / `sunsetLocationQuerySuffix` helpers |

### 4.5 Test / fixture only

- `scripts/verify-*`, `scripts/probe-*`, `fixtures/**`, golden runners, factory goldens.
- `sunset-conversation-qa-fixture.js` / `sunset-admin-qa-fixture.js` — fixture helpers, not portal runtime.

### 4.6 Stale / removable (non-runtime)

| Item | Evidence | Action |
|------|----------|--------|
| `_work/sunset-schedule-booking-drawer.js` | SHA ≠ `scripts/lib/sunset-schedule-booking-drawer.js` | Do not treat as owner; optional delete in a docs/chore PR |
| `_work/sunset-schedule-drawer-ui.js` | No matching `scripts/browser` owner | Stale |
| `_work/sunset-stripe-payment-links.js` | SHA ≠ lib | Stale |
| Pre-migration Crowsnest `wh-staging-rg` / `braveplant-…` tables | Docs explicitly **historical** after PR #324 | Do not “fix” app to old RG; leave Captain history banners |

### 4.7 Captain Crowsnest RG migration — **application seams only**

Merged at base via PR #324 (`975298de` docs + `scripts/verify-crowsnest.js`):

| Seam | What changed | App implication (not Captain work) |
|------|--------------|-------------------------------------|
| Live RG | `luna-crowsnest-rg` / env `luna-crowsnest-env` / FQDN `redbeach-6a768db0…` | Any **app deploy scripts or env samples still encoding `wh-staging-rg` as Crowsnest’s current home** are drift (Captain owns deploy path `/opt/luna/deploy/deploy-crowsnest.sh` mentioned in docs — out of this worktree audit execution) |
| Shared platform remains | `whstagingacr`, Postgres, `wh-staging-identity` | Staff API / Sunset images continue to share registry/DB identity — **not** a reason to merge Crowsnest into Staff API |
| `verify-crowsnest.js` | Asserts docs mention `luna-crowsnest-rg` + revision `crowsnest-internal--0000002` + image SHA | **Doc/verify coupling** — future app doc edits must keep verifier green; do not reintroduce old RG as “current” |
| Isolation | Crowsnest must not import Staff API | Templating cleanup of Staff portal must not pull Crowsnest UI into `staff-query-api.js` |

**Do not** redesign resource groups, RBAC, or DNS here.

---

## 5. Structural risks

### 5.1 Dual owners

| Pair | Nature | Risk |
|------|--------|------|
| `scripts/browser/*` ↔ injected HTML | Source vs **runtime-generated** consumer | Safe if production markers always hit; **silent skip** if marker missing under permissive `injectAtMarker` — OK for **partial verifier fixtures**, unsafe for production full template |
| Pure models Node `require` ↔ browser inject | Intentional dual surface (`typeof require` bridges in equipment/duration/money/rental modules) | Behavior drift if Node path and browser path diverge — mitigated by shared file |
| `SunsetScheduleRuntime` ↔ `schedule*` adapters | Intentional compatibility dual surface | Architecture verifier locks frozen APIs |
| `sunset-admin-ui-helpers.js` Node functions ↔ **hand-stringified** browser source in `getSunsetAdminBrowserHelperSource()` | True dual implementation text | Helper parity verifiers exist (`verify-sunset-admin-helper-parity` / pure); still a footgun |
| Location allowlist lib ↔ HTML/localStorage | Unintentional dual mirror | **Optional Sunset hygiene** after catalog-owner decision — not a FACTORY gate |
| Server drawer `scripts/lib/sunset-schedule-booking-drawer.js` ↔ browser drawer modules | Server authority vs browser presentation | Correct split; do not merge |

**Intentional partial `injectSunsetSchedulePortalModule` callers (must stay permissive):**

| Caller | Marker set (approx) | Why partial |
|--------|---------------------|-------------|
| `scripts/verify-sunset-create-course-drilldown.js` | portal only | Injects single marker into synthetic HTML for create-course DOM checks |
| `scripts/verify-sunset-create-private-drilldown.js` | portal only | Same pattern for private-create |
| `scripts/verify-sunset-create-footer-mobile-compact.js` | portal only | Footer/CSS compact checks against partial inject |
| `scripts/verify-sunset-edit-drawer-parity.js` | 6 markers (rental-availability → drawer-controller; no money-parse / day-ops / forecast / view-grid / runtime / nav / normalizer / data-loader) | Drawer parity fixture |
| `scripts/verify-sunset-schedule-drawer-actions.js` | 12 markers (omits money-parse + rental-availability) | Actions-module inject sample |
| `scripts/verify-sunset-schedule-drawer-edit-ui.js` | 12 markers (omits money-parse + row-normalizer) | Edit-module inject sample |
| `scripts/verify-sunset-rendered-ui-price-hotfix.js` | **full 14** (uses `SCHEDULE_MONEY_PARSE_INJECT_MARKER` + literals) | Full-template-style fixture — candidate for strict path later |
| Production `staff-query-api.js` `buildUiHtml` | **full 14** markers in portal HTML | Must use strict full-template validation |

### 5.2 Implicit globals

- Injected modules rely on **portal IIFE scope**, not `window.*` (architecture asserts runtime is not on `window`).
- Cross-module calls assume hundreds of shared names: `portalT`, `escHtml`, `getClient`, `getSunsetLocation`, `sunsetLocationQuerySuffix`, `scheduleBuildDisplayGroups`, `loadSchedulePage`, …
- Portal module header documents required globals; day-ops documents a long consumer list.
- **False sense of modularity:** files are separate, but the contract is a large implicit global API.

### 5.3 Injection-order dependencies

- Documented and partially verified (`verify-sunset-schedule-architecture.js`).
- **Gap:** money-parse + rental-availability are injected first (critical for create money + rental UI) but **not** in architecture MARKERS array (only 12 markers ordered there).
- Admin equipment models **must** precede `sunset-admin-ui.js` (comment in `sunset-admin-browser-source.js:19–21`).
- Money-parse must stay outside template literal (escape hazard called out in browser-source comments).

### 5.4 Source / generated parity risks

| Risk | Evidence |
|------|----------|
| Silent failed inject on production full template | `injectAtMarker`: `if (idx < 0) return html` — same primitive used by full and partial callers |
| Architecture verifier incomplete markers | money-parse / rental-availability omitted |
| Admin helpers dual text | string builder vs function bodies |
| FACTORY inventory ignores browser tree | `fixtures/factory-client-productization/slice1a-inventory.json` mentions `staff-query-api` but **not** `scripts/browser` / schedule browser-source — third-tenant dry-run does not see Schedule ownership graph |

### 5.5 False-genericization risks (do not do)

- Treating `sunset-schedule-runtime.js` as generic platform because it has reusable closure patterns — it still hardcodes Sunset day endpoint/client/location suffix.
- Treating `sunset-equipment-pricing-model.js` as generic platform because it is pure — it encodes `full_day_equipment_extension` exclusion and rental offering schema.
- Renaming `sunset-*` → `schedule-*` and loading for Wolfhouse without `is_surf_vertical` gates → wrong default tab / ops board.
- Treating `SCHEDULE_CANONICAL_RENTAL_OFFERINGS` / `full_day_equipment_extension` as multi-tenant config without server write validation.
- Removing `client === 'sunset'` checks because “profile vertical is enough” without proving all callers set profile correctly.
- Folding Crowsnest client-onboarding mock into Staff API “to reuse templates.”
- “Deleting” location allowlists in favor of free-form location strings (breaks isolation + rental scope).
- Making `injectAtMarker` unconditionally throw — **breaks intentional partial verifier fixtures** listed in §5.1.

### 5.6 Must remain untouched

- Tenant safety gates: `isSunsetLocationId`, `resolveRentalOfferingLocationScope`, golden no-send, host allowlist for portal deploy client.
- Write authorities in `sunset-schedule-booking-writes.js` / Stripe payment link libs.
- Crowsnest separate entrypoint + Captain RG migration docs/verify contract.
- CODEOWNERS-sensitive paths unless operator asks (`scripts/staff-query-api.js` is in-scope for *analysis*; edits still need careful PR ownership).
- Money-parse external injection technique.
- Consolidation lock: payment/waiver/delete as **single** actions module (do not re-split without cause).
- Permissive partial injection for offline verifier fixtures (or an explicit dual-API that preserves that behavior).

---

## 6. Smallest prioritized cleanup sequence

Dependency order matters. Each step lists **files**, **gates**, **stop conditions**. **No wholesale rewrite.**

### Step 0 — Baseline (done by this audit)

- Record base SHA, 17 browser modules, marker parity, residual monolith schedule surface, require 24/23, line counts.
- **Stop:** n/a.

### Step 1 — Complete marker coverage + strict production/full-template validation **[PREREQUISITE for safe further extract]**

| | |
|--|--|
| **Files** | `scripts/verify-sunset-schedule-architecture.js` (MARKERS + order includes money-parse & rental-availability); `scripts/lib/sunset-schedule-browser-source.js` — add **`injectSunsetSchedulePortalModuleStrict` / `requireAll: true` wrapper** (or equivalent) that throws when any expected marker is missing; wire **only** production `buildUiHtml` (`staff-query-api.js` ~L39819) and any true full-template builders to the strict path; leave `injectAtMarker` permissive for partial fixtures |
| **Behavior gates** | `node scripts/verify-sunset-schedule-architecture.js`; drawer-actions/controller/portal module verifies; **all intentional partial callers in §5.1 still pass**; production full HTML still injects 14 modules |
| **Stop if** | Architecture marker order fails on current tree; strict path breaks partial fixture injects; or production HTML loses a marker |
| **Untouched** | Browser module bodies; tenant gates; permissive `injectAtMarker` semantics for non-strict callers |

**Do not** change `injectAtMarker` to unconditional fail-closed.

### Step 2 — Vertical package + runtime catalog **architecture decision** **[PREREQUISITE before Client Maker awareness; not code extraction]**

| | |
|--|--|
| **Files** | Decision doc only (e.g. short addition under existing FACTORY / multiclient docs, or a focused ADR) — **no** Staff API split, **no** browser tree rename, **no** required catalog injection implementation in this step |
| **Decide** | (1) **Vertical package contract:** which browser/server modules are reusable surf-school vertical vs Sunset-only gates/adapters (use Inventory A as input). (2) **Runtime-consumed tenant/location catalog owner:** server `sunset-school-locations` vs injected browser catalog vs future multi-tenant catalog — and how Sunset-only gates (`client === 'sunset'`, runtime `client=sunset` endpoint branch, quote fallback `'sunset'`) would be removed **safely** later |
| **Behavior gates** | Doc review only; no runtime change |
| **Stop if** | Decision would require weakening `isSunsetLocationId` / host allowlist / golden no-send without a replacement gate |
| **Untouched** | Live code paths |

**True future prerequisite for Client Maker / multi-tenant Schedule UI (not implemented now):** choose the runtime-consumed catalog owner **and** define the vertical package contract so Sunset-only gates can be removed or parameterized safely. Location dual-mirror cleanup is **optional hygiene after that decision**, not the prerequisite itself.

### Step 3 — Optional: Sunset location dual-mirror hygiene **[AFTER Step 2 decision; not FACTORY/Staff-API prerequisite]**

| | |
|--|--|
| **Files** | Only if Step 2 chose “inject browser catalog from server allowlist”: `scripts/lib/sunset-school-locations.js` (export JSON-safe catalog); `scripts/staff-query-api.js` (`buildUiHtml` inject + school switcher HTML + `getSunsetLocation`/`setSunsetLocation`); i18n keys already `school.sunsetSomo` / `school.sunsetSardinero` |
| **Behavior gates** | School switch still only allowlisted IDs; server rejects invalid location; inbox/admin/schedule query suffix unchanged |
| **Stop if** | Unknown location accepted client-side or server; Sardinero/Somo labels regress |
| **Untouched** | SQL match helpers’ security behavior; rental write location scope |

### Step 4 — Constant hygiene `SUNSET_CLIENT_SLUG` **[OPTIONAL]**

| | |
|--|--|
| **Files** | 7 lib files → `require` from `sunset-school-locations` |
| **Gates** | Existing unit/verify for offerings/writes/admin |
| **Stop if** | Any circular require (`sunset-school-locations` must stay leaf) |

### Step 5 — Admin helper single-source emit **[OPTIONAL, before Admin extract]**

| | |
|--|--|
| **Files** | `scripts/lib/sunset-admin-ui-helpers.js` — generate browser string from shared AST/template or `Function.prototype.toString` with portalT adapter; strengthen helper-parity verifier |
| **Stop if** | i18n error keys diverge |

### Step 6 — Further Schedule extract from monolith IIFE **[OPTIONAL, large]**

| | |
|--|--|
| **Target** | Residual **234** column-0 `function schedule*` defs in portal IIFE still in `staff-query-api.js` |
| **Rule** | One behavioral vertical slice at a time (e.g. create-summary only); never LOC/file-count targets; re-run architecture + journey verifies |
| **Prerequisite** | Step 1 (strict production inject) strongly recommended; Step 2 contract recommended so extracts land in the right package bucket |
| **Not in first 1–3 slices** | Yes |

### Step 7 — FACTORY inventory extension **[OPTIONAL, only after Step 2 contract exists]**

| | |
|--|--|
| **Files** | factory slice1a discovery allowlist / inventory fixtures — register browser-source + `scripts/browser` as **vertical UI package** sites, not as `config/clients` acquisition |
| **Prerequisite for** | Honest third-tenant dry-run of “what UI you inherit” |
| **Not required for** | Wolfhouse/Sunset live stability |
| **Not unblocked by** | Location mirror cleanup alone |

### Explicit non-goals

- Wholesale Staff API decomposition rewrite.
- Renaming all `sunset-*` modules.
- Moving vertical rental vocabulary into tenant JSON without server validators.
- Crowsnest RG / identity / DNS work (Captain).
- Deleting shims while call sites still use `schedule*` names.
- Unconditional fail-closed `injectAtMarker`.
- Implementing multi-tenant location catalog or removing Sunset-only gates in this plan’s first slices.

---

## 7. Future Staff API decomposition & Client Maker / FACTORY

### Staff API decomposition

| Reality today | Implication |
|---------------|-------------|
| `staff-query-api.js` is still the portal HTML host (~49 195 lines) + HTTP API | Browser extraction reduced *file* entanglement but not the **host process** boundary |
| Schedule/Admin already use loader modules | Next decomposition unit is **route/area packages** (schedule server libs already exist: `sunset-schedule-queries`, `booking-writes`, `booking-drawer`) with a thin HTML host |
| Multiclient doctrine | Separate Staff API container per live client (`DEFAULT_CLIENT_SLUG`, access bake) — decomposition must preserve per-image defaults |

**Prerequisite cleanup for safer decomposition:** Step 1 (strict production inject + complete markers).  
**Architecture prerequisite (docs):** Step 2 (vertical package + runtime catalog owner).  
**Optional hygiene, not prerequisite:** Steps 3–6 (location mirror, constant hygiene, admin helper emit, further extract).  
**Do not block** on renaming modules or on dual-mirror cleanup alone.

### FACTORY / Client Maker

From `docs/FACTORY-CLIENT-PRODUCTIZATION.md` (stages **1A–1E complete**, dry-run only):

| Gate / fact | Relevance to this audit |
|-------------|-------------------------|
| Archetypes `surf_house` ← wolfhouse; `surf_school_shop` ← sunset multi-location | Browser Schedule/Admin are the **worked example UI** for `surf_school_shop` — still Sunset-branded |
| 1A–1E forbid runtime registration / `config/clients` writes | No FACTORY generator currently emits browser modules |
| Inventory includes `staff-query-api` config acquisition, **not** `scripts/browser` | Client Maker will under-count UI debt unless inventory extended (Step 7) **after** package contract (Step 2) |
| `G_LEGACY_COMPATIBILITY` | Wolfhouse + Sunset must keep working without forced migration — **forbids** big-bang generic rename |
| Crowsnest onboarding mock is UI-only | Not the FACTORY source of truth (`config/archetypes/`) |

**True prerequisite for a future “instantiate surf_school_shop UI” Client Maker step:**  
define the **vertical package contract** and the **runtime-consumed tenant/location catalog owner**, and only then plan how Sunset-only gates/adapters can be parameterized or removed safely.  

**Optional afterward:** dual-mirror location injection hygiene (Step 3), constant hygiene, further schedule extract.  

**Not prerequisite:** Crowsnest RG migration (already done for ops isolation); Staff API wholesale split; renaming `sunset-*` files.

**Do not propose catalog-injection or gate-removal implementation in this audit’s first slices.**

---

## 8. Top blockers (ordered)

1. **Production full-template inject is not fail-closed** — missing marker drops whole Schedule modules with no throw (`injectAtMarker`); partial fixture injects make unconditional throw unsafe — need a **separate strict path**.
2. **Missing architecture marker coverage** — money-parse + rental-availability absent from architecture MARKERS (12/14).
3. **No written vertical package / runtime catalog contract** — Client Maker and future multi-tenant Schedule work lack an agreed owner map (platform vs vertical vs Sunset-only adapters).
4. **Residual monolith Schedule surface** — 234 column-0 `function schedule*` functions still in portal IIFE; creates implicit global gravity that fights package boundaries.
5. **Admin helper dual text** — stringified browser helpers can drift from Node pure helpers.
6. **FACTORY inventory blind spot** — browser pipeline invisible to Client Maker inventory freeze (address after Step 2, not by location mirror cleanup alone).
7. **False-genericization pressure** — names say Sunset; only **2** browser modules are true generic platform; bulk rename without gates is the highest product risk.
8. **Optional dual-mirror location catalog** — server allowlist vs HTML buttons vs localStorage; hygiene only, after catalog-owner decision.

---

## 9. Counts summary

| Category | Count |
|----------|------:|
| Browser `sunset-*.js` modules | **17** |
| → generic platform | **2** |
| → surf-school vertical | **12** |
| → Sunset runtime compatibility adapter | **3** |
| → tenant configuration / removable | **0** / **0** |
| Schedule inject markers (loader ↔ HTML) | **14** (parity OK) |
| Architecture verifier markers incomplete | **2** missing from list (12 listed) |
| Server `scripts/lib/sunset-*.js` | **58** |
| Direct sunset requires from staff-query-api | **24 occurrences / 23 distinct** |
| Residual column-0 `function schedule*` in portal IIFE | **234** |
| `staff-query-api.js` lines | **49 195** |
| Material literal owner rows in §4 (curated) | **~20** owners (not 4k string hits) + browser hardcoding table §4.4b |
| `SUNSET_CLIENT_SLUG='sunset'` defining files | **7** |
| Wolfhouse default CLIENT_SLUG/DEFAULT_CLIENT defining lib files | **45** (mostly lodging path — out of Sunset UI extract) |

---

## 10. Recommended first slice (single sentence)

**Ship complete architecture marker coverage plus a strict production/full-template inject path while keeping permissive partial injection for verifier fixtures (Step 1), then document the vertical package and runtime tenant/location catalog contract as an architecture decision before Client Maker (Step 2); treat Sunset location dual-mirror cleanup as optional hygiene afterward — no wholesale rewrite, no unconditional `injectAtMarker` fail-closed.**

---

## Appendix A — Injection marker order (canonical)

From `scripts/lib/sunset-schedule-browser-source.js` `injectSunsetSchedulePortalModule` and `staff-query-api.js` L19934–19947:

1. `sunset-schedule-money-parse`
2. `sunset-schedule-rental-availability`
3. `sunset-schedule-portal-module`
4. `sunset-schedule-drawer-view-ui`
5. `sunset-schedule-drawer-edit-ui`
6. `sunset-schedule-drawer-actions`
7. `sunset-schedule-drawer-controller`
8. `sunset-schedule-day-ops-board-ui`
9. `sunset-schedule-forecast-cards-ui`
10. `sunset-schedule-view-grid-ui`
11. `sunset-schedule-runtime`
12. `sunset-schedule-navigation-ui`
13. `sunset-schedule-row-normalizer`
14. `sunset-schedule-data-loader`

## Appendix B — Related docs (read, not rewritten)

- `docs/FACTORY-CLIENT-PRODUCTIZATION.md`
- `docs/MULTICLIENT-ARCHITECTURE.md`
- `docs/CROWSNEST.md`, `docs/CROWSNEST-DEPLOY-PLAN.md`, `docs/CROWSNEST-LOCATION-PLAN.md` (Captain RG migration banners)
- `docs/PHASE-5-SOURCE-OF-TRUTH-CLEANUP.md` (engine extraction deferred historically)
- `scripts/verify-sunset-schedule-architecture.js` (injection contract)
- `scripts/verify-sunset-schedule-drawer-actions.js` (removed-module lock)

## Appendix C — Reproducible count commands (rerun at base)

```bash
cd /opt/data/worktrees/WH-grok-templating-analysis
git rev-parse HEAD
# 52160ab7f2a5b1ae92a13702625d5d38168060cf

ls -1 scripts/browser/sunset-*.js | wc -l
# 17

wc -l scripts/staff-query-api.js
# 49195 scripts/staff-query-api.js

rg -c '^function schedule' scripts/staff-query-api.js
# 234

ls -1 scripts/lib/sunset-*.js | wc -l
# 58

python3 - <<'PY'
from pathlib import Path
import re
src = Path('scripts/lib/sunset-schedule-browser-source.js').read_text()
admin = Path('scripts/lib/sunset-admin-browser-source.js').read_text()
api = Path('scripts/staff-query-api.js').read_text()
owned = set(re.findall(r"browser', '([^']+)'", src + admin))
disk = set(p.name for p in Path('scripts/browser').glob('sunset-*.js'))
print('owned==disk', owned == disk, 'n=', len(disk))
m1 = re.findall(r'/\* INJECT:([a-z0-9-]+) \*/', src)
m2 = re.findall(r'/\* INJECT:([a-z0-9-]+) \*/', api)
print('marker parity', m1 == m2, 'n=', len(m2))
print('silent miss', 'if (idx < 0) return html' in src)
reqs = re.findall(r"require\('\./lib/(sunset-[^']+)'\)", api)
print('require occurrences', len(reqs), 'distinct', len(set(reqs)))
print(sorted(set(reqs)))
PY
# owned==disk True n=17
# marker parity True n=14
# silent miss True
# require occurrences 24 distinct 23

rg -n "const SUNSET_CLIENT_SLUG = 'sunset'" scripts/lib --glob '*.js' | wc -l
# 7

wc -l scripts/browser/sunset-schedule-drawer-edit-ui.js
# 4665 scripts/browser/sunset-schedule-drawer-edit-ui.js
```
