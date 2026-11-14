# SD1701R3 local verification — partial fix, publication held

No live services, Stripe, WhatsApp, deployment, restart, push or historical data repair.

## Proven and retained changes

- Pre-save model-authoring payment-option declarations no longer override the save question. The registered quote/finalizer control asserts semantic pending state; supplied prose is not autonomous model evidence.
- A saved payment amount answer clears stale amount-question receipt markers and advances a group with unknown distribution to together/separate, without checkout.
- Guest status comparisons accept migration 024's TEXT column. Booking status remains the real migration 001/004 enum. Checkout and paid-helper tests retain separately labeled enum-guest compatibility controls.
- The service/SQL proof executes real Staff preview, production body reader/tenant dispatcher/create wrapper, and (solo only) explicitly invoked checkout with a fake provider. It is **not** a registered owner create/checkout continuation or autonomous `yes` proof. The speculative fixture wrapping a registered create handler did not establish checkout admission and was replaced, rather than changing product admission to fit it.

## Passing verification

Run from the repository root:

```sh
export NODE_PATH=/tmp/sd-0250-pg/node_modules
export PYTHONPATH=docker/hermes-staging:docker/hermes-staging/plugins:/opt/hermes
/opt/hermes/.venv/bin/python -m unittest -v \
  wolfhouse.test_infer_payment_completions \
  wolfhouse.test_deposit_or_full_after_save \
  wolfhouse.test_saved_payment_distribution \
  wolfhouse.test_save_payment_marker \
  wolfhouse.test_serious_booking_persistence \
  wolfhouse.test_saved_before_payment_sql \
  wolfhouse.test_incident_solo_finance
```

Result: **56 tests, OK** (54 in the first six modules, plus 2 finance tests), 104.733 seconds. Log: `/tmp/sd1701r3-56-tests.log`.

Six gates, each exit 0:

- `node scripts/verify-checkout-status-postgres.js`
- `node scripts/verify-hermes-send-flags.js`
- `node scripts/verify-luna-agreed-private-quote-on-save.js`
- `node scripts/verify-included-shuttle-and-mixed-room.js`
- `node scripts/verify-luna-guest-payment-status.js`
- `node scripts/verify-wolfhouse-always-save.js`

Also: `python3 scripts/verify-incident-solo-finance.py` passes solo and group controls.

Negative controls use the helper from pre-change HEAD `2ee8f8e8`, not a full baseline checkout:

- Override `GUEST_PAYMENT_STATUS_SOURCE` with the extracted base helper: exit 1, `operator does not exist: text = payment_status`; booking remains `not_requested` instead of `payment_link_sent`.
- Replace only the candidate module's exported paid helper in the Node require cache with the base paid helper: checkout controls pass, paid promotion assertion fails (exit 1). Candidate paid helper passes deposit/full, wrong-tenant, unrelated-payment, invalid unpaid-state and no-downgrade controls for TEXT and enum guest columns.

## Explicit evidence blocker

Synthetic incident-shaped solo/group terms preserve guest deposit **20000 cents**, package **malibu**, subtotal **29900 cents**. Missing deposit/package/subtotal is **not reproduced**. No fallback money or broader mapping was added. The actual hidden accepted-quote/request payload, ordered tool results, runtime provenance and persisted readback are still needed to explain that separate incident. An unscoped group draft is retained, not retired.

## Non-green exploratory runs (not acceptance passes)

Unnecessarily broad legacy-module runs were also attempted and left untouched:

- Importing `test_requoted_save_staff_body` fails because it references removed `SeriousBookingPersistenceTests.assert_mock_link_completed`.
- A broad run including `test_pass5_payment_question_lifecycle` and first-yes legacy tests ran 85 tests: 47 failures, 3 errors (`/tmp/sd1701r3-final-python.log`).
- A broad run including `test_classic_one_yes_deposit` and first-yes legacy tests ran 92 tests: 19 failures, 1 error (`/tmp/sd1701r3-scoped-python.log`).

These broad runs are not claimed baseline-equivalent; no broad repair was attempted. The parent's earlier 46-test confirmation comparison (same 2 failures/2 errors) is prior evidence, not rerun evidence from this handoff.

Local commit only. Parent must independently verify and decide publication. This does not close the full incident.
