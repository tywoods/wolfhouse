# Phase 26g.1 — Booking Drawer Tab Polish + Overview Cards

**Status:** IMPLEMENTED

## Tab styling

Drawer tabs use a pill-style bar with larger labels (~14px), generous padding, soft beige inactive backgrounds, and a cream active state with tan border accent. Hover and focus-visible states match Staff Portal palette.

Labels unchanged: **Overview**, **Services**, **Transfers**, **Payments**.

## No scroll jump on tab switch

Tab controls are `<button type="button">` elements (not anchor links). Tab switching:

- Uses `mousedown` + `click` `preventDefault()` to avoid focus-driven scroll
- Preserves `window` and `#bc-ctx-body` scroll positions after panel swap
- Does not reload drawer content or navigate

## Overview cards

Overview content is grouped into subtle beige/tan cards:

1. **Booking details** — contact, dates, guests, package, room/bed assignment
2. **Payment summary** — invoice total, paid, balance, status + note pointing to Payments tab
3. **Move bed** — assignment pills, target dropdown, Move Bed button
4. **Conversation / Handoff** — mode, handoff metadata

Cancel reservation and conversation action buttons remain on the neutral white footer below the cards.

## Tab content placement (unchanged)

| Tab | Contents |
|-----|----------|
| Overview | Brief payment summary + cards above |
| Services | Stage 26g package card, schedule, unscheduled, add/remove controls |
| Transfers | Flight / Transfer Details |
| Payments | Full running invoice and payment actions |

## Safety

- UI/CSS/JS polish only
- No DB schema changes
- No service scheduling writes
- No payment writes, Stripe, WhatsApp, Meta, n8n, or guest AI intake
