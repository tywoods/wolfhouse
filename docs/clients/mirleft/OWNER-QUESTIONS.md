# Mirleft Surf Camp — Owner confirmation checklist (Slice 2 planning)

**Purpose:** collect real inventory and owner-confirmed rules before any Mirleft runtime, SOUL, or live channel work.
**Audience:** Mirleft owners (Bohcin / Abdel) and Luna Front Desk operators.
**Status:** planning only — no deploy, no config runtime edits, no SOUL in this slice.

Related: [`ONBOARDING.md`](ONBOARDING.md) · discovery baseline `config/clients/mirleft.baseline.json` (when merged) · website seed https://mirleftsurfcamp.wordpress.com/

Mark each item **Confirmed** / **Changed** / **TODO**, and write the answer in the blank.

---

## 1. Rooms and capacity

Fill one row per real room (replace any placeholder map).

| Room name / number | Beds | Type (private / double / twin / shared / other) | Notes |
|--------------------|------|--------------------------------------------------|-------|
| | | | |
| | | | |
| | | | |
| | | | |
| | | | |

- [ ] Room list is complete for Inna Guest House / Mirleft Surf Camp
- [ ] Max guest capacity (whole property): _______________
- [ ] Max guests per room rules (if any): _______________
- [ ] Any rooms staff-only / not guest-assignable: _______________

## 2. Availability confirmation

When a guest asks for dates, Luna should:

- [ ] Confirm availability from Luna inventory alone (auto-confirm when free)
- [ ] Always request staff confirmation before promising a room
- [ ] Hybrid: auto for some cases, staff for others — describe: _______________

Staff contact for availability questions (name / channel, not secrets): _______________

## 3. Package prices and inclusions

Website seeds are **unverified** until you confirm. For each package: final price (EUR), inclusions, exclusions.

| Package | Final price | Inclusions OK? | Changes |
|---------|-------------|----------------|---------|
| Let's Do This | €_______ / person | Y / N | |
| Surf Guiding | €_______ / person | Y / N | |
| No Airport Transfer Surf | €_______ / person | Y / N | |
| Family Surf | bespoke / €_______ | Y / N | |

- [ ] 6-day fixed packages confirmed
- [ ] Travel insurance excluded (or change): _______________
- [ ] Other packages to add/remove: _______________

## 4. Custom stay pricing

- [ ] Custom stays allowed (non-6-day): Y / N
- [ ] How to price custom stays (per night, prorate package, handoff only, other): _______________
- [ ] Minimum stay (discovery said none — confirm): _______________
- [ ] Closed dates / seasons (discovery said none — confirm): _______________

## 5. Lessons, rentals, schedules

| Offering | Final price | Capacity / day | Schedule / notes |
|----------|-------------|----------------|------------------|
| First Steps lesson | €_______ | | |
| Daily Package lesson | €_______ | | |
| Board / wetsuit rental (if sold alone) | €_______ | | |
| Other: _______________ | €_______ | | |

- [ ] Lesson group sizes / instructor limits: _______________
- [ ] Daily prep needs (what staff must see each morning): _______________

## 6. Transfers and extras

| Offering | Final price | Notes |
|----------|-------------|-------|
| Agadir airport one way | €_______ | |
| Pickup + dropoff | €_______ | |
| Extras / adventures (list any fixed prices) | | |

## 7. Deposit and cancellation

- [ ] Deposit required? Y / N — amount / rule: _______________
- [ ] Deposit per booking or per person: _______________
- [ ] Cancellation / refund rules Luna may tell guests: _______________
- [ ] Date-change rules: _______________

## 8. Payment link flow (after confirmation)

Agreed product direction (confirm or correct):

- [ ] Booking can be **confirmed without payment**
- [ ] After confirmation, guest may optionally pay **deposit** or **full** via payment link
- [ ] Guest must **not** be forced to pay before confirmation
- [ ] Balance at arrival: cash (EUR / MAD) / card / other: _______________

Any exceptions (groups, peak dates, etc.): _______________

## 9. Stripe (later — no secrets here)

Do **not** put API keys, webhook secrets, or account passwords in this doc or in git.

When ready to migrate Stripe, operators will need (share out-of-band / secrets store only):

- [ ] Mirleft has (or will have) its **own** Stripe account (not shared with Wolfhouse)
- [ ] Account holder / business name on Stripe: _______________
- [ ] Currency for payment links: EUR (confirm): _______________
- [ ] Who can invite operators to the Stripe dashboard: _______________
- [ ] Test-mode access available for staging: Y / N

## 10. WhatsApp / Meta (later)

Do **not** put live Meta tokens or real `phone_number_id` values in this doc.

- [ ] Final Luna WhatsApp number (when known): _______________
- [ ] Public site phone `+212 678-551932` is **not** the Luna number (confirm): Y / N
- [ ] Meta Business / WABA ownership contact: _______________
- [ ] Preferred languages for first Luna replies: _______________

## 11. Email

- [ ] Guest email inbox Luna should use (if any): _______________
- [ ] Current contact `mirleftsurfcamp@gmail.com` — Luna should: ignore / notify staff only / auto-reply later
- [ ] Email auto-reply expected in staging: Y / N / later

## 12. Booking form fields

Collect (tick what Luna / staff forms should require):

- [ ] Guest name(s)
- [ ] Dates (arrival / departure)
- [ ] Guest count
- [ ] Package or custom stay choice
- [ ] Room type preference (private / double / twin / shared)
- [ ] Contact phone / email
- [ ] Airport transfer needed
- [ ] Other: _______________

**Explicitly excluded:**

- [x] Equipment sizes (board size, wetsuit size, etc.) — **do not** collect as required booking fields

Optional notes on equipment (info only, never required): _______________

---

## Sign-off

| | Name | Date |
|---|------|------|
| Owner confirmed inventory + prices | | |
| Operator recorded answers into config (later slice) | | |

**Next after this checklist:** replace placeholder rooming in Mirleft baseline, flip website prices from `unverified_seed` to owner-confirmed values, then plan isolated staging / channels (still no live guest traffic until go-live gates pass).
