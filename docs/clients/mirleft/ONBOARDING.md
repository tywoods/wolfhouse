# Mirleft — Onboarding

New client coming onto Luna Front Desk.
- `client_slug`: `mirleft`
- Location: `mirleft-main` (display: **Mirleft**)
- `live_enabled`: **false** (stays false until the go-live checklist passes)

This is a discovery questionnaire — answers drive the Mirleft config, runtime,
and a future `docs/clients/mirleft/GO-LIVE-CHECKLIST.md`. See
`docs/MULTICLIENT-ARCHITECTURE.md` for how clients/locations/runtimes work.

## 1. Business type
- [ ] What is Mirleft? (surf house / hostel / surf school / rentals / mix?)
- [ ] Lodging, lessons, rentals, or a combination?
- [ ] Who are the guests (languages, typical stay length)?

## 2. Locations
- [ ] Single site (`mirleft-main`) or multiple sites/branches?
- [ ] If multiple, list each with a desired `location_id` + display name.

## 3. Services
- [ ] What does Luna need to offer/book (rooms/beds, lessons, courses, rentals, transfers, experiences)?
- [ ] Per-location differences in services?

## 4. Prices / packages
- [ ] Price list (accommodation, lessons, courses, rentals, add-ons) with units.
- [ ] Packages/bundles and their durations.
- [ ] Deposit amount/policy; currency.

## 5. Languages
- [ ] Which languages should Luna speak (en/es/fr/…)?
- [ ] Primary guest language?

## 6. WhatsApp number
- [ ] Dedicated WhatsApp number for Mirleft? (Meta Cloud API)
- [ ] Meta `phone_number_id` (for inbound routing) once provisioned.

## 7. Email inbox
- [ ] Guest-facing email inbox address for Mirleft?
- [ ] Should Luna handle email as well as WhatsApp?

## 8. Stripe account
- [ ] Mirleft's own Stripe account (required — no shared default).
- [ ] Currency, payout details, webhook access.

## 9. Staff users
- [ ] Owner email(s) (full admin / owner insights).
- [ ] Staff emails + their access level.
- [ ] Staff/owner WhatsApp numbers for Luna recognition.

## 10. Booking / inventory source
- [ ] Where does availability/inventory live (Luna DB, external PMS, spreadsheet)?
- [ ] Source of truth for bookings + payments.

## 11. Cancellation / deposit policy
- [ ] Deposit required to hold a booking? amount?
- [ ] Cancellation/refund rules Luna should communicate.

## 12. Portal needs
- [ ] Which staff portal sections does Mirleft need (calendar, inbox, services/courses, prices, owner insights, staff numbers, general notes)?
- [ ] Any Mirleft-specific admin needs not covered by the existing portal?

---

**Next step after answers:** create `config` entries + a Mirleft staging runtime,
then draft `docs/clients/mirleft/GO-LIVE-CHECKLIST.md`. Keep `live_enabled=false`
until that checklist passes.
