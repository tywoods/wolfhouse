# Stage 40b — Hammer Failure Fixes

**Target seed:** 40402 (100 scenarios)  
**Mode:** local review-only (no writes, Stripe, WhatsApp, confirmations, n8n, production)

## Hammer seed 40402 — before vs after

| Metric | Before (40a) | After (40b) | Delta |
|--------|--------------|-------------|-------|
| PASS | 49 | 74 | **+25** |
| PARTIAL | 18 | 16 | −2 |
| FAIL | 33 | 10 | **−23** |

Target met: **≥65 PASS** and **<20 FAIL**.

## Top categories improved

- **date_parsing** — julyy/luglo typo + emoji normalization
- **embedded side-question context** — cash/transfer + booking facts route to intake
- **guest_count** — "N of us", correction patches, reset merge
- **service_addon_intent** — lezioni/clases; accommodation-only no longer clears add-ons
- **accommodation_only / no_package** — "no package just stay" vs bare no_package; weekly package guard

## Remaining top failure categories (40402)

- **cash_side_question** — turn-2 cash loses quote on some EN/IT/DE paths
- **correction_stale_quote** — IT correction guest-count stale invalidation edge cases
- **service_addon_intent** — DE surf addon phrasing partials
- **yoga_meals_intent** — dinner/meals mid-flow partials
- **reset** — rare reset final guest_count null

## Curated hammer-regression fixtures

| Fixture | Result |
|---------|--------|
| embedded-cash-with-booking-facts | PASS |
| embedded-transfer-with-booking-facts | PASS |
| first-turn-wetsuit-board | PASS |
| first-turn-surf-lesson | PASS |
| reset-with-new-booking-facts | PASS |

## Regression sets

| Set | PASS | PARTIAL | FAIL |
|-----|------|---------|------|
| multilingual-out-of-order | 11 | 1 | 0 |
| booking-core | 26 | 0 | 0 |

## Top 5 Stage 40c recommendations

1. **Cash side-Q quote preservation on turn 2** — context merge when payment_choice not yet wired
2. **Correction stale-quote for IT/ES guest-count** — ensure invalidation when count changes
3. **DE addon phrasing** — Surfkurs / Neopren partials on first turn
4. **Meals/yoga mid-flow** — reactive service detection on turn 2 ES/IT
5. **Hammer report polish + export failing fixtures** for Ale/Cami review (if hammer stable)

## Safety

No writes, live Stripe, WhatsApp, confirmations, n8n activation, or production changes.
