# Explicit split-bed create repair

Scope: Chief item 1, Wolfhouse Staff create/assignment only. Handoff 403/reason is Skip's item 2. No Hermes routing, production, live guest sends, or payment-link execution.

## Reproduced failure

The supplied Clara/Mateo run accepted ordered beds `R5-B1`, `R4-B1`, with one name-bound eligibility hint per traveler. Staff's create command builder reran group allocation whenever `needsGenderAwareBedAssignment` was true, including when `group_gender=mixed` and exact selections were supplied. The unchanged baseline reproduced `Bed assignment failed: no_eligible_mixed_room` against a real offline SQL inventory containing only the accepted split. With spare mixed inventory, it silently reassigned instead. This is a source/SQL reproduction, not a claim that an uncaptured live HTTP payload was recovered.

## Repair

- Explicit Luna bed selections take a validation path, never the ranking/auto-allocation path. No selection retains the existing auto-allocation behavior.
- Re-read actual tenant-scoped DB inventory and overlapping assignments, without CSV resurrection of removed/inactive beds. Validate exact count, uniqueness, existence, active/sellable state, occupancy and operator-room blocks at build and again before execution.
- Validate each selected bed against the traveler at the same roster position. Explicit per-person statements (including name-bound hint corrections) override stale group summaries and provisional name hints; contradictory person-level explicit sources fail closed. Unique name matching prevents reordered/unrelated/duplicate hint records from assigning the wrong person. Provisional hints require finite confidence >=0.70 and <=1 and no ambiguity. Unknown composition is permitted in mixed beds, never single-gender beds. Private-room constraints remain enforced.
- Reject raw nested/nonstring bed codes and malformed CSV slots before normalization. Only omitted/null/empty-array/blank-string inputs are genuine no-selection requests; malformed supplied choices never become allocation consent. Unrecognized room categories fail closed; the known legacy `shared` alias remains supported.
- Preserve typed selection failures through the real bot HTTP response mapper without the SQL-only `_blocked` flag. The regression exercises that unchanged handler on the recorded SQL rejection; this is not a live listener/auth test.
- Invalid/stale selections fail closed, with no alternative bed allocation, no booking/payment insert and no automatic human handoff for eligibility uncertainty.
- Persist occupant-to-bed mappings by accepted bed-code order, not `booking_beds.created_at` order (same-statement timestamps can tie).
- Existing availability provenance/package checks and write-time SQL overlap checks remain in place.

## Proof

`node scripts/verify-luna-explicit-bed-selection.js` exercises ordinary command build, execute, unchanged booking SQL, committed occupant/customer migrations, and independent DB readback using PGlite. The existing occupant runner is reused; network transports are denied. Fixtures are not live availability. No Stripe link is created or payment collected.

Coverage: accepted split with no spare mixed capacity; no silent replacement with spare capacity; exact occupant mapping; hint reordering/corrections; invalid/missing/ambiguous eligibility; swapped/unknown/duplicate/missing/extra/malformed beds; unsellable/inactive rooms/beds, changed eligibility, occupancy and operator blocks at build and pre-execution; DB failure; unknown group in explicit mixed beds; omitted selection auto-allocation.

Additional gates: `verify-luna-bed-allocator.js`, `verify-luna-mixed-room-allocation.js`, `verify-per-person-gear-room-pref.js`, `verify-luna-front-desk-accommodation-availability-service.js`, and `verify-luna-create-booking-occupants.js`.

The old mixed-room regression deliberately expected unsafe cached beds to be silently replaced. It now requires rejection regardless of alternative capacity; no-selection allocator checks are preserved. Whole-suite/baseline outcomes belong in the accompanying evidence packet; no global PASS claim follows from targeted gates.

## Landing

Staff-only reviewed patch, based on GitHub master. Use normal PR/merge and staging Staff image workflow with mandatory sync/master preflights and merged master SHA image tag. Do not include the independent Room Placement UI packet. Do not alter Sunset/Hermes services. Chief owns the fresh-phone Clara/Mateo simulator rerun after a verified Wolfhouse test revision is live. Local regression success is not staging DONE.
