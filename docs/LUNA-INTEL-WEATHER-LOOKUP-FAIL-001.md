# LUNA-INTEL-WEATHER-LOOKUP-FAIL-001 — general public research repair

This is a local repair and operator handoff, **not live acceptance or authorization to configure/restart a runner**. Weather is a repro, not a new weather integration. Retain the existing guest LLM, registered `search_public_info` / `read_public_source` tools, Staff Intelligence switches, and shared guest runners. No model swap, new simulator, booking/payment changes, or engineering-agent configuration changes.

## Diagnosis and scope

Chief's 2026-09-24 receipt identifies serving image `wh-hermes-staging:8cda03244a99c061742146d9c969a150047552e8`, created `2026-09-24T11:06:01Z`. On both `hermes-luna` and `hermes-sunset-luna-http`, the effective search provider was **None**. The two reported failed searches on `hermes-luna` were `invalid_public_query` (0.05s) and `public_search_unavailable` (5.84s); both remained non-escalating. This is supplied operator evidence, not a Captain observation of the containers.

The existing LLM cannot retrieve public evidence without a search backend. Code alone does not supply one. Separately, offline reproductions confirmed valid ISO dates were rejected as phone-like numbers; nullable/non-string provider metadata could discard valid sources; and the 30-second admission clock started before the LLM had chosen its first lookup. The latter two are local defects, not proven explanations of a particular live trace.

### Repair

- Exempt only standalone **valid** `YYYY-MM-DD` dates from the phone-like-number test. Keep full original query identity/secret/URL checks. Invalid dates, longer phone-like strings, and date-shaped known guest identity still fail closed.
- Normalize missing/null/non-string search title and description to empty strings; retain validated public URLs. Do not coerce arbitrary objects into evidence text.
- Start the 30-second research allowance at the first admitted search reservation, not at model setup. A separate 120-second absolute capability lifetime starts at guest-turn binding. Both limits apply; no activity resets them. Cleanup and Staff OFF revocation still invalidate copied worker contexts. Expiry returns `research_budget_exhausted`, not `intelligence_off`.
- Retry one failed search automatically, only in the same live capability and within the existing maximum **two searches / three reads**, four results/search, and eight-second public-operation limits. Invalid/private queries and observed OFF/revocation do not retry. Two failures remain an honest non-handoff limitation, not an invented answer.
- Both guest SOULs ask for a concise source-supported answer rather than only website suggestions, and a different permitted returned source when a page is unreadable. No bypass of robots, authentication, CAPTCHA, paywalls, or restricted destinations. Model compliance and answer quality still need live acceptance.

The 120-second cap bounds how long a not-yet-used capability survives model planning. It does not promise arbitrarily slow LLM turns will research. As before, Staff settings I/O has a two-second **socket** timeout, not a total DNS/trickle deadline. Late results cannot publish, but this is not a guaranteed total wall-clock response SLA.

## Required operator action: one general search provider

**Recommended concrete option: Tavily**, subject to Chief/Ty's approval of provider/account, billing, and commercial search/summary terms. No per-weather, restaurant, or ferry account is needed. Nothing in this patch provisions credentials.

1. Supply a real **`TAVILY_API_KEY`** through the approved secrets mechanism into the actual container environment of **both `hermes-luna` and `hermes-sunset-luna-http`**. Never put its value in chat, Git, test fixtures, receipts, or this document. Do not provision it into Skipper/Deckhand/Seadog. The existing bounded public worker already forwards this exact credential name to its restricted search subprocess; Staff/WhatsApp credentials and guest identity are not forwarded.
2. Verify the serving Hermes build registers the `tavily` provider and the effective selection is Tavily, not None. In Hermes versions with the inspected provider registry, explicit selection is `web.search_backend: tavily` in the runner's effective Hermes config (e.g. `hermes config set web.search_backend tavily` in the approved runtime context). **`WEB_SEARCH_PROVIDER` and `SEARCH_PROVIDER` are not that registry's configuration keys.** Auto-selection also selects Tavily when it is the sole available provider and no explicit competing backend is configured. Do not assume a generated/mounted config survives a runner recreation; use the existing approved provisioning owner and preserve all unrelated config.
3. No `TAVILY_BASE_URL` override is required: the default is `https://api.tavily.com`. This patch does not forward that optional override. Do not configure third-party page extraction; `read_public_source` deliberately retains the restricted local reader and source-ID boundary.
4. Container environment updates require separately authorized recreation/restart through the existing operator workflow. Updating a host env file alone does not modify an already running container. This document does **not** authorize that action, change send flags, enable Intelligence, or change tenant settings.

Only safe booleans/provider names should be returned in setup receipts: `provider=tavily`, `supports_search=true`, `is_available=true`, and `TAVILY_API_KEY_present=true`; then require an actual successful bounded search, because key presence/selection is not proof of valid credentials, quota, network access, or readable sources. Do not print provider exceptions containing credentials. Import/discover the serving build's normal web provider plugins before checking its registry; an uninitialized standalone registry is not serving-state evidence.

Reference: [Hermes tools reference](https://hermes-agent.nousresearch.com/docs/reference/tools-reference). The sandbox's `agent/web_search_registry.py` and `plugins/web/tavily/provider.py` corroborate the exact config/credential names. The serving-image probe remains necessary; Captain did not inspect or mutate that runtime.

## Offline verification and limits

From the repository root:

```sh
PYTHONPATH=docker/hermes-staging python3 -m unittest wolfhouse.test_public_lookup_dates wolfhouse.test_public_lookup_recovery wolfhouse.test_guest_public_worker wolfhouse.test_luna_intelligence wolfhouse.test_luna_intelligence_guards wolfhouse.test_luna_intelligence_lifecycle wolfhouse.test_ordinary_handoff -v
node scripts/verify-luna-intelligence.js
node scripts/verify-luna-intelligence-e2e.js
node scripts/verify-hermes-send-flags.js
npm run verify:luna-all
```

The ordinary-worker tests exercise both tenants, real registered handlers, emitted binding/cleanup, ISO-date queries (weather, museums, ferry), delayed first search, and the actual public-worker result parser. Their model, settings transport, search provider, public page transport, and external sends are **offline fixtures**. No real LLM answer quality, provider authentication, live forecast, or installed serving-image compatibility is established by those tests. Lower-level tests exercise the actual subprocess worker protocol, privacy/SSRF fences, budgets, concurrent/copy-context revocation, retry, and late-publication rejection.

The transfer packet carries RED logs, final focused receipts, independent review, and base/candidate full-suite logs. The full-suite baseline is not all green: the initial matched runs were 59/63 with four failing gates (Inbox shell channel defaults, Inbox theme, Inbox middle-column fill, personality live-eval). Final evidence must compare named nested failures, not claim equivalence solely from aggregate counts. Unrelated failures are not repaired in this scope.

This changes the timing bounds described in the earlier `LUNA-GUEST-LOOKUP-INTEL-002.md`; its historical local receipts remain historical, not this candidate's acceptance.

## Separate live acceptance gate — not executed by Captain

After Chief's separate approval and provider provisioning, use the existing ordinary/shared guest entrypoints with synthetic identity and verified request-scoped **no-send and no-business-write fences**. Do not use a simulator twin, change real WhatsApp routing, or infer safety from a fixture alone.

For each runner, preserve the actual serving revision, effective provider name/availability (no secrets), tool name, minimized query, attempt count/timings, returned source URLs, source validity/retrieval dates, and final reply. Require:

- Intelligence ON: Somo this weekend (Europe/Madrid dates) gets an actual source-supported answer, not only AEMET/Windy suggestions; no invented forecast. Unreadable pages prompt another permitted source within bounds.
- Generality: museum opening hours and ferry/public travel information also obtain relevant evidence and concise attributed answers. These are not weather-API cases.
- OFF, revoke, invalid/private query, missing provider, two failed attempts, expired budgets: no unauthorized public query, fabricated facts, silent Needs-human transition, or promised staff follow-up.
- Same booking/context retained; business prices/availability/payment facts remain Staff-owned; zero guest sends and business writes in the acceptance trial.

Stop and report missing credentials, quota, blocked sources, or unsupported installed code rather than converting local acceptance into a live-success claim. LOCAL CLEAN means reviewed local scope and a verified transfer artifact; provisioning and live acceptance are still separate gates. Chief alone tips Skipper afterward.
