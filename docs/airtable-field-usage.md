# Airtable Field Usage & Migration Mapping

Base: **Wolfhouse** (`appOCWIN47Bui9CSS`)  
CSV exports: `database/*.csv`

Legend:

- **Critical** — read/written by n8n; must exist in Postgres
- **Used** — referenced in formulas or staff UI
- **Legacy** — safe to drop after migration validation
- **Unused** — not referenced in exported workflows; candidate for cleanup

---

## Bookings (`tblYWm3zKFafe4qu7`)

| Field | Usage | Postgres column (proposed) |
|-------|-------|----------------------------|
| Booking ID | Critical — public ID `WH-rec…` | `bookings.booking_code` |
| Guest Name | Critical | `bookings.guest_name` (+ `guests` link later) |
| Status | Critical — enum | `bookings.status` |
| Payment Status | Critical | `bookings.payment_status` |
| Check In / Check Out | Critical | `bookings.check_in`, `bookings.check_out` |
| Guest Count | Critical | `bookings.guest_count` |
| Phone | Critical — WhatsApp key | `bookings.phone` / `guests.phone` |
| Email | Critical | `bookings.email` |
| Booking Beds | Critical — linked record IDs | relation via `booking_beds` |
| Assignment Status | Critical | `bookings.assignment_status` |
| Package | Critical — Malibu/Uluwatu/Waimea/Custom | `bookings.package_code` |
| Hold Expires At | Critical — Main hold expiry job | `bookings.hold_expires_at` |
| Payment Link | Critical (placeholder today) | `payments.checkout_url` |
| Send Confirmation | Critical — triggers confirmation flow | `bookings.send_confirmation` |
| Guest Gender / Group Type | Critical — assignment | `bookings.guest_gender_group_type` |
| Requested Room Type | Critical | `bookings.requested_room_type` |
| Room Preference | Critical | `bookings.room_preference` |
| Rooming Notes | Critical | `bookings.rooming_notes` |
| Rooming Confidence | Used — rooming AI path | `bookings.rooming_confidence` |
| Needs Rooming Review | Used | `bookings.needs_rooming_review` |
| Booking Source | Critical — Manual Staff / WhatsApp / Operator | `bookings.booking_source` |
| Staff Notes | Used — manual entries | `bookings.staff_notes` |
| Availability Check Status | Critical | `bookings.availability_check_status` |
| Conflict Notes | Critical | `bookings.conflict_notes` |
| Operator Name | Critical — operator blocks | `bookings.operator_name` |
| Block Type | Critical — e.g. Whole Room | `bookings.block_type` |
| Room to Block | Critical — operator blocks (linked room) | `bookings.room_to_block_id` |
| Deposit Required / Deposit Paid / Balance Due / Total Amount / Amount Paid | Used — manual staff; Stripe later | `payments` + `bookings` money fields |
| Payment Option / Payment Notes | Used | `bookings.payment_option`, `bookings.payment_notes` |
| Created At | Critical | `bookings.created_at` |
| Expired | Legacy checkbox? | fold into `status = Expired` |
| Google Calendar Event ID / Needs Calendar Sync / Calendar Title | Unused in n8n exports | defer or `bookings.calendar_*` optional |
| Room ID | Used — denormalized summary | `bookings.primary_room_id` optional |
| Booking Beds 2 / Booking Beds 3 | Legacy duplicates in Main schema metadata | **do not migrate** |

### Booking status values (from workflows)

`Hold`, `Payment_Pending`, `Confirmed`, `Cancelled`, `Expired`, `Needs_Review`, `Checked_In`, `Blocked` (operator)

### Payment status values

`not_requested`, `waiting_payment`, `deposit_paid`, `paid`

### Assignment status values

`Unassigned`, `Assigning`, `Assigned`, `Needs Review`

---

## Booking Beds (`tblO1ByvTMXS4SalB`)

| Field | Usage | Postgres |
|-------|-------|----------|
| Assignment ID | Critical — display label | `booking_beds.assignment_label` |
| Booking ID | Critical | `booking_beds.booking_id` |
| Booking | Critical — link to parent | FK |
| Bed / Bed Label | Critical | `booking_beds.bed_id` |
| Room / Room ID | Critical | `booking_beds.room_id` |
| Guest Name | Used — display | denormalized |
| Check In / Check Out | Used — mirrors booking | `assignment_start_date` / `assignment_end_date` |
| Assignment Start Date / Assignment End Date | Critical — overlap queries | indexed |
| Status (from Booking) | Critical — lookup only | derive from parent, do not store separately long-term |
| Payment Status (from Bookings) | Lookup | derive from parent |
| Assignment Type | Critical | `booking_beds.assignment_type` |
| Assignment Notes | Critical | `booking_beds.assignment_notes` |
| Package (from Bookings) | Lookup | derive |
| Guest Gender / Group Type / Room Preference / Rooming Notes | Used | copy or join from booking |
| Planning Row Label | Used — sheet sync | `booking_beds.planning_row_label` |
| Status - OLD | **Legacy** | drop |
| Deposit Paid (from Bookings 3) | Lookup artifact | drop |

---

## Beds (`tblEkF4SG4TLaNmW4`)

| Field | Usage | Postgres |
|-------|-------|----------|
| Bed ID | Critical — `R7-B1` | `beds.bed_code` |
| Room | Critical — link | `beds.room_id` |
| Room ID | Critical | denormalized |
| Bed Number / Bed Label | Critical | `beds.bed_number`, `beds.bed_label` |
| Active / Sellable | Critical — filters | `beds.active`, `beds.sellable` |
| Notes | Optional | `beds.notes` |
| Booking Beds | Reverse link | relation |
| Planning Row Label | Used — sync | `beds.planning_row_label` |

---

## Rooms (`tblrNdFnxdQvEnPuj`)

| Field | Usage | Postgres |
|-------|-------|----------|
| Room ID | Critical — `R1`…`R9` | `rooms.room_code` |
| Room Name / House | Used | `rooms.name`, `rooms.house` |
| Room Type | Critical | `rooms.room_type` |
| Capacity | Critical | `rooms.capacity` |
| Fill Priority / Private Priority | Critical — scoring | `rooms.fill_priority`, `rooms.private_priority` |
| Gender Strategy | Critical | `rooms.gender_strategy` |
| Can be Matrimonial | Critical | `rooms.can_be_matrimonial` |
| Often used By Operator | Critical | `rooms.often_used_by_operator` |
| Active | Critical | `rooms.active` |
| Room Sort / Round Robin Order | Used | `rooms.sort_order` |
| Avoid Until Needed | Used | `rooms.avoid_until_needed` |
| Beds / Bookings / Operator Room Release Request | Links | relations |

---

## Conversations (`tbllLFnkeriks575v`)

| Field | Usage | Postgres |
|-------|-------|----------|
| Name | Display | generated |
| Phone | Critical | `conversations.phone` unique per hostel |
| Guest Name / Email | Critical | link `guests` |
| Language | Critical | `conversations.language` |
| Session State | Critical — JSON | `conversations.session_state` JSONB |
| Chat Transcript / Last Message / Last Bot Reply | Used | messages table + summary fields |
| Needs Human | Critical | `conversations.needs_human` |
| Status | Critical — Open, etc. | `conversations.status` |
| Current Hold ID | Critical | `conversations.current_hold_booking_id` |
| Conversation Stage | Critical | `conversations.conversation_stage` |
| Bot Mode | Critical | `conversations.bot_mode` |
| Conversation Summary | Critical | `conversations.conversation_summary` |
| Pending Action | Used | `conversations.pending_action` |
| Staff Reply Draft / Send Staff Reply / Return To Bot | UI triggers | workflow flags → Postgres + sheet |
| Human Notes / Internal Staff Notes | Staff | text fields |
| Messages | Link | `messages.conversation_id` |

---

## Messages (`tbl3oMbUtrUr0XWLt`)

| Field | Usage | Postgres |
|-------|-------|----------|
| Conversation Phone | Critical | FK via phone |
| Direction | Critical | `messages.direction` |
| Message Text | Critical | `messages.message_text` |
| Message Type / Route / Language | Used | metadata |
| WhatsApp Message ID | Critical | `messages.whatsapp_message_id` |
| Created At | Critical | `messages.created_at` |
| Source | Critical — whatsapp / staff | `messages.source` |
| Conversation | Link | FK |
| Conversation Stage | Used | snapshot |
| Chat Line / Chat Time / Chat Display | Used — transcript formatting | optional |

---

## Operator Room Release Request (`tblWslWOfwbgoQGZy`)

| Field | Usage | Postgres |
|-------|-------|----------|
| Request ID | Display | `operator_room_release_requests.request_code` |
| Operator | Critical | `operator_name` |
| Room to Release | Critical | `room_id` |
| Release Start Date / Release End Date | Critical | date range |
| Status | Critical | enum |
| Room ID | Critical | denormalized |
| Notes | Optional | text |
| Original Booking / New Booking A / New Booking B | Critical — workflow output | FKs |
| Error Notes | Critical | `error_notes` |

---

## Manual Entries (Google Sheet — not Airtable)

Mapped in `manual_entries` table (see schema). Columns from Apps Script:

`Manual Entry ID`, `Created At`, `Created By`, `Guest Name`, `Package`, `Deposit Paid`, `Phone`, `Email`, `Check In`, `Check Out`, `Guest Count`, `Room / Bed`, `Status`, `Payment Status`, `Notes`, `Sync Status`, `Airtable Booking ID`, `Error`

---

## Fields to clean up (recommended)

1. **Booking Beds:** `Status - OLD`, redundant payment lookup fields  
2. **Bookings:** `Booking Beds 2`, `Booking Beds 3`, `Expired` if status covers it  
3. **Payments:** move `Payment Link`, deposit/balance fields into `payments` table  
4. **Calendar_* ** on Bookings unless Ale/Cami use Google Calendar sync today  

---

## `airtable_record_id` preservation

Every migrated row should store the original Airtable record ID (e.g. `recXXXXXXXX`) in `airtable_record_id` for dual-run cutover and debugging.
