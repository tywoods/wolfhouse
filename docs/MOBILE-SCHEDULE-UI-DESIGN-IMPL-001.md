# MOBILE-SCHEDULE-UI-DESIGN-IMPL-001 — Chief handoff

## Scope and ownership

Captain owns only `scripts/browser/sunset-schedule-day-cockpit-ui.js` and the new regression `scripts/verify-sunset-schedule-mobile-chrome.js`. Deckhand retains the shared portal shell/template. Chief owns GitHub landing and Sunset staging deployment; Skipper remains on the simulator assignment.

No production deployment, port 8094 change, agent routing/configuration change, guest sends, booking submissions, or `/sethome`.

## Chosen layout

An arrangement of the existing controls, not a new Schedule concept:

1. Prominent date and school/session summary, with Refresh at the top right.
2. Full-width Previous / Today / Next, with at least 44px touch targets.
3. Daily / Monthly beside Create booking.
4. Quiet Luna / Staff legend underneath.

Existing palette retained. Mobile dark-mode Today/Create text uses the existing dark green token instead of white to repair insufficient text contrast. Only the existing `max-width:768px` CSS block changes; renderer markup, navigation callbacks, fetching, desktop CSS and booking logic are untouched.

## Verification

Final production-font browser run: **16 cases passed, 0 failed**; minimum measured mobile normal-control text contrast was **4.54:1**. The final regression also checks Create hover contrast. All nine additional gates below passed. The earlier fully offline matrix also passed all 16 cases. No browser exceptions or booking-write/send requests occurred in the final matrix. Quick-run evidence has a separate directory and was verified not to overwrite the full-matrix receipt.

```bash
node scripts/verify-sunset-schedule-mobile-chrome.js
# Optional production Google Fonts loading; only the two font hosts are allowed:
node scripts/verify-sunset-schedule-mobile-chrome.js --web-fonts
```

The browser regression uses the actual generated `/staff/ui` and the existing loopback API fixture. It tests 360/390/430px and 1365px desktop, light/dark, Spanish/English. Checks cover date hierarchy, horizontal fit, control reachability, mobile target sizes/text contrast, date navigation, Daily/Monthly selection, Refresh requests, Enter activation of focused Create followed by pointer closing, and long-summary wrapping. This is not a full keyboard Tab-order test. The browser test waits for the loader's final paint before interacting, rather than racing the heading's early navigation update.

Independent final-diff review passed with no blocking security or logic findings. The earlier mobile dark-mode hover-contrast finding was already repaired and the final regression measures the hovered CTA. Separate before/after evidence comparison confirmed exact desktop header geometry, colors and hit targets in all four desktop theme/language cases (`desktop-parity.log`); this comparison is not yet built into the recurring regression. WebKit, 768/769px breakpoint edges, intermediate Monthly fit screenshots and full Tab traversal remain untested here.

No booking is submitted. All write requests are rejected; the exact loopback-only POST catalog path is permitted because it reads `listOfferings`. The fixture has an empty Schedule: this proves control layout/wiring, not live booking data, populated card layouts, or staging deployment.

Additional gates:

```bash
node scripts/verify-sunset-schedule-day-cockpit-ui.js
node scripts/verify-sunset-schedule-day-cockpit-p2-mount.js
node scripts/verify-sunset-schedule-day-cockpit-p3-states.js
node scripts/verify-sunset-schedule-navigation-ui.js
node scripts/verify-sunset-schedule-architecture.js
node scripts/verify-staff-portal-mobile-layout.js
node scripts/verify-portal-template-escapes.js
node scripts/verify-portal-typography-fonts.js
node scripts/verify-hermes-send-flags.js
```

The unmodified whole-HTML byte-parity gate intentionally fails because this is a visual change, not an extraction. For both Sunset and Wolfhouse, replacing only the changed injected cockpit module with its saved baseline reproduces the original generated HTML exactly. No Inbox/template collateral change was found.

Screenshots and geometry/contrast evidence are under `tmp/mobile-schedule/`. Baseline was captured before the CSS edit; `--capture-only --baseline-html tmp/inbox-ui-parity/baseline-sunset.html` can render that saved production HTML again without checking new-layout assertions. `--quick` runs only 390px/dark/Spanish and is not a full-matrix pass.

## GitHub and staging handoff

Local branch: `captain/mobile-schedule-date-first`, based on `a96e5a1b2a70fc401118df6ab3bb2f788b6906c0`.

This sandbox's configured fetch source `/opt/wolfhouse/WH` is inaccessible and its push URL is intentionally disabled. No GitHub PR, remote freshness, landing, or staging deployment is claimed. Chief should import the single-commit patch/bundle, reapply on current GitHub master if necessary, inspect overlap with Deckhand, run the gates, and open/merge the PR. Do not replace a newer portal/module wholesale with this branch.

Chief's normal mandatory sync/master preflights still apply before the approved staging image build/deploy. Staging visual acceptance remains a separate check.

## Staging browser acceptance (Chief / QA)

1. Open Sunset Schedule at 360, 390 and 430px, in light and dark mode.
2. Confirm the date leads; no sideways page scroll; all seven mobile controls fit and have usable targets.
3. Next → Previous restores the date; Previous → Today restores today.
4. Monthly changes the heading; next/previous month work; return to Daily.
5. Refresh retains the selected context and reloads Schedule.
6. Open Create booking and close it without submitting; check keyboard access as well.
7. Check a populated Schedule and a long venue/date label with real staging data.
8. Verify the desktop Schedule chrome and behavior remain unchanged.
