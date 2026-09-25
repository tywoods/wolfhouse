# Booking drawer tabs + Schedule resize rail

Local UI-only change for BOOKING-DRAWER-TABS-CHROME-001.
Base: `0149392ddae92c9e2c95ad34cb90c3970df5ea52`.

## Scope

- Overview / Service / Transfer / Payment inactive tabs: `#3A3A3C`, labels `#F5F5F7`.
- Calendar resize rail: the identical `--bc-inactive-chrome` fill; grip `#D1D1D6`.
- Selected tab retains its theme's panel background. Square bottom corners, no bottom border, and a one-pixel overlap join it to the panel.
- Root cause of floating-button appearance: the compact side-drawer rule reset all corner radii, all borders, and the active tab's negative bottom margin.
- No changes to booking logic, tab labels/order, payment flows, guest messaging, resize handlers, or Inbox resize handle.
- Dark theme keeps the active tab matched to the dark panel; inactive grey is identical across themes.

## Browser regression

```sh
node scripts/verify-booking-drawer-tabs-chrome.js tmp/tabs-chrome-evidence
```

Requires existing Playwright/Chromium. Emits the real `/staff/ui` including injected browser modules. All network is intercepted; explicit synthetic HTTP fixtures and source-derived tenant profiles are used. External fonts are blocked (fallback fonts); local header assets are served from the repository. No live data, credentials or API writes.

Wolfhouse: real calendar booking click, all four real tab clicks in light/dark themes, computed colour/contrast/border checks, hit-testing at the active/panel seam, screenshots, no drawer overflow, and mouse-drag resize. The rail decreased from 620px to 535px in the recorded desktop run.

Sunset: source profile uses `portal-home` and hides `bed-calendar` plus the Transfer tab. The regression verifies ordinary routing remains on the native surf Schedule and that the lodging rail/drawer is not exposed. Its screenshot is a native-profile non-regression view, **not** proof of a four-tab Sunset drawer. No profile override is used to manufacture coverage.

Network ledgers and JS errors are captured; unknown same-origin endpoints, missing local assets, invalid tenant queries, mutation attempts and JS exceptions fail the gate. The run records ten results: eight tab/theme cases, one resize case and one Sunset native-profile case.

## Verification results

- Browser gate on untouched base: 48 intended chrome assertion failures; ten result records. This establishes RED using the same production entrypoint.
- Browser gate on candidate: ten records, zero failures.
- `verify-staff-calendar-chrome.js`: PASS.
- `verify-wolfhouse-bookings-detail-route.js`: PASS (desktop + mobile).
- `verify-cancel-booking-scroll-001.js`: PASS (desktop + phone).
- Node syntax and `git diff --check`: PASS.
- `verify-booking-drawer-equipment-reorg.js`: fails its existing `drawer green token on create modal` assertion identically on base and candidate. Not repaired in this chrome scope.
- Full `verify-inbox-ui-parity.js`: expected FAIL, because this task intentionally changes rendered CSS. Baseline retained; emitted markup/scripts outside style blocks are byte-identical for both tenants. All Inbox resize-handle rules are byte-identical. Do not replace the baseline and label this a parity pass.

## Live staging evidence boundary / landing follow-up

Both `staff-staging.lunafrontdesk.com/staff/ui` and `sunset-staging.lunafrontdesk.com/staff/ui` redirected the available browser to sign-in. Local screenshots do not satisfy authenticated deployed-staging proof. No deployment or credential action was taken.

After separately authorized landing, Skipper/operator should verify the deployed SHA, open a safe existing Wolfhouse staging booking at desktop width, click all four tabs, inspect the active seam, and drag the Schedule rail. Capture the inactive grey and rail in the same frame. Check light/dark contrast. On Sunset, verify its native Schedule/booking drawer remains unchanged; if staging exposes a lodging drawer unlike the source profile, capture that discrepancy and the actual tab chrome. No booking edits/sends/payments are needed.

No production, no port 8094, no gateway restart. Live-staging evidence remains an explicit acceptance follow-up, not a claimed result.
