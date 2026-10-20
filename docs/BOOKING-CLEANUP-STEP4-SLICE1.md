# Booking Cleanup Step 4 — Slice 1 (SEALED HOLD)

## Scope and result

This slice repairs Lucía's accepted-offer continuity and conserves an acknowledged booking when a subsequent payment-link operation fails. A same-operation retry resumes only the missing link side effect; it does not create another booking. No live system, guest send, deployment, push, or PR was used.

Base: `fc22d0893e0685ffd945a2b093a861f9aee15765`. Branch: `fix/booking-step4-slice1-fc22d089`.

## Contract

- A successful Staff create receipt is durable independently of adapter follow-up.
- Link failure does not record owner completion; the frozen operation remains resumable.
- A retry with a saved receipt reuses authoritative booking/payment references and does not dispatch another booking create.
- A lost create response has no receipt and therefore retries Staff with the same owner-issued idempotency key; existing SQL tests prove one booking/payment row.
- Link creation and `pending`/`draft` status are not payment truth.
- Failed handoff persistence cannot claim referral; no-send and tenant/session isolation remain fail closed.
- Changes to dates, room, bed, occupant mapping, count, services, amount/currency, or offered payment terms require fresh authority.

## Exact-source and replay classification

`fixtures/booking-cleanup-step4/slice1-cases.json` is the case-level supplied-source matrix for Sim23/24/25, including SHA-256 provenance, Lucía's six raw turns, captured tool chronology, cause-isolation dimensions, and guests 2–5/9 expected preservation outcomes. Staff receipts used by deterministic Python tests are **constructed** unless the test explicitly invokes the repository's real isolated PGlite verifier.

Sim13–21 continue to use the immutable replay fixtures and ledger. Captain approved the amended gate: their 25 historical `not_replayable` decisions remain visible as **unavailable, not passes**, with every exact ID/reason and retained partial evidence, and do not block this gate. This is not a broader waiver or a new exclusion.

## Lucía cause isolation and behavior

The retained baseline records optional interpreter absent/present, interposed availability, equivalent re-quote, populated versus `{}` create, stale short-name hint versus corrected roster, and independent/combined dimensions. The candidate reaches registered create on the first valid Spanish acceptance without requiring `interpret_booking_turn`. Tests separately reject changed dates/room/bed/services/payment/count/occupant, explicit refusal, unrelated yes, reset, and foreign session.

The registered Lucía SQL witness crosses the installed registered adapter and executes `scripts/verify-luna-create-booking-occupants.js --payload` against isolated real PGlite. It asserts one booking, ordered `Lucía Fernández Ruiz -> R3-B3`, one draft payment, €100/EUR due, authoritative SQL-generated IDs, and no paid claim. Stripe remains disabled inside that SQL proof; link success/failure/retry is separately exercised with constructed transport responses through the real owner/plugin path.

## Style proof

Because `accepted_quote.py` is touched, the Lucía witness locks the Ty-approved style: `€` precedes amounts, insignificant `.00` is absent, single-guest room copy has no `Name:` label, and payment prompts do not say “check for this booking”. Confirmation copy includes dates, guest count, total, deposit, remaining balance, and booking reference.

## Tests and known inherited failures

Pinned interpreter: `/opt/data/artifacts/bcr-r2-venv/bin/python` (3.14.4). `PYTHONPATH=/opt/data/artifacts/bcr-r2-runtime-overlay:<worktree>/docker/hermes-staging:<worktree>/docker/hermes-staging/plugins`.

Candidate executions:

- focused slice: 7 passed, exit 0 (including 9 source-derived booking executions and 2 availability-only no-write controls inside one table-driven test).
- accepted quote / first yes / persistence: 183 run; 15 stale-copy assertion failures, exit 1. All failures expect the now-forbidden `120.00 EUR`/single-name-label copy.
- Sim24 / structured clarification / eligibility: 32 run; 10 stale-copy assertion failures, exit 1.
- registered Sim16 group: 24 run; 9 stale-copy assertion failures, exit 1.
- replay discovery: 10 run; 1 wrapper failure caused by 2 stale Sim22 copy assertions; ledger still reports 56 cases, 31 replayed, 25 Captain-approved unavailable; exit 1.
- offer identity: 42 passed, exit 0.
- offer retry handler: 5 PASS lines, exit 0.
- create occupants PGlite verifier: all named/legacy/money/contact/negative checks passed, exit 0.
- eligibility contract: pass, exit 0.
- send flags: 53 passed, exit 0.
- `git diff --check`: exit 0.
- grouped payment handoff: exact base and head commands each run 37 tests with **4 failures + 6 errors**, exit 1. SQL handoff cases passed. The identical base/head signature establishes inherited module-global/mock ordering behavior; it remains a failure, not a waiver or a green claim.
- `npm run verify:luna-all` is not run inside this active Hermes gateway because it includes prohibited process-management behavior; no attempt was made to restart/stop the gateway.

## TDD record

The original recovery RED failed because a retry returned no secure link. Production GREEN taught the plugin to consume the owner-saved receipt and taught owner completion not to freeze a failed/uncertain payment-link attempt. Retained RED evidence lives under untracked `artifacts/booking-cleanup-step4-slice1/red/`. Later test-only REDs for SQL fixture fidelity (`mixed` versus committed `flexible`) and row-shape assertions were corrected incrementally without production changes.

## Hold

This is a **SEALED HOLD for Captain**. It does not claim all Step 4 or all Sim25 findings are closed. No push, PR, merge, publish, deploy, rollback, live check, or real send is authorized.
