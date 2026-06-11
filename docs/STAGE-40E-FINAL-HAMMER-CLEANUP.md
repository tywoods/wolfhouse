# Stage 40e — Spanish Cash Classifier + Reset Guest-Count Retention

Targeted hammer cleanup after Stage 40d cash/correction fixes.

---

## Hammer score (seed 40402)

| Metric | Before (40d) | After (40e) |
|--------|--------------|-------------|
| PASS | 75 | **81** |
| PARTIAL | 19 | **16** |
| FAIL | 6 | **3** |
| Pass rate | 75% | **81%** |
| Fail rate | 6% | **3%** |

FAIL count halved (6 → 3). Target of ≤5 FAIL met.

---

## What we fixed

### 1. Spanish cash / payment side-questions

**Problem:** Spanish guests ask `puedo pagar en efectivo?` / `por transferencia?` but hammer classifier and expectations looked for English `"cash"`. `transferencia` was misrouted to the airport-transfer explainer instead of payment choice.

**Fix areas:**
- Expanded `detectPaymentChoiceFromMessage` for ES phrases (efectivo, metálico, al llegar, transferencia, tarjeta, cash)
- Hammer generator `cashReplyContainsForLanguage()` — ES expects `efectivo`, IT `contanti`, DE `bar`
- `detectTransferSideQuestionIntent` excludes payment-method `transferencia` (bank transfer vs airport shuttle)
- Updated `es-short-stay-cash-question` fixture expectation to `efectivo`

**Hammer scenarios now passing:** `0021`, `0069` (ES cash), `0033` (IT cash — localized reply)

### 2. Reset → guest_count null

**Problem:** After Italian reset, `siamoo in 2, 8-12 luglo, solo il soggiorno` extracted dates but `guest_count` stayed null (hammer `0095`).

**Fix areas:**
- `normalizeHammerDateText`: `luglo` → `luglio`, `siamoo` → `siamo`
- `extractGuests`: typo-tolerant `siamo+ in N` pattern

**Hammer scenario now passing:** `0095` (reset_flow IT)

---

## New hammer-regression fixtures (12 total, all PASS)

| Fixture | Result |
|---------|--------|
| spanish-cash-preserves-quote-efectivo | PASS |
| spanish-cash-preserves-quote-transferencia | PASS |
| reset-new-booking-facts-guest-count | PASS |

---

## Batch results

| Suite | PASS | PARTIAL | FAIL |
|-------|------|---------|------|
| hammer-regressions (12) | 12 | 0 | 0 |
| generated-hammer-failures (15) | 6 | 6 | 3 |
| multilingual-out-of-order (12) | 11 | 1 | 0 |
| booking-core (26) | 26 | 0 | 0 |

**generated-hammer-failures** still FAIL overall — curated from 40c snapshot; 3 remaining FAILs match live hammer (DE cash, ES/IT dinner/meals). `0095` now PASS.

---

## Remaining hammer FAILs (3)

| ID | Category | Lang | Issue |
|----|----------|------|-------|
| 0045 | cash_payment_side_question | de | quote not ready after turn-2 cash question |
| 0067 | dinner_meals_request | es | quote not ready after meals side-question |
| 0091 | dinner_meals_request | it | quote not ready after meals side-question |

**PARTIAL clusters (out of scope for 40e):** DE/ES wetsuit/surf_lesson first-turn extraction, ES/IT dinner/meals composer copy, IT yoga mid-flow.

---

## Verifier

`npm run verify:stage40e-final-hammer-cleanup` — **PASS (23/23)**

Prior verifiers unchanged: 40d, 40c, 40b, 39b, 38b, 37b all **PASS**.

---

## Safety

- No WhatsApp send path
- No Stripe checkout creation
- No confirmation send path
- No n8n activation
- No production / Azure deploy
- Local review-only hammer runs

---

## Manual hammering (Ale/Cami)

**Yes — safe to start manual hammering.**

Hammer FAIL ≤5, booking-core green (26/26), hammer-regressions green (12/12). Remaining 3 FAILs are edge cases (1 DE cash quote readiness, 2 dinner/meals quote path) — not blockers for owner exploratory testing.

Suggested manual focus:
- Spanish cash/transferencia mid-quote (now fixed in dry-run)
- Reset → new dates/guest count in ES/IT/EN
- Full deposit/full payment choice after quote

---

## Next recommendation

**Stage 41a — Somo/Wolfhouse knowledge config**

Hammer FAIL is 3 (≤5), booking-core remains green, Spanish cash and reset guest_count regressions covered. Remaining FAILs are dinner/meals quote path (explicitly out of scope) and one DE cash edge — defer to 40f only if manual hammer surfaces it as critical.
