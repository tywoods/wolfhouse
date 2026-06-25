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

- **Phase 1 (done): the engine + eval harness.** Model-agnostic agent loop +
  deterministic gate. New modules, no runtime change.
- **Phase 2 (done, flag-gated): live wiring.** `owner-insight-agent-live.js` wires the
  loop to the real model client (`luna-ai-provider`), the real validator, and the real
  read-only executor, and `planAndExecuteOwnerSqlQuestion` routes through it **when the
  flag is on**. Default OFF → the legacy template path is unchanged, so this is safe to
  deploy without enabling. Live gate: `npm run verify:owner-insight-agent-live`.
- **Phase 3 (next): turn it on + measure.** Enable on staging, run the live golden
  eval against the seeded DB, tighten catalog column descriptions, add guest-level
  detail as needed, then enable in prod. Plus a numeric self-check pass.

## Enabling (Phase 2 → live)

The agent path is controlled by an environment flag — **no code change to switch on**:

```
OWNER_INSIGHT_AGENT_ENABLED=1            # turn the agent path on (default: off)
OWNER_INSIGHT_AGENT_MODEL=gpt-5.5        # optional: per-path model for the SQL agent
OWNER_INSIGHT_AGENT_PROVIDER=anthropic   # optional: per-path provider (else inferred: claude-* => anthropic)
OWNER_INSIGHT_AGENT_MAX_STEPS=5          # optional: max queries per question
```

**Provider override (e.g. Anthropic Opus 4.8 for just this path):** set
`OWNER_INSIGHT_AGENT_MODEL=claude-opus-4-8` (provider auto-infers `anthropic`), and
ensure the Staff API has an **`ANTHROPIC_API_KEY`** (secret) — distinct from the
OpenAI key. The per-path provider override leaves all other staff AI on its
configured provider. GPT‑5.x note: the agent omits `temperature` (those models only
accept their default).

**Model:** by default the agent inherits the Staff API's `LUNA_AI_MODEL` (staging:
`gpt-4o-mini`). `OWNER_INSIGHT_AGENT_MODEL` overrides **only this path** (a strong
model for SQL accuracy) without changing the rest of the staff AI — owner insights
are low-volume, so cost is minor.

> **Caveat:** the Staff API authenticates to the **OpenAI API** via an API key. The
> model id must be one that key can call. `gpt-5.5` is Hermes's **Codex/OAuth** brain
> and may not be a valid OpenAI-API model id — if the live eval returns a model error,
> change `OWNER_INSIGHT_AGENT_MODEL` to a valid id the key supports (no code change),
> or point this path at Anthropic (`LUNA_AI_PROVIDER`/key) instead.

Note: this is the **Staff API** runtime (`wh-staging-staff-api`), where the owner SQL
agent runs — distinct from the guest-facing Hermes/Luna agent (lunabox VM, gpt-5.5).

**Rollout order (do NOT flip prod first):**
1. Set the flag (and a strong model) on **staging**, deploy via the gated scripts.
2. Run the live golden eval (real model + staging Postgres) — confirm the June/July
   case and other real questions answer correctly and grounded.
3. Only then enable on prod, behind the same flag, and watch the first real questions.

With the flag off, `planAndExecuteOwnerSqlQuestion` behaves exactly as before.

## Live evaluation (Phase 2)

The deterministic harness proves the *loop*. Accuracy of real model-written SQL must
be measured against a live DB with a golden Q→expected-answer set (the June/July
case is the first fixture). That run needs an API key + the staging Postgres and is
intentionally separate from the offline gate.
