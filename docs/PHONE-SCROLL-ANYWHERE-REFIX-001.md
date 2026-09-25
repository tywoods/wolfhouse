# PHONE-SCROLL-ANYWHERE-REFIX-001

## Scope and ownership

Captain local build under Ty's override. Skipper owns separately authorized
publication/landing. Wolfhouse + Sunset Staff staging/lunabox only; no production,
gateway restart, guest sends, booking/payment actions, or routing changes.

## Product requirement / ACCEPT

At phone widths, staff must be able to drag directly on:

1. Inbox Chats list rows to scroll the list.
2. An open conversation's message/card body to read older/newer messages.
3. Guests list rows to scroll the list.
4. Guest card/detail body to read its content.

No gesture may require the empty chrome around a surface. Verify both directions
with overflowing content in both `wolfhouse-somo` and `sunset`, including ordinary
list-row opens (not just deep links). Native finger scrolling stays native. The
phone-width mouse fallback supports the same non-control content surfaces;
inputs, links and buttons retain their normal mouse/editing behavior.

## Cause and bounded fix

The existing phone layout is auto-height: the document can own scrolling while
`.inbox-left-rows` and `#thread-container` have `scrollHeight === clientHeight`.
Their `overscroll-behavior: contain` traps native pans in zero-range inner panes.
The prior mouse fallback targets only the list pane and exits on zero range. It
cannot fix document-owned lists, conversation messages, or guest detail.

- Phone list and transcript rules now permit native scroll chaining (`auto`).
  Desktop containment rules are unchanged.
- The existing phone mouse fallback now covers lists, transcript and customer
  card. It resolves a genuinely scrollable pane/ancestor, then the document.
- It keeps the movement threshold, scoped drag-click suppression, normal control
  behavior, native touch/pen behavior, pointer cancellation and capture cleanup.
- No height/layout redesign, DOM replacement, new scroller layer, or forced
  scroll-to-bottom refresh behavior is introduced.

The untouched base already permits native guest-card touch scrolling in the
synthetic fixture. This is preservation coverage, not a newly reproduced defect
on that surface. Guest-card mouse dragging fails on the base and is repaired.

## Repeatable local verification

```sh
npm run verify:phone-scroll-anywhere-refix-001
node scripts/verify-phone-inbox-open-at-newest-001.js
node scripts/verify-sunset-mobile-inbox-icon-only-sticky-no-guest-card-001.js
node scripts/verify-sunset-wave3-ui-polish-001.js
node scripts/verify-hermes-send-flags.js
npm run verify:luna-all
```

The new browser verifier emits real production portal HTML independently per
tenant and uses actual list navigation and detail handlers. Only HTTP data is
synthetic. Context-wide interception blocks external traffic and non-GET writes;
unrecognized API requests and browser exceptions fail the test. It does not
start a service or use live credentials.

Default phone viewports: 360, 390 and 430 CSS pixels wide, height 844. CDP native
touch sequences and Playwright mouse drags start inside the actual surfaces;
`elementFromPoint` hit tests, ancestor geometry and before/after scroll positions
are saved. Assertions require movement of an ancestor of the hit content, not
just arbitrary page motion. The verifier never assigns scrollTop to manufacture
acceptance. It also checks normal row opening, composer typing without sending,
and the Notes button opening its editor without saving.

Artifacts: `tmp/phone-scroll-refix-evidence/<run-label>/`. Optional
`SCROLL_WIDTHS=390` narrows a diagnostic run; the default command is the complete
phone-width matrix. The fast isolated pointer test separately covers bounded
panes, document fallback, native touch/pen, controls, desktop guard, jitter,
cancellation, capture loss, blur, resize and post-drag activation.

## Baseline qualifications

On base `b911e77ced4e2bad7d75b96e6c99a4746f872388`, `verify:luna-all` is 59/63
steps green. Candidate and untouched base fail the same assertions in:

- `verify:inbox-shell-channel-defaults`
- `verify:inbox-theme`
- `verify:inbox-middle-column-fill`
- `verify:luna-personality-live-eval` (includes unavailable Hermes `run_agent` /
  `gateway` imports in this environment)

`verify-portal-template-escapes` also fails on both base and candidate for the
pre-existing `scheduleNormalizeGuestPhone` regex emission. These are not silently
fixed or counted as passing coverage in this task.

Raw inbox UI byte parity changes intentionally. Restoring only the two owned
injected modules (`inbox-shell.js`, `inbox-rows.js`) in generated candidate HTML
recovers the saved base HTML byte-for-byte for both clients. The original parity
baseline remains intact.

## Staging acceptance after authorized landing

Local Chromium emulation is not a deployed-staging or physical iPhone Safari
sign-off. After separately authorized publication/landing, record the served
revision and repeat on Wolfhouse and Sunset staging:

- With long content, swipe up/down directly over list row text, message bubbles,
  and guest-card body text. Also start native finger swipes over action labels.
- Do not use surrounding whitespace, scrollbar thumbs, wheel-only gestures, or
  script-assigned scroll offsets as substitutes.
- Confirm a swipe does not activate a row/button; a tap still does. Check the
  reply composer and guest editor without sending/saving.
- Confirm initial conversation opening still reaches the newest message and
  reading older history is not reset by unchanged refresh.
- Check a real iOS Safari phone and Android Chrome, plus a desktop width. No
  booking/payment execution, guest sends, production action, or gateway restart
  is part of this acceptance procedure.
