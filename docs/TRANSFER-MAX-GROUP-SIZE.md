# Wolfhouse transfer Max group size

Assignment: `TRANSFER-STAFF-PRICES-MAX-GROUP-SIZE-001`.
Scope: existing Wolfhouse Admin → Staff Prices → Transfers editor and a read-only
Hermes/Luna transfer-price contract. Sunset is an isolation control, not a new
transfer product. This packet does not enable or deploy anything.

## Staff field and storage

The UI label **Max group size** maps to `max_guest_count` in the existing
`wh_pricing_transfer_rules` table and transfer-rule API payload.

- A configured maximum is an integer from 1 through 99, inclusive, and must be
  at least the configured minimum group size.
- Empty/explicit `null` clears the maximum. A null value means **no configured
  maximum**, not zero people or a guarantee of unlimited capacity.
- Older callers omitting the new key preserve an existing maximum on update;
  an insert with no key starts with null.
- Per-person (`per_person`) and per-group (`flat`) amounts, currencies, package
  rules and the existing booking Custom Price controls retain their meaning.
- Existing saved booking-transfer charges are not recalculated by this field.

## Read-only Luna contract

The Wolfhouse Hermes tool `get_transfer_prices` calls
`POST /staff/bot/transfers/prices`. POST only carries the JSON request; this
endpoint performs reads, not booking or transfer writes. It needs no booking ID.

The endpoint requires authenticated **bot-token** mode and ordinary principal
request-tenant binding. Staff sessions (including Wolfhouse sessions) and open
auth mode are intentionally rejected with 403 before tenant selection or pricing
SQL. This new Luna service reader does not expand session access; the existing
Staff Prices UI retains its own unchanged Admin endpoints. Model-supplied tenant
aliases cannot switch the bot's client. The tool is not registered in the Sunset
tool collection, and non-Wolfhouse scope is rejected before pricing reads.

A successful response contains `client_slug`, `read_only: true`,
`availability_checked: false`, and `transfers[]`. Each transfer carries:

- `airport_code`, `label`;
- `price` from the existing resolved pricing contract, preserving amount in
  cents, `unit`, `currency` and provenance (or no configured price);
- `eligibility.min_guest_count`, `eligibility.max_guest_count`,
  `eligibility.requires_package`, `eligibility.included_when_package`, and
  eligibility provenance.

The reader uses the existing Staff pricing overlay, not the Admin view loader
(which can create tables/promote catalog rows). SQL failures return an error,
not a successful static-price fallback. It does not quote a booking total,
check vehicle availability, enforce booking capacity, or create a transfer.
Luna must not promise availability from this response. The existing Luna
transfer-save path remains unchanged; this is a read-contract addition, not
an incidental migration of write pricing authority.

## Schema rollout prerequisite — operator action, separately authorized

`database/migrations/109_wh_transfer_max_guest_count.sql` is additive and
idempotent on the existing migration-076 schema. Old rows remain null. The
existing runtime Admin schema ensure includes the same column and constraint
upgrade for compatibility.

The landing operator must review/apply the additive migration to the intended
**staging** database before activating consumers of the new column. Deploying
only the reader without the schema can yield a fail-closed unavailable result.
The read-only endpoint deliberately cannot run schema upgrades. No production
migration, deploy, push or landing is authorized by this packet.

## Offline verification

Run `npm run verify:transfer-max-group-size` with Node dependencies installed and
Playwright Chromium available. The gates cover SQL persistence and constraints,
handler/adapter propagation, actual Staff API authentication/tenant routing,
and production-HTML browser interactions. Tests use only disposable PGlite
state and synthetic/intercepted HTTP; no runtime database, WABA or booking send.

The router gate uses the existing dual-gated test seam but opens no listener.
Its evidence can be written using `TRANSFER_ROUTER_OUT=/absolute/path.json`.
Fixtures are explicitly synthetic; they are not staging observations.
On memory-constrained runners, set `NODE_OPTIONS=--max-old-space-size=256`.
To replay the independently SQL-read-back configured maximum through the actual
Python adapter (transport intercepted, never a live request):

```sh
node scripts/verify-luna-transfer-prices.js --configured-json > /absolute/evidence/configured-contract.json
TRANSFER_PRICES_FIXTURE=/absolute/evidence/configured-contract.json python3 docker/hermes-staging/plugins/wolfhouse_staff_api/test_transfer_prices.py
```

Preservation gates:

```sh
node scripts/verify-wolfhouse-admin-pricing.js
node scripts/verify-transfer-admin-price-custom.js
node scripts/verify-transfer-admin-unit-browser.js /absolute/evidence/path
node scripts/verify-transfer-admin-price-custom-browser.js /absolute/evidence/path
node scripts/verify-luna-pending-transfers-save.js
node scripts/verify-hermes-send-flags.js
```

The LOCAL CLEAN receipt distinguishes focused acceptance from pre-existing
baseline suite failures. No offline PASS establishes live rollout completion.
