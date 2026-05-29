# During-Stay Service Add-ons Plan

**Status:** Plan — docs only (Stage 3x.2c, 2026-05-29). No runtime, no schema migration, no Staff UI yet.
**Related:** baseline config `config/clients/wolfhouse-somo.baseline.json` (`service_addons`) · [`STAFF-HANDOFF-PLAN.md`](STAFF-HANDOFF-PLAN.md) · [`ROADMAP.md` § Engine portability](ROADMAP.md#engine-portability--adding-a-new-vertical-surf-shop--lessons)

---

## Requirement (owner)

Guests should be able to **text the bot during their stay** to add services, e.g.:

- **dinner / meal**
- **wetsuit rental**
- **surfboard rental**
- surf lesson
- (later) yoga, activities, photos

They should be able to specify a **number of days** (or sessions / quantity). The bot then **creates a Stripe payment link** for the add-on. After the guest pays, the add-on becomes a **paid voucher / confirmation** that the guest **shows to staff on-site to verify and redeem** (e.g. collect the wetsuit, sit down for dinner). We need to **track and display** these requests and their redemption.

This is the same booking spine (collect → quote → **Stripe link** → pay → confirm/voucher → handoff) applied to **add-ons against an existing booking**, and it maps directly to the future `rentals` / `slots` inventory providers from the portability plan — so building it well for Wolfhouse also advances the surf-shop / surf-school verticals.

---

## Data model (proposed — spec only, not yet in Postgres)

### `service_catalog`

| Field | Notes |
|-------|-------|
| `service_id` | PK |
| `name` | e.g. "Surfboard rental" |
| `type` | `rental` / `lesson` / `activity` / `meal` / `photo` |
| `pricing_unit` | `per_day` / `per_session` / `per_person` / `fixed` |
| `price` | owner_required |
| `requires_staff_approval` | bool |
| `inventory_limited` | bool (e.g. limited boards/wetsuits) |
| `fulfillment` | `onsite_redeem` (show voucher to staff) / `delivered` / `none` |
| `notes` | |

### `guest_service_requests`

| Field | Notes |
|-------|-------|
| `request_id` | PK |
| `booking_id` | Links to the active booking |
| `guest` / `customer` | Identity |
| `service_type` | From catalog |
| `start_date` / `end_date` | Window |
| `number_of_days` | Duration |
| `quantity` | Units |
| `price_estimate` | If config-known |
| `status` | `requested` / `needs_staff_approval` / `approved` / `payment_link_sent` / `paid` / `redeemed` / `cancelled` |
| `payment_status` | Reuses payment spine (Stripe webhook = truth) |
| `stripe_checkout_id` / `stripe_payment_intent_id` | Reuses payment isolation pattern |
| `voucher_code` | Short human-readable code shown to staff on-site |
| `redeemed_at` / `redeemed_by_staff` | Set when staff verify/fulfill on-site |
| `staff_notes` | |
| `created_from_conversation_id` | Provenance |

---

## Payment + on-site verification flow (owner requirement)

The happy path the owner described — guest pays via Stripe, then shows proof to staff to redeem:

1. Guest texts the bot: *"add a wetsuit for 3 days"* / *"dinner for 2 tonight"*.
2. Bot resolves the active booking, identifies the `service_type`, collects **number of days / quantity** (and date for dated items like dinner).
3. If the service is **priced in `service_catalog`** and inventory allows → bot computes `price_estimate` and **creates a Stripe payment link** (same isolated Checkout pattern proven in Phase 3d).
4. Guest pays → **Stripe webhook is the source of truth** (never the guest's word). Request → `paid`, a **`voucher_code`** is generated.
5. Bot sends the guest a confirmation with the voucher (and adds it to their booking record).
6. On-site, the guest **shows the voucher/confirmation to staff**, who **verify and redeem** it (request → `redeemed`, `redeemed_at` / `redeemed_by_staff` set). Staff hand over the wetsuit / seat them for dinner.

**Safety reuse:** this rides entirely on the already-proven payment spine — isolated Stripe Checkout creation, webhook payment truth, idempotency, and "bot never marks paid from LLM." No new payment-trust surface is invented; add-ons are just another thing the spine can charge for.

---

## Bot rules (safe behavior)

1. Bot **may collect** service type + dates/number-of-days + quantity.
2. If **price and inventory are known** and config allows → bot may **quote, create the Stripe link, and (on webhook-confirmed payment) issue a voucher** (reuse the proven Stripe link + webhook + confirmation spine).
3. If **price or inventory is unknown** → bot creates a **service request** and **hands off** to staff (never invents a price; see [`STAFF-HANDOFF-PLAN.md`](STAFF-HANDOFF-PLAN.md)).
4. **Redemption is a staff action**, not the bot's — the bot issues the voucher; staff mark it `redeemed` on-site. Bot never marks `redeemed` itself.
5. Track in **Staff UI / Airtable initially**, then a Postgres service table later.
6. Same dangerous-action discipline: no guessed prices, no LLM-only "paid", handoff on ambiguity.

---

## Pricing (3x.2e — provisional, operator-set)

Per-day / per-meal add-on prices (single easy-to-edit fields; safe for dry-run/shadow, live charge needs `pricing_status = confirmed`):

- **Surf lesson:** €25/day
- **Surfboard:** €20/day
- **Wetsuit:** €20/day
- **Surfboard + wetsuit:** €40/day (**no bundle discount** — rates just stack)
- **Dinner:** €15 per person/meal

**Add-on days are capped by the guest's free days remaining** in their booking. Add-on prices also feed non-7-night quotes (accommodation prorated + add-ons per day).

**Dinners & yoga:** bookable during the stay; the guest **shows the booking message / payment confirmation to staff** (dinner: when collecting food; yoga: to Cami before the class) — same voucher/redeem model. Yoga price still owner_required.

## Still pending Ale/Cami

- **Yoga** class price (now bookable like dinners; price needed to enable auto-quote).
- How **lessons are scheduled and tracked** (slots, instructors, capacity).
- **Bad weather / no-waves:** refund possible but **staff does it manually** (confirmed); confirm any credit/reschedule alternative.

---

## Stage placement

| Work | Stage |
|------|-------|
| This plan + config stub (`service_addons`) | **3x.2c (now)** — done |
| Owner answers → fill `service_catalog` prices/rules (wetsuit, surfboard, dinner, lesson) | 3x.2 / 3x.3 |
| Collect + handoff (no auto-pay) for add-ons | Stage 3y (shadow) / Stage 4 |
| Auto quote + **Stripe link** + voucher for config-known services | Stage 4–5 (reuses payment spine + `rentals`/`slots` provider) |
| Voucher issue + **staff on-site redemption** | Stage 4 (staff action) → Stage 6 (Inbox button) |
| `service_catalog` / `guest_service_requests` Postgres tables | Stage 5 (with schema migration) |
| Staff UI display + redeem of requests | Stage 6 |

**Do not** implement runtime, schema, or auto-pricing until owner prices/rules exist and the relevant stage is reached. The Stripe-link step reuses the existing proven payment workflows — it is **not** a new payment integration.
