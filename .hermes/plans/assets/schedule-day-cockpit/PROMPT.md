# Prompt for Claude (paste this)

I'm adding a new UI band to the Schedule page of my app (Luna Front Desk — a surf-school booking tool).
A designer produced a spec and a working HTML/CSS/JS reference. Implement it in this codebase.

**Read `design_handoff_day_cockpit/README.md` first — it is the source of truth** for layout, exact colors,
typography, states, interactions, the data contract and edge cases. Also open these, in this order:

1. `design_handoff_day_cockpit/before.png` — the current Schedule page. The region outlined in **orange** is
   what gets replaced. The region outlined in **green** must stay exactly as it is.
2. `design_handoff_day_cockpit/Cockpit Implementation.dc.html` — open in a browser. Shows the finished band
   in three states (mid-session, before the first session, after the last) and the data sample.
3. `design_handoff_day_cockpit/cockpit/cockpit.css` and `cockpit.js` — the reference implementation.
4. `design_handoff_day_cockpit/Luna Redesign Options.dc.html` — design exploration. Option **6a** is the
   approved direction, shown in place with the real header, nav and session list. Ignore 1a–5a.

## What to build

Replace, on the Schedule page only:
- the `Schedule for: <venue>` line
- the four stat cards (SURFBOARDS / WETSUITS / UNPAID-PENDING / NEED REPLY)
- the controls row (Previous · Today · Next / date title / Luna-Staff legend / Today · Week · Next 30 days /
  refresh / Create booking)

with the **day cockpit**: one card containing a control bar (all the controls above, relocated unchanged in
behavior), a live "ON NOW" hero, a proportional day ribbon with a now-needle, and a "TODAY'S PREP" rail that
absorbs the four old numbers.

Everything below it — the timeline session list, guest tables, now-line, RENTAL PICKUPS TODAY — is untouched.

## How I want it done

- **Recreate the design in this codebase's own idiom** — its framework, component conventions, styling system
  and data layer. The bundled HTML/CSS/JS is a design reference, not code to paste. If the app is a component
  framework, build a `DayCockpit` component; port `cockpit.css` to whatever styling approach the app uses
  (keep the values exactly).
- **Reuse the derivation logic verbatim** from `cockpit.js` — `classify` (live/next), the ribbon percentage
  math, `fmtDur`. It's pure functions and it's already correct; don't reinvent it.
- **Don't change any existing behavior.** Previous/Today/Next, the range pills, refresh and Create booking must
  call the handlers the page already uses. This is a relocation, not a rewrite.
- **Reuse existing components** where the app already has a matching pill/button/segmented control; otherwise
  build to the spec's values.
- **Data:** every field in the contract except the optional `note` chip is already rendered on the current
  page. Re-shape the existing view model — don't add queries. Point out anything that isn't actually available.
- **Match the palette exactly.** The colors in the README were sampled from the live app so the band has no
  visual seam. If the codebase has design tokens, map to them and tell me where the mapping is inexact
  instead of silently substituting.
- Hit the states and edge cases the README lists: before the first session, after the last, no sessions,
  non-today dates, Week / Next 30 days, back-to-back sessions, capacity 0.
- Accessibility: ribbon blocks are real buttons with titles, the refresh button needs an aria-label, segmented
  controls use `aria-pressed`, normal tab order.
- Keep the 60-second re-render for countdowns and the needle; no other animation.

## Before you write code

Tell me: which files you'll touch, how you're mapping the data, which existing components you'll reuse, and
anything in the spec that conflicts with how this codebase works. Then implement.

When you're done, show me the Schedule page in all three time-of-day states (there's an optional `now`
override in the reference for exactly this) and confirm the green region in `before.png` is byte-identical.
