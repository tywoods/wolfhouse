# Booking Cleanup Step 4 — Slice 2 (SEALED HOLD)

## Scope and result

Job `BOOKING-CLEANUP-STEP4-SLICE2-SIM26-20261021` preserves and covers unchanged accepted-offer continuity for Lucía and repairs two bounded contracts offline: propagation of explicit whole-party/person facts through registered availability, and truthful compact quote/confirmation presentation. No live DB, network model call, guest send, payment, service restart, deployment, push, PR, or merge was performed.

## Root causes and repair

1. **S2-01:** the supplied immutable Sim26 capture records four turns, eleven exact argument dictionaries, two `quote_owner_presented_offer_required` refusals and one `quote_owner_acceptance_required` refusal. The current base already includes Slice 1 continuity work. An identical packet-local constructed continuation is run against both `3d94ad87` and the exact candidate with the same pinned runtime and inputs; both pass registered create, isolated PGlite persistence and exactly-once retry. No speculative production change is attributed to S2-01.
2. **S2-03:** the registered availability schema exposed `group_gender`, `guests`, and `room_name_hints`, while its description explicitly prohibited `group_gender`. The description now requires explicit whole-party/person facts to survive availability → quote, forbids inference and distinguishes partial-party facts. Existing adapter behavior remains the implementation owner.
3. **S2-04:** ordinary successful quote copy appended boilerplate availability caveats and authoritative numbered room identity was suppressed with bed codes. Successful copy now omits that boilerplate, capitalizes natural room sentences, and discloses Staff-authoritative numbered rooms without bed codes. Existing unavailability, mismatch, money, payment and create-time checks remain intact.

## Evidence and runbook

Pinned interpreter: `/opt/data/artifacts/bcr-r2-venv/bin/python`. `PYTHONPATH=/opt/data/artifacts/bcr-r2-runtime-overlay:<worktree>/docker/hermes-staging:<worktree>/docker/hermes-staging/plugins`. Inputs and their approved hashes are retained untracked under `artifacts/booking-cleanup-step4-slice2/inputs`; `input-verify.log` records successful archive `SUMS.txt` verification. `RED.log` is the strict pre-production-change focused run. It shows the bounded presentation failures and a test-oracle mismatch for amount location; it does **not** manufacture the historical S2-01 owner refusal. `GREEN-focused.log` records the earlier 6/6 pass after correction. The final evidence-completeness pass added a literal, independent guest1 oracle for all four raw turns and all eleven exact ordered top-level argument dictionaries (including the failed package preview, populated creates, omissions/nulls and zero-tool turn); the fresh two-new-module run is 8/8.

Run every command in section 4 of the approved brief serially. Exact commands, outputs, exits and durations are in `artifacts/booking-cleanup-step4-slice2/run_gates.py`, `gates/*.log`, and `gate-summary.json`. The case-level Sim13–26 map is `fixtures/booking-cleanup-step4/slice2-cases.json`; all 25 inherited `not_replayable` decisions remain `approved_unavailable`, never passes.

## Truth and preservation

Whole-euro EUR copy is `€120`/`€100`; fractional cents remain exact. Deposit, full-payment, and pay-on-arrival semantics remain selected-payment-aware. A room request is not eligibility and an unchecked request is never rendered as fulfillment. Changed dates, party, person/bed mapping, room, services, currency, amount, or payment terms still require fresh authority. Successful booking status and link generation do not claim payment received.

Sim26 supplied readback remains 4/5: Camille, Becker, Emma, and Raj booked; Lucía did not historically book. Emma's timeout remains S2-02 reply delivery and is outside this repair. Constructed Python Staff/link responses are labelled; the mandatory repository occupant verifier supplies isolated PGlite SQL proof.

## Limitations

Scripted registered calls prove adapter behavior, not future model tool selection. Missing historical Staff response bodies are not reconstructed. General first-price/package-preview behavior and Crow's Nest reply delivery remain out of scope. Historical Sim13–21 unavailable evidence remains unavailable.

Historical refusal not reproduced or attributed; current-base and candidate continuation pass. S2-01 is preservation/coverage, not a proven historical bug fix.

This head is held for Captain exact-head review.
