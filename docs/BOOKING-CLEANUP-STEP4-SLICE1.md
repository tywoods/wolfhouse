# Booking Cleanup Step 4 — Slice 1

## Scope

This slice preserves an acknowledged booking when the subsequent payment-link operation fails. A retry resumes only the missing payment-link side effect; it does not create another booking. It also carries Lucía's checked offer through name completion and the first valid Spanish acceptance.

## Contract

- A successful Staff booking receipt is durable even if payment-link creation fails.
- The owner transaction is not recorded as complete while a requested payment link is missing or failed.
- A same-operation retry reuses the saved booking identity and idempotency key and calls only payment-link creation.
- Link creation and `pending` status are not payment truth.
- No-send behavior and tenant/session isolation remain fail closed.

## Evidence model

`fixtures/booking-cleanup-step4/slice1-cases.json` records SHA-256 provenance for the supplied masked Sim25 captures and Sim24 control. Captures establish chronology and argument shapes only. Deterministic Staff response bodies are constructed test inputs; they are not represented as captured live responses.

## Tests

- `wolfhouse.test_sim25_live_sequence`: captured Lucía chronology, offer continuity, direct first-valid-yes create, and source provenance.
- `wolfhouse.test_step4_receipt_recovery`: booking succeeds, initial link fails, owner remains resumable, retry creates no second booking, and the pending link is recovered.
- Existing registered-boundary, payment-handoff, replay, SQL, and no-send gates remain the regression authority.

## TDD record

The new recovery test first failed because the retry returned no secure payment URL. The production correction then taught the plugin to use the owner-saved booking receipt and taught owner completion to remain unset on payment-link failure. The retained red and green logs are sealed in the untracked evidence packet.
