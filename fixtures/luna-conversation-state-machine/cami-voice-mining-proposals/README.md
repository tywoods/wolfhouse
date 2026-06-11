# Cami Voice Mining — Proposed Future Fixtures (Stage 42a.5)

Proposals only — no runnable fixtures in this stage. Each scenario is grounded
in real Cami behavior observed in the 6 mined chat exports (PII redacted; see
`docs/STAGE-42A5-CAMI-VOICE-MINING-PACK.md`). Target implementation: Stage 42a.6.

All proposed fixtures run local-only via
`npm run luna:guest-flow-batch -- --local --fixture-set <set>`.

## Proposed fixtures (12)

1. **cami-closer-rotation** — Long booking conversation (8+ turns). Assert: warm
   closers appear and rotate (no repeated closer in consecutive replies), no
   `missing_next_step` flags when a closer is present.
   *Source pattern: A domani / A dopo / un abbraccio closes nearly every real message.*

2. **cami-refusal-with-alternative** — Guest asks for a transfer that isn't
   offered (e.g. bus station / no-lesson transfer). Assert: reply contains the
   practical reason AND an alternative in the same message, ≤2 lines, no policy words.
   *Source pattern: "non facciamo i transfer per la stazione... Possiamo però portarvi tutti assieme."*

3. **cami-honest-hedge-weather** — Guest asks an unknowable question (wetsuit
   thickness / surf conditions next month). Assert: honest hedge (`should be`,
   `depends on the day`, `more or less`), no fake certainty, no `no_warmth` flag.
   *Source pattern: "Dipende molto dalle giornate."*

4. **cami-zero-pressure-addon-decline** — Guest declines lessons/yoga. Assert:
   instant acceptance, light open door ("if you change your mind during the
   week"), conversation moves to the real next step, no re-selling.
   *Source pattern: per-chi-fosse-interessato framing, never pushy.*

5. **cami-quote-price-own-line** — Standard quote flow. Assert: price appears
   plainly on its own line, exactly one follow-up question.
   *Source pattern: flat prices stated plainly ("50 euro per persona").*

6. **cami-payment-choice-come-preferite** — Payment choice prompt. Assert:
   both options as equals + "whatever's easier for you" register, no urgency
   words, no repeated payment-prompt signature across turns.
   *Source pattern: "per bonifico... oppure in contanti al check-in. Come preferite 👍🙏".*

7. **cami-welcome-celebration** — New guest first contact. Assert: celebratory
   opener (`!!`), what-I-can-help-with line, exactly one question, ≤3 emojis.
   *Source pattern: "Benvenuti e benvenute!!!" welcomes.*

8. **cami-guest-changes-mind** — Guest changes party size/dates mid-flow.
   Assert: vai-tranquillo beat first, new plan restated in one line, what stays
   the same confirmed, no fee/policy warnings.
   *Source pattern: "Per me nessun problema."*

9. **cami-self-honest-correction** — Luna gives info then must correct itself
   (or processing hiccup lane). Assert: light self-honest register ("sorry,
   mixed that up — fixed now 👍"), no formal apology paragraph.
   *Source pattern: "mi sono confusa — sono fritta 🤣" register, kept mild.*

10. **cami-advice-real-opinion** — Guest is unsure between two packages. Assert:
    a real recommendation with a one-line reason, choice left with the guest,
    no "both have advantages" fence-sitting.
    *Source pattern: she gives direct personal advice (io vi consiglio).*

11. **cami-transfer-flight-info** — Guest asks about airport pickup. Assert:
    enthusiastic yes, asks for flight time, concrete meeting detail style
    (landmark register), no case-by-case hedging.
    *Source pattern: "furgone bianco, uscita lato destro" pickup instructions.*

12. **cami-anti-parody-guard** — Long English conversation (10+ turns). Assert:
    ≤1 Italian warmth word total, no deliberate typos, no emoji clusters in
    logistics/payment turns, no stretched vowels in payment turns, ALL CAPS ≤1.
    *Guards against overdoing mined markers (parody risk).*

## Notes

- Fixtures 1–5 are highest value (directly target remaining tone flags:
  `missing_next_step(5)`, `no_warmth(6)`).
- Fixture format should follow the existing `cami-realism` set conventions.
- No live sends, no WhatsApp, no Stripe, no n8n — all local fixture runs.
