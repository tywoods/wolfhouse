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

## Migration ledger

There is **no** `schema_migrations` table or migration ledger in this repository today. Apply order is manual/script-driven.

### Follow-up recommendation

Add a migration ledger and a single guarded runner before future fresh-DB work (staging, CI, new tenants). Until then, document and script the explicit apply order above.
