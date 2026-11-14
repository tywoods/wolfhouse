# BC-L08-FACADE-PREP

**Prep only; not merge-ready, not a facade implementation or PR #1723 review.**
Adds one new test module and this note on Lookout prep head
`6926accad6ce271d8e70b6d854a85c65aff93044`. Existing prep files remain unchanged.
No production edits or L07/L09 implementation.

## Actual producer contract

Seadog published #1723 during preparation. Reference source is pinned to
`02956512674fd1539d324a8d295f54195228cd91`, including real S14 APIs:

```python
adopt_legacy_booking_identity(*, legacy_version, expected_revision)
# {outcome: 'adopted'|'not_adopted', reason: str,
#  identity: {revision: int, values: dict, tombstones: list}}
```

The facade requests v2 adoption against its observed revision; it must honor a
`not_adopted/revision_changed` result and the current owner identity, not apply a
cached roster. Adoption/storage failure is never booking-save permission.

Tests use actual `read_booking_identity`, `apply_booking_identity`, and atomic
adoption with real SessionDB/SQLite readback. One spy wraps the actual adoption
method; another deterministically commits a genuine S14 correction immediately
before invoking that same real method. Neither fabricates an API result. Private
facade agent binding is a fixture seam, not a replacement runtime/owner.

## Coverage and actual results

New module: `wolfhouse.test_l08_facade_rebuild_contract`.

- **Pinned API reference:** 24 tests; **6 controls pass, 18 expected consumer
  assertion failures**, zero errors/skips. Controls qualify native facade binding,
  detached input/scope, actual S14 correction/clear/reopen/SQL rollback, and real
  atomic adoption plus revision rejection.
- **Uncomposed prep base:** 24 tests; **3 native controls pass, 21 explicit missing
  owner-API prerequisite failures**, zero errors/skips. No production prerequisites
  were cherry-picked to change this result.
- Earlier S14-only qualification reached 16 consumer failures, with 5 passing
  controls, before adding the published atomic API bindings. That is not the final
  module count above.

Consumer cases require current corrections/tombstones over legacy data, fresh
reads after binding, explicit raw capture before projection, read-only legacy
storage, no inferred count or agreed-save veto, real owner/legacy write-fault
handling, closed/wrong-scope exclusion, and current semantic intake.

The existing facade blob is identical at prep and #1723; the common earlier
atomic-contract fixture is also identical. Reference tests import that actual
producer/facade and only the new consumer test from this prep branch. No local
owner substitute or API overlay is used.

**RED means incomplete.** In particular, current atomic-call/race spies report
zero calls, and the consumer owner-write-fault case reports that its fault was
never reached. Assertions beyond those first failures await the real rebuild.
No booking/payment schema, registered create, INSERT proof, HTTP, model, delivery
or live guest operation is exercised; facade-level intent preservation is not
integrated saved-booking proof. These contracts must not become release gates
before their dependencies and consumer implementation exist.

## Reproduce

For native/precondition qualification on this prep checkout:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/opt/hermes:docker/hermes-staging \
  /opt/hermes/.venv/bin/python -m unittest wolfhouse.test_l08_facade_rebuild_contract -v
```

For the API reference, obtain a **separate read-only checkout** of the pinned
#1723 SHA (sparse `docker/hermes-staging/wolfhouse/` suffices). From the prep root:

```sh
export L08_PREP_ROOT="$PWD"
export L08_API_ROOT="/absolute/path/to/pinned-api-reference"
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPATH="/opt/hermes:$L08_API_ROOT/docker/hermes-staging:$L08_PREP_ROOT/docker/hermes-staging" \
/opt/hermes/.venv/bin/python -c '
import os, unittest, wolfhouse
wolfhouse.__path__.append(os.environ["L08_PREP_ROOT"] + "/docker/hermes-staging/wolfhouse")
from wolfhouse import accepted_quote as owner, test_l08_facade_rebuild_contract as tests
assert owner.__file__.startswith(os.environ["L08_API_ROOT"] + "/")
unittest.main(module=tests, verbosity=2)
'
```

Both full commands intentionally exit 1 at this stage. Local evidence logs are
under `WH-lookout/api-cache/bc-l08-facade-prep/`; final reference run additionally
asserted exact owner, facade and new-test import paths.

## Handoff

Wait for Seadog's producer approval/availability and Chief's explicit L08 build
assignment. No producer merge, adoption of its stacked history, facade edit,
plugin edit, or next-lane work is authorized by these tests. Cap reviews any
Lookout-authored implementation; Lookout does not self-review this packet.
