# Stage 41a — Somo/Wolfhouse Knowledge Config

Structured guest FAQ knowledge for Luna dry-run replies — grounded facts only, no live surf API.

---

## Config path

`config/clients/wolfhouse-somo.knowledge.json`

Helper: `scripts/lib/luna-guest-knowledge-config.js`

Wired via:
- `scripts/lib/luna-guest-message-router.js` — FAQ intent → `general_question` (no handoff)
- `scripts/lib/luna-guest-reply-composer.js` — `explain_house_knowledge` composer state
- `scripts/lib/luna-booking-state-transitions.js` — FAQ does not stale active quote
- `scripts/lib/luna-guest-context-merge.js` — mid-booking FAQ preserves chain

---

## Supported categories

| Category | Topics |
|----------|--------|
| location | Somo, maps link, beach proximity |
| towels_sheets | Sheets provided, towels not |
| packing | What to bring |
| wetsuit_info | Lesson wetsuits, 4/3 or 3/2 |
| lesson_times | 08:30 / 09:00–11:00, 10:30 / 11:00–13:00 |
| rentals_info | Board/wetsuit rental overview |
| payments_info | Deposit/full, balance on arrival |
| transfer_how | Airport transfer process (staff confirms) |
| yoga_meals_info | Request/add; staff schedules |
| board_care | Rinse + board storage |
| house_rules | Fridge labels, basics |
| checkin_checkout | General check-in/out guidance |
| gate_code | **Private** — confirmation path only |

---

## Public vs private rules

**Public (any guest):**
- Location / Google Maps link
- Towels, sheets, packing, wetsuit guidance
- Lesson rhythm (not exact group assignment)
- Transfer process (not confirmed driver)
- Board care, house basics
- Payment overview

**Private (confirmed booking / confirmation path only):**
- Gate code (`2684#` never in general FAQ)
- Room label (after hold/confirmation context)
- Bed number — never exposed

**Never invent:**
- Exact transfer pickup, lesson group, yoga/dinner times, live surf conditions

If unsure → answer generally + staff will confirm.

---

## Example answers (Cami tone)

**Towels:** “Tiny packing note 😊 We provide sheets, but not towels — so bring one for the shower and one for the beach if you can.”

**Wetsuit:** “For lessons we can sort you with a wetsuit 🌊 If you have your own, bring it too. Around here 4/3 or 3/2 is usually the safe call depending on the season.”

**Lessons:** “Most mornings we run two surf lesson groups: one leaves Wolfhouse around 08:30 for 09:00–11:00, and the second leaves around 10:30 for 11:00–13:00. The exact group gets confirmed closer to the day.”

**Location:** “We're in Somo 🌊 Here's the location: https://maps.app.goo.gl/oPRckhqozVBvXxL16”

**Gate code (pre-booking):** “The gate code comes with your confirmed booking/check-in info once the stay is locked in 🔒 …”

---

## Fixtures (8/8 PASS)

- faq-location-public
- faq-towels-sheets
- faq-wetsuit
- faq-lesson-times
- faq-transfer-how-it-works
- faq-gate-code-private
- faq-mid-booking-preserves-context
- faq-board-care

---

## Intentionally not included yet

- Live surf report / Stormglass API (**Stage 43a**)
- Website scraper / wolf-house.com FAQ expansion (**Stage 41b**)
- Vector search
- Owner-chat knowledge upload
- Multilingual FAQ copy (English-first in 41a)
- Service pay-now links

---

## Regression (unchanged)

- booking-core: 26/26 PASS
- hammer 40402: 81 PASS / 16 PARTIAL / 3 FAIL (unchanged from 40e)
- Stage 40e + 37b verifiers: PASS

---

## Next stages

1. **Stage 41b** — Expand FAQ from wolf-house.com / house rules; multilingual FAQ answers
2. **Stage 43a** — Client-facing surf report (Stormglass)
