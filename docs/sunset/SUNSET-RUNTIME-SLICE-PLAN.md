# Sunset rental price runtime slice — implementation plan

**Status:** Discovery complete. Implementation plan for Skipper/Captain review before code.
**Branch:** `feat/sunset-multitenant-luna`
**Scope:** Smallest safe runtime slice — Sunset rental price lookup from tenant config, test-only first, no WhatsApp wiring.

---

## Discovery findings

### Files inspected

| File | Purpose | Tenant-aware? |
|------|---------|---------------|
| `scripts/lib/luna-guest-message-router.js` | Classifies inbound messages, routes to planner | Has `const DEFAULT_CLIENT = 'wolfhouse-somo'`; accepts `client_slug` in input |
| `scripts/lib/luna-guest-frontdesk-planner.js` | GPT planner — plans read tools per turn | Accepts `client_slug` in input object |
| `scripts/lib/luna-guest-knowledge-config.js` | FAQ / knowledge reply builder | ✅ Fully slug-parameterised: `loadKnowledgeConfig(clientSlug)` |
| `scripts/lib/luna-guest-personality-config.js` | Reply persona loader | ✅ Fully slug-parameterised: `loadClientPersonalityFile(clientSlug)` |
| `scripts/lib/luna-guest-lesson-schedule-config.js` | Lesson schedule facts | ✅ Slug-parameterised: `loadClientBaseline(clientSlug)` reads `{slug}.baseline.json` |
| `scripts/lib/luna-client-messaging-playbook.js` | Messaging playbook loader | ⚠️ `SUPPORTED_CLIENTS = new Set(['wolfhouse-somo'])` — Sunset gracefully skips |
| `scripts/lib/wolfhouse-quote-calculator.js` | Stay quote calculator | ❌ Hardcoded to `wolfhouse-somo.pricing.json` — Wolfhouse-only |
| `scripts/lib/luna-guest-booking-dry-run.js` | Booking dry-run orchestrator | ❌ `PRICING_PATH = .../wolfhouse-somo.pricing.json` hardcoded at line 44 |
| `scripts/lib/staff-portal-clients.js` | Client slug discovery | ✅ Auto-discovers `sunset` from `sunset.baseline.json._meta.client_slug` |
| `config/clients/sunset.baseline.json` | Sunset tenant config | ✅ In place; rental prices under `catalog.rentals.offerings.{item}.prices_eur.{window}` |
| `fixtures/sunset-golden/_manifest.json` | Sunset golden fixture index | `"runner": "not_wired"` — not yet picked up by any verify script |
| `fixtures/luna-golden/` | Wolfhouse golden fixtures (16) | Wired to `scripts/verify-luna-golden.js` |

---

## Discovery: answers to the 8 questions

### 1. Where does current Luna determine client/tenant identity?

`client_slug` is passed as an input field at the invocation boundary (the turn context that calls `luna-guest-message-router.js`, `luna-guest-frontdesk-planner.js`, etc.). If absent, every module falls back to `const DEFAULT_CLIENT = 'wolfhouse-somo'`.

There is no automatic channel-to-tenant mapping yet — `client_slug` must be injected by the caller (Hermes/n8n inbound handler). For a Sunset-dedicated process (the §7.1 separate-process MVP described in `MULTI-TENANT-PLAN.md`), the env/config would pin `client_slug = 'sunset'` at startup. For a shared router (§7.2), resolution would happen per message.

### 2. Where does current Luna load client baseline config?

`luna-guest-lesson-schedule-config.js` already has a generic `loadClientBaseline(clientSlug)` function (lines 19–27) that reads `config/clients/{slug}.baseline.json`. This is the right pattern; `sunset.baseline.json` is already auto-loaded if called with `'sunset'`.

Knowledge and personality configs follow the same slug-parameterised pattern.

### 3. Where are prices/quotes currently calculated for Wolfhouse?

In `wolfhouse-quote-calculator.js`. It is invoked from:
- `luna-guest-booking-dry-run.js` (line 275) — dry-run stay quote
- `wolfhouse-short-stay-pricing.js` — short-stay variant (delegates back to the same function)

Both hardcode `wolfhouse-somo.pricing.json`. The calculator is night-based + weekly-package logic — entirely inapplicable to Sunset's item × time-window rental model.

### 4. Is there any generic service catalog or is pricing hardcoded around Wolfhouse lodging?

Pricing is hardcoded to Wolfhouse lodging. There is no generic catalog reader or rental price lookup. The paper-test samples (`surf-shop-rental.sample.json`, `surf-school.sample.json`) document what the schema should look like but are not wired to any runtime code.

### 5. Where should a Sunset rental price lookup helper live?

`scripts/lib/sunset-rental-price-lookup.js` — a new, standalone file.

**Why standalone and not a modification of `wolfhouse-quote-calculator.js`:**
- Wolfhouse calculator is a stay-calculator (nights × guests × weekly package). Rental pricing (item × time-window) is a different computation shape.
- Adding Sunset rental logic to the Wolfhouse file would entangle two unrelated verticals.
- A new file is purely additive — no Wolfhouse file changes.
- Later, if a generic `catalog-price-lookup.js` is extracted, both can delegate to it. That refactor is out of scope for this slice.

**Naming convention:** follows `wolfhouse-quote-calculator.js` pattern — tenant-prefixed until a generic version is warranted.

### 6. What tests should be added first?

`scripts/verify-sunset-rental-lookup.js` — a standalone no-API-key verify script that:
1. Calls `sunset-rental-price-lookup` for known items + windows.
2. Asserts prices match the expected values from `sunset.baseline.json`.
3. Asserts `pricing_status: unverified_seed` → `success: false, blocked_reason: 'unverified_seed'` in live mode.
4. Asserts that passing `client_slug: 'wolfhouse-somo'` to the same function returns `{success: false, tenant_mismatch: true}` (Wolfhouse isolation guard).

Script should be wired into `package.json` as `verify:sunset-rental-lookup`.

### 7. How can this be implemented so Wolfhouse behavior is unchanged?

- **Zero changes to any existing file.** New file only.
- `wolfhouse-quote-calculator.js` is not modified.
- `luna-guest-booking-dry-run.js` is not modified.
- `luna-guest-message-router.js` is not modified.
- The new lookup function is not called from any existing code path.
- Wolfhouse golden fixtures (`fixtures/luna-golden/`) are unaffected — the golden runner does not touch the new file.
- `npm run verify:luna-all` result does not change.

### 8. Can we write a test-only helper for Sunset config lookup without wiring WhatsApp/runtime?

Yes — and this is the recommended approach for this slice. The helper function is pure (no DB, no network, no Stripe, no WhatsApp) and reads only from `config/clients/sunset.baseline.json`. The verify script can run offline with no env setup.

---

## Recommended smallest implementation

### Slice boundary

**One new file. One new test script. Zero file modifications.**

```
NEW:  scripts/lib/sunset-rental-price-lookup.js
NEW:  scripts/verify-sunset-rental-lookup.js
EDIT: package.json  (add "verify:sunset-rental-lookup" script entry — one line)
```

### `sunset-rental-price-lookup.js` — specification

```js
/**
 * sunset-rental-price-lookup.js
 * Pure Sunset rental price lookup from tenant config.
 * No DB, no network, no Stripe, no WhatsApp.
 *
 * Input:
 *   client_slug    {string}  Must be 'sunset'. Returns tenant_mismatch if not.
 *   item_code      {string}  'board_rental' | 'wetsuit_rental' | 'board_and_suit_rental' | 'sup_rental'
 *   window_code    {string}  '1_hour' | 'half_day' | '1_day' | '2_days' | '5_days' | '7_days'
 *   require_confirmed  {boolean}  default true — blocks on unverified_seed
 *
 * Output:
 *   success        {boolean}
 *   price_eur      {number|null}
 *   pricing_status {string}       ('unverified_seed' | 'confirmed')
 *   item_code      {string}
 *   window_code    {string}
 *   blocked_reason {string|null}  null on success
 *   source         {string}       'sunset-rental-price-lookup'
 */
```

**Key behaviours:**

| Input scenario | Output |
|---|---|
| `client_slug !== 'sunset'` | `{success: false, blocked_reason: 'tenant_mismatch'}` |
| `item_code` not found in catalog | `{success: false, blocked_reason: 'unknown_item'}` |
| `window_code` not found for item | `{success: false, blocked_reason: 'unknown_window'}` |
| `pricing_status === 'unverified_seed'` + `require_confirmed: true` | `{success: false, blocked_reason: 'unverified_seed', price_eur: null}` |
| `pricing_status === 'confirmed'` | `{success: true, price_eur: N, ...}` |
| `require_confirmed: false` (dry-run/shadow mode) | Returns price with `pricing_status` value in result |

The function **never** constructs a payment link, invents availability, or calls any external service.

---

## Exact files likely to change

| File | Change type | Risk to Wolfhouse |
|------|-------------|-------------------|
| `scripts/lib/sunset-rental-price-lookup.js` | **CREATE** (new) | None — new file |
| `scripts/verify-sunset-rental-lookup.js` | **CREATE** (new) | None — new file |
| `package.json` | **EDIT** — add 1 script entry | Zero runtime impact; `verify:luna-all` unchanged |

**No other files change.**

---

## Tests to add

`scripts/verify-sunset-rental-lookup.js` should cover:

```
PASS — board_rental 1_day from unverified_seed config → blocked (unverified_seed, live mode)
PASS — board_rental 1_day from unverified_seed config → price=15 returned (dry-run mode, require_confirmed=false)
PASS — wetsuit_rental half_day → price=8 (dry-run mode)
PASS — board_and_suit_rental 5_days → price=65 (dry-run mode)
PASS — sup_rental 1_day → price=30 (dry-run mode)
PASS — sup_rental 2_days → blocked (null price in config) or unknown_window
PASS — client_slug='wolfhouse-somo' → tenant_mismatch (isolation guard)
PASS — unknown item_code → unknown_item
PASS — known item, unknown window → unknown_window
PASS — config JSON is valid (basic load check)
```

Expected output: `10/10 PASS` with `No API key required`.

The fixture schema in `sunset-golden-01` and `sunset-golden-02` confirms the expected test values:
- `board_rental 1_day` → `seed_price_eur_1_day: 15`
- `board_and_suit_rental 5_days` → `seed_price_eur_5_days: 65`

---

## Risks and guardrails

| Risk | Guardrail |
|------|-----------|
| `wolfhouse-quote-calculator.js` accidentally modified | No modification in scope — separate file only |
| Sunset lookup called in Wolfhouse code path | Not wired to any existing code; no call site created in this slice |
| Unverified seed prices served to real guests | `require_confirmed: true` default blocks all unverified_seed values; must flip per-item to `confirmed` before live use |
| Sunset config invalid JSON | Verify script catches load failure; `python3 -m json.tool` pre-flight already confirmed valid |
| `sup_rental` 2-day/5-day/7-day missing | Config has `null` for those windows (not in public site); lookup returns `unknown_window` or `null_price` — never invents |
| Future code tries to call this with `wolfhouse-somo` slug | Tenant mismatch check at entry point returns explicit `tenant_mismatch` rather than loading wrong config |

---

## Whether Wolfhouse golden tests are affected

**No.** The new file is not imported by any existing module. `scripts/verify-luna-golden.js` runs `run-luna-conversation-state-machine-tests.js` against `fixtures/luna-golden/` — the Sunset file and the new verify script are not in that path. `npm run verify:luna-all` adds one new green entry but does not affect the 13 existing passing checks.

---

## Whether implementation can be test-only before WhatsApp wiring

**Yes — this is the whole point of this slice.** The function and its verify script exist entirely outside the WhatsApp/Hermes/n8n call path. WhatsApp wiring (calling this function from `luna-guest-agent-tool-executor.js` when `client_slug === 'sunset'` and a rental price is requested) is the **next** slice, after this one is green and reviewed.

---

## What comes after (not in this slice)

1. **Owner confirms prices** → flip `pricing_status` per item from `unverified_seed` to `confirmed` in `sunset.baseline.json`.
2. **Runtime tool wiring** → add a `get_sunset_rental_price` tool to `luna-guest-agent-tool-plan.js` (tenant-gated: only active when `client_slug === 'sunset'`); call `sunset-rental-price-lookup` from `luna-guest-agent-tool-executor.js`.
3. **Sunset golden runner** → wire `fixtures/sunset-golden/` to a `verify:sunset-golden` script (separate from Wolfhouse golden).
4. **`service_addons.lesson_scheduling` alignment** — add stub at that path in `sunset.baseline.json` so `luna-guest-lesson-schedule-config.js` finds Sunset scheduling data.
5. **`SUPPORTED_CLIENTS`** — add `'sunset'` to `luna-client-messaging-playbook.js` when `sunset.messaging.json` exists.

None of steps 2–5 are in scope for the rental lookup slice.

---

## Open questions before implementing

1. **Wolfhouse `ceil5` export** — `wolfhouse-quote-calculator.js` does not export `loadConfig` or `ceil5` from its `module.exports`. `wolfhouse-short-stay-pricing.js` pulls them via `require`. Is that an internal dependency to keep clean of, or can the Sunset file use its own independent load utility? (Recommendation: Sunset file uses its own `loadClientBaseline` — no dependency on Wolfhouse calculator internals.)

2. **`sup_rental` missing multi-day prices** — the config has `null` for `2_days`, `5_days`, `7_days` SUP windows (not on public site). Should lookup return `unknown_window` or a distinct `price_not_available` reason? Suggestion: `{success: false, blocked_reason: 'price_not_configured', item_code: 'sup_rental', window_code: '2_days'}`.

3. **`require_confirmed` default** — should the default be `true` (safe, blocks seed prices) or should the function be always-blocking and require explicit `allow_seed: true`? Preference for `require_confirmed: true` default to make the safe path the default path.
