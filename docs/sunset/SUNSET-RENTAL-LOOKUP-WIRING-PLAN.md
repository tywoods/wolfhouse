# Sunset rental lookup wiring plan

**Status:** Discovery complete. Implementation plan for Captain/Skipper review before code.
**Branch:** `feat/sunset-multitenant-luna`
**Depends on:** `764a8b6` — `scripts/lib/sunset-rental-price-lookup.js` (pure, tested, not yet called by runtime)

---

## Files inspected

| File | Key finding |
|------|-------------|
| `scripts/lib/luna-guest-agent-tool-plan.js` | Defines `GUEST_AGENT_TOOLS` registry + `GUEST_AGENT_READ_TOOL_IDS`. `READ_TOOL_IDS` is injected directly into the Wolfhouse LLM system prompt. |
| `scripts/lib/luna-guest-agent-tool-executor.js` | `executeGuestAgentReadTool(toolId, ctx)` — one `if (id === '...')` block per tool. Already receives `ctx.client_slug`. 224 lines, clean pattern. |
| `scripts/lib/luna-guest-frontdesk-planner.js` | Line 74: `const readList = GUEST_AGENT_READ_TOOL_IDS.join(', ')` — injected into Wolfhouse system prompt at line 79. Line 112: also sent as `allowed_read_tools`. **Adding any tool to `GUEST_AGENT_READ_TOOL_IDS` makes it visible to the Wolfhouse LLM.** |
| `scripts/lib/luna-guest-gpt-tool-planner.js` | Same pattern — lines 53, 73, 104 use `GUEST_AGENT_READ_TOOL_IDS`. Two planners, same list. |
| `scripts/lib/luna-guest-reply-composer.js` | Accepts `client_slug` at entry (lines 1537–1539). Falls back to `'wolfhouse-somo'` at two points (lines 642, 797). Not a concern for test-only slice. |
| `scripts/lib/luna-guest-quote-proposal-dry-run.js` | `DEFAULT_CLIENT = 'wolfhouse-somo'`. Delegates to Wolfhouse booking dry-run. Not relevant for rental lookup. |
| `scripts/lib/luna-guest-agent-write-tool-executor.js` | Write tool executor — not relevant for rental price lookup (read-only). |
| `scripts/run-luna-conversation-state-machine-tests.js` | `const CLIENT_SLUG = 'wolfhouse-somo'` at line 74. BUT lines 2056/2163 use `fixture.client_slug \|\| CLIENT_SLUG` — fixture-level override exists. Requires `dotenv` + Postgres — not suitable for an offline test. |
| `fixtures/sunset-golden/_manifest.json` | `"runner": "not_wired"` — explicitly not wired to any verify script. |
| `fixtures/sunset-golden/*.json` | 7 draft fixtures; `active: false`; cover rental price, lesson booking, payment guardrail. |
| `scripts/lib/sunset-rental-price-lookup.js` | Pure helper, no imports from runtime modules, no Wolfhouse dependency. |

---

## Critical constraint discovered

**`GUEST_AGENT_READ_TOOL_IDS` feeds directly into the Wolfhouse LLM system prompt.**

Both `luna-guest-frontdesk-planner.js` and `luna-guest-gpt-tool-planner.js` build the list of allowed tools from `GUEST_AGENT_READ_TOOL_IDS` and inject it into GPT's system prompt for every Wolfhouse turn. If `get_sunset_rental_price` is added to the shared registry, the Wolfhouse LLM sees it as a plannable tool — even if execution is gated by `client_slug`. This is a prompt contamination risk for tenant 1.

**This rules out Option B (adding to the shared tool registry) for the test-only slice.**

---

## Answers to the 9 discovery questions

### 1. Where are guest-facing Luna tools/actions defined today?

`scripts/lib/luna-guest-agent-tool-plan.js` — `GUEST_AGENT_TOOLS` object (lines 12–83). 11 tools total: 7 read-only, 4 write-gated. The registry drives both planners and both executors.

### 2. Is there an existing tool executor pattern we can extend?

Yes — `executeGuestAgentReadTool(toolId, ctx)` in `luna-guest-agent-tool-executor.js`. Pattern is a flat `if (id === '...')` chain. `ctx` already carries `client_slug`. Clean, 224-line file, well-bounded.

However, extending this file adds a Sunset concept to a shared platform file — and since the tool list also feeds the Wolfhouse LLM prompt, extension must be done carefully (see §3 below).

### 3. Where would a `get_sunset_rental_price` or `get_rental_price` action live?

**Recommended: new file `scripts/lib/sunset-catalog-tool-executor.js`** — a Sunset-only parallel to `luna-guest-agent-tool-executor.js`.

This approach:
- Adds zero lines to any existing file
- Has its own tool registry (separate from `GUEST_AGENT_TOOLS`)
- Never appears in Wolfhouse LLM system prompt
- Calls `lookupSunsetRentalPrice` directly
- Is testable purely offline with a new verify script
- Plugs into the Sunset Hermes process at startup (separate process per `MULTI-TENANT-PLAN.md §7.1`)

When shared-router multi-tenant is later built (§7.2), the executor can be merged under a `client_slug` dispatch layer at that point, with Captain review.

### 4. Exact files that would need to change for minimal test-only integration

```
CREATE  scripts/lib/sunset-catalog-tool-executor.js    (new — Sunset-only tool executor)
CREATE  scripts/verify-sunset-catalog-tool-executor.js (new — offline test)
EDIT    package.json                                   (+1 line: verify:sunset-catalog-tools)
```

**Zero changes to any existing Wolfhouse file.** No edits to:
- `luna-guest-agent-tool-plan.js`
- `luna-guest-agent-tool-executor.js`
- `luna-guest-frontdesk-planner.js`
- `luna-guest-gpt-tool-planner.js`
- Any other shared platform file

### 5. Can this be done behind `client_slug === 'sunset'` so Wolfhouse is untouched?

Yes — two ways:

**Option A (recommended):** New `sunset-catalog-tool-executor.js` is only ever imported by Sunset-facing code. The Wolfhouse executor and planner never reference it. The gate is structural (separate file, separate import chain) not just conditional.

**Option B (not recommended for this slice):** Add to the shared tool registry with an execution guard. Rejected because it injects a sunset-only tool into the Wolfhouse LLM's system prompt.

### 6. Can it be tested without WhatsApp and without Staff API?

**Yes, completely offline.** The verify script calls `executeSunsetCatalogTool('get_sunset_rental_price', ctx)` directly (no GPT, no DB, no WhatsApp, no Stripe, no Staff API). Same offline profile as `verify:sunset-rental-lookup`.

The state machine runner (`run-luna-conversation-state-machine-tests.js`) requires Postgres and `dotenv` — it is not suitable for this offline test slice. The sunset golden fixtures are wired to that runner eventually but not in this slice.

### 7. What new verify script should be added?

`scripts/verify-sunset-catalog-tool-executor.js` — offline assertions covering:

```
[1] Tool gating
    - known sunset tool with client_slug=sunset → ok
    - known sunset tool with client_slug=wolfhouse-somo → tenant_mismatch
    - unknown tool → rejected/not_a_sunset_tool
    - write tool not accepted by read executor → rejected

[2] get_sunset_rental_price — price results
    - board 1_day (require_confirmed=false) → ok, amount_eur=15
    - board_suit 5_days → ok, amount_eur=65
    - wetsuit 7_days → ok, amount_eur=45
    - sup 1_day → ok, amount_eur=30

[3] get_sunset_rental_price — blocked results
    - board 1_day (require_confirmed=true, default) → ok=false, reason=price_unverified
    - sup 5_days → ok=false, reason=price_not_configured
    - unknown item → ok=false, reason=unknown_item

[4] Result shape
    - result contains tool_id, status, result.ok, result.amount_eur, result.tenant_id
```

`package.json`: add `"verify:sunset-catalog-tools": "node scripts/verify-sunset-catalog-tool-executor.js"`

### 8. Which files must Captain review before implementation?

| File | Why Captain review needed |
|------|--------------------------|
| `scripts/lib/sunset-catalog-tool-executor.js` (new) | Establishes the Sunset tool execution pattern — sets precedent for how Sunset tools are registered and gated |
| `scripts/lib/luna-guest-agent-tool-plan.js` | **Must NOT change in this slice.** Captain to confirm this boundary holds. |
| `scripts/lib/luna-guest-agent-tool-executor.js` | **Must NOT change in this slice.** Captain to confirm. |
| `scripts/lib/luna-guest-frontdesk-planner.js` | **Must NOT change in this slice.** Captain to confirm that Wolfhouse system prompt is unaffected. |

Captain does not need to review `package.json` (1 script line) or the verify script independently — those are consequence-free additions.

### 9. Would this require a SOUL.md edit, or can it be tested through local scripts first?

**No SOUL.md edit required for this slice.** `docker/hermes-staging/SOUL.md` is the Wolfhouse staging Hermes configuration. A Sunset test-only executor tested via local verify script:
- Does not run through Hermes at all
- Does not touch the Wolfhouse staging environment
- Does not require a Sunset SOUL.md (that would come when a Sunset Hermes process is set up, which is a separate slice)

SOUL.md becomes relevant only when wiring Sunset to an actual Hermes/WhatsApp process — that is two slices away (tool executor → Hermes process config → WhatsApp).

---

## Recommended smallest implementation — next slice

### What gets built

```
CREATE  scripts/lib/sunset-catalog-tool-executor.js
CREATE  scripts/verify-sunset-catalog-tool-executor.js
EDIT    package.json  (+1 line)
```

### What `sunset-catalog-tool-executor.js` does

```js
// Sunset-only tool registry — separate from GUEST_AGENT_TOOLS.
// NOT imported by luna-guest-frontdesk-planner or luna-guest-gpt-tool-planner.
// Safe to add tools here without affecting Wolfhouse LLM system prompt.
const SUNSET_CATALOG_READ_TOOLS = {
  get_sunset_rental_price: {
    read_or_write: 'read',
    backing: 'sunset-rental-price-lookup.lookupSunsetRentalPrice (config truth)',
  },
};

function executeSunsetCatalogTool(toolId, ctx) {
  // 1. Must be a known Sunset tool
  // 2. client_slug must be 'sunset'
  // 3. Delegates to lookupSunsetRentalPrice for price queries
  // Returns: { tool_id, status: 'ok'|'rejected'|'tenant_mismatch', result }
}
```

### Proposed verify command

```bash
node scripts/verify-sunset-catalog-tool-executor.js
npm run verify:sunset-catalog-tools
```

Expected: all assertions pass, no API key, no DB, no env required.

---

## Risks to Wolfhouse

| Risk | Assessment |
|------|------------|
| New tool leaks into Wolfhouse LLM prompt | **Eliminated** — separate file, not added to `GUEST_AGENT_TOOLS` or `GUEST_AGENT_READ_TOOL_IDS` |
| Existing Wolfhouse tool executor modified | **None** — `luna-guest-agent-tool-executor.js` untouched |
| Wolfhouse frontdesk planner modified | **None** — untouched |
| Wolfhouse golden fixtures affected | **None** — `fixtures/luna-golden/` untouched; new verify script is standalone |
| `npm run verify:luna-all` broken | **None** — new script is standalone; not added to `verify:luna-all` |
| Runtime import of Sunset executor by Wolfhouse code | **None** — Wolfhouse code never imports `sunset-catalog-tool-executor.js`; it is dead code until explicitly wired |

---

## Captain approval required?

**Yes, before implementation.** Specifically:

1. **Confirm Option A (separate executor file) over Option B (shared registry).** This is an architecture decision about how the platform separates per-tenant tool registries. Captain/Skipper should sign off on this pattern before it becomes a precedent.

2. **Confirm the `GUEST_AGENT_TOOLS` / `GUEST_AGENT_READ_TOOL_IDS` files are off-limits for this slice.** Particularly important because both planners inject `READ_TOOL_IDS` into Wolfhouse LLM system prompts.

3. **No SOUL.md edit, no Hermes deploy, no Wolfhouse file changes** — Deckhand confirms these boundaries hold.

Deckhand can implement immediately upon Captain/Skipper confirmation of Option A.

---

## After this slice — what comes next (not in scope here)

1. **Sunset Hermes process config** — set up a separate Hermes instance pinned to `tenant_id=sunset`, importing `sunset-catalog-tool-executor.js` alongside the platform executor.
2. **Sunset SOUL.md** — author Sunset-specific persona, catalog facts, and safety rules for the Sunset Hermes process.
3. **Wire sunset golden fixtures** — point `verify-luna-golden.js` (or a new `verify-sunset-golden.js`) at `fixtures/sunset-golden/` with the Sunset executor in scope.
4. **Platform generalization** — if a third client arrives with rental offerings, extract `sunset-catalog-tool-executor.js` into a generic `platform-service-catalog-tool-executor.js` parameterised by tenant config. Not needed yet.
