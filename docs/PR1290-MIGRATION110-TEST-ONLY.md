# PR1290 — migration110-only Wolfhouse TEST operator path

## Scope and target identity

This change registers `110_staff_room_fill_create_receipts.sql` as canonical
forward order **104**, and its existing down file as **rollback_down**, never
forward-executable. Neither SQL file is changed.

The supported exception is **one migration, one existing ledger, one target**.
It does not run the backlog, bootstrap/upgrade a ledger, baseline history, repair
042, deploy anything, or certify the whole database as migrated.

The repository's existing target owner is
`scripts/lib/staging-ledger-recovery.js` (`RECOVERY_TARGET`):

- host: `luna-pg-shared.postgres.database.azure.com`
- port: `5432`
- database: `wolfhouse_staging`
- tenant: `wolfhouse-somo`
- CLI target label: `wolfhouse-staging`

These agree with `infra/azure/staging/main.bicep` (app database and server naming),
`infra/azure/staging/parameters.ty-template.json` (prefix/database), and the
redacted connection example in `infra/azure/staging/README.md`. The existing
ledger-recovery owner also documents the sole-042 partial-history scenario.

**Identity limit:** these are committed staging configuration facts, not a live
probe. No separately named Wolfhouse TEST host/database was discoverable. This
path supports TEST **only if the operator means this exact Wolfhouse staging
pair**. If TEST is another deployment, STOP: its authoritative host, port and
database identity are missing; a reviewed target change is required. Do not
substitute an arbitrary DSN, `wolfhouse_test`, production or Sunset. The script
hard-refuses all those targets, including near-match hostnames.

## Exact supported commands for Skip

Run from the reviewed PR1290 checkout. Node dependencies (`pg`) must already be
installed. The reviewed migration file and manifest must be present together.

**Default offline plan — no credentials, socket, or DB reads/writes:**

```bash
node scripts/apply-wolfhouse-test-migration110.js \
  --target wolfhouse-staging \
  --host luna-pg-shared.postgres.database.azure.com \
  --port 5432 \
  --database wolfhouse_staging \
  --migration 110
```

`--dry-run` is an optional explicit spelling of the same offline plan. Output
`offline_plan` means the file/manifest and target arguments passed, **not** that
the live ledger/schema, credentials or network were checked.

**Authorized operator apply — not executed by Captain:**

With `WH_MIG_USER` and `WH_MIG_PASSWORD` already supplied privately by the
operator's approved credential mechanism, from a host with access to the exact
staging server, run:

```bash
node scripts/apply-wolfhouse-test-migration110.js \
  --target wolfhouse-staging \
  --host luna-pg-shared.postgres.database.azure.com \
  --port 5432 \
  --database wolfhouse_staging \
  --migration 110 \
  --apply
```

Do not put credentials in argv, this document, logs or evidence. No credential
retrieval is implemented. No dotenv loading, arbitrary DSN/SQL, migration path,
`--force`, target override via environment, or TLS-disable flag is supported.
TLS certificate/hostname verification is mandatory; configure trusted system
CAs through the operator environment if necessary, never disable validation.

After success, the same apply command is the supported repeat check. It checks
110's ledger checksum/provenance and receipt columns/PK/FK and returns
`already_applied` without executing migration SQL again. Output always includes
`wholeDatabaseMigrated: false` and `historyReconciled: false`.

## Apply preconditions and transaction

- Exact target/migration arguments and canonical LF migration hash are checked
  before client construction. The committed expected 110 hash is pinned too.
  Read once, hash and execute the same SQL bytes using the canonical transaction
  wrapper stripping helper.
- Connect with pinned host/database/port and verify-full TLS; check
  `current_database()` and `inet_server_port()` before transaction writes.
- In one transaction, pin the public search path; use the existing WH/MIG1
  advisory lock keys and a ledger table write lock. Timeouts bound lock waits.
- `public.clients` must contain exactly the Wolfhouse tenant. Missing or
  additional tenants fail closed.
- Ledger must already exist in the canonical provenance-aware shape and contain
  exactly valid `042_luna_sales_schema`, optionally valid 110. Existing canonical
  checksum/order/provenance validation is reused. Only the known sparse-history
  error is accepted in this dedicated path; the general runner is unchanged.
  The existing `applyOne` helper owns its own BEGIN/COMMIT, so it cannot wrap
  these locked preconditions and read-back in the same transaction. This script
  instead reuses its checksum/SQL-preparation/provenance and ledger-read owners,
  with a bounded outer transaction rather than another general migration runner.
  Missing/empty/legacy-incompatible/corrupt/other-shaped ledgers refuse without
  bootstrap, column upgrades, checksum rewrites or historical inserts.
- With no 110 ledger row, receipts must be absent. An existing unrecorded table
  refuses rather than treating `CREATE IF NOT EXISTS` as proof of execution.
- Execute only the original 110 forward SQL, verify its receipt schema, and
  insert only its canonical ledger row in the same transaction. Record the
  supported canonical execution kind with **truthful single-110 evidence/notes**,
  not a claim that `runCanonicalMigrations` applied the whole chain.
- Read back the ledger, verify 042 is unchanged and 110 is present, then commit.
  Any pre-commit failure rolls back DDL and ledger insertion together. Repeat
  validates recorded 110 and receipt shape, then commits a no-op.

No down migration or automatic cleanup is provided. A CLI error is deliberately
redacted; it reports no success. If a connection fails around COMMIT, the outcome
can be ambiguous. Do not assume rollback or manually rerun raw SQL: rerun this
same idempotent supported command to read the persisted state. Unknown or
inconsistent states refuse and need separate operator investigation/approval.

These guards prevent accidental target/scope mistakes in the reviewed script;
they are not IAM authorization and cannot constrain someone who can replace the
code or independently use privileged DB credentials. Code/runtime integrity and
operator authorization remain external controls.

## Offline regression evidence

```bash
node --test scripts/verify-wolfhouse-test-migration110.js
node scripts/verify-migration-integrity.js
```

The dedicated gate uses real SQL in disposable in-memory PGlite. The network
client lifecycle and server identity are explicitly mocked. It covers sole042 to
042+110; only110 execution; existing-row preservation; atomic rollback on injected
and real SQL ledger failures; no missing-ledger bootstrap; strict argument and
wrong-target/prod/Sunset refusal; SQL/manifest checksum tampering; LF/CRLF; repeat;
schema drift; incomplete provenance; and credential-canary redaction.

**Not proven offline:** real Azure DNS/network reachability, TLS handshake,
credential validity, live schema/ledger/tenant identity, or concurrent sessions
on stock PostgreSQL. No live apply, external database, deployment, credentials
or cleanup was used in producing this change.

Evidence is under `ROOT/artifacts/pr1290-migration110/` (not runtime DB evidence).
The initial 14-case gate was observed RED before production implementation and
GREEN after it; extended coverage passes 20 cases. The first RED run timed out
while allocating many PGlite instances; the completed RED rerun asserts the
missing owner before allocating SQL, and the final suite reuses one isolated
in-memory engine with per-case schema resets.

**Existing broad gate limitation:** at base `e2237803`, the manifest also omitted
`107_guest_conversation_alert_event_identity.sql`,
`108_staff_conversation_alert_delivery.sql`, and
`109_wh_transfer_max_guest_count.sql`. Those unrelated omissions remain untouched.
The broad integrity gate still fails `green-manifest-integrity` and
`green-all-sql-classified` for those three, not 110. This narrow path validates
its selected migration instead of invoking broad backlog validation/application.
Do not report the broad gate green or use this change to authorize backlog work.
