# Sunset catalog modeling plan

**Created:** 2026-06-23. Source: real Sunset (Somo) + elSardi (Sardinero) offering text from the schools.
**Goal:** model the real surf-lesson catalog in the admin portal with minimal new code. Phase 0 uses only what exists today.

> Assumptions flagged with **(?)** — confirm/correct. IDs like `sunset-somo` / `sunset-sardinero` must never be renamed.

## Product types (the whole catalog reduces to 3)
1. **Group course (multi-week)** — the "pack": age band, beach(es), weekday/weekend, schedule windows, price by duration (1–4 weeks = 10/20/30/40h) + single class.
2. **Drop-in single class** — one 2h session, per student. Already expressible as a pack `single_class` tier.
3. **Private / individual** — 1:1, per session, schedule "on request". Belongs in Lessons (per-session price), not packs.

## Fits the current model
School/location (Somo vs Sardinero), age bands (`6_to_11`,`12_and_up`), beaches (Somo/El Sardinero/Liencres), group size (16), multiple schedule windows, duration price tiers + single class.

## Gaps (ranked)
1. **Weekend price alongside weekday.** Pack `weekly` is single-select; can't hold Mon–Fri *and* Sat–Sun prices on one card. Phase 0 workaround: a second (Sat–Sun) pack. Phase 2: a real weekend-price field.
2. **Private/individual** lessons priced per session — model in Lessons, not packs.
3. **Includes** (board/wetsuit/insurance/taxes) and **Requirements** (age, swim) — not modeled; Luna needs these facts.
4. **Description** — rich marketing copy has no home; add an optional text field for Luna.
5. **Seasonal extra slots** (high-season 10:00 & 12:00) — minor; add as extra schedule windows for now.

## Phased approach
- **Phase 0 — zero code.** Enter the catalog with today's fields; weekend rates = a second pack. (Entry sheet below.) Proves coverage before building.
- **Phase 1 — additive fields, one write path, low risk:** `includes` (checkboxes), `requirements` (text), `description` (text).
- **Phase 2 — only if Phase 0 is clumsy:** weekend-price field on a pack, private as a first-class type, seasonal schedule variants.

**Open decision (Phase 1/2):** weekend pricing as two packs (now) vs a weekend-price field on one card (small code). Defaulting to two packs for Phase 0.

---

## Phase 0 entry sheet

### Sunset — `sunset-somo` (beach: Somo)
**1. Kids 6–11 — group course** · Pack · age `6_to_11` · beach Somo · group size **(?)** · Mon–Fri · schedules 11:00–13:00 + 16:00–18:00 · tiers: 1 week 150€, single class 35€ · includes RC insurance (+accident) · req ~6yo (flexible).
**2. Teens/Adults 12+ — weekday** · Pack · age `12_and_up` · beach Somo · group size **(?)** · Mon–Fri (5×2h) · schedules 11:00–13:00 + 16:00–18:00 (high-season also 10:00, 12:00) · tiers: 1 week 150€, single class 35€ · includes RC + accident.
**3. Teens/Adults 12+ — weekend** · Pack · age `12_and_up` · beach Somo · Sat–Sun (2×2h) · schedules 11:00–13:00 + 16:00–18:00 · tiers: 1 week 70€, single class 35€.
**4. Private class** · Lesson · 2h exclusive · schedule on request · 60€/session.
**5. Group discounts** · negotiated, not a portal entry (note for Luna).

### elSardi — `sunset-sardinero` (beaches: El Sardinero, Liencres)
**6. Kids 6+ — group course** · Pack · age `6_to_11` **(?)** · beach El Sardinero · Mon–Fri · schedule 11:00–13:00 · tiers: 1 week 170€, 2 weeks 320€, single class 40€ · includes Board+Wetsuit+RC+Municipal taxes · req 6yo + can swim.
**7. Teens/Adults 12+ — weekday** · Pack · age `12_and_up` · beaches El Sardinero + Liencres · group size 16 · Mon–Fri · schedules 9:30–11:30 + 12:15–14:15 · tiers: 1wk 180€, 2wk 335€, 3wk 480€, 4wk 600€, single class 40€ · includes Board+Wetsuit+RC+Municipal taxes.
**8. Teens/Adults 12+ — weekend** · Pack · age `12_and_up` · beaches El Sardinero + Liencres · group size 16 · Sat–Sun · schedule **(?)** · tiers: 1 week 80€ · includes Board+Wetsuit+RC+Municipal taxes.
**9. Private classes** · Lesson · schedule on request · 70€/student.
