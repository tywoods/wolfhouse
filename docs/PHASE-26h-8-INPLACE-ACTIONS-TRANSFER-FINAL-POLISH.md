# Phase 26h.8 — In-place tab actions + transfer final polish

Final Stage 26 UI/business-rule polish before closeout.

## In-place action priority

Tab actions prefer updating local UI state from API responses. When a full response is insufficient, only the affected tab/section is refreshed. Full drawer reload is avoided for Services, Payments, and Transfers actions.

Helpers:

- `bcActiveDrawerTab` — tracks the active drawer tab
- `bcRestoreActiveDrawerTab(tabId)` — restores tab after partial refresh
- `bcRefreshServicesTabAfterMutation(bk)` — refreshes Services schedule + add-on controls only
- `bcApplyServicesScheduleData(bk, data)` — in-place schedule update after schedule/unschedule
- `bcRefreshPaymentsTab(bk)` — refreshes Payments panel + Overview payment summary
- `bcTransferEnsureRemoveButton(direction, transfer)` — shows remove button after save without reload
- `bcRefreshTransferPebbleSummary()` — updates header transfer pebble from local transfer state

If `loadBlockDetail()` runs (e.g. Overview field edits, manual Refresh), it preserves `bcActiveDrawerTab` unless `preserveTab: false`.

## Active tab preserved after tab actions

| Action | Stays on |
|--------|----------|
| Add/remove service | Services |
| Schedule/unschedule service | Services |
| Generate payment link | Payments |
| Record cash payment | Payments |
| Cancel payment link | Payments |
| Save/remove transfer | Transfers |
| Lookup flight / Exception Override toggle | Transfers |

## No package option

Overview package edit includes **No package** (`no_package` → `NULL` in DB). Display labels: Uluwatu, Malibu, Waimea, No package.

## Transfer default date/time

Empty transfer forms default:

- **Arrival:** check-in date at `09:00` (`defaults.arrival_scheduled_at_local`)
- **Departure:** check-out date at `12:00` (`defaults.departure_scheduled_at_local`)

Saved `scheduled_at_local` wins over defaults. Dates use booking date-safe normalization (no UTC one-day shift).

## Remove button labels and live behavior

- **Remove Arrival Transfer**
- **Remove Departure Transfer**

After save, remove button appears immediately via `bcTransferEnsureRemoveButton`. After remove, button disappears and form resets to defaults.

## Header transfer pebble wording

Drawer header purple pebble:

- `Transfer: Arrival`
- `Transfer: Departure`
- `Transfer: Arrival + Departure`

Not used: `Transfer Required`, `Transfer saved`. Calendar block pebble remains simply **Transfer**.

## Transfer Charge UI

Label: **Transfer Charge** (title case). Amount input uses compact `.bc-transfer-override-amount` class. Exception Override stays under date/time; Notes on the right column.

## Bilbao under-4 override rule

Bilbao transfer normally requires groups of 4+. When `guest_count < 4` and airport is Bilbao:

- Block save unless Exception Override is checked with a Transfer Charge amount
- Error: *Bilbao transfer is normally available for groups of 4 or more. Use Exception Override to save a manual exception.*

With override + amount: save succeeds with `included_in_package=false`, manual pricing note, no payment rows.

Santander behavior unchanged.

## Safety — no side effects

- No DB schema changes
- No payment writes from transfer save/override
- No Stripe code changes
- No WhatsApp sends
- No Meta webhook / n8n / guest AI intake changes

## Staging flags (hosted proof)

```
STAFF_ACTIONS_ENABLED=true
STRIPE_LINKS_ENABLED=true
WHATSAPP_DRY_RUN=true
```
