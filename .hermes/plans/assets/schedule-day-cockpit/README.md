# Handoff: Day Cockpit (Schedule screen)

## Overview
Replaces the top region of the Luna Front Desk **Schedule** page — the "Schedule for: <venue>" line, the four
stat cards (SURFBOARDS / WETSUITS / UNPAID-PENDING / NEED REPLY), and the controls row
(Previous · Today · Next / date title / Luna-Staff legend / Today · Week · Next 30 days / refresh / Create booking)
— with a single **day cockpit** band.

The cockpit answers the three questions a front-desk person actually has, in one glance:

1. **What is happening right now?** (live session, seats booked, gear out, time remaining)
2. **What is next?** (next session, start time, countdown, quick create)
3. **What still needs preparing/chasing today?** (boards, wetsuits, unpaid, unanswered messages)

Everything below the cockpit — the timeline session list with its guest tables, the now-line, and
RENTAL PICKUPS TODAY — is **unchanged**.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes that show the intended
look and behavior. They are not meant to be shipped as-is. The task is to **recreate this design inside the
target codebase**, using its existing framework, component conventions, styling approach and data layer.

`cockpit.css` + `cockpit.js` are a working reference implementation in framework-free HTML/CSS/JS. Two ways to use them:

- **Fast path:** drop both files in as-is and mount the band with one `div`. Works in any stack that can
  render a container element and run a script (Rails/ERB, Django, plain JS, PHP, or a React `useEffect`).
- **Idiomatic path (recommended if the app is a component framework):** port the markup in `cockpit.js`'s
  `render()` into a component (`<DayCockpit data={...} />`), keep `cockpit.css` (or convert to the app's
  styling system), and reuse the derivation logic (`classify`, `pct`, `fmtDur`) verbatim — it is pure functions.

## Fidelity
**High fidelity.** Colors, typography, spacing, radii and states below are final and taken from the live
screenshot of the existing app, so the band sits in the current UI without a visual seam. Recreate it
pixel-accurately, but use the codebase's existing button/pill components where they already match.

## Screens / Views

### 1. Schedule — day view, cockpit band
- **Name:** Day cockpit
- **Purpose:** Orient the user in the current day and let them change the date/range and create a booking
  without scanning the list.
- **Placement:** first element of the page content area, directly under the nav row, replacing the region
  described in Overview. Full content width (page has ~30px horizontal padding).
- **Layout:** one rounded container (`border-radius: 14px`, `background: #f7f5ef`, `border: 1px solid rgba(60,45,20,.11)`,
  `overflow: hidden`) with two stacked regions:
  1. **Control bar** — horizontal flex, `padding: 12px 18px`, `gap: 12px`, bottom border `1px solid rgba(60,45,20,.09)`,
     `flex-wrap: wrap`. Order: date-nav segmented control · date block · legend · (margin-left:auto) range
     segmented control · refresh icon button · Create booking CTA.
  2. **Body** — CSS grid `grid-template-columns: 1fr 270px`; collapses to a single column under 1080px.
     Left cell `padding: 16px 18px`, `display:flex; flex-direction:column; gap:12px`, right border
     `1px solid rgba(60,45,20,.09)`. Right cell is the prep rail.

#### Components

**A. Date-nav segmented control** (`.ck-seg`)
- Container: `background:#efece2`, `border:1px solid rgba(60,45,20,.1)`, `border-radius:99px`, `padding:3px`, flex.
- Buttons: `padding:6px 15px` (middle 6px 16px), `border-radius:99px`, `font-size:12.5px`, color `#6f6757`;
  hover color `#3a3226`; **active** (`aria-pressed="true"`) `background:#6b7a5e`, `color:#fff`, `font-weight:600`.
- Copy: `Previous` · `Today` (active on today) · `Next`.

**B. Date block** (`.ck-date`)
- Line 1: `font-size:16px; font-weight:700; letter-spacing:-.01em; line-height:1.1` —
  `Today · Jul 31, 2026` (weekday short name instead of "Today" when not today).
- Line 2: `font-size:11px; color:#8d856f` — `Schedule for Sunset · 3 sessions · 5 guests`
  (this absorbs the old "Schedule for: <venue>" line; guest count = sum of `booked`).

**C. Legend** (`.ck-legend`) — two items, `font-size:11.5px; color:#6f6757`, `gap:11px`;
7px dots: Luna `#7b8fb5`, Staff `#6b8f5e`. Same as the existing legend.

**D. Range segmented control** (`.ck-seg--range`) — same shell as A; active pill is
`background:#302c22; color:#f4f1e8`. Copy: `Today` · `Week` · `Next 30 days`.

**E. Refresh icon button** (`.ck-icon-btn`) — 32×32, `border-radius:99px`, `background:#efece2`,
`border:1px solid rgba(60,45,20,.12)`, glyph `↻` 13px `#6f6757`; hover border+glyph `#3a3226`.
Needs `aria-label="Refresh"`.

**F. Create booking CTA** (`.ck-cta`) — `background:#6b7a5e`, `color:#fff`, `border-radius:99px`,
`padding:9px 20px`, `font-size:13px; font-weight:600`; hover `#5c6a50`.

**G. NOW hero** (`.ck-now`) — the visual anchor.
- Card: `background:#22301f`, `color:#eef2e9`, `border-radius:12px`, `padding:17px 20px`,
  flex row, `gap:20px`, `align-items:center`, wraps.
- Eyebrow (`.ck-eyebrow`): `font-size:10px; font-weight:700; letter-spacing:.16em; color:#a8c48f`,
  preceded by a 7px dot `#a8c48f` with `box-shadow:0 0 9px rgba(168,196,143,.9)`.
  Copy: `ON NOW · ENDS 14:00`.
- Title: `font-size:25px; font-weight:600; letter-spacing:-.01em; line-height:1.15` — session name.
- Sub: `font-size:12.5px; color:#9fb392` — `12:00 – 14:00 · ends in 1 h 23 m`.
- Chips (`.ck-chip`): `font-size:11.5px; font-weight:600; background:rgba(255,255,255,.12); border-radius:99px; padding:4px 11px`;
  muted variant `background:rgba(255,255,255,.07); color:#9fb392`.
  Copy: `✓ 2 boards out`, `✓ 2 wetsuits out`, optional context chip (e.g. `Edu · day 4 of 4`);
  when a live session needs no gear, one muted chip `no gear needed`.
- Seats ring (`.ck-ring`): 56px circle, `background: conic-gradient(#a8c48f 0 Xdeg, rgba(255,255,255,.14) Xdeg 360deg)`
  where `X = round(booked / capacity * 360)`; inner 43px circle `#22301f` holding
  `2` at 13.5px/700 and `/24` at 9px `#9fb392`. Label to its right: `seats / booked`, 11px `#9fb392`, `line-height:1.35`.
- **Idle variant** (`.ck-now--idle`, used before the first session and after the last):
  `background:#f2efe5`, `color:#3a3226`, `border:1px solid rgba(60,45,20,.11)`; eyebrow `#8d856f` with a
  hollow dot; no ring. Copy — before open: eyebrow `NOTHING IN THE WATER`, title `First up: Curso Mañana`,
  sub `10:00 – 12:00 · starts in 40 min`, chip `8 boards · 8 wetsuits to prep`.
  After close: eyebrow `DAY COMPLETE`, title `3 sessions run · 5 guests`, sub `Gear back in, day closed out.`,
  chip `8 boards · 8 wetsuits used`.

**H. Day ribbon** (`.ck-ribbon`) — the whole day proportionally, so quiet vs. busy reads instantly.
- Head row: `The day` (12.5px/700) · summary string 11.5px `#8d856f`
  (`Mañana done · Medio Día in the water · Tarde empty`) · right-aligned
  `next: **Curso Tarde 16:00** · in 3 h 23 m`.
- Track: 58px tall relative box; inner track `position:absolute; inset:20px 0 14px; background:rgba(60,45,20,.06); border-radius:8px`.
- Session blocks (`.ck-block`, `<button>`): absolutely positioned, `top:20px; bottom:14px`,
  `left = (start - windowStart) / windowSpan * 100%`, `width = duration / windowSpan * 100%`,
  `border-radius:8px`, centered label `font-size:11px; font-weight:600`, `white-space:nowrap; overflow:hidden`.
  States: **live** `background:#22301f; color:#eef2e9; font-weight:700`;
  **done/booked** `background:#cfd6c4; border:1px solid #b3bfa5; color:#4a5340; font-weight:700` (past sessions get a trailing `✓`);
  **empty** `background:#f7f5ef; border:1.5px dashed rgba(60,45,20,.28); color:#8d856f`, hover border+text `#6b7a5e`.
  Label format: `Mañana · 3/24 ✓` (the "Curso " prefix is stripped for density).
- Now needle (`.ck-needle`): 2px column `#a8563a` from `top:0` to `bottom:8px` at the current-time percentage,
  with a `12:37` monospace tag (`font-size:9.5px; font-weight:700; color:#fff; background:#a8563a; border-radius:4px; padding:1px 6px`).
  Hidden when the shown day is not today.
- Hour axis (`.ck-hours`): every 2 hours, monospace 9.5px `#a1997f`, space-between.
- **Window**: default = 2h before the first start to 2h after the last end, clamped to 00–24 and always
  wide enough to contain every session (a block must never fall outside the track).

**I. Prep rail** (`.ck-prep`) — the four old stat cards, condensed.
- Cell: `background:#f2efe5`, `padding:16px 20px`, vertically centered column, `gap:10px`.
- Heading: `TODAY'S PREP`, `font-size:10px; font-weight:700; letter-spacing:.12em; color:#8d856f`.
- Rows (`.ck-prep__row`): label left `font-size:12.5px; color:#6f6757`; value right —
  total `font-size:16px` `#3a3226` bold + breakdown `font-size:11px` `#a1997f`
  (`8  4 lesson · 4 rental`). Values must not wrap (`white-space:nowrap`).
- Divider: 1px `rgba(60,45,20,.1)`.
- Unpaid row: label `Unpaid / pending` in `#a8563a` 600; value is a badge
  `background:#f6e6df; color:#a8563a; border-radius:99px; padding:2px 10px; font-size:12px; font-weight:700`.
  Clickable → filtered unpaid view.
- Need-reply row: `#8d856f`; value `0 · inbox clear` when zero, otherwise the count. Clickable → Inbox.

## Interactions & Behavior
- **Previous / Today / Next** and **Today / Week / Next 30 days** must call the page's *existing* date and
  range handlers — the cockpit only relocates these controls, it does not change their behavior.
- **Create booking** (bar) opens the existing booking modal with no session preselected.
- **Ribbon block click**: a session with bookings scrolls/anchors to that session card in the list below;
  an empty slot opens the booking modal preselected to that slot. Blocks are real `<button>`s with
  `title="Curso Tarde 16:00–18:00"`; keyboard focus follows normal tab order.
- **Prep rail rows**: Unpaid → unpaid/pending list; Need reply → Inbox. (If those destinations don't exist yet,
  leave the rows non-interactive rather than inventing a target.)
- **Live clock**: countdowns and the needle re-render every 60s. Nothing animates otherwise — no transitions
  beyond the CSS hover color/border changes.
- **Responsive**: under 1080px the grid collapses to one column (prep rail moves below the ribbon); the
  control bar wraps. No mobile-specific design in scope.
- **Loading**: while the day payload is in flight, render the container and control bar with the
  hero/ribbon/rail areas empty (or the app's existing skeleton) — do not unmount the controls.

## State Management
No new persistent state. Derived per render, from data already on the page:
- `now` — minutes since midnight, only treated as live when the shown date is today; optional explicit
  override for tests/replay.
- `live` — the session where `start <= now < end`; `null` outside session hours.
- `next` — first session with `start > now` (or the first session of the day when not today).
- `window` — ribbon time range (see H).
- Cancelled sessions are filtered out before all of the above.
Re-render triggers: date change, range change, booking created/edited/paid, refresh click, 60s tick.

## Design Tokens
Colors (all exposed as CSS variables on `.cockpit`):
- Surfaces: `--ck-surface #f7f5ef`, `--ck-surface-2 #f2efe5`, `--ck-chip #efece2`, page bg `#eae7dd`
- Lines: `--ck-line rgba(60,45,20,.11)`, inner dividers `rgba(60,45,20,.09)` / `rgba(60,45,20,.1)`
- Ink: `--ck-ink #3a3226`, `--ck-ink-2 #6f6757`, `--ck-ink-3 #8d856f`, `--ck-ink-4 #a1997f`
- Accent: `--ck-olive #6b7a5e`, `--ck-olive-dark #5c6a50`, `--ck-dark #302c22`
- Live hero: `--ck-now-bg #22301f`, `--ck-now-ink #eef2e9`, `--ck-now-ink-2 #9fb392`, `--ck-now-accent #a8c48f`
- Alert: `--ck-alert #a8563a`, `--ck-alert-bg #f6e6df`
- Ribbon done block: `--ck-done-bg #cfd6c4`, `--ck-done-border #b3bfa5`
- Legend dots: Luna `#7b8fb5`, Staff `#6b8f5e`

Typography: inherits the app's sans (Instrument Sans in the mock). Sizes used: 25 / 16 / 13 / 12.5 / 11.5 / 11 / 10px.
Weights 400/500/600/700. Letter-spacing `-.01em` on the two large headings, `.12em`–`.16em` on the small caps labels.
Monospace (system ui-monospace) only for the needle tag and hour axis.

Spacing: 3 / 6 / 10 / 12 / 16 / 18 / 20px. Radii: 4 (tag) / 8 (ribbon block) / 10 / 12 (hero) / 14 (container) / 99px (pills).
Shadows: none — separation is by surface tint and 1px borders. Prep rail column width 270px.

## Data contract
```js
{
  venue: 'Sunset',
  date: '2026-07-31',                  // ISO date of the day shown
  range: 'today' | 'week' | 'next30',  // which range pill is active
  now: 757,                            // optional override, minutes since midnight
  window: [8, 20],                     // optional ribbon hours; auto-derived when omitted
  sessions: [
    { id, name, start: '10:00', end: '12:00',
      booked: 3, capacity: 24, boards: 2, wetsuits: 2,
      note: 'Edu · day 4 of 4',        // optional context chip on the live hero
      cancelled: false }
  ],
  prep: {
    boards:   { total: 8, lesson: 4, rental: 4 },
    wetsuits: { total: 8, lesson: 4, rental: 4 },
    unpaid: 9,
    needReply: 0
  },
  on: { prev, today, next, refresh, range(kind), create(sessionId|null), session(sessionId), unpaid(), inbox() }
}
```
Every field except `note` is already rendered somewhere on the current Schedule page, so this should be a
re-shape of the existing view model rather than new queries. `note` is optional — pick whatever one-line
context is most useful (top guest and course day, assigned instructor, etc.).

## Edge cases to honor
- No sessions at all → idle hero `No sessions scheduled` / `Add a session to get going.`, empty ribbon track.
- Back-to-back sessions (12:00 end / 12:00 start) → `start <= now < end` makes the later one live; blocks
  touch without overlapping.
- Overlapping sessions (if the product allows them) → the current reference renders blocks on one row and
  they would overlap; decide whether to stack rows before shipping that case.
- Non-today dates and Week / Next 30 days → no needle, no countdown, hero shows the first session.
- Capacity 0 or missing → guard the ring math (`booked/capacity`) against divide-by-zero.

## Assets
None. No images, icons or icon fonts — the only glyphs are the text characters `↻`, `✓` and `·`.
Substitute the codebase's icon component for `↻` if one exists.

## Files
- `Cockpit Implementation.dc.html` — the reference build: live band in all three states (mid-session,
  before open, after close) plus the wiring notes and data sample. Open in a browser.
- `cockpit/cockpit.css` — all styles, tokens as CSS variables on `.cockpit`.
- `cockpit/cockpit.js` — `renderCockpit(el, data)` → `{ update(next), destroy() }`; contains the derivation
  logic (live/next classification, ribbon geometry, duration formatting) worth porting verbatim.
- `Luna Redesign Options.dc.html` — design exploration for context: option **6a** is the approved direction
  (shown in situ with the unchanged header, nav and session list); options 1a–5a are earlier alternatives.
- `before.png` — screenshot of the current Schedule page, with the region being replaced outlined in orange
  and the region to leave untouched outlined in green.
