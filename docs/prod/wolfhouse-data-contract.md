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

The validator does not infer a target. It requires all of: host `178.33.91.59`, database `wolfhouse_prod`, a dedicated production data mount, a dedicated backup-spool mount, and a non-empty off-host backup destination. Missing or different values fail closed. Ports, resource caps, actual mount paths, Azure container/key binding names, and scheduler configuration remain S0/S5 inputs owned by Skip; they are never stored here as credentials.

## Acceptance contract

A later reviewed adapter must run the export from a consistent read-only TEST snapshot, transactionally import only the allowlist, verify FK/config equality, and prove zero operational destination rows. Retry is safe only as idempotent configuration upsert; no truncate, wipe, rebuild, or deletion shortcut is permitted.

Operational adapter (this repo): `scripts/wolfhouse-prod-data/adapter.js`. Default is `--dry-run`. TEST access is session read-only and never copies bookings, guests, payments, messages, sessions, or staff accounts. Client timezone/currency, rooms/beds, packages/seasons, deposit/pricing rules stay. Import `--apply` is reserved for an empty reviewed prod target.

## Backup boundary (S5)

The eventual package is nightly only, encrypted, bounded by spool/concurrency, requires off-host Azure readback, and is restored only into an isolated disabled-consumer target. Scheduler/mount wiring belongs exclusively to Skip. This contract neither creates backup credentials nor changes TEST/production runtime state.
