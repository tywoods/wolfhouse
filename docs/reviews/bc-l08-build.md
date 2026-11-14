# BC-L08-BUILD — owner-backed identity consumer

Build base: Seadog #1723 `02956512674fd1539d324a8d295f54195228cd91`, stacked
on #1715. Producer review is separate (Deckhand); this Lookout slice requires Cap
review. No merge, deploy, restart, runtime edit or live business operation.

## Root fix and scope

`booking_names.py` now delegates Wolfhouse capture/read/conditional adoption to
AQ's authenticated public APIs. It retains a routing/lifetime binding only, not
an identity snapshot, revision, party-count authority or phone cache. Atomic
adoption receives the observed revision and uses the actual returned identity,
including non-adoption after a revision race. It never reads a caller roster as
legacy conversion authority. Legacy Wolfhouse v2 rows stay read-only, including
reset/compression paths; non-Wolfhouse compatibility behavior is retained.

Optional adoption/projection exceptions produce only bounded internal stage and
exception-class diagnostics. No retries, alternate stores, guessed identity,
handoffs or prompt changes. `create_decision` always continues with current
explicit intent if optional identity is unavailable. This facade does not grant
booking authorization: the authenticated owner/Staff path remains responsible for
that. Count/roster completeness is advisory, never a facade save veto. Trusted
profile seeding cannot overwrite a current explicit-clear tombstone.

Only one production file changes. Seadog's `accepted_quote.py`, Cap's
`pending_question.py`, Skip's plugin/create/payment files, shared fixtures and
package/CI registration are unchanged.

## Real execution

- Unchanged prep module: baseline **18 assertion failures / 6 controls passed**;
  candidate **24/24 passed**. Its Git blob is identical to prep head
  `acb6612224a70b462efeb36c40cc14ed927c91c5` (no weakened assertions).
- Full focused command below: **59 tests passed**, comprising the existing 23
  atomic contracts, 8 S14 owner tests, 24 unchanged facade cases and 4 additional
  lifecycle/save-continuation cases. Zero failures/errors/skips.
- The 4 new cases independently run against the exact base: **4 assertion
  failures, zero errors**. They catch missing atomic entry/logging, trusted-name
  resurrection, legacy compression copying and the uninitialized-preflight veto.
- Actual optional-adoption SQLite trigger fault: **IntegrityError**, one adoption
  call, rollback with owner revision still zero, legacy bytes unchanged. The
  same registered create then reaches the unchanged Staff builder/executor and
  real ephemeral PGlite booking/bed INSERT + COMMIT + independent SELECT:
  **1 booking, 2 bed rows, 1 COMMIT**, booking ID
  `8469cd5a-0d72-4e41-87e2-713ceccd6756` in the final run. No second create or
  handoff. The wrapper observes the genuine API/SQL exception, never fabricates
  a failed API or successful receipt.

The SQL test reuses the unchanged reduced always-save fixture. Booking and bed
SQL are real; surrounding quote/availability reads, guest-row adapter and
payment-link edges remain explicitly synthetic. It is not production HTTP
middleware, live provider/delivery proof, or a complete registered C24 acceptance.

From the repository root, with pinned Hermes and PGlite 0.5.4 available:

```sh
PYTHONDONTWRITEBYTECODE=1 \
PYTHONPATH=/opt/hermes:docker/hermes-staging:docker/hermes-staging/plugins \
NODE_PATH=/absolute/path/to/offline-deps/node_modules \
NODE_OPTIONS='--max-old-space-size=64 --max-semi-space-size=1' \
/opt/hermes/.venv/bin/python -m unittest \
  wolfhouse.test_l08_atomic_conversion_contract \
  wolfhouse.test_dup_state_identity_owner \
  wolfhouse.test_l08_facade_rebuild_contract \
  wolfhouse.test_l08_save_continuation -v
```

This memory-constrained host additionally used a **private test-only** `node`
wrapper that execs `/usr/local/bin/node --liftoff-only
--wasm-num-compilation-tasks=1 --wasm-lazy-validation "$@"`. V8 flags must go on
Node's command line, not NODE_OPTIONS; no system/runtime binary was replaced.

## Always-save group (4): causal qualification, not a full-suite green claim

The supplied Dev-01 note path is absent on this Hermes host; its unseen text is
not claimed inspected. A fresh native context probe binds each existing fixture's
actual SessionDB-backed agent (as the ordinary runtime does) while omitting only
optional names preflight. Inherited test bodies and Staff fixtures are unchanged.
That reproduces **19 booking_names_unavailable failures** at the exact base.
The candidate eliminates **all 19 early names failures**. Exact reproduced IDs:

- `wolfhouse.test_always_save.AlwaysSaveTests.test_advisory_accepted_quote_changed`
- `wolfhouse.test_always_save.AlwaysSaveTests.test_advisory_booking_create_failure_limit`
- `wolfhouse.test_always_save.AlwaysSaveTests.test_advisory_quote_completion_identity_changed`
- `wolfhouse.test_always_save.AlwaysSaveTests.test_advisory_quote_ledger_invalid`
- `wolfhouse.test_always_save.AlwaysSaveTests.test_advisory_quote_owner_acceptance_required`
- `wolfhouse.test_always_save.AlwaysSaveTests.test_advisory_quote_owner_ended`
- `wolfhouse.test_always_save.AlwaysSaveTests.test_advisory_quote_owner_material_change_requires_requote`
- `wolfhouse.test_always_save.AlwaysSaveTests.test_advisory_quote_owner_presented_offer_required`
- `wolfhouse.test_always_save.AlwaysSaveTests.test_advisory_quote_owner_readiness_failed`
- `wolfhouse.test_always_save.AlwaysSaveTests.test_advisory_quote_owner_save_outcome_unknown`
- `wolfhouse.test_always_save.AlwaysSaveTests.test_advisory_quote_owner_sent_offer_required`
- `wolfhouse.test_always_save.AlwaysSaveTests.test_advisory_quote_owner_turn_missing`
- `wolfhouse.test_always_save.AlwaysSaveTests.test_advisory_quote_payment_options_unsupported`
- `wolfhouse.test_always_save.AlwaysSaveTests.test_current_quote_drift_keeps_the_presented_staff_price`
- `wolfhouse.test_always_save.AlwaysSaveTests.test_missing_presentation_and_failed_verification_save_with_links`
- `wolfhouse.test_always_save.AlwaysSaveTests.test_no_price_display_gate`
- `wolfhouse.test_always_save.AlwaysSaveTests.test_retry_returns_same_booking_without_second_create`
- `wolfhouse.test_always_save.PersistedOwnerAlwaysSaveTests.test_create_present_payment_options_persists_owner_payload`
- `wolfhouse.test_always_save.PersistedOwnerAlwaysSaveTests.test_invalid_stored_quote_persists_owner_payload`

Qualification outcomes:

- The ordinary unchanged `test_always_save` module independently runs **24 cases**
  on both exact base and candidate: **9 passed / 15 failed**, with identical
  failing IDs. Every remaining assertion concerns an immediate payment link;
  its result already has success/write_performed true and saved IDs. Do not alter
  payment consent or fabricate links to green an obsolete fixture expectation.
- In the bound-agent probe, current-price-drift and idempotent-repeat cases turn
  fully green; the 15 link assertions are unchanged payment/fixture debt, not
  identity save refusals. The two PersistedOwner cases reach actual SQL transport
  but that particular probe's Node children receive SIGKILL (-9). Cgroup oom_kill
  was 6 before and 8 after. Those two cases passed in the ordinary candidate
  module; the dedicated native-adoption-fault SQL test also passed. The resource-
  killed context-probe cases are **not** represented as green.
- Evidence and probe source: `WH-lookout/api-cache/bc-l08-build/`, especially
  `qualify-bound-agent.py`, `always-save-bound-{base,candidate}.log`,
  `always-save-full-{base,candidate}.log`, `save-continuation-base-red.log`, and
  `final-focused.log`. Tests stopped at the bounded test budget; no broad-suite
  all-green or unseen Dev-01 packet equivalence is claimed.

## Skip-owned follow-ups (read-only findings)

In `plugins/wolfhouse_staff_api/__init__.py` at the pinned producer base:

- Lines 6060–6071: missing helper + runtime presence still refuses with
  booking_names_unavailable. An absent/import-broken module cannot be repaired
  from within this facade; Skip owns that wrapper/import-failure policy.
- Lines 6080–6083: `_booking_count_validation` can refuse before invoking the
  facade. No count is rewritten or capped by this PR; Skip owns that guard.
- Lines 6099–6103: an explicit/owner-projected empty contact still returns
  `_missing_booking_contact_result` before the primary create. L08 preserves the
  clear and never substitutes a legacy/profile name to evade that refusal;
  removing the independent save veto belongs to Skip.
- The 15 unchanged payment-link expectations in `test_always_save.AlwaysSaveTests`
  are the 13 `test_advisory_*` cases plus
  `test_missing_presentation_and_failed_verification_save_with_links` and
  `test_no_price_display_gate`. Their synthetic saved receipts already prove
  save continuation, but not current payment-admission facts. Skip/payment-test
  ownership must distinguish stale fixtures from any remaining producer wiring;
  this PR does not change payment behavior to satisfy them.

No protected test/source assertion was removed or weakened. Full system release
and those independent Skip-owned refusals remain outside this slice.
