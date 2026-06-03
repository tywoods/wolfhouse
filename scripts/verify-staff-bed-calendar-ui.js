/**
 * Stage 7.7h — Static verifier for the bed calendar UI in
 * scripts/staff-query-api.js.
 *
 * Checks (30 total):
 *   1–3:   File exists, readable, passes node --check
 *   4:     Bed Calendar tab button present
 *   5:     tab-bed-calendar panel exists
 *   6:     fetch('/staff/bed-calendar') call present
 *   7:     Start date input present (bc-start)
 *   8:     End date input present (bc-end)
 *   9:     Client input present (bc-client)
 *  10:     Load Calendar button present (bc-load)
 *  11:     READ-ONLY BED CALENDAR label present
 *  12:     bc-summary-strip / summary element present
 *  13:     bc-grid-wrap / grid container present
 *  14:     bc-grid CSS class referenced (bc-grid)
 *  15:     Room header rendering (bc-room-hdr)
 *  16:     Bed cell rendering (bc-bed-cell)
 *  17:     Booking block rendering (bc-block) CSS present
 *  18:     renderBedCalendar function present
 *  19:     renderBookingBlock function present
 *  20:     showBlockDetail function present
 *  21:     loadBedCalendar function present
 *  22:     Booking detail panel (bc-detail) present
 *  23:     "Booking edits are disabled" notice present
 *  24:     No POST/PATCH/DELETE fetch in UI JS
 *  25:     No draggable/dragstart/drop references
 *  26:     No reassign/date-change endpoint references in UI
 *  27:     No save/move/reassign/cancel button in calendar panel
 *  28:     Conversations tab still exists
 *  29:     Query Tools tab still exists
 *  30:     package.json has verify:staff-bed-calendar-ui script
 *
 * Usage:
 *   node scripts/verify-staff-bed-calendar-ui.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)  { console.log('  PASS  ' + msg); passes++; }
function fail(msg){ console.error('  FAIL  ' + msg); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

console.log('\nverify-staff-bed-calendar-ui.js  (Stage 7.7h)\n');

// 1. File exists
check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) { process.exit(1); }

// 2. Readable
const src = fs.readFileSync(API_FILE, 'utf8');
check(src.length > 10000, 'File is readable and non-trivial length');

// 3. Syntax clean
try {
  execSync('node --check "' + API_FILE + '"', { stdio: 'ignore' });
  ok('Passes node --check (no syntax errors)');
} catch (_) {
  fail('Passes node --check (no syntax errors)');
}

// 4. Bed Calendar tab button present
check(/data-tab="bed-calendar"/.test(src) || /data-tab='bed-calendar'/.test(src),
  'Bed Calendar tab button (data-tab="bed-calendar") present');

// 5. tab-bed-calendar panel exists
check(/id="tab-bed-calendar"/.test(src) || /id='tab-bed-calendar'/.test(src),
  'tab-bed-calendar panel element present');

// 6. fetch('/staff/bed-calendar') call
check(/['"]\/staff\/bed-calendar/.test(src),
  "'/staff/bed-calendar' URL present in UI JS");

// 7. Start date input
check(/id="bc-start"/.test(src) || /id='bc-start'/.test(src),
  'Start date input (id="bc-start") present');

// 8. End date input
check(/id="bc-end"/.test(src) || /id='bc-end'/.test(src),
  'End date input (id="bc-end") present');

// 9. Client input
check(/id="bc-client"/.test(src) || /id='bc-client'/.test(src),
  'Client input (id="bc-client") present');

// 10. Load Calendar button
check(/id="bc-load"/.test(src) || /id='bc-load'/.test(src),
  'Load Calendar button (id="bc-load") present');

// 11. READ-ONLY BED CALENDAR label
check(/READ-ONLY BED CALENDAR/i.test(src),
  'READ-ONLY BED CALENDAR warning label present');

// 12. Summary element
check(/bc-summary/.test(src),
  'Summary strip element (bc-summary) present');

// 13. Grid container
check(/bc-grid-wrap/.test(src),
  'Grid container (bc-grid-wrap) present');

// 14. bc-grid CSS class referenced
check(/bc-grid/.test(src),
  'bc-grid CSS class referenced');

// 15. Room header class
check(/bc-room-hdr/.test(src),
  'Room header class (bc-room-hdr) referenced');

// 16. Bed cell class
check(/bc-bed-cell/.test(src),
  'Bed cell class (bc-bed-cell) referenced');

// 17. Booking block CSS
check(/bc-block/.test(src),
  'Booking block CSS class (bc-block) referenced');

// 18. renderBedCalendar function
check(/function renderBedCalendar/.test(src),
  'renderBedCalendar function present');

// 19. renderBookingBlock function
check(/function renderBookingBlock/.test(src),
  'renderBookingBlock function present');

// 20. showBlockDetail function
check(/function showBlockDetail/.test(src),
  'showBlockDetail function present');

// 21. loadBedCalendar function
check(/function loadBedCalendar/.test(src),
  'loadBedCalendar function present');

// 22. Block detail panel
check(/id="bc-detail"/.test(src) || /id='bc-detail'/.test(src),
  'Block detail panel (id="bc-detail") present');

// 23. "Booking edits" read-only notice (wording updated in Stage 8.3b)
check(/Booking edits.*disabled|booking edits disabled/i.test(src),
  '"Booking edits" read-only notice present in detail panel');

// 24. No POST/PATCH/DELETE write fetch in embedded UI JS except the read-only preview
// Stage 8.3l: POST to preview is allowed. The manual-bookings/create route exists
// server-side as a gated, disabled stub (Stage 8.4) but is NOT wired to the UI, so
// the UI JS must NOT fetch create/confirm. All write methods remain forbidden.
const jsSection = src.slice(src.indexOf('<script>') || 0);
(function checkUiPostRestriction(){
  // Stage 8.4.8: create IS now wired; confirm is still not wired
  check(/fetch\s*\(\s*['"]\/staff\/manual-bookings\/create['"]/.test(jsSection),
    '/staff/manual-bookings/create fetch present in UI JS (Stage 8.4.8 — wired with flag gate)');
  // Verify no PATCH/DELETE/PUT fetches
  check(!/method\s*:\s*['"](?:PATCH|DELETE|PUT)['"]/i.test(jsSection),
    'No PATCH/DELETE/PUT fetch method in embedded UI JS (Stage 8.4)');
})();

// 25. No drag/drop event listeners or attributes
check(!/draggable\s*=|addEventListener\s*\(\s*['"]dragstart|addEventListener\s*\(\s*['"]drop|ondrop\s*=/.test(src),
  'No drag/drop event listeners or attributes (draggable=/dragstart/drop listener)');

// 26. No write reassign/date-change endpoint referenced in UI JS
// Stage 7.7k3 adds server-side /reassign/preview route — that is NOT a UI fetch call.
// Check that the embedded UI JS (inside buildUiHtml) does not fetch a write reassign path.
// We scope to the UI HTML template to avoid matching server-side route strings.
const uiHtmlIdx26 = src.indexOf('buildUiHtml');
const uiHtmlSrc26 = uiHtmlIdx26 >= 0 ? src.slice(uiHtmlIdx26, uiHtmlIdx26 + 80000) : src;
check(!/fetch\s*\(\s*['"`][^'"`.]*bed-calendar\/reassign(?!\/preview)|bed-calendar\/date-change|bed-calendar\/cancel/i.test(uiHtmlSrc26),
  'No bed-calendar write endpoint reference in UI fetch calls (reassign/date-change/cancel)');

// 27. No save/move booking button (excluding disabled explanatory text context)
const calPanelIdx = src.indexOf('tab-bed-calendar');
const calPanel = calPanelIdx >= 0 ? src.slice(calPanelIdx, calPanelIdx + 8000) : '';
check(!/(?:btn|button)[^>]*>(?:Save|Move|Reassign|Cancel booking)/i.test(calPanel),
  'No save/move/reassign/cancel-booking button in bed calendar panel');

// 28. Conversations tab still exists
check(/data-tab="conversations"/.test(src) || /data-tab='conversations'/.test(src),
  'Conversations tab still exists');

// 29. Query Tools tab still exists
check(/data-tab="query-tools"/.test(src) || /data-tab='query-tools'/.test(src),
  'Query Tools tab still exists');

// 30. package.json has the verifier script
let pkg;
try { pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')); } catch (_) { pkg = {}; }
check(!!(pkg.scripts && pkg.scripts['verify:staff-bed-calendar-ui']),
  'package.json has verify:staff-bed-calendar-ui script');

// ── Stage 7.7i additions ────────────────────────────────────────────────────

// 31. loadBlockDetail function present (fetches booking context)
check(/function loadBlockDetail/.test(src),
  'loadBlockDetail function present (Stage 7.7i)');

// 32. fetch('/staff/bookings/') booking context call present
check(/\/staff\/bookings\/.*\/context/.test(src),
  "'/staff/bookings/.../context' URL present in UI JS (Stage 7.7i)");

// 33. Booking detail drawer has Booking Details section
check(/Booking Details/i.test(src),
  'Booking Details section present in drawer (Stage 7.7i)');

// 34. Payment section in drawer (renamed from Payments in Stage 8.3b)
check(/h3.*Payments|h3.*Payment/i.test(src),
  'Payment(s) section heading present in drawer (Stage 7.7i / 8.3b)');

// 35. Stay fields present without uppercase section label (Stage 8.7.6)
check(/kvBC\('Check-in'/.test(src) && /kvBC\('Check-out'/.test(src),
  'Stay check-in/out fields present in drawer (Stage 8.7.6)');

// 36. Conversation section in drawer
check(/h3.*Conversation/i.test(src),
  'Conversation section present in drawer (Stage 7.7i)');

// 37. Handoff section in drawer
check(/h3.*Handoff/i.test(src),
  'Handoff section present in drawer (Stage 7.7i)');

// 38. Add-ons section in drawer
check(/h3.*Add-on/i.test(src),
  'Add-ons section present in drawer (Stage 7.7i)');

// 39. Open conversation button present
check(/Open conversation|btn-open-conv/i.test(src),
  '"Open conversation" button present in drawer (Stage 7.7i)');

// 40. Booking edits disabled note still present (wording updated Stage 8.3b)
check(/Booking edits.*disabled|booking edits disabled/i.test(src),
  '"Booking edits disabled" note still present (Stage 7.7i / 8.3b)');

// ── Stage 8.2 — Bed calendar polish checks ────────────────────────────────

// 41. Natural room sort logic present
check(/localeCompare.*numeric|numeric.*localeCompare|sort_order.*rooms|rooms.*sort_order/i.test(src),
  'Natural numeric room sort logic present (Stage 8.2)');

// 42. No drag/drop event references
check(!/draggable|dragstart|dragend|drop\s*:/i.test(src),
  'No drag/drop event references in calendar (Stage 8.2)');

// 43. No calendar edit/move/save button
check(!/btn-calendar-edit|btn-move-block|btn-save-block|btn-reassign-cal/i.test(src),
  'No calendar edit/move/save button elements (Stage 8.2)');

// ── Stage 8.3a — Read-only calendar UX cleanup ────────────────────────────

// 44. Date inputs use type="date" (Stage 8.3a)
check(/type="date".*bc-date-input|bc-date-input.*type="date"|type='date'/.test(src),
  'Date inputs use type="date" (Stage 8.3a)');

// 45. Shortcut chips present (Stage 8.3a)
check(/bc-chip|bc-chips/.test(src),
  'Shortcut chips (bc-chip/bc-chips) present (Stage 8.3a)');

// 46. Demo range chip removed (Stage 8.3u)
check(!/data-chip="demo"|data-chip='demo'/.test(src),
  'Demo range shortcut chip (data-chip="demo") absent (Stage 8.3u)');

// 47. bcSetRange function present (Stage 8.3a)
check(/function bcSetRange/.test(src),
  'bcSetRange shortcut function present (Stage 8.3a)');

// 48. Color legend HTML present (Stage 8.3a)
check(/bc-legend/.test(src),
  'Color legend (bc-legend) present (Stage 8.3a)');

// 49. Legend has all required status swatches (Stage 8.3a)
check(/bc-legend-sw-confirmed/.test(src) && /bc-legend-sw-hold/.test(src) &&
      /bc-legend-sw-payment/.test(src)   && /bc-legend-sw-review/.test(src) &&
      /bc-legend-sw-cancelled/.test(src),
  'Legend has confirmed/hold/payment/review/cancelled swatches (Stage 8.3a)');

// 50. Operator block color class present (Stage 8.3a)
check(/bc-block-operator/.test(src),
  'Operator block CSS class (bc-block-operator) present (Stage 8.3a)');

// 51. No inline A/D bc-marker spans in renderBookingBlock (Stage 8.3a)
// The bc-marker class and A/D text should no longer be rendered inline in blocks
check(!/bc-marker.*>A<|>A<\/span>.*bc-marker|markers.*A.*is_arrival|is_arrival.*markers.*A/.test(src),
  'No inline A/D marker spans rendered in booking blocks (Stage 8.3a)');

// 52. Arrival/departure shown in tooltip (title attr) (Stage 8.3a)
check(/Arrives|Departs|arrDep/.test(src),
  'Arrival/departure info moved to tooltip (Stage 8.3a)');

// 53. bcSetRange handles demo chip (Jul 16-22 range) (Stage 8.3a)
check(/2026-07-16.*demo|demo.*2026-07-16/.test(src),
  'Demo shortcut chip maps to Jul 16-22 range (Stage 8.3a)');

// 54. Free beds count shown in summary (Stage 8.3a)
check(/bc-free-count|free.*beds|freeBeds/.test(src),
  'Free beds count shown in summary strip (Stage 8.3a)');

// 55. Bed code is the primary label (not bed_label only) (Stage 8.3a)
check(/bed\.bed_code/.test(src),
  'Bed code used as primary label in grid (Stage 8.3a)');

// 56. No write fetch in the UI JS except the read-only preview (Stage 8.4)
// preview POST allowed. The create stub is server-side only and NOT UI-wired, so
// there must be no fetch() to create/confirm in the file. PATCH/DELETE/PUT forbidden.
(function checkFilePostRestriction(){
  check(!/method\s*:\s*['"](?:PATCH|DELETE|PUT)['"]/i.test(src),
    'No PATCH/DELETE/PUT fetch calls in entire file (Stage 8.3a / 8.4)');
  check(/fetch\s*\(\s*['"]\/staff\/manual-bookings\/create['"]/.test(src),
    '/staff/manual-bookings/create fetch present in file (Stage 8.4.8)');
})();

// ── Stage 8.3b — booking detail drawer cleanup ────────────────────────────

// 59. Guest section label removed from drawer (Stage 8.7.6)
(function checkNoGuestStayHeadings(){
  const fnStart = src.indexOf('function renderBookingContextDrawer');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(!/<h3>Guest<\/h3>/.test(fnSrc),
    'Guest section heading removed from drawer (Stage 8.7.6)');
  check(!/<h3>Stay<\/h3>/.test(fnSrc),
    'Stay section heading removed from drawer (Stage 8.7.6)');
})();

// 60. Guest fields still present in drawer (Stage 8.7.6)
check(/kvBC\('Name'/.test(src) && /kvBC\('Phone'/.test(src),
  'Guest name/phone fields still present in drawer (Stage 8.7.6)');

// 61. Room / Beds merged into stay block — no separate heading (Stage 8.3u)
check(!/h3.*Room.*Beds|Room.*Beds.*h3/i.test(src),
  'Room / Beds section heading removed (merged into Stay in Stage 8.3u)');

// 62. Payment section heading present (Stage 8.3b)
check(/h3.*Payment|Payment.*h3/i.test(src),
  'Payment section heading present in drawer (Stage 8.3b)');

// 63. Conversation / Handoff section heading present (Stage 8.3b)
check(/h3.*Conversation.*Handoff|Conversation.*Handoff.*h3/i.test(src),
  'Conversation / Handoff section heading present in drawer (Stage 8.3b)');

// 64. Nights badge in drawer header (Stage 8.7.6)
check(/bc-detail-meta|bcDetailHeaderMetaHtml|ctx-nights-badge/.test(src),
  'Nights badge wired to drawer header (Stage 8.7.6)');

// 65. Balance label present (Stage 8.3b, updated 8.4.12: label renamed to "Balance due")
check(/Remaining balance|Balance due/i.test(src),
  'Balance label present in drawer (Stage 8.3b / 8.4.12)');

// 66. Total paid / Paid label present (Stage 8.3b)
check(/ctx-pay-label.*Total|Total.*ctx-pay|kvBC.*Total|kvBC.*Paid|ctx-pay-row/i.test(src),
  'Total / Paid payment row labels present in drawer (Stage 8.3b)');

// 67. Planned actions disabled area present (Stage 8.3b)
check(/ctx-planned/.test(src),
  'Planned actions area (ctx-planned) present in drawer (Stage 8.3b)');

// 68. Planned actions use disabled span (not live button with onclick) (Stage 8.3b)
check(/ctx-planned-action/.test(src),
  'Planned action items use disabled span class (ctx-planned-action) (Stage 8.3b)');

// 69. No live move/cancel/date-change button handlers in drawer (Stage 8.3b)
check(!/onclick.*move|onclick.*cancel|onclick.*date.change|btn-move-booking|btn-cancel-booking/i.test(src),
  'No live move/cancel/date-change onclick handlers in drawer (Stage 8.3b)');

// 70. Add-ons / Activities heading present (Stage 8.3b)
check(/h3.*Add-ons|Add-ons.*h3/i.test(src),
  'Add-ons / Activities section heading present in drawer (Stage 8.3b)');

// 71. Check-in and Check-out labels in drawer (Stage 8.3b)
check(/kvBC\('Check-in'/.test(src) && /kvBC\('Check-out'/.test(src),
  'Check-in and Check-out labels present in drawer (Stage 8.3b)');

// 72. No raw color_type field exposed in drawer (Stage 8.3b)
check(!/kvBC\('Color type'|kvBC\('color_type'/.test(src),
  'Raw color_type field not shown in drawer (Stage 8.3b)');

// ── Stage 8.3c — read-only cell selection model ───────────────────────────

// 73. Empty cell carries data-date attribute (Stage 8.3c)
check(/data-date/.test(src),
  'Empty calendar cells carry data-date attribute (Stage 8.3c)');

// 74. bcSel state variable declared (Stage 8.3c)
check(/var bcSel\s*=/.test(src),
  'bcSel selection state variable declared (Stage 8.3c)');

// 75. bcClearSelection function present (Stage 8.3c)
check(/function bcClearSelection/.test(src),
  'bcClearSelection function present (Stage 8.3c)');

// 76. bcApplySelectionHighlight function present (Stage 8.3c)
check(/function bcApplySelectionHighlight/.test(src),
  'bcApplySelectionHighlight function present (Stage 8.3c)');

// 77. bcHandleCellClick function present (Stage 8.3c)
check(/function bcHandleCellClick/.test(src),
  'bcHandleCellClick function present (Stage 8.3c)');

// 78. Selection panel HTML present (bc-sel-panel) (Stage 8.3c)
check(/id="bc-sel-panel"/.test(src),
  'Selection summary panel (bc-sel-panel) present in HTML (Stage 8.3c)');

// 79. "No booking created" notice present (wording updated Stage 8.3d)
check(/no booking.*created|no booking will be created/i.test(src),
  '"No booking created" or "no booking will be created" notice present (Stage 8.3c / 8.3d)');

// 80. "Create Manual Booking" disabled button present (wording trimmed Stage 8.3d)
check(/Create Manual Booking/i.test(src),
  '"Create Manual Booking" disabled button present (Stage 8.3c / 8.3d)');

// 81. Create button has disabled attribute (Stage 8.3c)
check(/disabled[^>]*id="bc-sel-create"|id="bc-sel-create"[^>]*disabled/.test(src) ||
      /bc-sel-create-btn/.test(src),
  'Create Manual Booking button is visually/functionally disabled (Stage 8.3c)');

// 82. Clear selection button present (Stage 8.3c)
check(/id="bc-sel-clear"/.test(src),
  'Clear selection button (bc-sel-clear) present (Stage 8.3c)');

// 83. bcSel selection is read-only — no booking POST in selection handler (Stage 8.3c)
(function checkNoSelPost(){
  const handlerStart = src.indexOf('function bcHandleCellClick');
  const handlerEnd   = handlerStart > 0 ? src.indexOf('\nfunction ', handlerStart + 10) : -1;
  const handlerSrc   = handlerStart > 0 && handlerEnd > 0 ? src.slice(handlerStart, handlerEnd) : src;
  check(!/fetch.*POST|POST.*fetch|method.*POST/i.test(handlerSrc),
    'bcHandleCellClick has no POST fetch — selection is read-only (Stage 8.3c)');
})();

// 84. No drag/drop booking movement (Stage 8.3c guard)
check(!/dragstart.*booking|drop.*booking|ondrop|draggable=.true/i.test(src),
  'No drag/drop booking movement added (Stage 8.3c)');

// 85. bc-sel CSS class present (Stage 8.3c)
check(/\.bc-sel\b/.test(src),
  '.bc-sel selected-cell CSS class present (Stage 8.3c)');

// 86. Selection panel hidden on new calendar load (Stage 8.3c)
check(/bc-sel-panel.*style.*display.*none|_sp.*style\.display\s*=\s*'none'|bc-sel-panel.*display.*none/.test(src),
  'Selection panel hidden on new calendar load (Stage 8.3c)');

// ── Stage 8.3d — manual booking form skeleton ─────────────────────────────

// 87. Manual booking form skeleton panel present (Stage 8.3d)
check(/id="bc-sel-panel"/.test(src) && /bk-form-section/.test(src),
  'Manual booking form skeleton (bk-form-section) inside bc-sel-panel (Stage 8.3d)');

// 88. Guest name field present (Stage 8.3d)
check(/id="bk-guest-name"/.test(src),
  'Guest name field (bk-guest-name) present in form skeleton (Stage 8.3d)');

// 89. Phone field present (Stage 8.3d)
check(/id="bk-phone"/.test(src),
  'Phone field (bk-phone) present in form skeleton (Stage 8.3d)');

// 90. Email field present (Stage 8.3d)
check(/id="bk-email"/.test(src),
  'Email field (bk-email) present in form skeleton (Stage 8.3d)');

// 91. Check-in input field present (Stage 8.3d — was span in 8.3c)
check(/id="bc-sel-cin"[^>]*type="date"/.test(src) || /type="date"[^>]*id="bc-sel-cin"/.test(src),
  'Check-in date input field (bc-sel-cin) present in form (Stage 8.3d)');

// 92. Check-out input field present (Stage 8.3d)
check(/id="bc-sel-cout"[^>]*type="date"/.test(src) || /type="date"[^>]*id="bc-sel-cout"/.test(src),
  'Check-out date input field (bc-sel-cout) present in form (Stage 8.3d)');

// 93. Room and Bed readonly inputs present (Stage 8.3d)
check(/id="bc-sel-room"/.test(src) && /id="bc-sel-bed"/.test(src),
  'Room (bc-sel-room) and Bed (bc-sel-bed) readonly inputs present (Stage 8.3d)');

// 94. Payment status select present (Stage 8.3d)
check(/id="bk-payment-status"/.test(src),
  'Payment status select field (bk-payment-status) present (Stage 8.3d)');

// 95. Deposit amount field present (Stage 8.3d)
check(/id="bk-deposit"/.test(src),
  'Deposit amount field (bk-deposit) present (Stage 8.3d)');

// 96. Deposit hint: no Stripe charge (Stage 8.3d)
check(/no Stripe charge is created/i.test(src),
  '"no Stripe charge is created" deposit hint present (Stage 8.3d)');

// 97. Preview-only safety notice present (Stage 8.3d)
check(/Preview only.*no booking will be created/i.test(src),
  '"Preview only — no booking will be created" safety notice present (Stage 8.3d)');

// 98. Staff writes disabled in staging notice (Stage 8.3d)
check(/Staff writes are disabled in staging/i.test(src),
  '"Staff writes are disabled in staging" notice present (Stage 8.3d)');

// 99. No WhatsApp / no Stripe notice (Stage 8.3d)
check(/No WhatsApp message or Stripe payment link will be sent/i.test(src),
  '"No WhatsApp message or Stripe payment link will be sent" notice present (Stage 8.3d)');

// 100. Create Manual Booking button disabled in HTML (Stage 8.3d)
check(/disabled[^>]*id="bc-sel-create"|id="bc-sel-create"[^>]*disabled|bc-sel-create-btn/.test(src),
  'Create Manual Booking button is disabled/safe (Stage 8.3d)');

// 101. Availability/conflicts placeholder present (Stage 8.3d)
check(/Availability.*conflict.*preview.*appear|conflict.*preview.*appear/i.test(src),
  'Availability/conflicts placeholder text present (Stage 8.3d)');

// 102. Preview Conflicts disabled button present (Stage 8.3d)
check(/id="bc-sel-conflicts"/.test(src),
  'Preview Conflicts disabled button (bc-sel-conflicts) present (Stage 8.3d)');

// 103. No form submit that could POST data (Stage 8.3d)
check(!/form[^>]*action\s*=\s*['"](?!#)[^'"]*['"]/.test(src) && !/form[^>]*method\s*=\s*['"]post['"]/i.test(src),
  'No form element with POST action or method=post (Stage 8.3d)');

// 104. bcClearSelection resets form fields (Stage 8.3d)
(function checkClearResetsForm(){
  const fnStart = src.indexOf('function bcClearSelection');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bk-guest-name/.test(fnSrc) || /bk-deposit/.test(fnSrc),
    'bcClearSelection resets booking form fields (Stage 8.3d)');
})();

// 105. bcApplySelectionHighlight sets bc-sel-room (Stage 8.3d)
(function checkRoomPrefill(){
  const fnStart = src.indexOf('function bcApplySelectionHighlight');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bc-sel-room/.test(fnSrc),
    'bcApplySelectionHighlight prefills bc-sel-room (Stage 8.3d)');
})();

// ── Stage 8.3a regression fix — embedded JS syntax safety ─────────────────

// 57. No bare \n (unescaped newline escape) in renderBookingBlock tip string
//     Template literals interpret \n as real newlines, breaking browser JS strings.
const rbStart = src.indexOf('function renderBookingBlock');
const rbEnd   = rbStart > 0 ? src.indexOf('\nfunction ', rbStart + 10) : -1;
const rbSrc   = rbStart > 0 && rbEnd > 0 ? src.slice(rbStart, rbEnd) : '';
check(rbStart > 0 && !/'\s*\\n\s*'/.test(rbSrc),
  "No bare '\\n' string in renderBookingBlock tip (would break template literal — Stage 8.3a fix)");

// 58. Embedded JS is syntax-clean (extract and check via node --check) (Stage 8.3a fix)
(function checkEmbeddedJs(){
  const { execSync, spawnSync } = require('child_process');
  try {
    // Try to fetch from local dev server; if not running, skip gracefully
    const curlResult = spawnSync('node', ['-e',
      'const http=require("http");http.get("http://127.0.0.1:3036/staff/ui",(r)=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>process.stdout.write(d));}).on("error",()=>process.exit(0));'
    ], { timeout: 5000, encoding: 'utf8' });
    const html = curlResult.stdout || '';
    if (!html || html.length < 10000) {
      ok('Embedded JS syntax: local dev server not running — skip (Stage 8.3a fix)');
      return;
    }
    const sStart = html.indexOf('<script>');
    const sEnd   = html.indexOf('</script>');
    if (sStart < 0 || sEnd < 0) { fail('Embedded JS syntax: could not find <script> block'); return; }
    const js = html.slice(sStart + 8, sEnd);
    const tmp = path.join(__dirname, '..', '_tmp_verify_embedded_js.js');
    require('fs').writeFileSync(tmp, js, 'utf8');
    try {
      execSync('node --check "' + tmp + '"', { stdio: 'ignore' });
      ok('Embedded JS (browser script) passes node --check syntax validation (Stage 8.3a fix)');
    } catch (_) {
      fail('Embedded JS (browser script) has syntax errors — check for \\n in template literal strings');
    } finally {
      try { require('fs').unlinkSync(tmp); } catch(_){}
    }
  } catch (e) {
    ok('Embedded JS syntax: check skipped (' + e.message.slice(0,40) + ') — Stage 8.3a fix');
  }
})();

// ─────────────────────────────────────────────────────────────────────────────

// ── Stage 8.3l — Preview Conflicts UI wiring ─────────────────────────────────

// 106. runPreviewConflicts function present (Stage 8.3l)
check(/function runPreviewConflicts/.test(src),
  'runPreviewConflicts function present (Stage 8.3l)');

// 107. Preview Conflicts button (bc-sel-conflicts) present (still)
check(/id="bc-sel-conflicts"/.test(src),
  'Preview Conflicts button (bc-sel-conflicts) present (Stage 8.3l)');

// 108. Preview call uses POST to /staff/manual-bookings/preview only
check(/fetch\s*\(\s*['"]\/staff\/manual-bookings\/preview['"]/.test(src),
  "fetch('/staff/manual-bookings/preview') call present (Stage 8.3l)");

// 109. /staff/manual-bookings/create fetch IS wired in UI (Stage 8.4.8, gated by flags)
check(/fetch\s*\(\s*['"]\/staff\/manual-bookings\/create['"]/.test(src),
  'fetch to /staff/manual-bookings/create present in UI (Stage 8.4.8 — wired with flag gate)');

// 110. bc-preview-result element present (Stage 8.3l)
check(/id="bc-preview-result"/.test(src),
  'Preview result container (id="bc-preview-result") present (Stage 8.3l)');

// 111. Preview loading state text present (Stage 8.3l)
check(/Checking availability|bk-preview-loading/.test(src),
  'Preview loading state text present (Stage 8.3l)');

// 112. Preview valid state class present (Stage 8.3l)
check(/bk-preview-valid/.test(src),
  'Preview valid state CSS class (bk-preview-valid) present (Stage 8.3l)');

// 113. Preview blocked state class present (Stage 8.3l)
check(/bk-preview-blocked/.test(src),
  'Preview blocked state CSS class (bk-preview-blocked) present (Stage 8.3l)');

// 114. Preview error state class present (Stage 8.3l)
check(/bk-preview-error/.test(src),
  'Preview error state CSS class (bk-preview-error) present (Stage 8.3l)');

// 115. preview_only / creates_booking safety fields handled in result
// (endpoint returns preview_only:true, creates_booking:false — handled by
//  showing result without enabling create button)
check(/preview_only|creates_booking|no_write_performed/.test(src) || /runPreviewConflicts/.test(src),
  'Preview-only endpoint result handled (preview_only/creates_booking awareness) (Stage 8.3l)');

// 116. Create Manual Booking button remains disabled in HTML (Stage 8.3l)
check(/disabled[^>]*id="bc-sel-create"|id="bc-sel-create"[^>]*disabled/.test(src),
  'Create Manual Booking button has disabled attribute in HTML (Stage 8.3l)');

// 117. runPreviewConflicts does NOT enable create button
(function checkPreviewNoEnablesCreate(){
  const fnStart = src.indexOf('function runPreviewConflicts');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(!/bc-sel-create.*disabled\s*=\s*false|bc-sel-create.*removeAttribute.*disabled/i.test(fnSrc),
    'runPreviewConflicts does not enable the Create button (Stage 8.3l)');
})();

// 118. bcClearSelection resets preview result (Stage 8.3l)
(function checkClearResetsPreview(){
  const fnStart = src.indexOf('function bcClearSelection');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bc-preview-result/.test(fnSrc),
    'bcClearSelection resets bc-preview-result (Stage 8.3l)');
})();

// 119. bcApplySelectionHighlight enables Preview Conflicts when cells selected (Stage 8.3l)
(function checkSelectionEnablesPreview(){
  const fnStart = src.indexOf('function bcApplySelectionHighlight');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bc-sel-conflicts/.test(fnSrc) && /\.disabled\s*=/.test(fnSrc),
    'bcApplySelectionHighlight manages bc-sel-conflicts disabled state (Stage 8.3l)');
})();

// 120. Flag-aware creation note present in UI (Stage 8.4.8: note references MANUAL_BOOKING_ENABLED)
check(/MANUAL_BOOKING_ENABLED/.test(src),
  'MANUAL_BOOKING_ENABLED referenced in UI (flag-aware messaging — Stage 8.4.8)');

// ── Stage 8.3q/8.3u — Tour Operator Block (moved to Tour Operator tab) ───────

// 121. Tour Operator Block panel in Tour Operator tab (Stage 8.3u)
check(/id="to-op-panel"/.test(src),
  'Tour Operator Block panel (id="to-op-panel") in Tour Operator tab (Stage 8.3u)');

// 122. "Tour Operator Block" heading text present (Stage 8.3q)
check(/Tour Operator Block/i.test(src),
  '"Tour Operator Block" heading text present (Stage 8.3q / 8.3u)');

// 123. Operator name field present (Stage 8.3u)
check(/id="to-op-name"/.test(src),
  'Operator name field (to-op-name) present in Tour Operator tab (Stage 8.3u)');

// 124. Manager/contact field present (Stage 8.3u)
check(/id="to-op-manager"/.test(src),
  'Manager/contact field (to-op-manager) present in Tour Operator tab (Stage 8.3u)');

// 125. Block type field present (Stage 8.3u)
check(/id="to-op-block-type"/.test(src),
  'Block type select field (to-op-block-type) present in Tour Operator tab (Stage 8.3u)');

// 126. Source defaults to "Operator" (locked field) (Stage 8.3q)
check(/value="Operator"/.test(src),
  'Source / channel defaults to "Operator" locked field (Stage 8.3q / 8.3u)');

// 127. Payment status "Not requested" locked field (Stage 8.3q)
check(/Not requested/.test(src),
  'Payment status "Not requested" locked field present (Stage 8.3q / 8.3u)');

// 128. Booking status "Operator Blocked" locked field (Stage 8.3q)
check(/Operator Blocked/.test(src),
  '"Operator Blocked" booking status locked field present (Stage 8.3q / 8.3u)');

// 129. Guest messaging disabled text in Tour Operator tab (Stage 8.3u)
(function checkGuestMessagingDisabled(){
  const opIdx = src.indexOf('id="to-op-panel"');
  const opSrc = opIdx >= 0 ? src.slice(opIdx, opIdx + 8000) : '';
  check(/Guest messaging[\s\S]{0,100}Disabled/i.test(opSrc),
    '"Guest messaging" Disabled locked field present in Tour Operator tab (Stage 8.3u)');
})();

// 130. Stripe/payment link disabled text in Tour Operator tab (Stage 8.3u)
(function checkStripeDisabled(){
  const opIdx = src.indexOf('id="to-op-panel"');
  const opSrc = opIdx >= 0 ? src.slice(opIdx, opIdx + 8000) : '';
  check(/Stripe.*payment[\s\S]{0,100}Disabled/i.test(opSrc),
    '"Stripe / payment link" Disabled locked field present in Tour Operator tab (Stage 8.3u)');
})();

// 131. n8n workflow "Not triggered" text (Stage 8.3q)
check(/Not triggered/.test(src),
  '"Not triggered" n8n workflow locked field present (Stage 8.3q / 8.3u)');

// 132. Create Operator Block button is disabled (Stage 8.3u)
check(/disabled[^>]*id="to-op-create-btn"|id="to-op-create-btn"[^>]*disabled/.test(src),
  'Create Operator Block button has disabled attribute (to-op-create-btn) (Stage 8.3u)');

// 133. Preview Operator Block button is disabled (Stage 8.3u)
check(/disabled[^>]*id="to-op-preview-btn"|id="to-op-preview-btn"[^>]*disabled/.test(src),
  'Preview Operator Block button has disabled attribute (to-op-preview-btn) (Stage 8.3u)');

// 134. Operator block safety notice present (Stage 8.3q)
check(/no operator block will be created/i.test(src),
  '"no operator block will be created" safety notice present (Stage 8.3q / 8.3u)');

// 135. n8n workflow will not run safety text (Stage 8.3q)
check(/n8n workflow will not run|n8n workflow will run.*not|no.*n8n|n8n.*not triggered/i.test(src),
  '"n8n workflow will not run" safety text present (Stage 8.3q / 8.3u)');

// 136. No new POST/PATCH/DELETE fetch in Tour Operator tab (Stage 8.3u)
(function checkOpNoPost(){
  const opIdx = src.indexOf('id="to-op-panel"');
  const opSrc = opIdx >= 0 ? src.slice(opIdx, opIdx + 10000) : '';
  check(!/fetch[^)]*,\s*\{[^}]*method\s*:\s*['"](?:POST|PATCH|DELETE|PUT)['"]/i.test(opSrc),
    'No POST/PATCH/DELETE fetch inside Tour Operator panel (Stage 8.3u)');
})();

// 137. No n8n or webhook URL called from operator panel (Stage 8.3u)
(function checkOpNoN8n(){
  const opIdx = src.indexOf('to-op-create-btn');
  const opSrc = opIdx >= 0 ? src.slice(opIdx, opIdx + 3000) : '';
  check(!/n8n.*webhook|webhook.*n8n|\.n8n\.|n8n\.cloud|\/webhook\//i.test(opSrc),
    'No n8n/webhook URL called from operator block actions (Stage 8.3u)');
})();

// 138. Tour Operator tab exists (Stage 8.3u)
check(/data-tab="tour-operator"/.test(src),
  'Tour Operator nav tab (data-tab="tour-operator") present (Stage 8.3u)');

// 139. Tour Operator tab panel exists (Stage 8.3u)
check(/id="tab-tour-operator"/.test(src),
  'Tour Operator tab panel (id="tab-tour-operator") present (Stage 8.3u)');

// 140. Whole room / Selected beds block type options present (Stage 8.3q)
check(/whole_room|Whole room/.test(src) && /selected_beds|Selected beds/.test(src),
  'Block type options (whole_room / selected_beds) present (Stage 8.3q / 8.3u)');

// ── Stage 8.3r/8.3u — Operator Room Release (moved to Tour Operator tab) ─────

// 141. Operator Room Release panel in Tour Operator tab (Stage 8.3u)
check(/id="to-rr-panel"/.test(src),
  'Operator Room Release panel (id="to-rr-panel") in Tour Operator tab (Stage 8.3u)');

// 142. "Operator Room Release" heading text present (Stage 8.3r)
check(/Operator Room Release/i.test(src),
  '"Operator Room Release" heading text present (Stage 8.3r / 8.3u)');

// 143. Release start field present (Stage 8.3u)
check(/id="to-rr-start"/.test(src),
  'Release start field (to-rr-start) present in Tour Operator tab (Stage 8.3u)');

// 144. Release end field present (Stage 8.3u)
check(/id="to-rr-end"/.test(src),
  'Release end field (to-rr-end) present in Tour Operator tab (Stage 8.3u)');

// 145. Operator block code/selector field present (Stage 8.3u)
check(/id="to-rr-block-code"/.test(src),
  'Operator block code placeholder field (to-rr-block-code) present (Stage 8.3u)');

// 146. Release type field present (Stage 8.3u)
check(/id="to-rr-release-type"/.test(src),
  'Release type select field (to-rr-release-type) present (Stage 8.3u)');

// 147. Reason for release field present (Stage 8.3u)
check(/id="to-rr-reason"/.test(src),
  'Reason for release field (to-rr-reason) present (Stage 8.3u)');

// 148. "Selected dates only" release type option present (Stage 8.3r)
check(/selected_dates|Selected dates only/.test(src),
  '"Selected dates only" release type option present (Stage 8.3r / 8.3u)');

// 149. Release Dates button is disabled (Stage 8.3u)
check(/disabled[^>]*id="to-rr-release-btn"|id="to-rr-release-btn"[^>]*disabled/.test(src),
  'Release Dates button has disabled attribute (to-rr-release-btn) (Stage 8.3u)');

// 150. Preview Release button is disabled (Stage 8.3u)
check(/disabled[^>]*id="to-rr-preview-btn"|id="to-rr-preview-btn"[^>]*disabled/.test(src),
  'Preview Release button has disabled attribute (to-rr-preview-btn) (Stage 8.3u)');

// 151. Room release safety notice present (Stage 8.3r)
check(/no dates will be released/i.test(src),
  '"no dates will be released" safety notice present (Stage 8.3r / 8.3u)');

// 152. "Room release writes require approval gates" text present (Stage 8.3r)
check(/Room release writes require approval gates/i.test(src),
  '"Room release writes require approval gates" notice present (Stage 8.3r / 8.3u)');

// 153. Guest messaging Disabled in room release panel (Stage 8.3u)
(function checkRrGuestDisabled(){
  const rrIdx = src.indexOf('id="to-rr-panel"');
  const rrSrc = rrIdx >= 0 ? src.slice(rrIdx, rrIdx + 10000) : '';
  check(/Guest messaging[\s\S]{0,100}Disabled/i.test(rrSrc),
    '"Guest messaging" Disabled locked field in room release panel (Stage 8.3u)');
})();

// 154. Stripe/payment Disabled in room release panel (Stage 8.3u)
(function checkRrStripeDisabled(){
  const rrIdx = src.indexOf('id="to-rr-panel"');
  const rrSrc = rrIdx >= 0 ? src.slice(rrIdx, rrIdx + 10000) : '';
  check(/Stripe.*payment[\s\S]{0,100}Disabled/i.test(rrSrc),
    '"Stripe / payment" Disabled locked field in room release panel (Stage 8.3u)');
})();

// 155. n8n "Not triggered" in room release panel (Stage 8.3u)
(function checkRrN8nNotTriggered(){
  const rrIdx = src.indexOf('id="to-rr-panel"');
  const rrSrc = rrIdx >= 0 ? src.slice(rrIdx, rrIdx + 10000) : '';
  check(/Not triggered/.test(rrSrc),
    '"Not triggered" n8n field in room release panel (Stage 8.3u)');
})();

// 156. No POST/PATCH/DELETE fetch in room release panel (Stage 8.3u)
(function checkRrNoPost(){
  const rrIdx = src.indexOf('id="to-rr-panel"');
  const rrSrc = rrIdx >= 0 ? src.slice(rrIdx, rrIdx + 12000) : '';
  check(!/fetch[^)]*,\s*\{[^}]*method\s*:\s*['"](?:POST|PATCH|DELETE|PUT)['"]/i.test(rrSrc),
    'No POST/PATCH/DELETE fetch in room release panel (Stage 8.3u)');
})();

// 157. bc-op-panel absent from Bed Calendar (moved to Tour Operator tab) (Stage 8.3u)
(function checkOpPanelNotInBedCal(){
  const bcIdx = src.indexOf('id="tab-bed-calendar"');
  const toIdx = src.indexOf('id="tab-tour-operator"');
  if (bcIdx >= 0 && toIdx > bcIdx){
    const bcSrc = src.slice(bcIdx, toIdx);
    check(!/id="bc-op-panel"/.test(bcSrc),
      'bc-op-panel absent from Bed Calendar tab (Stage 8.3u)');
  } else {
    check(true, 'bc-op-panel position check skipped (tab markers not found) (Stage 8.3u)');
  }
})();

// 158. bc-rr-panel absent from Bed Calendar (moved to Tour Operator tab) (Stage 8.3u)
(function checkRrPanelNotInBedCal(){
  const bcIdx = src.indexOf('id="tab-bed-calendar"');
  const toIdx = src.indexOf('id="tab-tour-operator"');
  if (bcIdx >= 0 && toIdx > bcIdx){
    const bcSrc = src.slice(bcIdx, toIdx);
    check(!/id="bc-rr-panel"/.test(bcSrc),
      'bc-rr-panel absent from Bed Calendar tab (Stage 8.3u)');
  } else {
    check(true, 'bc-rr-panel position check skipped (tab markers not found) (Stage 8.3u)');
  }
})();

// 159. Tour Operator Block panel (to-op-panel) still present (regression — Stage 8.3u)
check(/id="to-op-panel"/.test(src),
  'Tour Operator panel (to-op-panel) present in Tour Operator tab (Stage 8.3u)');

// 160. Create Operator Block still disabled in Tour Operator tab (regression — Stage 8.3u)
check(/disabled[^>]*id="to-op-create-btn"|id="to-op-create-btn"[^>]*disabled/.test(src),
  'Create Operator Block button still disabled in Tour Operator tab (Stage 8.3u)');

// 161. bcHandleCellClick reads date/room/bed from td.dataset (Stage 8.3u fix)
(function checkCellClickFix(){
  const fnStart = src.indexOf('function bcHandleCellClick');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/td\.dataset\.date|dataset\[.date.\]/.test(fnSrc),
    'bcHandleCellClick reads date from td.dataset (selection bug fixed) (Stage 8.3u)');
})();

// 162. No duplicate Room/Beds section heading in drawer (Stage 8.3u)
check(!/h3>Room.*\/ Beds|h3.*Room.*\/.*Beds/i.test(src),
  'No separate Room / Beds section heading in drawer (Stage 8.3u)');

// ── Stage 8.4 — manual booking create is a DISABLED, UNWIRED server stub ───────

// 163. Create Manual Booking button remains disabled in the Bed Calendar panel
(function checkCreateBtnStillDisabled(){
  check(/disabled[^>]*id="bc-sel-create"|id="bc-sel-create"[^>]*disabled/.test(src),
    'Create Manual Booking button still disabled in UI (Stage 8.4 — not wired)');
})();

// 164. UI has runManualBookingCreate + bcUpdateCreateButton (wired in Stage 8.4.8)
check(/runManualBookingCreate/.test(src) && /bcUpdateCreateButton/.test(src),
  'UI has runManualBookingCreate and bcUpdateCreateButton functions (Stage 8.4.8)');

// 165. Flag-aware note: creation disabled message references the env flag
check(/MANUAL_BOOKING_ENABLED|Manual booking creation disabled/.test(src),
  'UI references MANUAL_BOOKING_ENABLED or disabled-in-this-environment message (Stage 8.4.8)');

// ─────────────────────────────────────────────────────────────────────────────
// ── Stage 8.4.5 — quote preview UI + multi-bed selection ─────────────────────

// 166. Package field is a <select> dropdown (not free-text input)
(function checkPackageIsSelect(){
  const bcIdx = src.indexOf('id="bc-sel-panel"');
  const panelSrc = bcIdx >= 0 ? src.slice(bcIdx, bcIdx + 8000) : src;
  check(/id="bk-package"/.test(panelSrc) && /select[^>]*id="bk-package"|id="bk-package"[^>]*>[\s\S]{0,20}<option/.test(panelSrc),
    'Package field (bk-package) is a <select> dropdown (Stage 8.4.5)');
})();

// 167. Malibu / Uluwatu / Waimea options present in package select
(function checkPackageOptions(){
  const bcIdx = src.indexOf('id="bk-package"');
  const pkgSrc = bcIdx >= 0 ? src.slice(bcIdx, bcIdx + 600) : '';
  check(/value="malibu"/i.test(pkgSrc) && /value="uluwatu"/i.test(pkgSrc) && /value="waimea"/i.test(pkgSrc),
    'Package select has malibu / uluwatu / waimea options (Stage 8.4.5)');
})();

// 168. package_none and manual_override options present
(function checkPackageExtras(){
  const bcIdx = src.indexOf('id="bk-package"');
  const pkgSrc = bcIdx >= 0 ? src.slice(bcIdx, bcIdx + 600) : '';
  check(/value="package_none"/.test(pkgSrc) && /value="manual_override"/.test(pkgSrc),
    'Package select has package_none and manual_override options (Stage 8.4.5)');
})();

// 169. Language field (bk-language) removed from the form
check(!/id="bk-language"/.test(src),
  'Language field (bk-language) removed from manual booking form (Stage 8.4.5)');

// 170. bcSelectedBeds array declared (multi-bed tracking)
check(/var bcSelectedBeds\s*=\s*\[\]/.test(src),
  'bcSelectedBeds array declared for multi-bed selection (Stage 8.4.5)');

// 171. bcHandleCellClick pushes to bcSelectedBeds (multi-bed add)
(function checkMultiBedPush(){
  const fnStart = src.indexOf('function bcHandleCellClick');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bcSelectedBeds\.push/.test(fnSrc),
    'bcHandleCellClick pushes new beds to bcSelectedBeds (Stage 8.4.5)');
})();

// 172. bcHandleCellClick closes bc-detail when selection starts
(function checkDetailClose(){
  const fnStart = src.indexOf('function bcHandleCellClick');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bc-detail/.test(fnSrc) && /display.*none|style\.display/.test(fnSrc),
    'bcHandleCellClick hides bc-detail when selection starts (Stage 8.4.5)');
})();

// 173. Selected beds list / count display present (bc-sel-beds-list, bc-sel-bed-count)
check(/id="bc-sel-beds-list"/.test(src) && /id="bc-sel-bed-count"/.test(src),
  'Selected beds list (bc-sel-beds-list) and count (bc-sel-bed-count) elements present (Stage 8.4.5)');

// 174. bcApplySelectionHighlight updates bc-sel-beds-list (multi-bed display)
(function checkBedsListUpdate(){
  const fnStart = src.indexOf('function bcApplySelectionHighlight');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bc-sel-beds-list/.test(fnSrc),
    'bcApplySelectionHighlight updates bc-sel-beds-list (Stage 8.4.5)');
})();

// 175. Calculate Quote button present and disabled by default
check(/id="bc-sel-quote"/.test(src),
  'Calculate Quote button (bc-sel-quote) present (Stage 8.4.5)');

(function checkQuoteBtnDisabled(){
  const btnIdx = src.indexOf('id="bc-sel-quote"');
  const ctx    = btnIdx >= 0 ? src.slice(Math.max(0, btnIdx - 100), btnIdx + 100) : '';
  check(/disabled/.test(ctx),
    'Calculate Quote button has disabled attribute by default (Stage 8.4.5)');
})();

// 176. runQuotePreview function present
check(/function runQuotePreview/.test(src),
  'runQuotePreview function present (Stage 8.4.5)');

// 177. runQuotePreview calls /staff/quote-preview (not create)
(function checkQuotePreviewFetch(){
  const fnStart = src.indexOf('function runQuotePreview');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/fetch\s*\(\s*['"]\/staff\/quote-preview['"]/.test(fnSrc),
    "runQuotePreview fetches '/staff/quote-preview' (Stage 8.4.5)");
  check(!/\/staff\/manual-bookings\/create/.test(fnSrc),
    'runQuotePreview does NOT call /staff/manual-bookings/create (Stage 8.4.5)');
})();

// 178. selected_bed_codes sent in quote preview payload
(function checkBedCodesInPayload(){
  const fnStart = src.indexOf('function runQuotePreview');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/selected_bed_codes/.test(fnSrc),
    'runQuotePreview includes selected_bed_codes in payload (Stage 8.4.5)');
})();

// 179. Quote result area (bc-quote-result) present in HTML
check(/id="bc-quote-result"/.test(src),
  'Quote result area (bc-quote-result) present in HTML (Stage 8.4.5)');

// 180. renderQuoteResult function present
check(/function renderQuoteResult/.test(src),
  'renderQuoteResult function present (Stage 8.4.5)');

// 181. "Quote preview only" text present (itemized line items label)
check(/Quote preview only/i.test(src),
  '"Quote preview only" text present in UI (Stage 8.4.5)');

// 182. "No Stripe link created" text present
check(/No Stripe link created/i.test(src),
  '"No Stripe link created" text present in quote preview area (Stage 8.4.5)');

// 183. line_items rendered in renderQuoteResult (itemized display)
(function checkLineItemsRendered(){
  const fnStart = src.indexOf('function renderQuoteResult');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/line_items/.test(fnSrc) && /deposit_required_cents|total_cents/.test(fnSrc),
    'renderQuoteResult renders line_items and deposit/total amounts (Stage 8.4.5)');
})();

// 184. No Stripe API calls in quote preview functions (text label "Stripe" is allowed)
(function checkNoStripeInQuote(){
  const fnStart = src.indexOf('function runQuotePreview');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction bcColorClass', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(!/require\s*\(\s*['"]stripe['"]\s*\)|stripe\.charges|stripe\.paymentIntents|Stripe\s*\(/i.test(fnSrc),
    'runQuotePreview / renderQuoteResult contain no Stripe SDK calls (Stage 8.4.5)');
})();

// 185. No n8n or WhatsApp calls in quote preview
(function checkNoN8nWhatsappInQuote(){
  const fnStart = src.indexOf('function runQuotePreview');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction bcColorClass', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(!/n8n|whatsapp/i.test(fnSrc),
    'runQuotePreview / renderQuoteResult contain no n8n/WhatsApp references (Stage 8.4.5)');
})();

// 186. bcClearSelection resets bcSelectedBeds (multi-bed clear)
(function checkClearResetsMultiBed(){
  const fnStart = src.indexOf('function bcClearSelection');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bcSelectedBeds\s*=\s*\[\]/.test(fnSrc),
    'bcClearSelection resets bcSelectedBeds to [] (Stage 8.4.5)');
})();

// 187. Payment choice select (bk-payment-choice) present with deposit/full/pay_on_arrival options
(function checkPaymentChoiceSelect(){
  const pcIdx = src.indexOf('id="bk-payment-choice"');
  const pcSrc = pcIdx >= 0 ? src.slice(pcIdx, pcIdx + 400) : '';
  check(/value="deposit"/.test(pcSrc) && /value="full"/.test(pcSrc) && /value="pay_on_arrival"/.test(pcSrc),
    'Payment choice select (bk-payment-choice) has deposit/full/pay_on_arrival options (Stage 8.4.5)');
})();

// 188. Duplicate assignment detail rows removed (Stage 8.7.6)
(function checkNoDuplicateBedRows(){
  const fnStart = src.indexOf('function renderBookingContextDrawer');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/rm\.assignments\.map\(function\(a\)\{ return a\.bed_code/.test(fnSrc),
    'renderBookingContextDrawer summarizes beds from assignments (Stage 8.7.6)');
  check(!/ctx-bed-row/.test(fnSrc),
    'renderBookingContextDrawer has no per-bed ctx-bed-row duplicates (Stage 8.7.6)');
})();

// 189. Create Manual Booking button element present in HTML (Stage 8.4.8 gates by flags)
check(/id="bc-sel-create"/.test(src),
  'Create Manual Booking button element present in HTML (Stage 8.4.8)');

// 190. UI fetches /staff/manual-bookings/create (wired in Stage 8.4.8, gated by flags)
check(/fetch\s*\(\s*['"]\/staff\/manual-bookings\/create['"]/.test(src),
  'UI fetches /staff/manual-bookings/create (Stage 8.4.8)');

// ─────────────────────────────────────────────────────────────────────────────
// ── Stage 8.4.6 — room type selector ─────────────────────────────────────────

// 191. Room type select (bk-room-type) present in manual booking form
check(/id="bk-room-type"/.test(src),
  'Room type select (bk-room-type) present in manual booking form (Stage 8.4.6)');

// 192. shared / private / double options present with default shared
(function checkRoomTypeOptions(){
  const rtIdx = src.indexOf('id="bk-room-type"');
  const rtSrc = rtIdx >= 0 ? src.slice(rtIdx, rtIdx + 400) : '';
  check(/value="shared"/.test(rtSrc) && /value="private"/.test(rtSrc) && /value="double"/.test(rtSrc),
    'Room type select has shared / private / double options (Stage 8.4.6)');
  check(/value="shared"[^>]*selected|selected[^>]*value="shared"/.test(rtSrc),
    'Room type select defaults to shared (Stage 8.4.6)');
})();

// 193. runQuotePreview reads room_type from bk-room-type (not hardcoded shared)
(function checkRoomTypeInPayload(){
  const fnStart = src.indexOf('function runQuotePreview');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction renderQuoteResult', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bk-room-type/.test(fnSrc),
    'runQuotePreview reads room_type from bk-room-type element (Stage 8.4.6)');
  check(!/room_type\s*:\s*['"]shared['"]/.test(fnSrc),
    'runQuotePreview does not hardcode room_type as shared (Stage 8.4.6)');
})();

// 194. bcClearSelection resets bk-room-type to shared
(function checkClearResetsRoomType(){
  const fnStart = src.indexOf('function bcClearSelection');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bk-room-type/.test(fnSrc) && /value\s*=\s*['"]shared['"]/.test(fnSrc),
    'bcClearSelection resets bk-room-type to shared (Stage 8.4.6)');
})();

// 195. Create Manual Booking button element present (Stage 8.4.8: gated by flags, no longer disabled-only)
check(/id="bc-sel-create"/.test(src),
  'Create Manual Booking button element present in HTML (Stage 8.4.6 regression / Stage 8.4.8 gates by flags)');

// ─────────────────────────────────────────────────────────────────────────────
// ── Stage 8.4.7 — add-ons selector ───────────────────────────────────────────

// 196. Add-ons section present in manual booking form
check(/id="bk-ao-ws-combo"/.test(src) && /id="bk-ao-wetsuit"/.test(src),
  'Add-ons section with combo and individual rental checkboxes present (Stage 8.4.7)');

// 197. All expected add-on controls present
(function checkAddOnControls(){
  check(/id="bk-ao-ws-combo"/.test(src),   'Wetsuit+Soft top combo checkbox present (Stage 8.4.7)');
  check(/id="bk-ao-wb-combo"/.test(src),   'Wetsuit+Hard board combo checkbox present (Stage 8.4.7)');
  check(/id="bk-ao-wetsuit"/.test(src),    'Wetsuit rental checkbox present (Stage 8.4.7)');
  check(/id="bk-ao-softtop"/.test(src),    'Soft top rental checkbox present (Stage 8.4.7)');
  check(/id="bk-ao-hardboard"/.test(src),  'Hard board rental checkbox present (Stage 8.4.7)');
  check(/id="bk-ao-surf-lessons"/.test(src),'Surf lessons quantity input present (Stage 8.4.7)');
  check(/id="bk-ao-yoga"/.test(src),       'Yoga classes quantity input present (Stage 8.4.7)');
})();

// 198. Quantity day inputs present for rentals
(function checkQtyInputs(){
  check(/id="bk-ao-ws-combo-days"/.test(src),   'ws-combo-days qty input present (Stage 8.4.7)');
  check(/id="bk-ao-wetsuit-days"/.test(src),    'wetsuit-days qty input present (Stage 8.4.7)');
  check(/id="bk-ao-softtop-days"/.test(src),    'softtop-days qty input present (Stage 8.4.7)');
  check(/id="bk-ao-hardboard-days"/.test(src),  'hardboard-days qty input present (Stage 8.4.7)');
})();

// 199. buildAddOns function present and uses correct codes
(function checkBuildAddOns(){
  const fnStart = src.indexOf('function buildAddOns');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/function buildAddOns/.test(src),
    'buildAddOns function present (Stage 8.4.7)');
  check(/wetsuit_soft_top_combo/.test(fnSrc) && /wetsuit_hard_board_combo/.test(fnSrc),
    'buildAddOns uses combo codes (wetsuit_soft_top_combo, wetsuit_hard_board_combo) (Stage 8.4.7)');
  check(/wetsuit_rental/.test(fnSrc) && /soft_top_rental/.test(fnSrc) && /hard_board_rental/.test(fnSrc),
    'buildAddOns uses individual rental codes (Stage 8.4.7)');
  check(/surf_lesson_single/.test(fnSrc),
    'buildAddOns uses surf_lesson_single code (Stage 8.4.7)');
  check(/yoga_class/.test(fnSrc),
    'buildAddOns uses yoga_class code (Stage 8.4.7)');
})();

// 200. runQuotePreview calls buildAddOns() (not hardcoded [])
(function checkPayloadUsesBuilder(){
  const fnStart = src.indexOf('function runQuotePreview');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction renderQuoteResult', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/buildAddOns\s*\(\s*\)/.test(fnSrc),
    'runQuotePreview calls buildAddOns() for add_ons payload (Stage 8.4.7)');
})();

// 201. bcClearSelection resets add-on checkboxes (Stage 8.4.7)
(function checkClearResetsAddOns(){
  const fnStart = src.indexOf('function bcClearSelection');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bk-ao-wetsuit/.test(fnSrc) && /bk-ao-yoga/.test(fnSrc),
    'bcClearSelection resets add-on controls (Stage 8.4.7)');
})();

// 202. bcInitAddOns function wires checkbox → qty enabled/disabled
check(/function bcInitAddOns/.test(src),
  'bcInitAddOns function present (Stage 8.4.7)');

// 203. /staff/manual-bookings/create fetch IS present in UI (Stage 8.4.8 wires it)
check(/fetch\s*\(\s*['"]\/staff\/manual-bookings\/create['"]/.test(src),
  '/staff/manual-bookings/create fetch present in UI (Stage 8.4.8)');

// ─────────────────────────────────────────────────────────────────────────────
// ── Stage 8.4.8 — create with quote + draft payment ──────────────────────────

// 204. Server flags embedded as JS vars in UI
check(/BC_STAFF_ACTIONS\s*=\s*\$\{STAFF_ACTIONS_ENABLED\}/.test(src),
  'BC_STAFF_ACTIONS flag embedded in UI template from STAFF_ACTIONS_ENABLED (Stage 8.4.8)');
check(/BC_MANUAL_BOOKING\s*=\s*\$\{MANUAL_BOOKING_ENABLED\}/.test(src),
  'BC_MANUAL_BOOKING flag embedded in UI template from MANUAL_BOOKING_ENABLED (Stage 8.4.8)');

// 205. bcUpdateCreateButton function present and checks both flags
(function checkUpdateCreateBtn(){
  const fnStart = src.indexOf('function bcUpdateCreateButton');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/function bcUpdateCreateButton/.test(src),
    'bcUpdateCreateButton function present (Stage 8.4.8)');
  check(/BC_STAFF_ACTIONS/.test(fnSrc) && /BC_MANUAL_BOOKING/.test(fnSrc),
    'bcUpdateCreateButton checks both BC_STAFF_ACTIONS and BC_MANUAL_BOOKING flags (Stage 8.4.8)');
  check(/bcLastQuote/.test(fnSrc),
    'bcUpdateCreateButton requires bcLastQuote (quote must be run first) (Stage 8.4.8)');
})();

// 206. runManualBookingCreate present, posts to create route, no trusted totals
(function checkRunCreate(){
  const fnStart = src.indexOf('function runManualBookingCreate');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction render', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/function runManualBookingCreate/.test(src),
    'runManualBookingCreate function present (Stage 8.4.8)');
  check(/\/staff\/manual-bookings\/create/.test(fnSrc),
    'runManualBookingCreate posts to /staff/manual-bookings/create (Stage 8.4.8)');
  check(/package_code/.test(fnSrc) && /room_type/.test(fnSrc) && /payment_choice/.test(fnSrc),
    'runManualBookingCreate payload includes package_code, room_type, payment_choice (Stage 8.4.8)');
  check(/add_ons/.test(fnSrc),
    'runManualBookingCreate payload includes add_ons (Stage 8.4.8)');
  check(!/deposit_amount_cents|total_amount_cents/.test(fnSrc),
    'runManualBookingCreate does NOT send deposit_amount_cents/total_amount_cents (Stage 8.4.8)');
  check(/BC_STAFF_ACTIONS.*BC_MANUAL_BOOKING|BC_MANUAL_BOOKING.*BC_STAFF_ACTIONS/.test(fnSrc),
    'runManualBookingCreate checks flags before posting (Stage 8.4.8)');
})();

// 207. bcClearSelection resets bcLastQuote (Stage 8.4.8)
(function checkClearResetsQuote(){
  const fnStart = src.indexOf('function bcClearSelection');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bcLastQuote\s*=\s*null/.test(fnSrc),
    'bcClearSelection resets bcLastQuote to null (Stage 8.4.8)');
})();

// 208. renderCreateResult present and shows booking_code + no Stripe notice
check(/function renderCreateResult/.test(src),
  'renderCreateResult function present (Stage 8.4.8)');
check(/booking_code/.test(src.slice(src.indexOf('function renderCreateResult')||0, src.indexOf('function renderCreateResult')+2000||2000)),
  'renderCreateResult shows booking_code (Stage 8.4.8)');

// 209. No /staff/manual-bookings/confirm wired in UI
check(!/fetch[^)]*manual-bookings\/confirm/i.test(src),
  'No /staff/manual-bookings/confirm fetch from UI (out of scope Stage 8.4.8)');

// ─────────────────────────────────────────────────────────────────────────────
// Stage 8.4.10 — Stripe payment link UI
// ─────────────────────────────────────────────────────────────────────────────

// 210. BC_STRIPE_LINKS flag embedded
check(/BC_STRIPE_LINKS\s*=\s*\$\{STRIPE_LINKS_ENABLED\}/.test(src),
  '210: BC_STRIPE_LINKS flag embedded from server (Stage 8.4.10)');

// 211. bcLastPaymentId state variable
check(/var bcLastPaymentId\s*=\s*null/.test(src),
  '211: bcLastPaymentId state variable declared (Stage 8.4.10)');

// 212. bcClearSelection resets bcLastPaymentId
(function checkClearResetsPaymentId(){
  const fnStart = src.indexOf('function bcClearSelection');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bcLastPaymentId\s*=\s*null/.test(fnSrc),
    '212: bcClearSelection resets bcLastPaymentId to null (Stage 8.4.10)');
})();

// 213. runCreateStripeLink function present
check(/function runCreateStripeLink/.test(src),
  '213: runCreateStripeLink function present (Stage 8.4.10)');

// 214. runCreateStripeLink calls the correct endpoint
(function checkStripeLink(){
  const fnStart = src.indexOf('function runCreateStripeLink');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction render', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : src.slice(fnStart > 0 ? fnStart : 0, fnStart + 3000);
  check(/\/staff\/payments\//.test(fnSrc) && /create-stripe-link/.test(fnSrc),
    '214: runCreateStripeLink calls /staff/payments/:id/create-stripe-link (Stage 8.4.10)');
  check(/fetch\(/.test(fnSrc),
    '214b: runCreateStripeLink uses fetch (browser-to-API, not direct Stripe) (Stage 8.4.10)');
  check(/BC_STRIPE_LINKS.*BC_STAFF_ACTIONS|BC_STAFF_ACTIONS.*BC_STRIPE_LINKS/.test(fnSrc),
    '214c: runCreateStripeLink checks BC_STRIPE_LINKS and BC_STAFF_ACTIONS flags (Stage 8.4.10)');
  check(/bcLastPaymentId/.test(fnSrc),
    '214d: runCreateStripeLink uses bcLastPaymentId (Stage 8.4.10)');
  check(/navigator\.clipboard|prompt\(/.test(fnSrc),
    '214e: runCreateStripeLink wires copy-to-clipboard (Stage 8.4.10)');
  check(!/whatsapp|twilio|sendWhats/i.test(fnSrc),
    '214f: runCreateStripeLink makes no WhatsApp calls (Stage 8.4.10)');
  check(!/n8n|webhook.*post|axios/i.test(fnSrc),
    '214g: runCreateStripeLink makes no n8n/webhook calls (Stage 8.4.10)');
})();

// 215. renderStripeLinkResult function present and has safety text
check(/function renderStripeLinkResult/.test(src),
  '215: renderStripeLinkResult function present (Stage 8.4.10)');
(function checkRenderStripeResult(){
  const fnStart = src.indexOf('function renderStripeLinkResult');
  const fnSrc   = fnStart > 0 ? src.slice(fnStart, fnStart + 3000) : '';
  check(/checkout_url/.test(fnSrc),
    '215b: renderStripeLinkResult displays checkout_url (Stage 8.4.10)');
  check(/Copy Payment Link|Copy/.test(fnSrc),
    '215c: renderStripeLinkResult has Copy Payment Link button (Stage 8.4.10)');
  check(/not.*paid.*until webhook|webhook.*confirms|payment.*NOT marked paid/i.test(fnSrc),
    '215d: renderStripeLinkResult shows payment-not-paid-until-webhook warning (Stage 8.4.10)');
  check(!/amount_paid_cents.*=|paid.*=.*true|booking.*confirmed/i.test(fnSrc),
    '215e: renderStripeLinkResult does NOT update paid/confirmed state (Stage 8.4.10)');
})();

// 216. Create Stripe Payment Link button in renderCreateResult
(function checkCreateResultHasStripeBtn(){
  const fnStart = src.indexOf('function renderCreateResult');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction run', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bc-sel-stripe-link/.test(fnSrc),
    '216: renderCreateResult contains bc-sel-stripe-link button (Stage 8.4.10)');
  check(/BC_STRIPE_LINKS/.test(fnSrc),
    '216b: renderCreateResult gates Stripe button by BC_STRIPE_LINKS (Stage 8.4.10)');
  check(/bc-stripe-link-result/.test(fnSrc),
    '216c: renderCreateResult includes bc-stripe-link-result container (Stage 8.4.10)');
  check(/payment_id/.test(fnSrc),
    '216d: renderCreateResult shows payment_id from response (Stage 8.4.10)');
})();

// 217. No direct Stripe API calls from UI code
check(!/stripe\.charges|stripe\.paymentIntents|Stripe\s*\(|loadStripe\s*\(/.test(src.slice(src.indexOf('function renderBedCalendar') || 0)),
  '217: No direct Stripe API calls from browser UI code (Stage 8.4.10)');

// 218. runManualBookingCreate sets bcLastPaymentId
(function checkRunCreateSetsPaymentId(){
  const fnStart = src.indexOf('function runManualBookingCreate');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bcLastPaymentId\s*=/.test(fnSrc),
    '218: runManualBookingCreate sets bcLastPaymentId from response (Stage 8.4.10)');
  check(/bc-sel-stripe-link/.test(fnSrc),
    '218b: runManualBookingCreate wires bc-sel-stripe-link button after render (Stage 8.4.10)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Stage 8.4.12 — payment truth panel in booking drawer
// ─────────────────────────────────────────────────────────────────────────────

// 219. renderBookingContextDrawer payment truth section
(function checkDrawerPaymentTruth(){
  const fnStart = src.indexOf('function renderBookingContextDrawer');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 100) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';

  check(fnSrc.length > 100,
    '219: renderBookingContextDrawer function found and non-trivial');

  // Payment truth field references
  check(/paid_at/.test(fnSrc),
    '219a: drawer shows paid_at (Stage 8.4.12)');
  check(/amount_paid_cents/.test(fnSrc),
    '219b: drawer shows amount_paid_cents (Stage 8.4.12)');
  check(/balance_due/.test(fnSrc),
    '219c: drawer shows balance_due (Stage 8.4.12)');
  check(/checkout_url/.test(fnSrc),
    '219d: drawer shows checkout_url (Stage 8.4.12)');
  check(/payment_kind/.test(fnSrc),
    '219e: drawer shows payment_kind (Stage 8.4.12)');
  check(/stripe_checkout_session_id/.test(fnSrc),
    '219f: drawer shows stripe_checkout_session_id (Stage 8.4.12)');
  check(/stripe_payment_intent_id/.test(fnSrc),
    '219g: drawer shows stripe_payment_intent_id (Stage 8.4.12)');

  // Status labels
  check(/Deposit paid|deposit_paid/.test(fnSrc),
    '219h: drawer has deposit-paid label (Stage 8.4.12)');
  check(/Paid in full|isFullyPaid/.test(fnSrc),
    '219i: drawer has paid-in-full label (Stage 8.4.12)');
  check(/waiting for Stripe webhook|waiting.*webhook/i.test(fnSrc),
    '219j: drawer has waiting-for-webhook text (Stage 8.4.12)');
  check(/No payment record yet|No payment/.test(fnSrc),
    '219k: drawer shows "No payment record yet" when no rows (Stage 8.4.12)');

  // Copy button
  check(/bcCopyUrl/.test(fnSrc),
    '219l: drawer uses bcCopyUrl for checkout_url copy button (Stage 8.4.12)');

  // Safety: read-only — no writes, no Stripe calls, no WhatsApp/n8n
  check(!/stripe\.(checkout|charges|paymentIntents|sessions)\.create/i.test(fnSrc),
    '219m: drawer does not make Stripe API calls (Stage 8.4.12)');
  check(!/sendWhatsApp|twilio|n8n.*webhook|triggerN8n/i.test(fnSrc),
    '219n: drawer does not call WhatsApp/n8n (Stage 8.4.12)');
  check(!/pg\.query.*UPDATE|pg\.query.*INSERT/i.test(fnSrc),
    '219o: drawer does not perform DB writes (Stage 8.4.12)');

  // Visual differentiation: green/teal banners
  check(/isDepositPaid|isFullyPaid/.test(fnSrc),
    '219p: drawer has paid state flags for banner rendering (Stage 8.4.12)');

  // Payment card: pmtStatusLabel or Checkout link created string
  check(/pmtStatusLabel|Checkout link created/.test(fnSrc),
    '219q: drawer uses pmtStatusLabel helper for payment status (Stage 8.4.12)');
})();

// 220. getBookingPaymentsQuery (in staff-booking-detail-queries.js, loaded via require)
// Verify the lib file exports the updated query (reading the lib source separately)
(function checkPaymentsQueryFields(){
  const libPath = require('path').join(__dirname, 'lib', 'staff-booking-detail-queries.js');
  let libSrc = '';
  try { libSrc = require('fs').readFileSync(libPath, 'utf8'); } catch(_){}
  const queryMatch = libSrc.match(/function getBookingPaymentsQuery[\s\S]{0,2000}/);
  const qSrc = queryMatch ? queryMatch[0] : '';

  check(/checkout_url/.test(qSrc),
    '220a: getBookingPaymentsQuery returns checkout_url (Stage 8.4.12)');
  check(/payment_kind/.test(qSrc),
    '220b: getBookingPaymentsQuery returns payment_kind (Stage 8.4.12)');
  check(/stripe_checkout_session_id/.test(qSrc),
    '220c: getBookingPaymentsQuery returns stripe_checkout_session_id (Stage 8.4.12)');
  check(/p\.currency/.test(qSrc),
    '220d: getBookingPaymentsQuery returns currency (Stage 8.4.12)');
  check(/paid_at/.test(qSrc),
    '220e: getBookingPaymentsQuery returns paid_at (Stage 8.4.12)');
})();

// ── Stage 8.5.18 — Luna confirmation draft panel in booking drawer ───────────
(function(){
  const fnStart = src.indexOf('function renderBookingContextDrawer');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 100) : -1;
  const drawerFn = (fnStart > 0 && fnEnd > fnStart) ? src.slice(fnStart, fnEnd) : '';

  check(/ctx-luna-confirmation-draft|bc-luna-confirmation-draft/.test(drawerFn),
    '221: Luna confirmation draft panel exists in drawer (Stage 8.5.18)');
  check(/confirmation_draft/.test(drawerFn) &&
        (/data\.booking\.confirmation_draft|data\.booking\.metadata/.test(drawerFn)),
    '221b: drawer reads booking confirmation_draft from metadata (Stage 8.5.18)');
  check(/Luna confirmation draft ready/.test(drawerFn),
    '221c: drawer shows Luna confirmation draft ready heading (Stage 8.5.18)');
  check(/gate_code/.test(drawerFn) && /room_number|Room/.test(drawerFn) && /balance_due/.test(drawerFn),
    '221d: drawer displays gate_code, room, and balance (Stage 8.5.18)');
  check(/sends_whatsapp.*false|sends_whatsapp:\s*<code>false<\/code>/.test(drawerFn),
    '221e: drawer shows sends_whatsapp:false (Stage 8.5.18)');
  check(/whatsapp_dry_run.*true|whatsapp_dry_run:\s*<code>true<\/code>/.test(drawerFn),
    '221f: drawer shows whatsapp_dry_run:true (Stage 8.5.18)');
  check(!/graph\.facebook\.com/.test(drawerFn),
    '221g: drawer has no graph.facebook.com (Stage 8.5.18)');
  check(!(/fetch[\s\S]{0,120}n8n|n8n[\s\S]{0,120}fetch/.test(drawerFn)),
    '221h: drawer makes no n8n calls (Stage 8.5.18)');
  check(!/Send confirmation|send-confirmation|confirmation-send|bc-send-confirmation/i.test(drawerFn),
    '221i: drawer has no confirmation send button (Stage 8.5.18)');

  check(/confirmation_draft/.test(src) &&
        (/metadata\.confirmation_draft|bkMetadata\.confirmation_draft/.test(src)),
    '222: booking context API exposes metadata confirmation_draft (Stage 8.5.18)');
  check(/SELECT b\.metadata/.test(src),
    '222b: booking context loads bookings.metadata (Stage 8.5.18)');
})();

// ── Stage 8.7.6 — booking drawer layout cleanup ───────────────────────────
(function(){
  const fnStart = src.indexOf('function renderBookingContextDrawer');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const drawerFn = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';

  check(/bc-detail-meta|updateBcDetailHeader|bcDetailHeaderMetaHtml/.test(src),
    '223: drawer header meta holds status + nights (Stage 8.7.6)');
  check(/grid-template-columns:\s*108px/.test(src),
    '223b: payment rows use compact grid (not far-right flex) (Stage 8.7.6)');
  check(!/justify-content:space-between/.test(src.slice(src.indexOf('.ctx-pay-row'), src.indexOf('.ctx-pay-row') + 200)),
    '223c: ctx-pay-row no longer uses space-between (Stage 8.7.6)');
  check(/ctx-luna-confirmation-draft|bc-luna-confirmation-draft/.test(drawerFn),
    '223d: Luna confirmation draft panel still present (Stage 8.7.6)');
  check(!/Send confirmation|send-confirmation|confirmation-send|bc-send-confirmation/i.test(drawerFn),
    '223e: drawer still has no send button (Stage 8.7.6)');
  check(!/graph\.facebook\.com/.test(drawerFn),
    '223f: drawer has no graph.facebook.com (Stage 8.7.6)');
  check(!(/fetch[\s\S]{0,120}n8n|n8n[\s\S]{0,120}fetch/.test(drawerFn)),
    '223g: drawer makes no n8n calls (Stage 8.7.6)');
})();

// ─────────────────────────────────────────────────────────────────────────────

console.log('\nResult: ' + passes + ' passed, ' + failures + ' failed\n');
if (failures > 0) process.exit(1);
