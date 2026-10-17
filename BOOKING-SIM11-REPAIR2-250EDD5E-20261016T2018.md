# BOOKING-SIM11-REPAIR2-250EDD5E-20261016T2018

## Custody

- Parent: `250edd5efc0dd2e7baaef2532073326752f77c07`
- Parent tree: `9f09b6533b6e341c6468bcb50445c74de72bc98d`
- Branch: `fix/booking-sim11-repair2-250edd5e`
- Scope: source/offline France Wolfhouse TEST only.
- No deploy, restart, simulator turn, guest send, live Staff write, booking, Stripe action, or production action.

## Approved repairs

1. `mapBotHttpAvailabilityResponse` now transports Staff's canonical `exact_bed_eligibility` receipt.
2. Python no longer fabricates `eligible=true` from a matching free-bed list. Missing receipts fail closed.
3. Final preview responses with unavailable/not-checked/null revision normalize into the existing guest-clarification path and do not expose totals, deposit, or a payment invitation.
4. `/conversation/needs-human` again carries the trusted runtime `client_slug`, preserving Staff's principal/runtime conflict gate and typed denial subreason.
5. Exact-bed rechecks preserve accepted `room_type` and `room_preference`, including private-room intent.

## Tests and evidence

- `test_accepted_quote.py`: 79 tests, OK.
- `test_selected_bed_retention.py`: 16 tests, OK.
- `test_handoff_reason_contract.py`: 6 tests, OK.
- `test_preview_revision_failure.py`: 1 test, OK.
- `verify-sim11-exact-bed-eligibility.js`: PASS for canonical mapper transport with extra free inventory, occupied/changed negatives, and private intent.
- `verify-hermes-send-flags.js`: 53 passed, 0 failed.
- Python compilation, Node syntax checks, and `git diff --check`: exit 0.

Copied Cap defect probes were rerun from external evidence directories. Their old defect assertions now fail on the repaired observations:

- Mapper-positive: canonical receipt present, three free beds, one inert create.
- Mapper-negative: canonical `eligible=false`, zero inert creates.
- Preview late failure: `quote_success=false`, `needs_guest_clarification`, payment draft did not escape.
- Handoff: matching Wolfhouse principal invokes; Sunset mismatch is `request_tenant_conflict` with no handler.

## Refreshed boundary fixture

Per Chief approval, only Jim's synthetic availability control was refreshed to include the exact canonical Staff receipt for Jim/R4-B3 and James/R4-B4. Emre remains unresolved and fails before booking. No missing-receipt admission path exists.

The refreshed fixture passes:

- Emre: no presentation, no payment invitation, no create.
- Jim: owner presentation persists, identity remains stable, exactly one inert create.
- Final marker: `BOUNDARY CONTRACT PASS; not a live acceptance result`.

The fixture remains an offline control and makes no live booking/payment claim.
