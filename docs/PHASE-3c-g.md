# Phase 3c.g — Main local controlled runtime tests

**Status:** **3c.g.2l success** (fresh end-to-end `booking_flow -> payment_details_provided` local stub runtime proven).

## Scope

Controlled local runtime verification for Main (`RBfGNtVgrAkvhBHJ`) after 3c.e wiring and 3c.g.1d/1f/1j/1l fixes.

Guardrails:
- One valid POST per attempt.
- Keep workflow inactive outside the test window.
- No intentional payment/session/reassign paths.
- No writes to `booking_beds`, `payments`, `payment_events`.

## 3c.g.1m result (successful)

Execution evidence:
- Execution: `941`
- Status: `success`
- Last node: `Update Conversation After Reply`

Path reached:
- `Normalize Incoming Message` (ignore=false; phone `+353399990327`)
- `Code - Booking State Resolver` booking flow path
- `Postgres - Main Availability`
- `Postgres - Create Booking Hold`
- `Postgres - Upsert Conversation Hold`
- `Create Booking Hold` (Airtable test-base mirror)
- `Postgres - Backfill Booking AT Record Id`

Data evidence:
- Booking created:
  - `booking_code`: `WH-260528-4773`
  - `status/payment_status`: `hold` / `not_requested`
  - `check_in/check_out`: `2026-09-10` / `2026-09-12`
- Conversation created:
  - `current_hold_booking_id`: `766b8427-9067-468e-8213-b97ff45f2ade` (matches booking UUID)
- PG `airtable_record_id` backfilled:
  - `recxxmoE1gLasw9t0`

Safety evidence:
- `booking_beds` unchanged for test phone: `0`
- `payments` unchanged: `23`
- `payment_events` unchanged: `3`
- Payment session path avoided
- Reassign path avoided
- Workflow returned to `active=false`

## 3c.g.1n result (repeat success)

Execution evidence:
- Execution: `946`
- Status: `success`
- Last node: `Update Conversation After Reply`
- Route: `booking_flow`

Path reached:
- `Normalize Incoming Message` (ignore=false; phone `+353399990328`)
- `Code - Booking State Resolver` booking flow path
- `Postgres - Main Availability`
- `Postgres - Create Booking Hold`
- `Postgres - Upsert Conversation Hold`
- `Create Booking Hold` (Airtable test-base mirror)
- `Postgres - Backfill Booking AT Record Id`

Data evidence:
- Booking created:
  - `booking_code`: `WH-260528-1493`
  - `status/payment_status`: `hold` / `not_requested`
  - `check_in/check_out`: `2026-09-10` / `2026-09-12`
- Conversation created:
  - `current_hold_booking_id`: `33ac2766-537c-4b95-85d4-91c01c862beb` (matches booking UUID)
- PG `airtable_record_id` backfilled:
  - `recIP3DFb0nCx8gBh`

Safety evidence:
- `booking_beds` unchanged for test phone: `0`
- `payments` unchanged: `23`
- `payment_events` unchanged: `3`
- Payment session path avoided
- Reassign path avoided
- Workflow returned to `active=false`
- Temp payload file deleted after run

## 3c.g.2l result (successful fresh E2E to payment stub)

Scope proven:
- Fresh hold from prior POST #1: `WH-260528-9437` / `13e76c27-c23f-4203-8268-57586152270c` / `rec4VXB7Rf1VxDr0C`.
- Controlled POST #2 only (`wamid.PHASE3CG2L.001`) for the same phone `+353399990329`.

Execution evidence:
- Main execution: `1036` (`success`)
- Stub execution: `1037` (`success`)
- Route: `resolved_route=payment_details_provided`
- Router route: `human_handoff`
- Override: `route_overridden=true`
- Decision code: `R2F_PAYMENT_DETAILS_PRIORITY_ON_CONTACT_AND_LINK_FROM_HANDOFF`
- Resolver version: `2f.6`
- Hold lookup: `should_search_hold=true`
- Signals: `has_payment_link_intent=true`, `has_guest_email=true`, `has_payment_claim=false`, `has_explicit_rooming_or_reassign_signals=false`

Hold selection / Ensure evidence:
- `Search Hold With Guest Details` selected fresh record `rec4VXB7Rf1VxDr0C` (old `recIP3DFb0nCx8gBh` not selected).
- Ensure output:
  - `booking_id=13e76c27-c23f-4203-8268-57586152270c`
  - `booking_code=WH-260528-9437`
  - `action=promoted`, `promoted=true`
  - resulting `status/payment_status=payment_pending/waiting_payment`

Payment-link path evidence:
- `Code - Call Create Payment Session` used local stub path and returned:
  - `checkout_url=https://example.test/checkout/session_stub_13e76c27-c23f-4203-8268-57586152270c`
- `Update Booking - Stripe Payment Link` updated fresh Airtable record `rec4VXB7Rf1VxDr0C` only.
- No legacy Create Payment Session execution.
- No Stripe URL/call.

Safety evidence:
- Global `payments` unchanged: `23`
- Global `payment_events` unchanged: `3`
- Target booking `payments/payment_events`: `0/0`
- Target `booking_beds`: `0`
- Old booking `WH-260528-1493` unchanged
- No Send Confirmation side effect (`send_confirmation=false`, `confirmation_sent_at=NULL` on target booking)
- Main/stub/legacy workflows inactive after run
- Temp payload deleted; git clean after run

Conclusion:
- `3c.g.2l` proves fresh E2E local runtime coverage for `booking_flow -> payment_details_provided -> stub payment link update` on the correct hold record.

## Notes

- Hosted reassign URL warning remains deferred (`tywoods.app.n8n.cloud/webhook/reassign-booking-beds` in rooming nodes).
- Keep created booking/conversation rows as audit evidence; no cleanup required for this successful run.
- Exclusions still pending sign-off:
  - Real Stripe path (separate sign-off)
  - Stripe Webhook Handler (separate)
  - Send Confirmation chain (separate)
  - Rooming/reassign runtime path (deferred until hosted reassign URL remap)
