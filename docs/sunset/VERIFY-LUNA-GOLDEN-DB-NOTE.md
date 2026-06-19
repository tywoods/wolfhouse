# verify:luna-golden — DB gate constraints on Lunabox

## Current blocker

`verify:luna-golden` fails on Lunabox with:

```
connect ECONNREFUSED 127.0.0.1:5433
```

All 16 fixtures fail with the identical error. The runner (`run-luna-conversation-state-machine-tests.js`) requires a Postgres instance on `localhost:5433` even in its default `dry_run_review_only` mode — it executes read-only SELECTs against `bookings`, `payments`, `beds`, and related tables.

## Decision

**Keep `verify:luna-golden` as CI / dev-machine-only for now. Do not run local Postgres on Lunabox.**

## Reason

Live host RAM constraint. Lunabox runs Hermes containers and OpenClaw; adding a Postgres instance is not viable on the current host budget.

## Safety constraints — do not do these on Lunabox

- Do not create `infra/.env` from `infra/.env.example`.
- Do not run `docker compose -f infra/docker-compose.local.yml up -d wolfhouse-postgres` or any variant.
- Do not attempt to start any local Postgres service on the live host.

## Migration gap — must resolve before applying migrations to a fresh DB

`database/migrations/` goes 001–014 then jumps directly to 016. Migration 015 is absent. Before applying the migration sequence 002–020 to any fresh local or CI DB, the 015 gap must be investigated and resolved (confirm it was intentionally skipped, never existed, or was applied out-of-band).

## What still passes on Lunabox without Postgres

These offline checks require no DB, network, or env dependency and pass fully:

| Script | Runner | Result |
|---|---|---|
| `verify-luna-bed-allocator.js` | `node scripts/verify-luna-bed-allocator.js` | 60/60 |
| `verify-per-person-gear-room-pref.js` | `node scripts/verify-per-person-gear-room-pref.js` | 53/53 |
| `verify:sunset-all` | `npm run verify:sunset-all` | 6/6 checks, all assertions pass |

`verify:luna-golden` is excluded from `verify:sunset-all` — it is a Wolfhouse-only gate that requires a live DB.

## Next proper fix

Document and repair the `verify:luna-golden` DB runbook on a dev machine or CI environment (not the live host). Candidate path: `docker compose` on a CI runner or a dev laptop with the `wolfhouse-postgres` service, after resolving the migration-015 gap.
