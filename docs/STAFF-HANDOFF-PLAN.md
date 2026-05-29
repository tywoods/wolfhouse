# Staff Handoff Plan

**Status:** Plan — docs only (Stage 3x.2c, 2026-05-29). No runtime, no Staff UI build yet.
**Related:** [`STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md` §3x.8](STAGE-3x-BOT-KNOWLEDGE-GUARDRAILS.md#3x8--human-handoff-rules) · baseline config `config/clients/wolfhouse-somo.baseline.json` (`handoff`) · [`ROADMAP.md`](ROADMAP.md)

---

## Principle

**Handoff is a product feature, not just an internal failure state.** When the bot stops, it should hand the staff a ready-to-act context (who, what, why, suggested reply), and let them respond and return the conversation to the bot. This is also a sellable capability ("AI drafts, staff approve") and the backbone of Stage 3y shadow/co-pilot mode.

---

## When handoff fires (confirmed triggers)

From the baseline `handoff.always_handoff` list:

- Refund request · complaint / angry guest · discount request
- Custom or unclear package · group beyond configured limit
- Multiple active bookings for the same conversation
- Guest claims paid but no payment record found
- **Paid booking cancellation** (3x.2c)
- **Reschedule outside the unpaid / same-night-count safe rule** (3x.2c)
- Cancellation ambiguity · date-change ambiguity · rooming uncertainty
- Staff / manual room-assignment change request
- **Any question the bot cannot answer** (3x.2c)
- Medical / legal / emergency
- Low route confidence · conflicting dates or guest count
- LLM parse error or API failure

---

## Short-term implementation (no Staff UI required)

Use the existing conversation model + Airtable/staff view. Reuses the already-built **Send Staff Reply** and **Return Conversation To Bot** workflows.

| Field / behavior | Detail |
|------------------|--------|
| `conversation.status = human_handoff` | Bot stops auto-replying on this conversation |
| `bot_mode = staff` | Existing enum (`bot` / `staff` / `paused`) already in schema |
| Store `handoff_reason` | Which trigger fired (from list above) |
| Store `last_bot_summary` | Short summary of the conversation/booking state |
| Store `suggested_reply` (if available) | Draft the bot would have sent, for staff to approve/edit |
| Staff visibility | Transcript + booking/customer context in Airtable view or temporary staff view |
| Staff responds | Into the conversation (Send Staff Reply → WhatsApp) |
| Return to bot | Staff hands the conversation back (Return Conversation To Bot) |

**Guest-facing pattern:** acknowledge and set expectation ("Let me connect you with our team — they'll be with you shortly"); never promise refund, room, or price.

---

## Future Staff UI — Handoff Inbox (Stage 6)

| Element | Purpose |
|---------|---------|
| Handoff Inbox (queue) | All conversations in `human_handoff`, newest/oldest |
| Conversation transcript | Full message history |
| Booking / customer context | Linked booking, payment status, prior stays |
| Detected intent / reason | Why the bot handed off |
| Suggested reply draft | Editable bot draft |
| **Actions** | Send staff reply · Return to bot · Mark resolved · Create/update booking · Send payment link · Escalate cancel/refund |
| SLA / age indicator | How long the guest has waited |
| Unread / waiting-guest flag | Surfaces conversations needing a reply |

---

## Open questions for Ale/Cami (ask before building the channel)

- Should handoff **notify** Cami/Ale via WhatsApp group, email, Airtable view, or Staff UI notification?
- **Single staff inbox**, or **topic-based routing** (payments vs rooming vs complaints)?
- Should the bot tell the guest **"I'll ask the team"** before handing off (always, or only for some triggers)?
- Notify **within how long** / during which hours (`handoff_notify_within_hours` is currently `owner_required`)?
- Emergency script wording (`emergency_script` is `owner_required`).

---

## Stage placement

| Work | Stage |
|------|-------|
| Short-term handoff state + reason + summary + suggested reply (reuse Send Staff Reply / Return To Bot) | Stage 3y (shadow/co-pilot) |
| Notification channel (per owner answer) | Stage 3y / Stage 4 |
| Full Handoff Inbox UI | Stage 6 (Beautiful) |
