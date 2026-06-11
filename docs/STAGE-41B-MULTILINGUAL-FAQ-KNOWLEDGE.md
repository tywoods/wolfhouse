# Stage 41b — Multilingual Wolfhouse FAQ Knowledge

Expansion of Stage 41a knowledge config with EN/IT/ES/DE FAQ answers and broader category coverage.

---

## Categories expanded (17 + legacy alias)

| Category | Coverage |
|----------|----------|
| location | Somo, maps link, surf-house vibe |
| checkin_checkout | Times from baseline (15:00 / 11:00), gate private |
| towels_sheets | Sheets yes, towels no |
| packing | Full packing list |
| wetsuit_info | Lessons wetsuit, 4/3 or 3/2 |
| rentals_info | Board/wetsuit add to booking |
| lesson_times | 08:30 / 09:00–11:00, 10:30 / 11:00–13:00, low season |
| yoga_info | Request/add; staff confirms schedule |
| meals_dinner | Dinners; staff confirms; checkout |
| transfer_how | Airport/flight/passengers; staff confirms pickup |
| payments_info | Deposit/full, balance cash/bank/Stripe |
| house_rules | Fridge labels, board rinse, shared house |
| board_care | Rinse + storage |
| rooms_beds | Room label after booking; no bed numbers |
| local_area | Somo vibe; restaurant tips staff-confirmed |
| gate_code | **Private** — multilingual refusal pre-booking |
| yoga_meals_info | Legacy 41a alias |

---

## Multilingual coverage

**EN / IT / ES / DE templates** for:

- location, towels_sheets, wetsuit_info, lesson_times, transfer_how, payments_info, yoga_info, meals_dinner, gate_code, board_care, packing, checkin_checkout, house_rules, rooms_beds, local_area, rentals_info

**Language detection:** message-text heuristics + router `detected_language` fallback.

**Localized mid-booking tails:** IT/ES/DE return-to-booking prompts after FAQ side-questions.

---

## Source / verification limitations

- **wolf-house.com:** not scraped — `website_source_status: partial` in config meta
- **local_area restaurants/bars:** general Somo vibe only; specific venues deferred to staff
- **Rental deposits:** omitted unless already in pricing config — staff confirms
- **No Stormglass / surf API / vector search / scraper**

---

## Public vs private guardrails

| Public | Private |
|--------|---------|
| Maps, packing, lessons rhythm, transfers process, payments overview | Gate code (`2684#` never in public FAQ) |
| Towels/sheets, board care, house rules | Room label only after booking context |
| Yoga/meals “can add, staff confirms” | Bed number never in guest copy |

Verifier + fixtures assert no `2684#` in pre-confirmation FAQ replies.

---

## Sample answers

**IT towels:** “Piccola nota valigia 😊 Le lenzuola le diamo noi, ma gli asciugamani no…”

**ES cash:** “Sí 😊 El resto se puede pagar a la llegada en efectivo, transferencia bancaria o Stripe…”

**DE lessons:** “Die Surfkurse laufen meistens morgens in zwei Gruppen 🌊 … Die genaue Gruppe bestätigt das Team später.”

**IT gate (private):** “Il codice del cancello arriva con la prenotazione confermata…” — no code leaked

---

## Fixtures (20 FAQ total)

**Stage 41b (12/12 PASS):**

- faq-it-towels-sheets, faq-it-wetsuit, faq-it-lesson-times
- faq-es-payment-cash, faq-es-transfer, faq-es-packing
- faq-de-towels-sheets, faq-de-lesson-times, faq-de-payment-cash
- faq-mid-booking-it-wetsuit-preserves-context
- faq-mid-booking-es-transfer-preserves-context
- faq-private-gate-code-multilingual

**Stage 41a (8/8 PASS):** unchanged

---

## Regression

| Suite | Result |
|-------|--------|
| verify:stage41b | PASS (68/68) |
| verify:stage41a | PASS (50/50) |
| booking-core | 26/26 PASS |
| hammer 40402 | 81 / 16 / 3 (unchanged) |
| multilingual-out-of-order | 11 PASS / 1 PARTIAL |

---

## Remaining FAQ gaps

- French FAQ copy (FR booking flow exists; FAQ templates not yet localized)
- wolf-house.com curated FAQ import (Stage 41c candidate)
- Detailed house rules from website
- Verified restaurant/bar list for local_area
- Live surf conditions (Stage 43a)

---

## Next stage

**Stage 43a — Client-facing Somo surf report**

Text-only positive conditions report from Stormglass when ready — no hard safety calls in guest copy.
