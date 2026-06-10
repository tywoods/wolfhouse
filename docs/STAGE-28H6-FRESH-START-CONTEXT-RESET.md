# Stage 28h.6 — Fresh Start conversation reset

## Why the old “Clear Conversation” was misleading

The Inbox button previously labeled **Clear Conversation** called `POST /staff/conversations/:id/clear-messages`, which:

- **Hard-deleted** all `messages` rows for the thread (Inbox looked empty).
- Cleared UI fields (`staff_reply_draft`, `last_message_preview`, etc.).
- **Did not** clear `conversations.metadata.luna_guest_context` or `luna_inbound_reviews`.

Luna’s open-demo / inbound-review path reads prior state from `metadata.luna_guest_context`. After “clearing,” the transcript could look fresh while Luna still carried quote/payment/intake poison from earlier turns.

## What **Fresh Start** does

**Button:** `Fresh Start` (`#btn-fresh-start`)

**Endpoint:** `POST /staff/conversations/:id/reset-luna-context`

**Body:** `{ "client_slug": "wolfhouse-somo" }`

**Auth:** Operator+ session (same as prior clear endpoint).

**Environment:** Staging/test only (`NODE_ENV` staging/test/dev, or host contains `staging` / `localhost`). Returns **403** in production.

### Cleared

On the selected `conversations` row:

| Target | Action |
|--------|--------|
| `metadata.luna_guest_context` | Removed |
| `metadata.luna_inbound_reviews` | Removed |
| `metadata.guest_context` | Removed (if present) |
| `metadata.last_inbound_message_id` / `last_inbound_at` | Removed |
| `metadata.source` | Removed when `luna_inbound_review_dry_run` |
| `staff_reply_draft` | `NULL` |
| `pending_action` | `NULL` |
| `last_bot_reply` | `NULL` |
| `conversation_summary` | `NULL` |

Other metadata keys (e.g. staff notes) are preserved.

### Preserved

- `messages` transcript rows
- `guest_message_events` / `guest_message_sends`
- `conversations` row (phone, status, `current_hold_booking_id`, etc.)
- `bookings`, `payments`, `booking_beds`
- `bot_pause_states` (pause not cleared unless staff resumes manually)

## When to use before live retests

Use **Fresh Start** on a guest conversation (e.g. `+491726422307`) **before** sending a new intake sequence when you need Luna to forget quote/payment/intake state but keep history and financial records.

Example retest after Fresh Start + deploy `62f0178`:

1. `Hello, I want to create a new booking please`
2. `July 1st to 5th. just me`

Expected: Luna asks for package (Malibu / Uluwatu / Waimea), **not** check-out date.

## Warning

**Fresh Start does not cancel bookings or payments.** Existing holds (e.g. `WH-G27-3888294D42`) remain in `bookings` / `payments`. It only resets Luna’s **active conversation context** for the next inbound turn.

## Legacy destructive clear

`POST /staff/conversations/:id/clear-messages` still exists for admin/dev use (deletes `messages`). It is **not** wired to the Inbox **Fresh Start** button.

## Verifier

```bash
npm run verify:stage28h6-fresh-start-button
```
