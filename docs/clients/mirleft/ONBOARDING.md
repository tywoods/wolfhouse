# Mirleft Surf Camp — Tenant discovery (signed client)

**Status:** signed real Luna Front Desk client — **config / discovery only**.
**Not live.** No Meta, Stripe, email, or guest/payment runtime wiring in this slice.
**Not a Wolfhouse fork** — Mirleft is its own tenant on the shared Luna Front Desk platform.

| Field | Value |
|-------|--------|
| `client_slug` | `mirleft` |
| `location_id` | `mirleft-main` |
| Display (client) | **Mirleft Surf Camp** |
| Display (location) | **Mirleft** |
| `live_enabled` | **false** (stays false until a go-live checklist passes) |
| Registry | [`config/clients/clients.json`](../../../config/clients/clients.json) |
| Baseline | [`config/clients/mirleft.baseline.json`](../../../config/clients/mirleft.baseline.json) |
| Architecture | [`docs/MULTICLIENT-ARCHITECTURE.md`](../../MULTICLIENT-ARCHITECTURE.md) |

## Business facts

- **Business name:** Mirleft Surf Camp
- **Type:** accommodation + surf camp + surf school / rental / adventures
- **Location:** Mirleft, Morocco
- **Address:** Ctre De Santé Mirleft, Mirleft, Morocco
- **Property (website):** Inna Guest House / riad — en-suite rooms, shared lounge, kitchen, terraces, BBQ, courtyard, 24h front desk, free parking, free WiFi; self-catering / B&B / full board possible; ~5 min walk to Atlantic
- **Founders:** Bohcin and Abdel (founded 2017)
- **Open:** 365 days/year; arrivals / check-ins all days; no minimum stay; no closed dates
- **Languages:** English, French, Spanish, Arabic
- **Currency:** EUR primary; MAD accepted in cash
- **Public contact (not Luna channels):**
  - Website: https://mirleftsurfcamp.wordpress.com/
  - Email: mirleftsurfcamp@gmail.com (contact only for now)
  - Public phone on site: `+212 678-551932` — **not** the final Luna WhatsApp number

## Channels (all deferred)

| Channel | Status |
|---------|--------|
| New WhatsApp number for Luna | **TODO** (coming later) |
| Meta Cloud API (`phone_number_id`, WABA) | **TODO** — not provisioned |
| Email ingress / auto-reply | **Later** — not wired |
| Staging auto-reply | **Later** — isolated Mirleft staging required first |

Sample routing IDs in `config/clients/channel-routing.sample.json` are **fake** (`*_SAMPLE` only). Never commit real Meta IDs.

## Payment policy

- Payment links **desired** (Stripe account to be migrated later).
- Payment is **not** required before booking confirmation (`payment_required_before_confirmation: false` in baseline).
- Guest must not be forced to pay before confirmation.
- Final Stripe account: **TODO**.

## Portal target

**Hybrid** (not wired yet):

1. **Accommodation calendar** — stays / rooms (separate from daily ops).
2. **Daily prep board** — lessons, rentals, transfers, adventures for the day.

Portal code today is still binary (lodging vs surf). Hybrid implementation is a later slice.

## Room inventory

**Wolfhouse-style placeholder only** in `mirleft.baseline.json` (`rooming.rooms` R1–R10).
Every room is marked `TODO_provisional_placeholder_until_real_inventory`.
**Do not** use for live assignment or quotes until real Inna Guest House inventory is collected.

## Booking fields

- Collect normal stay / package / guest details as needed.
- **Do not** collect equipment sizes (board/wetsuit size) as required booking fields.

## Website-seeded catalog (`pricing_status: unverified_seed`)

Source: https://mirleftsurfcamp.wordpress.com/ — provisional notes only; owner must confirm before live quotes.

### Main 6-day packages

| Package | Price | Notes |
|---------|-------|--------|
| Let's Do This Package | €750/person | 6 full surf days, min 24h lessons, 2 sessions/day, accommodation, Agadir airport transfer, beach transport, board/wetsuit, instructor, 3 meals/day, extras/tourist visits/sandboarding, towel/WiFi/water/tea/coffee/surf wax; travel insurance excluded |
| Surf Guiding Package | €750/person | 6 full surf days, independent surfers, private en-suite room, Agadir airport transfer, beach transport, board/wetsuit if needed, guide, up to 3 sessions/day, 3 meals/day, extras; travel insurance excluded |
| No Airport Transfer Surf Package | €650/person | 6 days, en-suite private room, surf spot transport, full board, equipment, private instructor/guide, one no-surf-day activity |
| Family Surf Package | bespoke quote | 6-day stay, airport transfers, one double + one twin en-suite room, full board, 5 days equipment hire, daily transport, 2 private instructors/guides, one no-surf-day activity |

Packages may be **6-day fixed** or **custom stays**.

### Lessons

| Offering | Price | Notes |
|----------|-------|--------|
| First Steps | €20/person | 2-hour lesson, ~1.5h water, board + wetsuit included |
| Daily Package | €50/person | 4-hour session, board + wetsuit + lunch included |

### Transfers

| Offering | Price |
|----------|-------|
| Agadir airport one way | €70 |
| Pickup + dropoff | €125 |

### Extras / adventures (website list; prices mostly TBD)

Fishing, motorbike/Mobylette, quad biking, horse riding, paragliding, beach parties, private dinners, yoga, dune surfing/sandboarding, 3-hour cooking experience, city trips.

### Equipment (info only; not required booking fields)

Soft boards, NSP mini-mals, shortboards, longboards, bodyboards, swimfins, wetsuits, ponchos, zinc, parasols, wax, leash, roof straps.

## Luna identity

Mirleft needs its **own** Luna identity / config later, separate from Wolfhouse Luna.
**No SOUL edits** in this slice.

## Verifier coverage (this slice)

| Check | Role |
|-------|------|
| JSON parse of `clients.json` + `mirleft.baseline.json` | Structural validity |
| `npm run verify:multiclient` | Registry isolation, no hardcoding, tenant resolution samples, Meta shadow samples, staff tenant scope |

**Verifier gap:** there is no Mirleft-specific baseline schema verifier (unlike Sunset portal slice verifiers). JSON parse + `verify:multiclient` is enough for this discovery slice. Do not invent a large runtime system here.

## Open questions / TODOs

1. Real room inventory (replace Wolfhouse-style placeholder).
2. Final Luna WhatsApp number + Meta Cloud API IDs.
3. Final Stripe account (migrate later).
4. Email ingress (`mirleftsurfcamp@gmail.com` is contact only for now).
5. Isolated Mirleft staging runtime (required later).
6. Hybrid portal implementation (accommodation calendar + daily prep board).
7. Separate Mirleft Luna identity / SOUL.
8. Owner confirmation of website prices (`unverified_seed` → `confirmed`).
9. Deposit amounts / cancellation policy.
10. Public phone `+212 678-551932` is **not** the final Luna number.

## Out of scope (this slice)

- Deploy
- Production env / secrets
- Meta / Stripe / email runtime wiring
- Luna SOUL edits
- Real guest or payment flows

## Next slices (later)

1. Collect real inventory + owner-confirmed prices.
2. Isolated Mirleft staging + channel credentials (secrets, not git).
3. Mirleft Luna identity / SOUL (tenant-specific).
4. Hybrid portal wiring.
5. Draft `docs/clients/mirleft/GO-LIVE-CHECKLIST.md`; keep `live_enabled=false` until it passes.
