# Booking Cleanup Step 1 contract

## Staff room eligibility

The accommodation availability service is the producer. For a requested gendered room it emits:

```json
{"room_eligibility":{"status":"unsure","requested_room_preference":"female_only","affected_guest_indices":[0],"reason_code":"room_eligibility_unknown","question_kind":"confirm_room_eligibility"}}
```

* `status` is exactly `yes`, `no`, or `unsure` and concerns eligibility for the requested room only.
* `affected_guest_indices` uses zero-based roster positions. For `unsure` it identifies missing person-bound facts; for `no` it identifies incompatible explicit facts.
* `yes` does not mean stock exists or authorize a booking. `no` does not mean sold out. `unsure` is not rejection.
* `requested_room_preference`, `reason_code`, and `question_kind` carry meaning without parsing prose.
* Inventory (`has_enough_beds`, counts, selected beds) remains separate and authoritative.
* The plugin preserves this object and does not run its legacy wording/name inference when a valid structured result exists. Unsupported structures fail back to the established policy safely.

The model may collect explicit facts for affected occupants; Staff evaluates the next request. Payment intent and a room name are not eligibility facts.

## Equal deposit and total

When positive integer `deposit_required_cents === total_cents`, the renderer presents one full-stay amount and one payment instruction. It does not offer a deposit/full choice or duplicate due-now lines. Currency, amount, offer fingerprint, and ledger semantics remain Staff-owned.

## Harness

`node scripts/verify-wolfhouse-eligibility-contract.js` exercises the real Staff producer for yes/no/unsure, partial roster scope, and a non-gendered control. Plugin and localized finalizer behavior remains covered by the Python suites listed in the implementation brief.
