# Phase 3c.g — Main local controlled runtime tests

**Status:** **3c.g.1m + 3c.g.1n success** (repeatable controlled Main `booking_flow` runtime tests).

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

## Notes

- Hosted reassign URL warning remains deferred (`tywoods.app.n8n.cloud/webhook/reassign-booking-beds` in rooming nodes).
- Keep created booking/conversation rows as audit evidence; no cleanup required for this successful run.
