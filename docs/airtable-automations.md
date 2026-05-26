# Airtable Automations (documented from screenshots)

**Base:** Wolfhouse (`appOCWIN47Bui9CSS`)  
**Screenshots:** `Screenshots/automations/`  
**Pattern:** Almost all operational automations are thin scripts that `POST` to n8n Cloud webhooks. Your hosted Airtable + n8n stay untouched until Azure cutover.

## Summary table

| # | Automation name | Trigger | Conditions | n8n webhook | Payload |
|---|-----------------|--------|------------|-------------|---------|
| 1 | Create Booking ID | Record created | Bookings table | *(none — Airtable only)* | Sets `Booking ID` = `WH-` + record id |
| 2 | Operator Room Release Request | Record created | Operator Room Release Request table | `operator-room-release` | `{ record_id }` |
| 3 | Assign Beds When Booking Is Unassigned | Record matches conditions | See below | `assign-beds-to-booking` | `{ record_id }` |
| 4 | Cancel Booking Beds When Booking Cancelled | Record matches conditions | Status = Cancelled AND Booking Beds not empty | `cancel-booking-beds` | `{ record_id }` |
| 5 | Update bed bookings when dates change | Record updated (Check In, Check Out) | See below | `reassign-booking-beds` | `{ record_id }` |
| 6 | Staff Reply Sent | Record matches conditions | See below | `send-staff-reply` | `{ recordId }` |
| 7 | Return Conversation To Bot | Record matches conditions | Return To Bot checked | `return-to-bot` | `{ recordId }` |
| 8 | Send Confirmation | Record matches conditions | Send Confirmation checked | `send-confirmation` | `{ record_id }` |

**Not in Airtable:** Sync Planning Sheet — n8n schedule every 30 minutes only.

---

## 1. Create Booking ID

| | |
|--|--|
| **Trigger** | When a record is **created** in **Bookings** |
| **Action** | Update record (same record) |
| **Field update** | `Booking ID` = `"WH-"` + Airtable record ID |

**Postgres migration:** Replace with `BEFORE INSERT` trigger or n8n/应用 logic: `booking_code = 'WH-' || replace(id::text, '-', '')` or use `airtable_record_id` during dual-write. Keep `WH-rec…` format for staff familiarity.

---

## 2. Operator Room Release Request

| | |
|--|--|
| **Trigger** | When a record is **created** in **Operator Room Release Request** |
| **Script** | POST `https://tywoods.app.n8n.cloud/webhook/operator-room-release` |

```javascript
body: JSON.stringify({ record_id: inputConfig.record_id })
```

**n8n workflow:** Wolfhouse - Operator Room Release

---

## 3. Assign Beds When Booking Is Unassigned

| | |
|--|--|
| **Trigger** | When a record **matches conditions** in **Bookings** |
| **All conditions** | |
| | Assignment Status = **Unassigned** |
| | Check In is not empty |
| | Check Out is not empty |
| | Status is **not** Cancelled |
| | Status is **not** Expired |
| | Availability Check Status = **Not Checked** *(Airtable label — map to `unknown` in Postgres)* |
| | Guest Count **>** 0 |

**Script:** POST `…/webhook/assign-beds-to-booking` with `{ record_id }`

**n8n workflow:** Wolfhouse - Bed Assignment

**Note:** Main assistant may set availability inline; this automation runs when booking is saved as Unassigned with dates filled.

---

## 4. Cancel Booking Beds When Booking Cancelled

| | |
|--|--|
| **Trigger** | When a record **matches conditions** in **Bookings** |
| **Conditions** | Status = **Cancelled** AND Booking Beds is **not empty** |
| **Script** | POST `…/webhook/cancel-booking-beds` with `{ record_id }` |

**n8n workflow:** Wolfhouse - Cancel Bed Assignments

---

## 5. Update bed bookings when dates change

| | |
|--|--|
| **Trigger** | When a record is **updated** in **Bookings** — fields watched: **Check In**, **Check Out** |
| **Conditional group** | Only if **all** true: |
| | Status is **not** Cancelled |
| | Assignment Status = **Assigned** |
| | Booking Beds length **>** 0 |
| **Description** | “Only run this date-change cleanup if this booking already has bed assignments” |
| **Script** | POST `…/webhook/reassign-booking-beds` with `{ record_id }` |

**n8n workflow:** Wolfhouse - Reassign Bed Assignments

---

## 6. Staff Reply Sent

| | |
|--|--|
| **Trigger** | When a record **matches conditions** in **Conversations** |
| **All conditions** | |
| | Send Staff Reply = **checked** |
| | Staff Reply Draft is **not empty** |
| | Phone is **not empty** |
| | Bot Mode = **human_active** |

**Script:** POST `…/webhook/send-staff-reply` with `{ recordId }` *(camelCase)*

**n8n workflow:** Wolfhouse Booking Assistant - Send Staff Reply

---

## 7. Return Conversation To Bot

| | |
|--|--|
| **Trigger** | When a record **matches conditions** in **Conversations** |
| **Condition** | Return To Bot = **checked** |
| **Script** | POST `…/webhook/return-to-bot` with `{ recordId }` |

**n8n workflow:** Wolfhouse Booking Assistant - Return Conversation To Bot

---

## 8. Send Confirmation

| | |
|--|--|
| **Trigger** | When a record **matches conditions** in **Bookings** |
| **Condition** | Send Confirmation = **checked** |
| **Script** | POST `…/webhook/send-confirmation` with `{ record_id }` |

**n8n workflow:** Wolfhouse - Send Confirmation (then searches bookings with Send Confirmation + Payment_Pending inside workflow)

**Future:** Stripe webhook sets `send_confirmation` and calls same n8n path — staff checkbox optional for manual bookings.

---

## Migration to Postgres (replacement options)

| Airtable automation | Phase 3+ replacement |
|---------------------|-------------------|
| Create Booking ID | DB default / insert trigger on `bookings` |
| Operator release | Insert on `operator_room_release_requests` → n8n webhook or queue |
| Assign beds | Booking insert/update when `assignment_status = unassigned` + dates → webhook |
| Cancel beds | `status` → cancelled → webhook |
| Date change | Update `check_in`/`check_out` when assigned → webhook |
| Staff reply | `conversations.send_staff_reply` flag → webhook |
| Return to bot | `conversations.return_to_bot` flag → webhook |
| Send confirmation | `bookings.send_confirmation` OR Stripe paid event → webhook |

During dual-write, you can keep Airtable automations on the **old** base and disable them on the **new** Azure stack only.
