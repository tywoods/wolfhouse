# Luna V2 import audit

Generated during the V2 reset before moving any files.

## Active roots inspected

```text
scripts/staff-query-api.js
scripts/deploy-staging-hermes.js
scripts/run-live-booking-from-plan-e2e.js
scripts/run-live-booking-e2e.js
```

## Finding

`staff-query-api.js` currently pulls a very large portion of legacy Luna code into the active dependency graph. That is the concrete reason cleanup cannot safely start by moving `scripts/lib/luna-guest-*` wholesale.

The active graph reaches 95 Luna-related modules, including old agent/planner/reply/automation layers. This confirms the architecture problem: the Staff API and legacy Luna brain are still coupled.

## Safe immediate action

Do not move active imports yet. First create/prove the V2 live path and then split the legacy Meta/old Luna routes away from the Staff API core.

## Unreached `luna-guest-*` files from the inspected roots

These are candidates for early quarantine after a second repo-wide search confirms no dynamic use:

```text
scripts/lib/luna-guest-coach-evaluator.js
scripts/lib/luna-guest-regression-fixture-builder.js
scripts/lib/luna-guest-staging-profile.js
scripts/lib/luna-guest-stripe-payment-truth-apply.js
```

## V2 cleanup implication

The real cleanup is not just moving files. We need to extract a narrow Staff API V2 bot surface from the mega `staff-query-api.js` dependency graph:

```text
availability
quote
booking create
payment link/status
transfer save/list
service add/list
package update
```

Then old Luna guest-brain paths can move to `-old` without risking the staff portal or live API.
