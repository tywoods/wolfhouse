# Wolfhouse — Luna Golden Go-Live Triage

Read-only triage of why `verify:luna-all` is **16/17** on `master` (`d5acc4f`).
The single red sub-gate is `verify:luna-golden`. Companion docs:
`LIVE-CUTOVER-RUNBOOK.md` (lists golden as a go-live gate), `GO-LIVE-CHECKLIST.md`.

**Verdict:** category **(4) deterministic-composer harness/environment issue** —
specifically a **missing local database dependency**. Not baseline drift, not a
guest-behavior regression, not fixture snapshot drift. **Does not block Wolfhouse
live as a code/behavior issue, but the gate is currently unverified** (it cannot
produce a real pass/fail without its DB up).

---

## 1. Exact commands run

```
npm run verify:luna-all
node scripts/verify-luna-golden.js
node scripts/run-luna-conversation-state-machine-tests.js --fixture-dir fixtures/luna-golden --all --json
```

Environment: triage host `/opt/wolfhouse/WH`, branch
`captain/luna-golden-go-live-triage` (from `master` @ `d5acc4f`). Read-only — no
writes, no deploys, no DB started.

## 2. Exact failing fixtures (16/16)

All 16 golden fixtures fail:

```
golden-01-new-booking-happy-path        golden-09-greeting-no-price-dump
golden-02-package-explain-before-choice  golden-10-stale-context-preserved
golden-03-quote-to-payment               golden-11-september-guest-count
golden-04-services-during-booking        golden-12-package-gear-not-duplicated
golden-05-existing-booking-addon         golden-13-greeting-welcome
golden-06-transfer-capture               golden-14-post-booking-yoga-each
golden-07-no-false-handoff               golden-15-transfer-both-directions
golden-08-no-internal-language           golden-16-addon-no-false-link-error
```

`verify:luna-golden` reports all 16 as `PASS -> FAIL` regressions vs
`fixtures/luna-golden-baseline.json`.

## 3. Expected vs actual (per failure)

The failure is **identical for all 16 fixtures** — one signature, not 16 distinct
behaviors:

| | |
|---|---|
| **Expected** | Baseline result `PASS` for each fixture (recorded when the local DB was up) |
| **Actual** | `result: "FAIL"`, `turns: []`, `failures: ["connect ECONNREFUSED 127.0.0.1:5433"]` |

Distinct failure signatures across all 16 fixtures: **1**
(`connect ECONNREFUSED 127.0.0.1:5433`). Every fixture has `turns: []` — **no
conversation turn ever executed**. The runner connects to the local Wolfhouse
Postgres at `localhost:5433` (`scripts/lib/pg-connect.js`, the
`infra/docker-compose.local.yml` dev DB) *before* running any turn; the connection
is refused because no Postgres is listening on `5433` in this triage environment
(verified: nothing on `:5433`, no `postgres` container), so each fixture aborts at
setup and is classified `FAIL`.

This is the **"deterministic-composer (no GPT, no API key)"** profile — it needs no
OpenAI key, but it **is** a DB-backed integration test and needs the seeded local
Postgres.

## 4. Live-guest-safety impact

**None observable from these results — because no guest turn ran.** The runner dies
at DB connect with `turns: []`, so none of the guest-safety behaviors are exercised
or contradicted by this failure:

| Dimension | Exercised? | Affected by this failure? |
|-----------|-----------|---------------------------|
| Prices | No (no turns ran) | No signal — not affected |
| Availability | No | No signal — not affected |
| Payment links | No | No signal — not affected |
| Booking confirmation | No | No signal — not affected |
| Deposits | No | No signal — not affected |
| Handoff | No | No signal — not affected |
| One-question WhatsApp behavior | No | No signal — not affected |

The failure is purely "the test's database dependency is absent here." It carries
**no evidence of any guest-behavior regression**. It also means the gate currently
gives **no positive signal** in this environment — absence of a real pass, not a
proven failure.

## 5. Suspected owner file(s)

Not a guest-behavior owner file (planner/composer/Cami) — no behavior executed.
The relevant files are the **harness + its DB dependency**:

- `scripts/run-luna-conversation-state-machine-tests.js` — runner; opens the pg
  connection per fixture and classifies the connect error as `FAIL` with empty turns.
- `scripts/lib/pg-connect.js` — builds the `localhost:${WOLFHOUSE_DB_PORT:-5433}`
  connection the runner depends on.
- `infra/docker-compose.local.yml` — provides the `localhost:5433` dev Postgres the
  gate expects to be up.
- `scripts/verify-luna-golden.js` — baseline compare; reports the DB-down run as
  `PASS -> FAIL` regressions (the baseline `fixtures/luna-golden-baseline.json`
  assumes DB-up).

## 6. Recommendation

- **Mark as known non-blocker (code/behavior):** these 16 failures are 100%
  attributable to a missing local Postgres (`ECONNREFUSED 127.0.0.1:5433`), not to
  Luna code, fixtures, or composer logic. Do **not** fix code and do **not** update
  fixtures for this — both would be wrong responses to an environment gap. (No
  changes made in this branch.)
- **Go-live action (required before relying on the gate):** run the golden gate in
  an environment with the seeded local DB up, e.g.
  `docker compose -f infra/docker-compose.local.yml up -d` + the dev seed, then
  `npm run verify:luna-golden`, and confirm green. The cutover runbook already lists
  golden as a gate — this triage adds the precondition that **the gate needs its DB
  up to be a valid signal.** Until then the gate is *unverified*, not *failing*.
- **Split into a separate (optional) harness bug:** the runner/gate should treat an
  unreachable DB as `SKIPPED` with a clear "local Postgres on 5433 required" reason
  rather than `FAIL`/regression, so a missing dependency stops masquerading as a
  guest-behavior regression. Low priority, harness-only, out of scope for this
  read-only branch.

## 7. Does this block Wolfhouse live?

**No — not as a code or guest-behavior blocker.** The red is an environmental DB
dependency, with zero evidence of any behavior regression. **However**, the golden
gate must still be **run green against a DB-provisioned environment** as part of the
go-live checklist before flipping `live_enabled` — a missing-DB red is not a
substitute for a real green. Treat it as: *unverified gate to satisfy in CI/dev with
the DB up*, not *known-bad behavior*.
