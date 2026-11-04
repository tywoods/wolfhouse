# France Wolfhouse staging private copy

This helper creates a **local, throwaway** copy of the France Wolfhouse staging
runtime for a reviewed SHA. It is intentionally host-side only: it does not
restart, replace, stop, or alter any serving container; it does not contact
`wh.lunafrontdesk.com`; and it never runs Docker prune.

## Run on France

Copy this repository checkout (or these scripts plus the checked-out source) to
the France host. Check out the requested commit and ensure that the checkout is
clean; `up.sh` refuses to build when `HEAD` differs from `<sha>` or any tracked
or untracked source bytes are present. Then run from the repository root:

```bash
sudo bash scripts/private-copy/up.sh <sha>
```

`up.sh` uses only these exact France staging source containers:

- `ovh-wolfhouse-staff` for the staging database URL
- `hermes-luna` for the private Luna runtime environment

It rejects absent source containers and rejects any source URL that contains a
production marker (`prod`, `production`, `wolfhouse-prod-`, or
`wh.lunafrontdesk.com`). It never accepts a source-container override.

The default tag is `private`; an operator may choose a second isolated run
namespace with `PRIVATE_COPY_TAG=review-1`. The database is always named:

```text
wolfhouse_c<tag>_<sha8>_<YYYYMMDD>
```

The script performs a custom-format `pg_dump`, creates only that checked
throwaway database, and restores with `pg_restore --exit-on-error`. Before
starting containers it compares source and restored row counts for `guests`,
`clients`, `customers`, `bookings`, `conversations`,
`booking_conversation_links`, and `rooms`. A missing table, restore error, or
count mismatch exits non-zero and does not start the private containers.

It builds local-only images named `wh-hermes-staging-private:<sha>` and
`wh-staff-api-private:<sha>`, then starts two clearly named private containers
on loopback only. Defaults are Staff `127.0.0.1:13036` and Luna
`127.0.0.1:18090`; the script prints both ports. The private Luna receives
explicit dry-run/send-off flags and reaches the private Staff container through
its isolated Docker network alias.

### Supervisor containment

Before either private container starts, `up.sh` removes inherited supervisor-event
and webhook variables **by variable name** from both copied environment files.
It then pins events off, keeps WhatsApp dry-run on, and gives the copy the label
`wolfhouse-france-staging-<tag>-<sha8>-<YYYYMMDD>`. `SUPERVISOR_WEBHOOK_URL`,
`SUPERVISOR_WEBHOOK_KEY`, `SUPERVISOR_WEBHOOK_SECRET`, and
`SUPERVISOR_WEBHOOK_SIGNING` are absent from
both private containers; a post-start name-only inspection fails closed if any
is retained. Before any private database, network, image, or container is
created, the helper verifies the sanitized **values** without displaying them.
The copied Staff process points only at the private Luna container; copied Luna
points only at private Staff. Live fresh-start/session-reset URL overrides are
removed, so Staff derives both reset routes from its private Luna base.

If any later stage fails, `up.sh` loudly removes only this run's generated
private Staff/Luna containers, network, and a database it successfully created.
It refuses to claim or delete a pre-existing throwaway-named database. No
environment values are printed. The helper
creates protected temporary environment files only while it is running and
removes them on exit.

## Cleanup

Use the literal cleanup command printed by `up.sh`, for example:

```bash
sudo bash scripts/private-copy/down.sh <sha> <YYYYMMDD> private
```

`down.sh` has no database URL input. It reconstructs the name locally, requires
the same exact France staging Staff source container, rejects production-looking
URLs, and removes only exact names matching the private-copy prefix. It refuses
all other database, container, and network names.

## Review boundary

This was patterned from the required `sudo bash` France workflow. The author
could not read Skip's `/tmp/c13-clone.sh` from this repo-only environment, so
Skip should diff this helper against that working script after the proof rather
than being interrupted during it.
