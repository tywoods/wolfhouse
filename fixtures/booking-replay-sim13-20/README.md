# Sim13–21 accepted-quote decision replay

This fixture implements Chief ruling **JW1628**: replay only the real accepted-quote decision owner, not a complete booking flow.

## Inputs

`build_expected_table.py` extracts, for every supplied guest capture:

- recorded `check_availability` arguments;
- recorded quote arguments;
- recorded `create_booking_from_plan` arguments;
- the offer text shown by Luna; and
- captured beds, total, and currency used to freeze the Staff response.

The generated, reviewable expected table is `expected_cases.json`. Captures without the arguments required for a decision are explicitly classified as `not_replayable` with a reason; they do not block the replay.

`sim21_cases.json` appends the three Sim21 booking regressions while retaining this
directory name for compatibility with existing commands: explicit-bed offer identity,
women-only stock plus corrected dates during eligibility clarification, and preservation
and disclosure of a specific room request. The tests assert room/bed correctness, not
only booking references.

## Run

```sh
PYTHONPATH="docker/hermes-staging:docker/hermes-staging/plugins:/opt/hermes" \
  python3 -m unittest fixtures/booking-replay-sim13-20/test_decision_replay.py -v
```

The harness calls the real `wolfhouse.accepted_quote` owner with frozen captured Staff facts. It performs no live Staff, inventory, pricing, eligibility, booking, payment, or messaging calls.

`synthetic_refusal_cases.json` is explicitly non-historical and contains executable
shown plans, frozen Staff facts, refresh variations, and strict expected owner decisions
for changed-date/count/bed/price/package and unavailable/conflicting-bed refusals plus
unchanged/name/payment controls. `test_explicitly_synthetic_refusals_and_controls` runs
every row through the same real `accepted_quote` owner and SessionDB harness.

Expected current result:

- 56 total captures
- 31 replayed decisions
- 25 `not_replayable` entries with reasons
- 0 mismatches

Raw RED and GREEN evidence is retained under `artifacts/booking-gate-simplify/`.
