# Stage 8.5 — Demo Data Seed Plan (Luna Front Desk)

**Status:** PLAN DONE (2026-06-02). No data seeded yet. Implementation deferred to Stage 8.6.
**Parent:** [`STAGE-8-CLIENT-READY-STAGING-ROADMAP.md`](STAGE-8-CLIENT-READY-STAGING-ROADMAP.md)
**Depends on:** Stage 8.2 dashboard polish deployed (`2e415e3`, revision `0000004`).
**Pilot decision:** Remains **NO_GO**. Demo data makes staging presentable; it does not unlock any live gate.

> **Safety scope.** This plan proposes inserting clearly fake, tagged records into the Azure staging
> database only. No live WhatsApp sends. No Stripe. No workflow activation. No staff write enablement.
> All demo rows are tagged `source='stage8_demo'` and are fully removable by the cleanup script.

---

## 1. Objective

Make the Luna Front Desk staging dashboard immediately useful for an Ale/Cami walkthrough by ensuring:

| View | Empty-state risk | Demo data fix |
|---|---|---|
| Today — Needs Human tile | Shows `0` or `—` | ≥1 open handoff row |
| Today — Open Conversations tile | Shows `0` or `—` | ≥2 open conversations |
| Inbox | Empty table | 3 realistic guest rows |
| Needs Human sub-tab | Empty | 1 urgent handoff visible |
| Conversation detail + draft | No thread or draft | Messages + Luna draft |
| Bed Calendar (July 16–23) | No booking blocks | 1 confirmed block on a real bed |
| Booking drawer | Empty context | Full guest/stay/payment/rooming |

---

## 2. Demo Data Principles

- **Fake identities only.** Guest names, phones, emails are clearly synthetic.
- **No real payment links.** Stripe IDs are blank or fake strings with `demo_` prefix.
- **No WhatsApp sends.** Messages are inserted directly to the `messages` table; no webhook calls.
- **No workflow activation.** n8n workflows remain inactive.
- **Staging-only.** Seed script refuses to run if `WOLFHOUSE_DATABASE_URL` points to a production host.
- **Easily removable.** All demo rows tagged with `metadata->>'source' = 'stage8_demo'`.
- **Idempotent.** Seed skips rows that already exist (checked by phone/booking_code uniqueness).
- **Print counts.** Seed and cleanup scripts both print affected row counts.

### Tagging standard

Every inserted row that supports a `metadata` JSONB column gets:

```json
{ "source": "stage8_demo", "note": "Stage 8 demo data — safe to delete" }
```

Rows without a `metadata` column (e.g. `booking_beds`) are tagged via their parent booking.

---

## 3. Demo Guest Identities

| Guest | Name | Phone | Email |
|---|---|---|---|
| A | Sofia Demo | +34 999 000 001 | sofia.demo@example.test |
| B | Marco Demo | +34 999 000 002 | marco.demo@example.test |
| C | Lena Demo | +34 999 000 003 | lena.demo@example.test |

Phone numbers use the `.test` top-level domain for emails and the `+34999000XXX` block — both are
globally reserved for testing and will never belong to a real guest.

---

## 4. Demo Scenarios

### Scenario A — Needs-Human: Date Change Request (**high priority, urgent handoff**)

> **Purpose:** populate Today → Needs Human tile, Inbox → Needs Human sub-tab, conversation detail,
> and demonstrate the Luna draft copy/manual-send flow.

| Field | Value |
|---|---|
| Guest | Sofia Demo |
| Booking code | `DEMO-2601` |
| Booking status | `hold` |
| Payment status | `not_requested` |
| Check-in | `TODAY + 7 days` (computed at seed time) |
| Check-out | `TODAY + 10 days` |
| Conversation status | `open` |
| `needs_human` | `TRUE` |
| `bot_mode` | `bot` |
| Handoff reason | `date_change_request` |
| Handoff priority | `urgent` |
| Handoff status | `open` |
| Handoff summary | "Guest wants to move check-in from original date to July 5th. Needs staff to check availability and confirm." |
| `last_message_preview` | "Hola, is it possible to move my check-in to July 5th? I had a flight change." |
| `staff_reply_draft` | "Hi Sofia! Thanks for letting us know. Let me check our availability for July 5th and get back to you shortly. 🙏" |

**Messages (3 rows):**
1. `inbound` — "Hola! I just booked the surf week package for the 9th. Could I change to July 5th? My flight changed last minute."
2. `outbound` — "Hi Sofia! Got your message — let me check availability for July 5th and come back to you shortly."
3. `inbound` — "Thanks! Also, would the price change? Same package or different?"

**No bed assignment.** (Booking is a hold — not yet assigned.)

---

### Scenario B — Payment Pending: Payment Follow-up (**inbox row, no handoff**)

> **Purpose:** populate Inbox with a payment_pending conversation and demonstrate the booking
> context drawer (payment section shows 'waiting_payment').

| Field | Value |
|---|---|
| Guest | Marco Demo |
| Booking code | `DEMO-2602` |
| Booking status | `payment_pending` |
| Payment status | `waiting_payment` |
| Check-in | `TODAY + 14 days` |
| Check-out | `TODAY + 17 days` |
| Conversation status | `open` |
| `needs_human` | `FALSE` |
| `bot_mode` | `bot` |
| No handoff | — |
| `last_message_preview` | "I sent the payment yesterday via bank transfer — can you confirm receipt?" |
| `staff_reply_draft` | "Hi Marco! We're checking our records now. We'll confirm as soon as the transfer clears — usually within 1 business day." |

**Messages (2 rows):**
1. `inbound` — "Hi! I completed the bank transfer for booking DEMO-2602 yesterday afternoon. Can you confirm you received it?"
2. `outbound` — "Hi Marco! Thanks for the transfer. We'll check and confirm within 1 business day. 👍"

**Payment row (1 row in `payments` table):**
- `status = 'pending'` (`payment_record_status` enum)
- `payment_kind = 'deposit_only'`
- `amount_due_cents = 15000` (€150 deposit)
- `amount_paid_cents = 0`
- `stripe_payment_intent_id = NULL` (no Stripe)

**No bed assignment.** (Booking in payment_pending — not yet assigned.)

---

### Scenario C — Confirmed Booking: Bed Calendar Block (**visible in Jul 16–23 default range**)

> **Purpose:** show a confirmed booking block in the Bed Calendar and demonstrate the full booking
> context drawer (guest/stay/payment/rooming all populated).

| Field | Value |
|---|---|
| Guest | Lena Demo |
| Booking code | `DEMO-2603` |
| Booking status | `confirmed` |
| Payment status | `paid` |
| Check-in | `2026-07-16` (fixed — matches default calendar range) |
| Check-out | `2026-07-22` |
| Guest count | 2 |
| Assignment status | `assigned` |
| `total_amount_cents` | 58000 (€580) |
| `amount_paid_cents` | 58000 |
| `balance_due_cents` | 0 |
| Conversation status | `open` |
| `needs_human` | `FALSE` |
| `bot_mode` | `bot` |
| No handoff | — |
| `last_message_preview` | "Can't wait for the surf week! See you soon 🤙" |

**Messages (2 rows):**
1. `outbound` — "Hi Lena! Your booking for July 16–22 is confirmed. We're looking forward to welcoming you! 🏄"
2. `inbound` — "Amazing, can't wait! Do I need to bring anything specific for the surf lessons?"

**Booking_beds (2 rows — one per guest):**
- Look up 2 active, sellable beds for client `wolfhouse-somo` at seed time.
- `assignment_start_date = 2026-07-16`, `assignment_end_date = 2026-07-22`
- `guest_name = 'Lena Demo'` on first bed; `guest_name = 'Lena Demo (+1)'` on second.
- `assignment_type = 'confirmed'`
- `planning_row_label` set from bed's `planning_row_label` if available.

**Payment row (1 row):**
- `status = 'paid'`
- `payment_kind = 'full_amount'`
- `amount_due_cents = 58000`, `amount_paid_cents = 58000`
- `stripe_payment_intent_id = 'demo_pi_stage8_lena'` (obviously fake)

---

### Scenario D — Add-ons (DEFERRED)

Add-on demo data is deferred to Stage 8.7 because:
- Migration 007 (`007_add_addon_orders.sql`) is marked "NOT YET APPLIED" and may not exist on staging.
- The seed script will verify `add_on_orders` table existence and skip gracefully if absent.
- Document in Stage 8.7 plan.

---

## 5. Tables and Record Counts

| Table | Scenario A | Scenario B | Scenario C | Total |
|---|---|---|---|---|
| `conversations` | 1 | 1 | 1 | **3** |
| `messages` | 3 | 2 | 2 | **7** |
| `bookings` | 1 | 1 | 1 | **3** |
| `booking_beds` | 0 | 0 | 2 | **2** |
| `staff_handoffs` | 1 | 0 | 0 | **1** |
| `payments` | 0 | 1 | 1 | **2** |
| **Total rows** | **6** | **5** | **7** | **18** |

No inserts into: `clients`, `rooms`, `beds`, `guests`, `packages`, `staff_users`, `auth_sessions`,
`add_on_orders`, `workflow_events`, `manual_entries`, `operator_room_release_requests`.

---

## 6. Date Strategy

| Date field | Strategy |
|---|---|
| Scenario A check-in/out | Relative: `NOW() + INTERVAL '7 days'` / `+10 days` at seed time |
| Scenario B check-in/out | Relative: `NOW() + INTERVAL '14 days'` / `+17 days` at seed time |
| Scenario C check-in/out | Fixed: `2026-07-16` / `2026-07-22` (matches default calendar Jul 16–23) |
| `updated_at` / `created_at` | `NOW()` at seed time |
| Handoff `opened_at` | `NOW() - INTERVAL '2 hours'` (looks recent but not just-now) |
| Scenario A hold_expires_at | `NOW() + INTERVAL '24 hours'` |

**Rationale:** Scenario C uses fixed July dates so it appears in the Bed Calendar without any input
change. Scenarios A and B use relative dates so they appear in Inbox as current/active conversations
regardless of when the seed runs.

**Refresh option:** If demo sessions happen weeks after initial seeding, run a partial re-seed that
updates `conversations.updated_at` and `bookings.check_in/check_out` for scenarios A and B to keep
them looking active. The cleanup + re-seed cycle handles this.

---

## 7. Cleanup Strategy

All demo rows have `metadata->>'source' = 'stage8_demo'` (conversations, messages, bookings,
payments, staff_handoffs) or are linked by FK to tagged parent rows (booking_beds).

**Deletion order (respects FK constraints):**

```
1. DELETE FROM staff_handoffs   WHERE metadata->>'source' = 'stage8_demo'
2. DELETE FROM booking_beds     WHERE booking_id IN
     (SELECT id FROM bookings WHERE metadata->>'source' = 'stage8_demo')
3. UPDATE conversations SET current_hold_booking_id = NULL
     WHERE metadata->>'source' = 'stage8_demo'
4. DELETE FROM messages         WHERE metadata->>'source' = 'stage8_demo'
   -- OR cascade: messages delete automatically with conversations (ON DELETE CASCADE)
5. DELETE FROM conversations    WHERE metadata->>'source' = 'stage8_demo'
6. DELETE FROM payments         WHERE metadata->>'source' = 'stage8_demo'
7. DELETE FROM bookings         WHERE metadata->>'source' = 'stage8_demo'
```

**Cleanup verifies** by re-querying each table for `source = 'stage8_demo'` rows and asserting 0.

---

## 8. Implementation Plan for Stage 8.6

### Files to create

| File | Purpose |
|---|---|
| `scripts/fixtures/stage8-demo-seed.js` | Idempotent JS seed script |
| `scripts/fixtures/stage8-demo-cleanup.js` | Idempotent cleanup script |
| `scripts/fixtures/stage8-demo-proof.js` | Row-count proof script |

### Why JS, not raw SQL?

- `booking_beds.bed_id` requires real UUID from the `beds` table — must be looked up at runtime.
- Relative date arithmetic is cleaner in JS than `INTERVAL` SQL literals.
- Idempotency check (skip if exists) is more readable in JS.
- Safety checks (refuse prod URL) are easier in JS.

### Seed script structure (`stage8-demo-seed.js`)

```
1. Load WOLFHOUSE_DATABASE_URL from env (fail if not set)
2. Safety: parse DB hostname — refuse if matches known prod patterns
3. Connect via pg
4. Resolve client_id: SELECT id FROM clients WHERE slug = 'wolfhouse-somo'
5. Verify rooms/beds exist: SELECT id, bed_code, bed_label FROM beds
     WHERE client_id = $clientId AND active AND sellable LIMIT 5
6. Compute dates (relative + fixed)
7. For each scenario:
     a. Check if conversation with this phone already exists → skip if found
     b. INSERT conversation → capture id
     c. INSERT messages with conversation_id
     d. Check if booking with this booking_code exists → skip if found
     e. INSERT booking → capture id
     f. UPDATE conversation SET current_hold_booking_id = booking_id (scenario A only)
     g. INSERT booking_beds (scenario C only, using looked-up bed_id)
     h. INSERT staff_handoff (scenario A only)
     i. INSERT payment (scenarios B, C)
8. Print inserted row counts
9. Close connection
```

### Cleanup script structure (`stage8-demo-cleanup.js`)

```
1. Same safety checks as seed
2. Run deletion steps in order (§7 above) — each step reports deleted count
3. Re-verify all tables have 0 demo rows
4. Print final "Cleanup complete — N rows removed"
```

### Proof script structure (`stage8-demo-proof.js`)

```
1. Connect (no safety check needed — read-only)
2. SELECT COUNT(*) per table WHERE metadata->>'source' = 'stage8_demo'
3. Assert: conversations = 3, messages = 7, bookings = 3, handoffs = 1, etc.
4. SELECT conversation_id, guest_name, needs_human FROM conversations WHERE source
5. SELECT booking_code, status, check_in, check_out FROM bookings WHERE source
6. Print PASS/FAIL per assertion
```

---

## 9. Proof Requirements for Stage 8.6

After seeding Azure staging, all of the following must pass:

| Check | Expected |
|---|---|
| `GET /staff/ui` Today → Needs Human tile | Shows `1` (not `0` or `—`) |
| `GET /staff/ui` Today → Open Conversations tile | Shows `3` (or ≥2) |
| `GET /staff/conversations?client=wolfhouse-somo` | Returns 3 rows |
| `GET /staff/handoffs?client=wolfhouse-somo` | Returns 1 open handoff |
| `GET /staff/bed-calendar` (Jul 16–23) | Returns DEMO-2603 block |
| Clicking DEMO-2603 block → booking drawer | Shows Lena Demo, confirmed, paid, rooming |
| Click Scenario A conversation → detail | Shows thread (3 msgs) + Luna draft |
| Safety: `STAFF_ACTIONS_ENABLED` | `false` |
| Safety: `WHATSAPP_DRY_RUN` | `true` |
| Safety: n8n workflows | All inactive |
| Safety: no WhatsApp sends triggered | No outbound messages to real phones |
| Cleanup script | Removes all 18 rows; proof shows 0 |

---

## 10. Non-Negotiables

- No real guest data.
- No real payment links or Stripe session IDs.
- No WhatsApp sends (no calls to WhatsApp API or n8n webhooks).
- No workflow activation.
- No production DB writes (safety check in seed + cleanup scripts).
- No new write endpoints in the Staff API.
- Demo rows do not affect any protected table baseline.

---

## 11. Next Step: Stage 8.6

> **Stage 8.6** — implement `scripts/fixtures/stage8-demo-seed.js`,
> `scripts/fixtures/stage8-demo-cleanup.js`, and `scripts/fixtures/stage8-demo-proof.js`
> per this plan; run seed against Azure staging DB; run proof; capture outputs; update docs.

Seed is executed via:
```
WOLFHOUSE_DATABASE_URL=... node scripts/fixtures/stage8-demo-seed.js
```

Cleanup (if needed before re-seeding or before a live pilot):
```
WOLFHOUSE_DATABASE_URL=... node scripts/fixtures/stage8-demo-cleanup.js
```
