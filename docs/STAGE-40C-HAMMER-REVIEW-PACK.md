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
| **74** | **16** | **10** | 100 |

| Metric | Value |
|--------|-------|
| Pass rate | **74%** |
| Partial rate | 16% |
| Fail rate | **10%** |

Stage 40b target was ≥65 PASS and <20 FAIL — **met**.

### Language breakdown

| Language | PASS | PARTIAL | FAIL |
|----------|------|---------|------|
| de | 16 | 9 | 1 |
| it | 17 | 2 | 6 |
| en | 26 | 0 | 2 |
| es | 15 | 5 | 1 |

### Scenario breakdown

| Scenario | PASS | PARTIAL | FAIL |
|----------|------|---------|------|
| short stay accommodation | 9 | 0 | 0 |
| package booking | 9 | 0 | 0 |
| package surf addons | 5 | 4 | 0 |
| short stay surf addons | 4 | 5 | 0 |
| lesson addon | 5 | 3 | 0 |
| yoga request | 8 | 0 | 0 |
| dinner meals request | 2 | 4 | 2 |
| transfer side question | 7 | 0 | 1 |
| cash payment side question | 4 | 0 | 4 |
| correction flow | 7 | 0 | 1 |
| reset flow | 7 | 0 | 1 |
| out of order all in one | 7 | 0 | 1 |

### Top failure categories

- **service addon intent** — 12 hits
- **internal error** — 8 hits
- **yoga meals intent** — 6 hits
- **guest count** — 4 hits
- **cash side question** — 4 hits
- **date parsing** — 1 hits
- **transfer side question** — 1 hits
- **reset** — 1 hits

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

### Example 1: hammer-40402-0004 (PARTIAL)

**Type:** short_stay_surf_addons · **Lang:** de

1. Guest: "Hallo, 3 Personen, vom 8. bis 13. Juli, nur Unterkunft, Neopren und Board"

Luna (last turn): "Perfekt — das Board ist für dich reserviert 🌊 No stress on payment now — it's added to your booking and you can settle it at checkout. Um den Platz zu halten: lieber €100 Anzahlung oder €750 komplett?"

Facts kept: dates 2026-07-08→2026-07-13, guests 3, package accommodation_only

**Issue:** turn 1: expected_service_interest missing wetsuit

### Example 2: hammer-40402-0009 (FAIL)

**Type:** cash_payment_side_question · **Lang:** en

1. Guest: "Hey we're 3, julyy 10-17, just the stay"
2. Guest: "cash payment ok?"

Luna (last turn): "Thanks! Would you prefer to pay the deposit or the full amount for your stay?"

Facts kept: dates 2026-07-10→2026-07-17, guests 3, package accommodation_only

**Issue:** final: final expected_quote_ready but quote_status=not_ready

### Example 3: hammer-40402-0010 (FAIL)

**Type:** correction_flow · **Lang:** it

1. Guest: "🏄 per 1, 10-17 luglio, solo il soggiorno"
2. Guest: "scusa siamo 1"

Luna (last turn): "Ottime notizie — abbiamo posto per quelle date ☀️ Il soggiorno viene €315. Vi serve muta, tavola o lezioni, o solo pernottamento?"

Facts kept: dates 2026-07-10→2026-07-17, guests 1, package accommodation_only

**Issue:** turn 2: expected_stale_quote but quote was not invalidated

### Example 4: hammer-40402-0017 (PARTIAL)

**Type:** lesson_addon · **Lang:** de

1. Guest: "Hallo, 2 Personen, vom 17. bis 24. Juli, nur Unterkunft, Surfkurse bitte"

Luna (last turn): "Yesss, good news — we have space for those dates ☀️ The stay comes to €630. Do you need a wetsuit, board, or lessons too, or just the stay?"

Facts kept: dates 2026-07-17→2026-07-24, guests 2, package accommodation_only

**Issue:** turn 1: expected_service_interest missing surf_lesson

### Example 5: hammer-40402-0027 (PARTIAL)

**Type:** package_surf_addons · **Lang:** de

1. Guest: "✨ Hallo wir sind 2 Personen, Waimea Paket, vom 3. bis 10. Juli, 🏄 Neopren und Board"

Luna (last turn): "Would you rather pay the €200 deposit or the full €1203?"

Facts kept: dates 2026-07-03→2026-07-10, guests 2, package waimea

**Issue:** turn 1: expected_service_interest missing wetsuit


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

Seed **40402** · 10 FAIL + 5 PARTIAL exported (caps: 10 fail, 5 partial)

- `hammer-40402-0009.json` (FAIL) — final: final expected_quote_ready but quote_status=not_ready (internal_error, cash_side_question)
- `hammer-40402-0010.json` (FAIL) — turn 2: expected_stale_quote but quote was not invalidated (date_parsing, guest_count)
- `hammer-40402-0032.json` (FAIL) — turn 1: expected_quote_ready but quote_status=not_ready (internal_error, guest_count, transfer_side_question)
- `hammer-40402-0033.json` (FAIL) — final: final expected_quote_ready but quote_status=not_ready (internal_error, cash_side_question)
- `hammer-40402-0045.json` (FAIL) — final: final expected_quote_ready but quote_status=not_ready (internal_error, cash_side_question)
- `hammer-40402-0048.json` (FAIL) — turn 1: expected_quote_ready but quote_status=not_ready (internal_error, guest_count)
- `hammer-40402-0067.json` (FAIL) — final: final expected_quote_ready but quote_status=not_ready (internal_error, yoga_meals_intent)
- `hammer-40402-0081.json` (FAIL) — final: internal language turn 2: didn't quite catch (forbidden_language, internal_error, cash_side_question)
- `hammer-40402-0091.json` (FAIL) — final: final expected_quote_ready but quote_status=not_ready (internal_error, yoga_meals_intent)
- `hammer-40402-0095.json` (FAIL) — final: final.expected_fields.guest_count expected 2 got null (guest_count, reset)
- `hammer-40402-0004.json` (PARTIAL) — turn 1: expected_service_interest missing wetsuit (service_addon_intent)
- `hammer-40402-0017.json` (PARTIAL) — turn 1: expected_service_interest missing surf_lesson (service_addon_intent)
- `hammer-40402-0027.json` (PARTIAL) — turn 1: expected_service_interest missing wetsuit (service_addon_intent)
- `hammer-40402-0028.json` (PARTIAL) — turn 1: expected_service_interest missing wetsuit (service_addon_intent)
- `hammer-40402-0031.json` (PARTIAL) — turn 2: expected_meals_request but meals_request missing (yoga_meals_intent)

---

## Safety

No writes, live Stripe, WhatsApp, confirmations, n8n activation, or production changes.

