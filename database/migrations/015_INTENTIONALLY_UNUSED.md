# Migration 015 — intentionally unused

Migration number **015** is intentionally unused in this repository.

- Phase 25 staff phone access shipped as `016_staff_phone_access.sql`.
- There is no missing, deleted, or squashed `015_*.sql` migration.
- Do not chase a "lost" 015 file in git history.

## Fresh database apply order

Run migrations in this order:

1. `001` through `014`
2. Skip `015` (this note only)
3. `016` through `020`
