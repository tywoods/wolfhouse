# Phase 26h.6 — Service pebbles, transfer layout polish, payment link enablement

Small Staff Portal UI/data polish before Stage 26 closeout. No DB schema changes, no payment row writes except existing manual payment-link route, no WhatsApp/Meta/n8n/guest AI.

## Payment link testing on staging

Both flags are required for the Payments tab **Generate Payment Link** button:

| Env | Purpose |
|-----|---------|
| `STAFF_ACTIONS_ENABLED=true` | Staff write actions (add service, schedule, transfers, payment link) |
| `STRIPE_LINKS_ENABLED=true` | Stripe Checkout link creation (default **false**) |

When `STRIPE_LINKS_ENABLED=false`, the drawer shows a disabled hint and the API returns `Stripe link creation is disabled. Set STRIPE_LINKS_ENABLED=true to enable.`

Staging proof uses **test Stripe** config only. Keep `WHATSAPP_DRY_RUN=true`. Do not enable live WhatsApp.

## Service label cleanup

Removed from service pebbles and the **Paid / requested services** summary:

- `not requested` / `requested` raw status pairs
- Noisy internal status text

Pebbles show **name · unit price** (e.g. `Yoga · €15.00`). Summary can still aggregate quantity (e.g. `Yoga ×3 · €45.00`).

## Service color coding (CSS classes)

| Service | Class |
|---------|-------|
| Board / surfboard / soft or hard board | `bc-svc-color-board` (blue) |
| Wetsuit | `bc-svc-color-wetsuit` (grey) |
| Yoga | `bc-svc-color-yoga` (purple) |
| Meal / meals | `bc-svc-color-meal` (green) |
| Surf lesson / lesson | `bc-svc-color-lesson` (orange/yellow) |
| Fallback | `bc-svc-color-neutral` |

## Quantity >1 → schedulable units

**Add flow:** `POST /staff/bookings/add-service` inserts **N rows** with `quantity=1` each when quantity >1. Each row gets `amount_due_cents = unit_cents`. Idempotency keys use `-unit-1`, `-unit-2`, … suffixes.

**Existing rows:** `GET /staff/bookings/:id/services` auto-splits `quantity > 1` rows with `amount_paid_cents = 0` into individual records before building the schedule. Rows with payments applied are **not** split (avoids invoice drift).

Scheduling/unscheduling operates on a single `service_record_id`, so one Yoga unit moves independently.

## Transfer Exception Override layout

Both arrival and departure cards use a two-column layout:

- **Left:** Airport, Transfer date/time, small Exception Override under date/time, amount input under the button when expanded
- **Right:** Flight number, Notes
- **Footer:** Lookup flight, Save, Remove (bottom-right)

Override maps to `price_cents`, `included_in_package=false`, `pricing_note=Manual transfer override`. No payment records created.

## Safety

- No WhatsApp sends, Meta webhooks, n8n, or guest AI intake
- No Stripe business-logic changes beyond respecting existing flags
- No new payment rows from service split or transfer override

## Verifier

```bash
npm run verify:luna-agent-phase26-service-pebbles-transfer-payment-polish
```
