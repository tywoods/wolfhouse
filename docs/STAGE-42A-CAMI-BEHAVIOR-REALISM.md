# Stage 42a — Cami Behavior Realism + Tone Judge

## What changed

Stage 42a makes Luna feel less like warm templates and more like Cami actually doing bookings — through **behavior rules**, **reply variation**, and a **deterministic tone judge** for fixtures/tests.

### New / updated files

| Area | File |
|------|------|
| Behavior profile | `config/clients/wolfhouse-somo.personalities.json` — Cami `behavior` layer |
| Variation helper | `scripts/lib/luna-guest-cami-reply-variation.js` |
| Tone judge | `scripts/lib/luna-cami-tone-judge.js` |
| Composer wiring | `scripts/lib/luna-guest-reply-composer.js` |
| Personality lexicon | `scripts/lib/luna-guest-personality-config.js` |
| Fixture batch | `scripts/lib/luna-conversation-fixture-set-batch.js` |
| Expectations | `scripts/lib/luna-fixture-expectations.js` |
| Payment realism | `scripts/lib/luna-guest-message-router.js` — broken link → `payment_failed` |
| Fixtures | `fixtures/luna-conversation-state-machine/cami-realism/*.json` (10) |
| Verifier | `scripts/verify-stage42a-cami-behavior-realism.js` |

## Cami behavior rules

Cami is a **behavior pattern**, not only tone:

- Warm welcome, practical logistics, “no stress, we’ll sort it”
- One clear next step per message
- Little excitement — not repetitive, not corporate
- No fake-confirming payment, holds, or scheduling
- Gentle surf-house energy

### Core patterns (config)

- `one_question_at_a_time`
- `max_emoji_density: 3`
- `avoid_yesss_opener_streak`
- `avoid_same_payment_prompt_wording`
- `avoid_repeat_dates_price_back_to_back`

### Scenario guides

| Scenario | Cami behavior |
|----------|---------------|
| Guest unsure on package | Explain briefly, don’t force choice, one next question |
| Guest adds service | “Noted/held” — not paid unless payment truth exists |
| Staff scheduling needed | “Team will confirm the exact time” |
| Side question mid-booking | Answer briefly + return to booking |
| Guest changes mind | “No stress — we update it” |

## Reply variation

`luna-guest-cami-reply-variation.js` picks from EN variation pools per state:

- welcome, ask dates, guest count, quote ready, add-ons, payment choice
- cash/transfer side questions, reset, confirmation intro, FAQ/surf tails

**Deterministic:** seeded by guest phone + turn index + pool key.  
**Anti-repeat:** tracks openers and payment-prompt signatures in `cami_variation_history` on guest context.

Business facts (€ amounts, dates, URLs) stay code-owned — only wording varies.

## Tone judge scoring

`luna-cami-tone-judge.js` — heuristic only (no LLM). Returns:

```json
{
  "cami_score": 0-100,
  "flags": ["robotic_opening", "..."],
  "suggested_category": "warmth|robotic|repetition|structure|safety|good"
}
```

### Flags

| Flag | Meaning |
|------|---------|
| `robotic_opening` | Template/dev receptionist phrasing |
| `repeated_phrase` | Same opener or snippet as prior turn |
| `too_long` | >900 chars |
| `too_many_emojis` | >4 emojis |
| `missing_next_step` | No question or clear next action |
| `fake_confirmation` | Confirmed/held/paid language without payment truth |
| `internal_language` | Staging/dev/system terms |
| `too_corporate` | Formal hotel-agent tone |
| `no_warmth` | Missing Wolfhouse/human warmth markers |

**Tests/verifier only** — does not block live replies at runtime.

## Before / after examples

| Situation | Before (template-y) | After (Cami realism) |
|-----------|---------------------|----------------------|
| Quote ready | Always “Yesss, good news — we have space…” | Rotates: “Good news — we’re good for those dates…” / “We’ve got space…” |
| Payment choice | Always “Would you rather pay the deposit…” | Rotates: “To hold the spot — deposit or full?” / “Which works — deposit now or full?” |
| Reset | Always “No problem at all, we start fresh…” | Rotates: “No stress — let’s start over…” / “All good, fresh start…” |
| Already paid | (unchanged safety) | Still: team checks payment — no fake confirmation |

## Running fixtures

```bash
npm run luna:guest-flow-batch -- --local --fixture-set cami-realism
npm run verify:stage42a-cami-behavior-realism
```

Batch report includes: pass/partial/fail, **cami_score average**, top tone flags, business fact safety.

## Remaining Cami realism gaps

- Router payment/transfer awkward replies still use safe Luna templates (not full Cami pools)
- IT/ES/DE variation pools not yet expanded (EN only in 42a)
- Tone judge is heuristic — may miss subtle repetition or false-flag long FAQ answers
- Social vibe / beginner answers depend on FAQ/knowledge coverage — not new copy in 42a
- Live runtime does not block on tone score (by design)

## Recommendation for manual Ale/Cami hammering

After 42a PASS:

1. **Stage 42b** — payment/transfer awkward edge cases (already paid, link broken, friend pays, delayed flight, Bilbao/Santander ambiguity)
2. **Stage 44a** — Ale/Cami manual hammer mode/runbook with tone judge overlay on real WhatsApp-style threads

Use hammer seed **40402** as regression baseline while hammering new awkward scenarios manually.

## Safety proof

- No payment truth changes
- No Stripe / confirmation gate changes
- No WhatsApp send path
- No n8n activation
- No production / Azure deploy
- `validateComposerFacts` unchanged for business grounding
