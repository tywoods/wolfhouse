# Owner Insight Agent — let Luna answer any data question (Phase 1)

> Goal: Luna reads an owner's natural-language question, writes her **own** scoped
> read-only SQL, reads the rows, optionally refines, and answers from the **actual
> data** — instead of matching the question to a hand-written template. No more
> imagining every possible question and patching it in.

This replaces the brittle regex picker (`owner-sql-planner.js`) that ignored *which*
month/filter was asked and returned confidently-wrong numbers (the "same revenue for
June and July" bug). It is built **on top of the existing safety layer**, not around it.

## Why this is safe (giving Luna "the database")

Luna does not get raw DB access. Every query she writes is forced through the
existing guards before it can run:

- `validateOwnerReadOnlySql` (`owner-readonly-sql.js`): SELECT-only, must filter
  `client_slug = $1` (tenant scope), allowlisted tables **and** columns, no
  `SELECT *`, `LIMIT ≤ 100`, no write/DDL keywords, single statement.
- `executeOwnerReadOnlySql`: runs inside a `BEGIN READ ONLY` transaction with a
  `statement_timeout` and a row cap.
- Catalog (`owner-data-catalog.js`): the allowlist + per-table tenant-scoping rules
  + sensitive-column blocks (Stripe IDs, raw payloads, auth tables, etc.).

So "creative querying" stays read-only, single-tenant, and bounded by construction.

## The loop (`scripts/lib/owner-insight-agent.js`)

`runOwnerInsightAgent({ question, clientSlug, planStep, execSql, validateSql?, maxSteps? })`

1. **Plan** — the model is given the catalog + the question (+ prior queries/rows)
   and returns one JSON decision: `query` | `answer` | `clarify`.
2. **Validate** — a `query` decision is run through the real validator; a rejection
   is fed back into history so the model can self-correct (it is **not** executed).
3. **Execute** — valid SQL runs read-only; the rows are added to history.
4. **Observe / iterate** — the model sees the rows and decides to query again or
   answer (bounded by `maxSteps`, default 4).
5. **Answer (grounded)** — the agent refuses to return a final answer unless at
   least one query executed successfully (**guard against hallucinated numbers**),
   and surfaces its work (`showWork`: the SQL + row counts) plus the `basis` (which
   date column / definition was used).

The agent is **dependency-injected** (model + DB + validator are passed in), so it
is model-agnostic (OpenAI, Anthropic, …) and testable with stubs.

### Prompt + parsing (pure, model-agnostic)
- `buildOwnerInsightSystemPrompt()` — emits the catalog (`describeOwnerCatalogForAi`),
  the JSON output contract, the approved templates as **few-shot examples**, and the
  rules that prevent the June/July class of bug: *always filter the asked period*,
  *pick the right date column on purpose* (`check_in` vs `created_at` vs `paid_at`)
  and name it, *ground every number in rows*, *clarify when ambiguous*.
- `buildOwnerInsightUserPrompt()` — question + compact transcript of prior queries/rows.
- `parsePlannerResponse()` — tolerant JSON extraction (fenced or inline).
- `makeLlmPlanner({ callModel, clientSlug })` — turns an injected model call into a
  `planStep`. Wire `callModel` to the live LLM client at integration time.

## Eval harness (`scripts/verify-owner-insight-agent.js`)

Deterministic gate: **stubbed model + stubbed DB, but the REAL validator** (no API
key, no Postgres needed). Proves: month is honored (June ≠ July, grounded in rows —
the screenshot bug), no-grounded-data is refused, unsafe SQL is rejected and never
executed, multi-query iteration works, ambiguous questions clarify, and the
prompt/parse functions behave. Run: `npm run verify:owner-insight-agent`.

## Status / rollout

- **Phase 1 (this change): the engine + eval harness.** Added as new modules; the
  live `owner-sql-planner` path is **unchanged** — no runtime behavior change, no
  deploy. Reviewable in isolation.
- **Phase 2 (next): wire it in.** Route the Hermes `owner_insights` tool /
  `owner-command-center-answer.js` through `runOwnerInsightAgent` with a real
  `callModel` (a capable model is recommended for SQL accuracy), tighten catalog
  column descriptions, and add any missing tables (e.g. guest-level detail for "who
  signed up"). Expand the eval set with real owner questions, then deploy behind the
  usual gates.
- **Phase 3: clarify-on-ambiguity UX + a numeric self-check pass.**

## Live evaluation (Phase 2)

The deterministic harness proves the *loop*. Accuracy of real model-written SQL must
be measured against a live DB with a golden Q→expected-answer set (the June/July
case is the first fixture). That run needs an API key + the staging Postgres and is
intentionally separate from the offline gate.
