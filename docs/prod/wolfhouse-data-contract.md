# Wolfhouse production configuration-data contract — v2026-10-28.3

## Scope

This is the S2 interface between Seadog’s offline exporter/import validator and Skip’s production landing. It is **config-only** and read-only against TEST. It creates no database, mounts no secret, contacts no host, and does not schedule backups.

## Versioned allowlist

`clients`, `rooms`, `beds`, `wh_pricing_seasons`, `wh_pricing_season_ranges`, `wh_pricing_items`, `wh_pricing_rules`, and `wh_pricing_transfer_rules`. The producer preserves room fill/private priorities, gender policy, room type/order, and bed sellability/schedule/order.

The fixture `fixtures/wolfhouse-prod-data/config-only.json` is the Deckhand/UI contract: all operational counts must remain zero.

`wh_pricing_items.metadata` is copied faithfully. Typed keys are the ones Staff Admin Pricing and Luna catalog actually read/write (`allow_daily_proration`, `includes`, `min_days`, `pebble`, `promoted_from`, `minimum_nights`, plus legacy `pricing_unit` / `per_guest` / `inclusions`). Wrong types on those keys still fail `invalid_metadata`. Unknown keys (including prototype-named own keys) are carried through unchanged with a logged warning; they are never dropped and never rejected just for being unknown. JSON `null` stays `null`; validation does not rewrite it to `{}` or mutate the envelope.

## Explicit exclusions

Bookings, guests/occupants, allocations/holds, payments/refunds/invoices, Stripe IDs, messages/conversations/queues, sessions, webhook/idempotency receipts, alert/audit rows, consent/quote records, caches, TEST credentials, staff accounts, and unknown tables are excluded. Unknown schema names fail closed.

## S0 inputs supplied by Skip

The validator does not infer a target. The reviewed prod apply target is the isolated internal Docker service, not the unpublished public IP. It requires all of: host `wolfhouse-prod-postgres`, port `5432`, database `wolfhouse_prod`, network `wolfhouse-prod-private`, a dedicated production data mount, a dedicated backup-spool mount, and a non-empty off-host backup destination. Missing or different values fail closed — including `178.33.91.59`, loopback, TEST/Sunset hosts and databases, and any other hostname. Ports other than 5432, resource caps, actual mount paths, Azure container/key binding names, and scheduler configuration remain S0/S5 inputs owned by Skip; they are never stored here as credentials. Do not publish host 5432.

## Apply from the isolated network

`--apply` must run from a one-off container on `wolfhouse-prod-private` so it can reach `wolfhouse-prod-postgres:5432`. Example (placeholders only; Skip supplies the envelope, target JSON, image, and prod URL):

```bash
docker run --rm --network wolfhouse-prod-private \
  -v "$PWD":/work -w /work \
  node:22 \
  node scripts/wolfhouse-prod-data/adapter.js import --apply \
    --envelope ./wolfhouse-config.envelope.json \
    --target ./wolfhouse-prod.target.json \
    --prod-url "postgres://USER:PASSWORD@wolfhouse-prod-postgres:5432/wolfhouse_prod"
```

`wolfhouse-prod.target.json` must name that same identity:

```json
{
  "host": "wolfhouse-prod-postgres",
  "port": 5432,
  "database": "wolfhouse_prod",
  "network": "wolfhouse-prod-private",
  "manifestId": "<skip-manifest-id>",
  "mounts": { "data": "<prod-data-mount>", "backupSpool": "<backup-spool-mount>" },
  "backupDestination": "azure://<account>/<container>/<object>"
}
```

## Acceptance contract

A later reviewed adapter must run the export from a consistent read-only TEST snapshot, transactionally import only the allowlist, verify FK/config equality, and prove zero operational destination rows. Retry is safe only as idempotent configuration upsert; no truncate, wipe, rebuild, or whole-database deletion shortcut is permitted.

Migration-seeded config rows are expected on a fresh prod (for example five active `wh_pricing_rules` from 121). Those rows share a natural unique key with TEST but not the TEST UUID, so `ON CONFLICT (id)` alone raises 23505. Inside the same import transaction the adapter:

1. Locks operational tables and fails `destination_operational_nonzero` if any operational row exists (including a booking inserted after the CLI precheck).
2. Rejects any incoming UUID already owned by another tenant (`uuid_owned_by_other_tenant`).
3. Refuses to delete a config row that would cascade into any child row outside this tenant's deletion scope — excluded tables (conversations, staff, bookings) **and** allowlisted config children owned by another tenant (a Sunset season-range pointing at a stale Wolfhouse season) — `protected_dependent`.
4. Parks dest unique keys to values disjoint from both existing destination keys and incoming source keys so retained-id natural-key swaps and identical-snapshot re-imports converge, then deletes tenant config rows whose id is not in the envelope (children first), then upserts TEST rows by id.

TEST ids and values win when the delete is safe. Leftover seeds are gone. Duplicate natural keys in the envelope fail closed (`duplicate_natural_key:<table>`). Natural keys:

- `clients` `(slug)`
- `rooms` `(client_id, room_code)`
- `beds` `(client_id, bed_code)`
- `wh_pricing_seasons` `(client_slug, code) WHERE active`
- `wh_pricing_items` `(client_slug, item_type, item_code) WHERE active`
- `wh_pricing_rules` `(client_slug, item_type, item_code, COALESCE(season_code,'')) WHERE active`
- `wh_pricing_transfer_rules` `(client_slug, airport_code) WHERE active`

`wh_pricing_season_ranges` has no natural unique index; leftovers still leave by id so dest equals source.

Operational adapter (this repo): `scripts/wolfhouse-prod-data/adapter.js`. Default is `--dry-run`. TEST access is session read-only and never copies bookings, guests, payments, messages, sessions, or staff accounts. Client timezone/currency, rooms/beds, packages/seasons, deposit/pricing rules stay. Import `--apply` is reserved for a reviewed prod target with zero operational rows; config seeds on that target are reconciled, not treated as `prod_not_empty`.

## Backup boundary (S5)

The eventual package is nightly only, encrypted, bounded by spool/concurrency, requires off-host Azure readback, and is restored only into an isolated disabled-consumer target. Scheduler/mount wiring belongs exclusively to Skip. This contract neither creates backup credentials nor changes TEST/production runtime state.
