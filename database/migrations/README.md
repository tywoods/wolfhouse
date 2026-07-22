# Database migrations

## Migration 015 — intentionally unused

Migration number **015** is intentionally unused. See also `015_INTENTIONALLY_UNUSED.md`.

- Phase 25 staff phone access shipped as `016_staff_phone_access.sql`.
- There is no missing, deleted, or squashed `015_*.sql` migration.
- Do not chase a "lost" 015 file in git history.

## Fresh Sunset DB apply order

On a **fresh** database (no prior schema), apply SQL migrations in this order:

1. `001_init.sql`
2. `003_rename_hostel_to_client.sql`
3. `002_package_pricing.sql`
4. `004` through `014`
5. `016` through `020`
6. `024` (Slice A — `booking_guests`; optional until Wolfhouse staging applies it)

Skip `015` (documentation only).

### Why 003 runs before 002

`002_package_pricing.sql` references the `clients` table (`client_id UUID NOT NULL REFERENCES clients(id)`).

`001_init.sql` creates `hostels`; `003_rename_hostel_to_client.sql` renames that table to `clients`.

Numeric file order (`001`, `002`, `003`) does not match fresh-DB dependency order.

### Migration 020 on Sunset

`020_wolfhouse_room_gender_metadata.sql` updates `rooms` for `wolfhouse-somo` only. On an empty Sunset database it is a **no-op** (zero matching rows) but should still run to keep migration parity with Wolfhouse.

## Migration ledger (FOUNDATION Slice 4 + 13A.1)

Canonical forward chain + classifications live in `canonical-manifest.json`.

**Checksum mode:** `canonical_lf_v1` (Slice 13A.1) — SHA-256 over UTF-8 bytes after CRLF/lone-CR → LF normalization. Identical on Windows and Linux regardless of checkout EOL conversion. Rejects NUL/binary content.

**Legacy ledger rows:** environments that applied under Slice 4 may still store pre-transition (CRLF-era working-tree) hashes. The runner accepts only the exact committed `legacySha256` for that entry, or the new canonical hash. New ledger inserts always write `canonical_lf_v1`. Arbitrary mismatches fail closed. Transition evidence: `fixtures/sunset-schema-observer/slice13a1-checksum-canonical-lf-v1-transition-report.json`.

```bash
# Integrity gate (no database)
node scripts/verify-migration-integrity.js

# Fail-closed runner — ephemeral local DB only (wh_mig_* + localhost)
# WH_MIG_HOST=127.0.0.1 WH_MIG_PORT=... WH_MIG_USER=... WH_MIG_PASSWORD=... WH_MIG_DATABASE=wh_mig_...
node scripts/run-canonical-migrations.js

# Disposable Docker proof (unique container/volume/credentials; guaranteed cleanup)
node scripts/prove-canonical-migrations-fresh-db.js
```

The runner refuses Azure / staging / production hosts and forbidden DB names (`sunset_staging`, `wolfhouse_staging`, …). It records applies in `schema_migration_ledger` under a PostgreSQL advisory lock.

**Staging ledger recovery (plan-only):** when staging ledger history is partial (e.g. only `042` present → `ledger_partial_history`), use the dry-run recovery certifier documented in [`docs/STAGING-LEDGER-RECOVERY.md`](../docs/STAGING-LEDGER-RECOVERY.md). Mutation remains disabled in that slice; canonical reconciliation is not weakened.

**015 gap:** intentionally unused (documented above). Duplicate numbers `024` / `030` / `033` are resolved in the manifest without renaming SQL files.

Git attributes pin `database/migrations/*.sql` to `eol=lf` so new migrations stay LF in the object store.

---
