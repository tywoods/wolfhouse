# Stage 39b — Multilingual Parser Hardening Results

**Date:** 2026-06-10  
**Prior (Stage 39a):** 3 PASS / 9 FAIL / 0 PARTIAL  
**After Stage 39b:** **11 PASS / 1 PARTIAL / 0 FAIL**

## Fixes applied

1. **Compact IT/ES/DE date ranges** — `1-5 luglio`, `10-17 luglio`, `1-5 julio`, `del 1 al 5 julio`, `dal 1 luglo al 5`, `vom 10. bis 17. Juli`, `1/5 luglio`.
2. **`solo` guest-count guard** — `solo alloggio`, `solo alojamiento`, `solo il soggiorno`, `no pack solo stay` no longer set `guest_count=1`; valid solo-traveller phrases preserved.
3. **Side-question context** — package explainer messages with embedded dates/guests/package retain extracted fields via `extractEmbeddedSideQuestionFields`.
4. **Spanish reset** — `empezamos de nuevo`, `empecemos de nuevo`, `quiero empezar de nuevo`, `empezamos otra vez`, `no espera, empezamos de nuevo` → `reset_new_booking`.
5. **Minor** — `tavola` → surfboard add-on; `siamoo` typo; `luglo` month typo; `para`/`per` guest count; side-question bogus guest-name filter.

## Fixture results (after)

| Fixture | Result | Notes |
|---------|--------|-------|
| it-short-stay-out-of-order | PASS | |
| it-package-addons-messy | PASS | |
| it-yoga-dinner-midflow | PARTIAL | turn 3 yoga reply copy (separate handling) |
| en-clean-but-casual | PASS | |
| es-short-stay-cash-question | PASS | |
| de-package-question | PASS | side Q + embedded facts |
| mixed-it-en-booking | PASS | |
| typo-heavy-booking | PASS | |
| emoji-heavy-surf-addons | PASS | |
| correction-language-switch | PASS | |
| reset-spanish | PASS | |
| german-transfer-side-question | PASS | regression green |

## Remaining failure category

| Category | Fixture |
|----------|---------|
| composer tone (yoga/dinner reply copy) | it-yoga-dinner-midflow |

## Recommendation

**Stage 40a** — Randomized hammer/stress tester (multilingual pack at 11/12 PASS exceeds 8/12 threshold).

Optional follow-up before stress: tiny **Stage 39c** only if yoga/dinner mid-flow copy matters for demo — not blocking for Stage 40a.

## Safety

No WhatsApp, live Stripe, confirmations, n8n, deploy, or production changes.

## Regression

`booking-core` batch expected green at commit time.
