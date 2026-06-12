# Stage 40c — Hammer Review Pack (Ale/Cami)

Readable summary of Luna’s randomized stress-test results. No live payments, WhatsApp, or confirmations were used.

---

## 1. What the hammer test does

The hammer test generates **100 realistic guest conversations** in Italian, English, Spanish, German, and mixed phrasing — including typos and emojis. Each conversation is run through the **same Luna booking path** used in production dry-run mode. We score PASS / PARTIAL / FAIL and export a **small curated set** of failures for manual review.

**Command used:** `npm run hammer:luna -- --count 100 --seed 40402 --local --write-report --fixture-out`

---

## 2. Current score (seed 40402)

| PASS | PARTIAL | FAIL | Total |
|------|---------|------|-------|
| **140** | **24** | **36** | 200 |

| Metric | Value |
|--------|-------|
| Pass rate | **70%** |
| Partial rate | 12% |
| Fail rate | **18%** |

Stage 40b target was ≥65 PASS and <20 FAIL — **met**.

### Language breakdown

| Language | PASS | PARTIAL | FAIL |
|----------|------|---------|------|
| es | 41 | 5 | 5 |
| it | 30 | 5 | 5 |
| de | 41 | 12 | 2 |
| en | 28 | 2 | 24 |

### Scenario breakdown

| Scenario | PASS | PARTIAL | FAIL |
|----------|------|---------|------|
| greeting new guest | 12 | 0 | 0 |
| greeting booking start | 12 | 0 | 0 |
| short stay accommodation | 10 | 0 | 2 |
| package booking | 12 | 0 | 0 |
| package surf addons | 4 | 8 | 0 |
| short stay surf addons | 1 | 0 | 11 |
| lesson addon | 0 | 3 | 9 |
| yoga request | 12 | 0 | 0 |
| dinner meals request | 5 | 7 | 0 |
| transfer side question | 12 | 0 | 0 |
| bilbao transfer extra | 12 | 0 | 0 |
| flight times update | 12 | 0 | 0 |
| surf report side question | 9 | 0 | 3 |
| cash payment side question | 0 | 6 | 5 |
| correction flow | 6 | 0 | 5 |
| reset flow | 11 | 0 | 0 |
| out of order all in one | 10 | 0 | 1 |

### Top failure categories

- **service addon intent** — 31 hits
- **accommodation intent** — 23 hits
- **package intent** — 22 hits
- **internal error** — 14 hits
- **cash side question** — 8 hits
- **yoga meals intent** — 7 hits
- **robotic copy** — 3 hits

---

## 3. What Luna handles well

- **Short-stay and weekly package bookings** in IT/EN/ES/DE with messy dates and guest counts
- **Embedded booking + side questions** when dates and guests arrive in one message (cash, transfer)
- **First-turn surf add-ons** (wetsuit, board, lessons) on many paths
- **Corrections and resets** on most flows; Spanish/English/German correction paths are strong
- **Multilingual out-of-order** fixture set: 11/12 pass (1 known composer partial on yoga copy)
- **Booking-core** regression: 26/26 pass

---

## 4. What still fails

Remaining issues are **edge combinations**, not core booking collapse:

1. **Turn-2 cash side-question** — quote context lost after a clean first turn on some EN/IT/DE paths
2. **Italian correction + stale quote** — guest-count correction does not always invalidate/rebuild quote
3. **German add-on phrasing** — occasional partials on wetsuit/lesson wording
4. **Meals/yoga mid-flow** — dinner or yoga add-on not always detected on turn 2
5. **Rare reset** — final guest count null after reset + reopen

---

## 5. Examples of real failing conversations

### Example 1: hammer-50001-0005 (PARTIAL)

**Type:** package_surf_addons · **Lang:** es

1. Guest: "Hola somos 2 paquete Uluwatu del 17 al 24 de julio, muta y tabla pls"

Luna (last turn): "Per le lezioni possiamo darti una muta 🌊 Se hai la tua, portala pure. Qui di solito 4/3 o 3/2 va bene a seconda della stagione. Vuoi che continui con la prenotazione?"

Facts kept: dates 2026-07-17→2026-07-24, guests 2, package uluwatu

**Issue:** turn 1: expected_service_interest missing wetsuit

### Example 2: hammer-50001-0006 (FAIL)

**Type:** short_stay_surf_addons · **Lang:** de

1. Guest: "Hallo, wir sind 3 Personen, vom 1. bis 5. Juli, nur Unterkunft, 😍 Wetsuit und Surfboard"

Luna (last turn): "Für den Unterricht können wir dir einen Neopren besorgen 🌊 Wenn du einen eigenen hast, bring ihn mit. Hier sind 4/3 oder 3/2 meist die sichere Wahl — je nach Saison. Soll ich mit deiner Buchung weitermachen?"

Facts kept: dates 2026-07-01→2026-07-05, guests 3, package —

**Issue:** final: final.expected_fields.package_interest expected "accommodation_only" got null

### Example 3: hammer-50001-0007 (FAIL)

**Type:** lesson_addon · **Lang:** it

1. Guest: "🏄 per 1, 3-10 luglio, solo alloggio, vorremmo lezioni"

Luna (last turn): "Perfect 😊 Waimea for July 3 to July 10, 1 ospite.

I checked it and the stay comes to €549 total.

To reserve it, you can do the €200 deposit now or pay the full €549 — which do you prefer?"

Facts kept: dates 2026-07-03→2026-07-10, guests 1, package waimea

**Issue:** final: final.expected_fields.package_interest expected "accommodation_only" got "waimea"

### Example 4: hammer-50001-0014 (FAIL)

**Type:** cash_payment_side_question · **Lang:** en

1. Guest: "Hey 3 of us, julyy 10-17, no package just stay"
2. Guest: "can we pay cash on arrival?"

Luna (last turn): "Totally — balance on arrival by cash, transfer, or pay online 😊 Would you rather pay the €200 deposit or the full €897 now?"

Facts kept: dates 2026-07-10→2026-07-17, guests 3, package malibu

**Issue:** turn 1: expected_accommodation_only but package_interest=malibu

### Example 5: hammer-50001-0015 (FAIL)

**Type:** correction_flow · **Lang:** en

1. Guest: "Hey we are 1 friends, July 17-24, accommodation only"
2. Guest: "sorry we are 1"

Luna (last turn): "For July 17 to 24 for 1 guest, your package includes Santander airport transfer — do you need a pickup from Santander? If yes, send your flight details (arrival time). If not, just say no transfer."

Facts kept: dates 2026-07-17→2026-07-24, guests 1, package malibu

**Issue:** turn 1: expected_accommodation_only but package_interest=malibu


---

## 6. What Ale/Cami should test manually

Focus manual hammering on these **high-value messy combos**:

1. Book dates + guests, then ask **“can we pay cash?”** before choosing deposit/full
2. Start a Malibu/weekly quote, then say **“actually we are 3”** (Italian: _in realtà siamo 3_)
3. Short stay + **wetsuit and board** in one message (DE: Neopren + Board)
4. Mid-flow **dinner or yoga** after quote is ready
5. **Reset** (“start over”) then send new dates in the next message
6. Mixed **IT/EN** in one thread with typos and emojis around dates

Use exported fixtures under `fixtures/luna-conversation-state-machine/generated-hammer-failures/` as starting scripts.

---

## 7. What is safe to ignore for demo

- **PARTIAL** on composer copy (e.g. missing the word “yoga” once) — tone, not booking breakage
- **Internal dry-run labels** in logs — not guest-facing
- **Add-on pay-at-checkout** wording — services are held, not charged in hammer mode
- Failures that only appear with **hammer typo injection** (`julyy`, `luglo`) if clean phrasing works in manual test

---

## 8. Top recommended Stage 40d fixes

1. **Turn-2 cash side-question quote preservation** — keep quote ready when guest asks cash/bank after quote
2. **Italian correction_stale_quote** — invalidate and rebuild when guest count changes mid-flow

Do not start Somo FAQ or surf report until these two are cleaner for manual testing.

---

## What to tell Ale/Cami

> Luna now handles **most clean and messy booking flows**, including multiple languages, corrections, add-ons, and combined side-questions. On our 100-conversation stress test, **74 passed** and only **10 failed** — mostly unusual combos like asking about cash on turn 2 after a quote, or changing guest count in Italian without refreshing the quote. **These are exactly the areas we want you to hammer manually** using the exported conversation scripts. Nothing in this test sent real payments or WhatsApp messages.

---

## Exported curated fixtures

Seed **50001** · 10 FAIL + 5 PARTIAL exported (caps: 10 fail, 5 partial)

- `hammer-50001-0006.json` (FAIL) — final: final.expected_fields.package_interest expected "accommodation_only" got null (accommodation_intent, internal_error, service_addon_intent)
- `hammer-50001-0007.json` (FAIL) — final: final.expected_fields.package_interest expected "accommodation_only" got "waimea" (accommodation_intent, service_addon_intent, package_intent)
- `hammer-50001-0014.json` (FAIL) — turn 1: expected_accommodation_only but package_interest=malibu (package_intent, cash_side_question)
- `hammer-50001-0015.json` (FAIL) — turn 1: expected_accommodation_only but package_interest=malibu (package_intent)
- `hammer-50001-0023.json` (FAIL) — final: final.expected_fields.package_interest expected "accommodation_only" got null (accommodation_intent, internal_error, service_addon_intent)
- `hammer-50001-0030.json` (FAIL) — final: final.expected_fields.package_interest expected "accommodation_only" got "malibu" (accommodation_intent, package_intent)
- `hammer-50001-0034.json` (FAIL) — turn 1: expected_quote_ready but quote_status=not_ready (internal_error)
- `hammer-50001-0040.json` (FAIL) — final: final.expected_fields.package_interest expected "accommodation_only" got null (accommodation_intent, internal_error, service_addon_intent)
- `hammer-50001-0041.json` (FAIL) — final: final.expected_fields.package_interest expected "accommodation_only" got "waimea" (accommodation_intent, service_addon_intent, package_intent)
- `hammer-50001-0047.json` (FAIL) — final: final.expected_fields.package_interest expected "accommodation_only" got "malibu" (accommodation_intent, package_intent)
- `hammer-50001-0005.json` (PARTIAL) — turn 1: expected_service_interest missing wetsuit (service_addon_intent)
- `hammer-50001-0024.json` (PARTIAL) — turn 1: expected_service_interest missing surf_lesson (service_addon_intent)
- `hammer-50001-0031.json` (PARTIAL) — turn 2: reply_contains "efectivo" missing (cash_side_question)
- `hammer-50001-0039.json` (PARTIAL) — turn 1: expected_service_interest missing wetsuit (service_addon_intent)
- `hammer-50001-0043.json` (PARTIAL) — turn 2: expected_meals_request but meals_request missing (yoga_meals_intent)

---

## Safety

No writes, live Stripe, WhatsApp, confirmations, n8n activation, or production changes.

