# Booking cleanup close-out — Step 4 slice 3

Job `DH-STEP4-S3-DIAGNOSTICS-CLOSEOUT-20261022`. Round `BOOKING-CLEANUP-STEP4-SLICE3-SIM28-29-20261022`.

This document inventories coverage. It is not a Captain PASS, not a land, and not a claim that step 4 is universally complete. Five successful simulated bookings are not certification of contact, transfer, handoff, or payment outcomes. Captain owns the final close-out verdict.

Base at start: GitHub master `55c4cf1b2f0f1a779cca76f8cf8aec2b55ca35b6` (not newer than the inspected base). The exact candidate head is recorded in the seal after commit. Seadog and Skip lanes were still open when this file was written. Their results are not invented here.

## Diagnostics (#1394)

PR #1394 (`c29d9181`) already keeps `success=False` and a safe `reason`, `error_code`, or `detail`, and falls back to `reason=unavailable`. This lane did not change `simulate_write_guards.py` or either capture wrapper.

`scripts/verify-sim28-sim29-capture-summary.py` reads the immutable JSONL captures. It does not call Staff, Stripe, Meta, or a model.

| Capture | What the verifier reports | Status |
|---|---|---|
| Sim28 guest 3 turn 1 and guest 4 turn 1 `package_price_preview` | Ordinary failures. Diagnostic unavailable. Both guests later book. Not dropped. | Reported. Cause not invented. |
| Sim28 `CHATS.md` top error line | Empty. Not used as the failure source. | Gap recorded, file not rewritten. |
| Sim29 five booking journeys | Zero ordinary failures and zero intentional denials. | Journey-only. Not a whole-sim zero. |
| Sim29 `probe.log` `owner_insights` | Separate intentional guard denial (`blocked_unlisted_wolfhouse_sim_write`). | Not folded into zero tool errors. Not a reason to enable owner tools. |
| Sim28 `probe.log` | No tool error. Separate from the journeys. | Reported separately. |

Historical missing bodies stay missing. Adapter or local capture in the new tests is not proof that a model selected the call. Core and Crowsnest wrapper key sets were asserted unchanged.

## Outcome inventory

Statuses below are coverage labels, not fresh passes unless a command in this lane actually ran.

### Saved booking versus post-booking link

Prior slice 1 contract (`docs/BOOKING-CLEANUP-STEP4-SLICE1.md`): a saved Staff create is independent of adapter follow-up; link failure does not freeze completion; a retry with a saved receipt does not create again; a lost create response retries with the same owner idempotency key; link or pending status is not payment truth.

Named existing tests, not re-run in this lane:

- `wolfhouse.test_step4_receipt_recovery.Step4ReceiptRecoveryTests.test_saved_booking_link_failure_retries_link_not_booking`
- `wolfhouse.test_step4_receipt_recovery.Step4ReceiptRecoveryTests.test_partial_receipt_survives_retry_but_not_a_new_material_offer`
- `wolfhouse.test_step4_receipt_recovery.Step4ReceiptRecoveryTests.test_partial_per_guest_links_are_retained_and_only_failure_is_retried`
- `wolfhouse_staff_api.test_payment_failure_handoff.PaymentFailureHandoffTests.test_inline_whole_failure_preserves_saved_booking_without_retry`
- `wolfhouse.test_first_yes_persistence.FirstYesPersistenceTests.test_completed_retry_survives_session_db_reopen_without_another_booking`
- `wolfhouse.test_first_yes_persistence.FirstYesPersistenceTests.test_lost_commit_reply_recovers_same_sql_booking_and_idempotency_key`
- `wolfhouse.test_sim26_live_sequence.Sim26LiveSequenceTests.test_lucia_unchanged_offer_first_populated_create_then_retry_reuses_receipt`

Slice 1 receipt on its own head: focused slice 7 passed, exit 0. Grouped payment handoff was 37 tests, 4 failures + 6 errors, exit 1, on both exact base and head. SQL handoff cases passed. That inherited failure stays a failure, not a waiver.

Sim28 review limit still applies: one observed create per conversation is not a retry experiment, and the captures are not an independent persisted-row readback. **Open** for a fresh exact-head re-run of those suites on this base, and **open** for live retry proof.

### Contact update

Simulate admission still denies `update-contact` (`blocked_booking_mutation_in_simulate` in `test_admitted_capability_still_denies_unlisted_effects`). Existing continuity tests include `FirstYesOwnerTests.test_post_booking_contact_pending_unknown_and_completed_survive_reopen` and `GuestSimQuoteAvailabilityTests.test_post_booking_contact_owner_status_controls_replay_transport`. Sim28/29 limitation lists include `update_booking_contact` as a denied action. These logs do not contain an executed contact-update success or failure body. **Open.**

### Transfer

Simulate admission still denies `transfers/save` (`blocked_transfer_not_admitted`). Sim28/29 limitation lists include `save_transfer_request`. No executed transfer outcome is in these captures. **Open.**

### Human handoff

Slice 1 contract: failed handoff persistence cannot claim the guest was referred. Named tests include `test_handoff_failure_never_claims_notified`, `test_explicit_human_handoff.py` (script checker, not a unittest module), and `test_sim21_successful_handoff_tells_guest_it_happened_without_retry_request`. The inherited grouped payment-handoff failure above is still open. These Sim28/29 journeys do not exercise an explicit human-handoff outcome. **Open.** No false notified claim is authorized by a booking receipt.

### Paid confirmation and sends

Successful booking status and a payment link are not payment received. Actual paid-confirmation delivery is outside this no-send round. Sim28 explicitly did not exercise a post-payment receipt. **Open / out of round.**

Send-suppression evidence in the supplied probes: `wa_sends=False` and `suppressed=True`. This lane ran `node scripts/verify-hermes-send-flags.js`: 53 passed, 0 failed, exit 0. That is an offline flag gate, not a live send test. Live sends stay suppressed.

### Sim26 attribution (ruling B)

Historical Sim26 refusal was not reproduced or attributed. Slice 2 records S2-01 as preservation and coverage, not a proven historical bug fix. Later Sim28 and Sim29 booking success is not attribution of that refusal. **Unresolved and nonblocking.** Missing historical bodies stay missing.

### Earlier steps, Sim29 totals, and R4

First-three-step ledger entries stay as prior evidence. This lane does not re-certify them.

Sim29 notes record supplied execution totals, not an independent database or payment readback: guest 1 `120 / 100 / 20`, guest 2 `240 / 240 / 0`, guest 3 `240 / 200 / 40`, guest 4 `120 / 120 / 0` with the changed stay 17–20 November, guest 5 `120 / 100 / 20`. This verifier does not re-check money. **Cited, not re-audited.**

R4 rental duration and full-payment-only proof is separate. Named existing tests, not re-run here: `CaptainR2Tests.test_capfix2_finalizer_preserves_rental_quantity_and_duration_before_consent`, `CaptainR2Tests.test_capfix2_finalizer_localizes_full_payment_only_timing`, and `GuestSimQuoteAvailabilityTests.test_full_payment_only_is_money_based_not_choice_based`. Sim29 journeys are accommodation-only and do not re-exercise that proof. **Separate. Not closed by these logs.**

### Parallel lanes still open

Seadog copy (eligibility wording, group room lines, German capitalization and group address, unpaid remainder copy, French extra-turn review) has no sealed receipt in this lane. **Open.**

Skip flow (eligibility continuity, offer-bound consent, plugin/policy/SOUL) has no sealed receipt in this lane. **Open.**

Any uncovered supported-flow failure returns to Captain and Chief. This docs allocation does not grant extra product files or a live test.

### Step 5

Broad step-5 HTTP and adapter extraction remains **DEFERRED**. Five-step plan slice 5A is held. It is not done. Do not treat this close-out as `docs/BOOKING-CLEANUP-ACCEPTANCE.md`.

## Gates this lane actually ran

Interpreter used: `/opt/hermes/.venv/bin/python` (3.13.5). `PYTHONPATH` was the repo `docker/hermes-staging` and `docker/hermes-staging/plugins` only. `PYTHONDONTWRITEBYTECODE=1`. No live Staff, Stripe, Meta, or LLM call.

The recorded slice 1/2 pin `/opt/data/artifacts/bcr-r2-venv/bin/python` (3.14.4) and overlay `/opt/data/artifacts/bcr-r2-runtime-overlay` are not on this machine. That pinned-runtime gate is **incomplete, not PASS**.

| Command | Result |
|---|---|
| `python -m unittest wolfhouse.test_simulate_write_guards` | 31 tests, 1 failure, exit 1. Inherited. See below. |
| `python scripts/test_sim28_sim29_capture_summary.py` | R2: 24/24, exit 0, with `SIM28_INPUT_DIR` and `SIM29_INPUT_DIR` set to a packet copy that is not a private notes path. The earlier 12/12 was not portable. |
| `python scripts/verify-sim28-sim29-capture-summary.py --sim28-dir … --sim29-dir …` | exit 0 on the original packet. Non-string name, summary, probe `n`, or probe `r` exits 2 with `ok: false`. |
| `node scripts/verify-hermes-send-flags.js` | 53 passed, exit 0. |

Inherited failure, same on the unmodified base and this candidate because the guard file was not edited: `WolfhouseStagingBookingCapabilityTests.test_france_origin_exception_is_exact_and_keeps_all_other_gates`. The test expects `BOT_BOOKING_ENABLED=false` to deny with `bot_booking_disabled`. The landed evaluator says no environment business switch may grant or deny booking here, and the France origin fixture stays admitted. This is not a preview-diagnostic regression and it is not waived. Guard permissions were left behavior-identical. It blocks a green claim for that suite.

## Hold

No merge, deploy, guest send, Staff alert, payment, gateway restart, or live repair. Ty's current France Wolfhouse TEST session was not touched. Unsupported items above stay open.

## R2 — DH-1395-R2-CHANGES-20261022T1358

Captain CHANGES at `bfb366ce3fce95835d0ae85659c370bf4f2b14ce`. The repair stays in the same four files. `simulate_write_guards.py` and `test_simulate_write_guards.py` are untouched.

The suite reads `SIM28_INPUT_DIR` and `SIM29_INPUT_DIR`. It does not hard-code a private packet path, and it does not skip when those inputs are missing. A non-string journey `name` or `result_summary`, and a non-string probe `n` or `r`, is malformed input even when the expected failure counts would be unchanged.

Measured again with `/opt/hermes/.venv/bin/python` (3.13.5), from a packet copy outside the private notes path: capture-summary suite 24/24, exit 0. Original-packet verifier exit 0; both Sim28 `package_price_preview` failures stay listed after later booking, diagnostic unavailable. Captain's unchanged malformed-capture probe exit 0; null summary, object summary, list summary, and null tool name each exit 2 with `ok: false`; original input bytes unchanged. Send-flags 53 passed, exit 0. Guard suite still 31 tests, 1 failure, exit 1, same inherited `test_france_origin_exception_is_exact_and_keeps_all_other_gates`. Not waived. The recorded 3.14.4 pin and overlay are still absent. That gate remains incomplete, not PASS. This is not a source PASS and not a close-out PASS.
