# Stage 40d — Cash Side-Question + Italian Correction Fixes

Targeted fixes for the top two hammer failure categories from Stage 40c review.

---

## Hammer score (seed 40402)

| Metric | Before (40c) | After (40d) |
|--------|--------------|-------------|
| PASS | 74 | **75** |
| PARTIAL | 16 | 19 |
| FAIL | 10 | **6** |
| Pass rate | 74% | **75%** |
| Fail rate | 10% | **6%** |

Stage 40b target (≥65 PASS, <20 FAIL) remains met. Fail count dropped by 4; pass count up by 1.

---

## What we fixed

### 1. Turn-2 cash / payment side-questions

**Problem:** Phrases like `cash payment ok?`, `posso pagare in contanti?`, and `Kann ich bar bezahlen?` were not detected as arrival-payment questions. Luna sometimes dropped quote context or routed to clarify/name prompts.

**Fix areas:**
- Expanded `detectPaymentChoiceFromMessage` for EN/IT/DE/ES cash phrasing
- Early router lane when a ready quote exists + cash side-question
- Payment-choice wire gate for arrival questions even when deposit/full prompt not yet shown
- Quote-preserving side-question path does not mark stale quote
- Warm arrival-payment copy (`Yep — … deposit or full amount?`)

**Hammer scenarios now passing:** `hammer-40402-0009`, `0010`, `0081` (EN cash + IT correction)

### 2. Italian guest-count correction stale quote

**Problem:** Italian corrections (`in realtà siamo 3`, `no aspetta siamo 2`, `siamo in due`, etc.) did not always invalidate and rebuild quotes.

**Fix areas:**
- Italian correction phrase patterns (`no aspetta`, `alla fine`, `invece`)
- Guest-count extraction for `siamo in due/tre/quattro`, `siamo 2 non 1`
- Stale-quote invalidation when correction intent detected with guest-count signal

**Regression fixture:** `italian-guest-count-correction-invalidates-quote` — PASS

---

## New hammer-regression fixtures (9 total, all PASS)

| Fixture | Result |
|---------|--------|
| turn2-cash-preserves-short-stay-quote-en | PASS |
| turn2-cash-preserves-short-stay-quote-it | PASS |
| turn2-cash-preserves-short-stay-quote-de | PASS |
| italian-guest-count-correction-invalidates-quote | PASS |

---

## Remaining hammer failures (6)

Not in scope for 40d:

| Category | Examples | Notes |
|----------|----------|-------|
| internal_error / quote not ready | 0032, 0048, 0067, 0091 | Transfer/meals + availability edge paths |
| cash side-question (ES localized copy) | 0021, 0033, 0069 | Reply uses *efectivo/contanti/bar* — hammer checks English `"cash"` |
| reset guest_count null | 0095 | Rare reset + reopen |
| DE cash on 7-night path | 0045 | Quote not ready before cash turn (name/availability) |

**Top remaining categories:** service_addon_intent (partials), yoga_meals_intent, internal_error, reset/guest_count

---

## Ale/Cami manual hammering

**Can start with guidance:** Luna is materially better on turn-2 cash questions (EN/IT/DE) and Italian guest-count corrections. Use the four new regression fixtures as scripts.

**Still hammer manually:**
- Spanish cash phrasing (*efectivo*)
- 7-night stays where quote needs name/availability before payment side-questions
- Reset → new dates flows
- German add-on wording (partials only — not booking breakage)

---

## Safety

No WhatsApp send, live Stripe, confirmations, n8n activation, production deploy, or payment-ledger changes. All tests local dry-run / review-only.

---

## Next recommendation

Hammer is **75 PASS / 6 FAIL** — improved but not yet at the 80+ PASS bar for Somo FAQ.

**Stage 40e (recommended):** Fix one final category only — either:
1. ES/IT hammer cash classifier accepting localized payment words (*efectivo/contanti*), or
2. Reset flow guest_count null (`0095`)

**Stage 41a (Somo/Wolfhouse knowledge config)** — start once hammer is ≥80 PASS and ≤5 FAIL after 40e, or Ale/Cami sign off on manual hammering with current score.

Do not start surf report or service pay-now links until hammer + manual review are clean enough.
