# R6 requirement-to-proof map

| Requirement | Executable proof | Retained output |
|---|---|---|
| Seven kinds: accommodation, package, rental, lesson A, lesson B, mixed, multi-guest | `scripts/test-luna-v3-rootfix-r6.py`; 77 assertion instances over seven kinds | `candidate-r6.log` |
| Cap #3 boundary binding and typed truth counterexamples | Per kind: producer-shaped positive, evidence-missing negative, false confirmation, extra JPY, negated package, extra person/quantity | `candidate-r6.log`; base failures in `base-e0e9c38-red.log` |
| Mandatory real producer-shaped boundary evidence | Every semantic positive includes exact `request`, `public_request`, `trusted_authority`, event/call IDs, statuses and exact original/observed response bytes | `scripts/test-luna-v3-rootfix-r6.py`; `candidate-r6.log` |
| Cap #4 complete operation equivalence | Per kind: normalized positive plus purpose/payment and room-bed mutation negatives through the choices-bearing branch | `candidate-r6.log`; exact-base red log |
| Cap #6 non-JSON transport semantics | Per kind: genuine producer-shaped non-JSON fault positive plus unrelated-JSON substitution negative | `candidate-r6.log`; exact-base red log |
| Mechanical exact-base red replay | Exact files extracted from `e0e9c38...` without resetting the worktree | `base-e0e9c38-source/`; `base-e0e9c38-red.log`; `offline-gate-exits.json` |
| Existing offline non-regression gates | R6 runner executes rendered 28, plugin 19, simulator 13, lifecycle, routes, FIX1, public quote owner and shared contract | individual `*.log`; `offline-gate-exits.json` |
| Integrity | SHA-256 over every retained file except manifest itself | `SHA256SUMS` |

## Explicitly unproved / blocked

No real-owner/Dev-01 receipt was available, and no live/authentic model was run. These remain required before commit/push/landing; R6 does not replace them.
