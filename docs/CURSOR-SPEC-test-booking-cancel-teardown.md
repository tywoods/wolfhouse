# Cursor spec — bot-callable cancel for test-booking teardown

**Lane:** Staff API (Cursor). **Author:** Captain. **Status:** spec for relay — do not build until owner confirms.
**Robustness plan:** supports step 1 (golden fixtures) — makes the `--allow-writes` goldens non-accumulating.

## The problem

The golden suite's `--allow-writes` fixtures (e.g. `mixed-couple-private-supplement-on-bill`)
create a **real Stripe-TEST booking** on every green run and never clean it up. The simulate
teardown (`POST /wolfhouse/guest-fresh-start`) clears the **session**, not the **booking row**,
so each pass leaves a synthetic booking that occupies its room. Once enough accumulate, the
private room (R6) fills for the fixture's dates and it can never reach the private-room offer
again — the fixture wedges itself into a misleading red. Witnessed 2026-06-18: leftover
`MB-WOLFHO-20260706-5a3ab8` (July 6–13, "Robin") blocked R6, requiring a manual portal wipe.

**Mitigated, not solved, on the Captain side:** the goldens now use *rolling dates* (each run
targets a fresh future week) plus a *pre-flight availability check* that SKIPs rather than
FAILs when R6 is taken. That stops the false reds, but synthetic rows still accumulate across
the calendar — they just no longer collide. True non-accumulation needs a teardown cancel.

**Why Captain can't do it:** the Luna internal bot token (`X-Luna-Bot-Token`) can *create*
bookings (`POST /staff/bot/bookings/create`, `/staff/bot/booking-create-from-plan`) but has
**no cancel route** — cancel/refund is staff-auth only. There is no DB access from Lunabox.

## The rule

> Provide a **bot-token-authenticated, test-only** way to cancel a synthetic booking the suite
> just created, so an `--allow-writes` fixture can tear down its own row. It must be safe:
> only cancellable for Stripe-TEST / non-paid bookings created via the bot lane, never a real
> guest booking.

## Suggested shape (one of)

1. **New bot endpoint** `POST /staff/bot/bookings/cancel` (bot-token auth), body
   `{ booking_code }`. Guardrails: refuse unless the booking is `source LIKE 'agent_luna%'`
   **and** payment status is unpaid/test (no captured Stripe-LIVE payment). Sets
   `status = 'cancelled'`, frees the bed allocation. Returns `{ success, booking_code, freed_beds }`.
2. **Extend `guest-fresh-start`** with an opt-in `cancel_bookings: true` flag that also cancels
   bookings tied to the derived test guest_phone (same Stripe-TEST guardrail).

Option 1 is cleaner for the golden harness (it already has the `booking_code` from the create
response) and is the recommended path.

## Captain-side follow-up once shipped

- Wire `cancelTestBooking(booking_code)` into the golden harness `finally` teardown
  (`scripts/luna-golden-conversations.js`), called for `allow_writes` fixtures after assertions.
- Then the rolling-date + pre-flight machinery + this cancel = fully self-cleaning goldens.

## Open item for the owner (now, one-off)

Full-Wipe `MB-WOLFHO-20260706-5a3ab8` in the portal to free July 6–13 R6 (left by the
2026-06-18 green run, before rolling dates landed).
