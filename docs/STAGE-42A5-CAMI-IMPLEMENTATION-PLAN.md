# Stage 42a.5 — Cami Voice Pack Implementation Plan (for Stage 42a.6)

This plan tells the next stage exactly how to wire the mined Cami voice pack
(`config/clients/wolfhouse-somo.cami-voice-mining.json` +
`docs/STAGE-42A5-CAMI-VOICE-MINING-PACK.md`) into the live reply variation and
tone judge systems **safely**.

Scope of 42a.6: config + variation pools + tone judge heuristics + fixtures only.

---

## 1. Files to update

| File | Change type |
|------|-------------|
| `config/clients/wolfhouse-somo.personalities.json` | Edit `cami.behavior.variation_pools` (refresh variants, add new pools) and `cami.behavior.scenario_guides` |
| `scripts/lib/luna-guest-cami-reply-variation.js` | Add `closers` pool support + closer rotation in `applyCamiReplyVariation`; extend `COMPOSER_STATE_POOL_KEYS` if a new lane is added |
| `scripts/lib/luna-cami-tone-judge.js` | Update `HUMAN_ENERGY_MARKERS` / warmth markers; add honest-hedge credit and closer-present bonus |
| `fixtures/luna-conversation-state-machine/` | Add new cami-realism fixtures (see §4) |
| `scripts/verify-stage42a-cami-behavior-realism.js` | Extend expected pools/flags if checks are pool-name-driven |
| `package.json` | New verifier script for 42a.6 if created |

## 2. Pools to add / refresh

Existing pool keys (from `COMPOSER_STATE_POOL_KEYS` / `WELCOME_POOL_KEYS`):
`welcome`, `welcome_booking_intent`, `welcome_info_only`, `welcome_returning`,
`ask_dates`, `ask_guest_count`, `quote_ready`, `payment_choice_prompt`,
`cash_side_question`, `transfer_side_question`, `reset_start_over`,
`correction_accepted`, `confirmation_intro`, `surf_report_fallback`,
`faq_answer_tail`, `service_added`, `addons_declined`.

### New pool
- **`closers`** — rotating warm closers appended (when reply lacks a question):
  EN equivalents of `A domani` / `A dopo` / `un abbraccio` / `talk soon` /
  `see you soon ☀️`. Rotate with the same seeded anti-repetition mechanism as
  openers. This is the single highest-impact change (targets `missing_next_step(5)`).

### Refresh existing pools (use `phrase_banks` + `reply_recipes` from the JSON pack)
- `welcome*`: add celebratory `!!` variants (`Ciao!! Welcome to Wolfhouse ☀️`);
  reduce Yesss-led variants to at most one per pool.
- `quote_ready`: add plain-price-on-its-own-line variant
  (`Good news — we have space ☀️\nComes to {{total}}.\nWant me to hold it?`).
- `payment_choice_prompt`: add "whatever's easier for you 👍" (come-preferite) variant.
- `cash_side_question`: add one-breath yes variant
  (`Sure — cash with me at check-in, or bank transfer on arrival day. Whatever's easier 🙏`).
- `transfer_side_question`: add constraint+alternative variant and
  "send me your flight time and I'll organize it" variant.
- `addons_declined`: add zero-pressure variant
  (`No stress at all 😊 If you change your mind during the week just tell me.`).
- `service_added`: add short-confirm + next-touchpoint variant (`Done! ... A domani!`).
- `correction_accepted`: add vai-tranquillo variant
  (`No problem at all! So that's {{new}} — same dates. Updating it now 👍`).
- Uncertainty-adjacent lanes (`surf_report_fallback`, `faq_answer_tail`):
  add honest-hedge variants (`should be`, `more or less`, `depends on the day`,
  `I'll let you know later today`).

### New scenario guide (behavior config)
- **constraint_plus_alternative**: when refusing anything, state the practical
  reason and an alternative in the same reply, ≤2 lines, never bare "no" and
  never policy-citing.

## 3. Tone judge improvements

In `scripts/lib/luna-cami-tone-judge.js`:

1. **Human energy markers**: add `!!`/`!!!`, stretched vowels (`/(\w)\1{2,}/`),
   `a domani`, `talk soon`, `see you`, `no stress at all`; de-weight `yesss`.
2. **Honest-hedge credit** (new positive marker set): `I think`, `should be`,
   `more or less`, `I'll let you know`, `depends on` — counts toward warmth/human
   score; reduces `no_warmth` false negatives on honest-hedge replies.
3. **`closer_present` bonus**: if the reply ends with a warm closer or clear
   next touchpoint, suppress/offset `missing_next_step` — many real Cami
   messages end with a social close instead of a question.
4. **New flag (optional): `bare_refusal`** — a "no/can't/don't offer" reply with
   no alternative in the same message.
5. Keep all existing guards unchanged: fake-certainty, internal-language,
   corporate phrases, emoji density cap of 3, repeated-phrase detection.

## 4. New fixtures to add

Implement the 12 proposals in
`fixtures/luna-conversation-state-machine/cami-voice-mining-proposals/README.md`
as runnable fixtures (suggested set name: `cami-voice-mining` or extend
`cami-realism`). Highest value first:

1. closer-rotation-no-repeat (closers vary across a long conversation)
2. refusal-with-alternative (transfer constraint)
3. honest-hedge-uncertain-answer (wetsuit/weather-style question)
4. zero-pressure-addon-decline
5. quote-price-own-line

## 5. Tests to run (42a.6 exit criteria)

```
npm run verify:stage42a5-cami-voice-mining-pack
npm run verify:stage42a-cami-behavior-realism
npm run verify:stage41b-multilingual-faq-knowledge
npm run luna:guest-flow-batch -- --local --fixture-set booking-core   (must stay 26/26)
npm run luna:guest-flow-batch -- --local --fixture-set cami-realism   (must stay 10/10)
```

Plus: Cami tone score average must not regress below 91.2, and
`missing_next_step` + `no_warmth` flag counts should drop.

## 6. What NOT to touch

- Payment logic, Stripe, payment links
- Confirmation gates / confirmation send paths
- WhatsApp sending paths
- n8n workflows or activation
- Production config or deploys
- Booking/orchestrator logic (pool *content* only, not state machine)
- Deterministic seeded variant picking mechanism (extend, don't replace)

## 7. Anti-parody guardrails (must be enforced in 42a.6)

- ≤1 Italian/Spanish warmth word per conversation in English replies.
- No deliberate typos.
- No emoji clusters in logistics/payment lanes.
- No stretched vowels in payment/serious lanes.
- ALL CAPS at most once per conversation, only for genuinely critical info.
