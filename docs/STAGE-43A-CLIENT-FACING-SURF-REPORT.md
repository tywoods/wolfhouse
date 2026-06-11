# Stage 43a — Client-Facing Somo Surf Report

Guest-facing surf conditions for Luna (Cami tone). Text paragraphs only — no charts, cards, or staff UI.

## Config

- **Path:** `config/clients/wolfhouse-somo.surf-report.json`
- **Beach:** Somo
- **Ideal wave height:** 0.1m–2.5m
- **Tide guidance:** bigger waves (1.0–2.5m) → rising/high tide generally nicer; smaller waves → lower tide can be sweet
- **Wind:** ignore minor wind; mention only when stormy / very windy
- **Safety:** no hard safe/unsafe calls; surf school/staff confirm lesson timing
- **Tone:** positive, short, Cami-style paragraph (no raw metrics table)

## Helper

- **Path:** `scripts/lib/luna-guest-surf-report.js`
- **Composer state:** `explain_surf_report`
- **Buckets:** tiny/flat, small and friendly, fun, solid, stormy/messy

## Guest intent examples

- How are the waves today?
- Surf report / Surfbericht
- What's the surf like?
- Is Somo good today?
- Are there waves tomorrow?
- How are conditions?
- Qué tal las olas? / Cómo está el surf?
- Com'è il mare? / Come sono le onde?
- Wie sind die Wellen?

Mid-booking surf questions preserve dates, guest count, and quote context (no stale quote invalidation).

## API / fallback behavior

- **Live API:** When `STORMGLASS_API_KEY` is configured, uses existing backend-only `staff-stormglass-forecast` client (key never exposed to guests or fixtures).
- **Timeout/errors:** Friendly fallback — *"I can't see the live surf report right this second, but Somo usually works with a nice range of conditions. The team can confirm the best window closer to the day 🌊"*
- **Tests:** Use `surf_report_mock` in fixtures only; no live API required.
- **No hallucination:** Fallback never inventing wave heights.

## Multilingual

Minimum EN / IT / ES / DE guest copy in the formatter.

## Verifier & fixtures

```bash
npm run verify:stage43a-client-facing-surf-report
npm run test:luna-conversations -- --fixture surf-report-en-fun --verbose
# … see verifier for full fixture list
```

## Not included yet

- Staff surf report UI changes
- Forecast charts / image cards
- Hosted Stormglass live proof (Stage **43b**)
- Production deploy / n8n / WhatsApp / Stripe / confirmations

## Live API proof status

**Not run in 43a.** Local/mock fixtures only. Stage 43b can prove hosted staging with configured Stormglass key when safe.

## Next stage

- **Stage 43b** — hosted staging proof with Stormglass/live API (if safe)
- Otherwise **Stage 44a** — Ale/Cami manual hammer mode/runbook
