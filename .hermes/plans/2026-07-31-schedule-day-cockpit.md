# Cockpit Redesign — Schedule Day Cockpit

> **For Hermes/coding agents:** This is a scoped implementation plan for a UI relocation + redesign. Implement it as ONE reviewable slice on its own branch, not concurrently with the staff-api Slice 1 injection-hardening. Behavior-neutral for everything below the band. Do not touch schedule routes/roles, waiver, mutation handlers, tenant/location gates, DB, or Azure.

**Goal:** Replace only the **top region** of the Sunset Schedule page — the `Schedule for: <venue>` line, the four stat cards (SURFBOARDS / WETSUITS / UNPAID-PENDING / NEED REPLY), and the controls row (Previous·Today·Next / date title / Luna-Staff legend / Today·Week·Next 30 / refresh / Create booking) — with a single **Day Cockpit** band: control bar + live "ON NOW" hero (seats ring, gear chips) + proportional day ribbon with now-needle + a prep rail that absorbs the four old numbers. **Everything below (timeline session list, guest tables, now-line, RENTAL PICKUPS TODAY) stays byte-identical.** It is a relocation + redesign, not new behavior.

**Design source of truth:** `.hermes/plans/assets/schedule-day-cockpit/` — `README.md` (exact colors/typography/states/edge cases/data contract), `PROMPT.md`, `before.png` (orange = replaced, green = keep byte-identical), `cockpit/cockpit.css` + `cockpit/cockpit.js` (framework-free reference; reuse the pure derivation fns `classify`/`pct`/`fmtDur` verbatim), and the two `*.dc.html` prototypes (option **6a** is the approved direction). Bundle received from Earthling 2026-07-31.

Base for implementation: current `master` (was `77f06aeb…` at planning time). Read-only planning + P0 audit already done against source; no implementation, deploy, DB, Azure, secret, or live-data action has occurred.

---

## 1. P0 data-contract audit (done — data is available)

Every field the cockpit needs maps to the existing schedule view model. **No new DB queries.**

| Cockpit field | Source today | Status |
|---|---|---|
| `venue` / `date` / `range` | current top region + `SunsetScheduleRuntime.nav` | present (being replaced) |
| `session.id/name/start/end` | schedule session/slot data (the list below) | present |
| `session.booked` | `scripts/lib/sunset-schedule-ops.js` (`bucket.booked += qty`) | present |
| `session.boards/wetsuits` (gear out) | ops group gear (`gear.boards`, `scheduleGroupBoardsNeeded`) | derivable |
| `prep.boards {total,lesson,rental}` | `sunset-schedule-ops.js` — `boardsTotal / boardsLesson / boardsRental` | present (exact split) |
| `prep.wetsuits {total,lesson,rental}` | ops, same pattern | present |
| `prep.unpaid` / `prep.needReply` | `scripts/browser/sunset-schedule-forecast-cards-ui.js` (`unpaidCount`, `needReplyCount`) | present |
| `on.prev/today/next` | `SunsetScheduleRuntime.nav.*` | reuse handler |
| `on.range` (today/week/next30) | nav range fns + existing range pills | reuse |
| `on.create` | existing create-booking drawer (`data-ps-add-slot`) | reuse |
| `on.session` | existing session view/edit drawer | reuse |

**Two open items (small, both resolved to actions below):**
1. **Seats-ring `capacity`** — the ring denominator (`/24`) is NOT currently surfaced onto the schedule session view model (only referenced in the booking/pricing path `sunset-schedule-booking-drawer.js`). Needs a small **read-only** surfacing of course/offering capacity into the session VM in `sunset-schedule-ops.js` (no new query — value exists in course config), OR the ring degrades to booked-only. This is the only genuine data addition.
2. **`on.refresh`** — a refresh control exists in the current controls row; locate its exact handler and point the new refresh icon at it (P1, trivial).
3. `session.note` chip — genuinely new and **optional**; skip for v1 (designer flagged it).

## 2. Injection model (how the band slots in)

The schedule UI is request-time-generated HTML with a **14-marker permissive injection** system: `injectAtMarker(html, marker, moduleJs)` over ordered `/* INJECT:sunset-schedule-* */` markers in `scripts/lib/sunset-schedule-browser-source.js` (money-parse, rental-availability, portal-module, drawer-view, drawer-edit, drawer-actions, drawer-controller, day-ops-board, forecast-cards, view-grid, runtime, navigation, row-normalizer, data-loader). The cockpit adds a **15th** module + marker. This rides the exact system the staff-api decomposition **Slice 1** (strict full-template injection) hardens — see §5.

## 3. Files touched

- **NEW** `scripts/browser/sunset-schedule-day-cockpit-ui.js` — the band; reuse `classify`/`pct`/`fmtDur` verbatim from the reference `cockpit.js`; port `render()` into our module idiom.
- `scripts/lib/sunset-schedule-browser-source.js` — `getSunsetScheduleDayCockpitBrowserSource()` + `SCHEDULE_DAY_COCKPIT_INJECT_MARKER` + the `injectAtMarker` call (14→15); publish the canonical ordered 15-marker list.
- `scripts/staff-query-api.js` (`buildUiHtml` top region) — replace venue line + 4 stat cards + controls row markup with the cockpit mount `<div>` + the new INJECT marker; leave everything below untouched.
- `scripts/lib/sunset-schedule-ops.js` — small read-only surfacing of per-session `capacity`.
- CSS: port `cockpit.css` values into the schedule stylesheet / existing styling approach (values exact; map to design tokens where they exist and note any inexact mapping).
- Verifiers: extend `scripts/verify-sunset-schedule-architecture.js` to the 15th marker in order; add a cockpit state/edge verifier; reuse the offline cook + startup smoke; add authenticated staging/Playwright for the 3 time-of-day states.

## 4. Phased slices (one reviewable step at a time)

**P1 — build the module (isolated, not yet mounted)**
- Port `render()` → new module; reuse `classify`/`pct`/`fmtDur` verbatim.
- Map the data contract to the runtime view model per §1 (prep from `sunset-schedule-ops`; sessions incl. `gear.boards/wetsuits`; venue/date/range from `nav`).
- Resolve the two open items: (a) surface `capacity` read-only into the session VM; (b) locate the refresh handler.
- Port `cockpit.css` values.
- **RED:** a 15-marker offline fixture proves the new module renders each state before any wiring.

**P2 — mount + top-region swap (the surgery)**
- Add the 15th marker + `injectAtMarker`; mount in `buildUiHtml`; remove the old venue line + 4 cards + controls row markup.
- Wire `on.{prev,today,next,range,refresh,create,session}` → existing `SunsetScheduleRuntime.nav.*` + create/session drawers + refresh handler.
- **GREEN gate:** cooked HTML **below the band is byte-identical** (diff the region before/after); existing handlers fire unchanged.

**P3 — states + a11y + 60s re-render**
- States: before-first / after-last / no-sessions / non-today / week / next30 / capacity-0 / back-to-back.
- a11y: `aria-pressed` on segmented controls, `aria-label` on refresh, ribbon blocks are real `<button>`s with titles, normal tab order.
- 60s `setInterval` re-render for needle + countdowns reusing the runtime clock; must not conflict with the page's existing refresh; no other animation.

**P4 — verify**
- 3 time-of-day states via the reference `now` override.
- Green-region byte-identical assertion.
- Offline production cook (`buildUiHtmlForOfflineTest`) through the **15-marker** injection.
- Architecture verifier updated to 15 markers in exact order.
- Startup smoke (requiring the module does not begin listening).
- **Authenticated staging/Playwright** on the 3 states — this IS a UI behavior change, which the decomposition plan's own test taxonomy says requires the fuller treatment (not behavior-neutral).

## 5. Sequencing & risk

- **Do NOT run concurrently with staff-api Slice 1** — both touch the injection system + schedule modules. Preferred order: **land Slice 1 first** (its strict 15-marker injection hardens the very seam this rides on — a benefit), then this as its own branch/worktree. If run before Slice 1, this must extend the marker set consistently so Slice 1 later covers 15.
- Own branch/worktree; one writer per shared file; serial merges. No deploy until a merged exact-SHA branch passes repo/deploy preflight and the operator explicitly approves deployment.
- This redesign consolidates three injected modules (`forecast-cards-ui`, top of `day-ops-board-ui`, `navigation-ui`) into one band — coordinate a single owner for the schedule modules during the window.

## 6. Rollback & stop conditions

**Rollback:** one code revert restores the old top region (venue line + 4 cards + controls row) and removes the marker/module. No DB, no infrastructure. The below-band region never changed, so rollback is clean.

**Stop conditions:**
- Any diff to schedule routes/roles, waiver routing, mutation handlers, tenant/location gates, DB, Azure, or deployment files.
- The below-band cooked HTML stops being byte-identical.
- Capacity surfacing requires a new query or touches booking/pricing writes (it must be read-only config surfacing).
- `injectAtMarker` is made globally fail-closed (breaks partial fixtures) — the new marker must ride Slice 1's permissive/strict split.
- Fidelity substitutes a palette value silently instead of reporting an inexact token mapping.

## 7. Size

**Medium — ~3–5 focused days** (implement + verify) for one careful agent, plus coordination overhead (frozen/actively-refactored zone). Capacity surfacing adds ~½ day and is the only data addition. Design work is done; derivation logic is provided; scope is one band.

## 8. Completion definition

- P0 audit recorded (§1). Data contract confirmed available; the one capacity addition scoped as read-only.
- P1–P4 each land as reviewed steps; below-band proven byte-identical; 15-marker architecture verifier green; 3-state staging proof captured.
- Plan committed separately from any runtime implementation; implementation gets its own later branch, tests, review, merge, and optional staging deployment with explicit operator approval.
