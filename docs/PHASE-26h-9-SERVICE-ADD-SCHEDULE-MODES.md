# Phase 26h.9 — Service add scheduling modes + totals

Final Services tab polish before staging deploy.

## Total services line

Under **Paid / Requested services** in the Services tab summary card:

- Horizontal separator below the service list
- **Total services** line summing only `booking_service_records` amounts in that list
- Excludes accommodation, package prorate, package price, and transfer charges
- Uses cents-based totals; respects quantity/unitized rows

## Add service — Service Date label

- Visible label is **Service Date** (not “Add-on date”)
- In **Span Across Booking** mode the label becomes **Start Date**

## Scheduling modes

Two links under the date field:

### Schedule Later

- Hides the date field
- Creates unit rows with `service_date = null`
- Services appear in **Unscheduled services**
- Quantity >1 still creates individual qty=1 unit rows

### Span Across Booking

- Uses **Start Date** as the first scheduling day
- Distributes quantity across remaining stay dates (through check-out − 1)
- Distribution rules:
  - If `quantity === guest_count × days`: `guest_count` units per day
  - If `quantity < days`: one unit per day from Start Date until quantity is used
  - Otherwise: even spread with remainder filled on earlier dates first
- Blocks when `quantity > days × guest_count` from Start Date with:
  *Not enough stay dates from this start date. Choose an earlier start date or Schedule Later.*
- All rows remain qty=1 unit records; no payment rows

## Naming / color polish

- Visible label **Meal** (internal `meals` code unchanged)
- Soft board / Soft top: teal (`bc-svc-color-softboard`)
- Hard board / surfboard: blue (`bc-svc-color-board`)
- Wetsuit grey, Yoga purple, Meal green, Surf lesson orange/yellow

## Tab preservation

Add service success uses tab-only Services refresh (`bcRefreshServicesTabAfterMutation`); drawer stays on Services.

## Safety

- No DB schema changes
- No payment writes from add service / span / schedule later
- No Stripe / WhatsApp / Meta / n8n / guest AI changes
