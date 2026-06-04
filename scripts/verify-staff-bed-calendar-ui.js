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
 *  11:     READ-ONLY BED CALENDAR header removed (10.6a.5)
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
 *  23:     stale "Booking edits disabled" notice absent (10.6a.5)
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

/** Full drawer fn (nested `function eur` breaks naive `\nfunction ` slicing). */
function extractRenderBookingContextDrawer(fileSrc) {
  const start = 'function renderBookingContextDrawer(data){';
  const i = fileSrc.indexOf(start);
  if (i < 0) return '';
  const j = fileSrc.indexOf('\n/* ── Tour Operator forms', i);
  return j > i ? fileSrc.slice(i, j) : fileSrc.slice(i);
}

function extractBcRenderRunningInvoiceHtml(fileSrc) {
  const start = 'function bcRenderRunningInvoiceHtml(bk, svcRows, pmt){';
  const i = fileSrc.indexOf(start);
  if (i < 0) return '';
  const j = fileSrc.indexOf('\n/* Phase 10.5f-lite', i);
  return j > i ? fileSrc.slice(i, j) : fileSrc.slice(i);
}

function extractTourOperatorJs(fileSrc) {
  const start = fileSrc.indexOf('/* ── Tour Operator forms');
  if (start < 0) return '';
  const end = fileSrc.indexOf('\nfunction loadBedCalendar', start);
  return end > start ? fileSrc.slice(start, end) : '';
}

function extractTourOperatorTabHtml(fileSrc) {
  const start = fileSrc.indexOf('id="tab-tour-operator"');
  const end = fileSrc.indexOf('</div><!-- /tab-tour-operator -->', start);
  return start >= 0 && end > start ? fileSrc.slice(start, end) : '';
}

console.log('\nverify-staff-bed-calendar-ui.js  (Stage 7.7h)\n');

// 1. File exists
check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) { process.exit(1); }

// 2. Readable
const src = fs.readFileSync(API_FILE, 'utf8');
const toJs = extractTourOperatorJs(src);
const toTab = extractTourOperatorTabHtml(src);
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

// 11. Stale READ-ONLY BED CALENDAR header removed (10.6a.5)
const bcPanelStart = src.indexOf('id="tab-bed-calendar"');
const bcPanelEnd   = bcPanelStart >= 0 ? src.indexOf('id="tab-tour-operator"', bcPanelStart) : -1;
const bcPanelSrc   = bcPanelStart >= 0 && bcPanelEnd > bcPanelStart
  ? src.slice(bcPanelStart, bcPanelEnd) : '';
check(!/READ-ONLY BED CALENDAR/i.test(bcPanelSrc),
  '10.6a.5: READ-ONLY BED CALENDAR header text removed from bed calendar tab');
check(!/edits disabled/i.test(bcPanelSrc),
  '10.6a.5: edits disabled header text removed from bed calendar tab');
check(/id="bc-start"/.test(bcPanelSrc) && /id="bc-end"/.test(bcPanelSrc) && /id="bc-load"/.test(bcPanelSrc),
  '10.6a.5: From / To inputs and Load button still in bed calendar tab');
check(/id="bc-chips"/.test(bcPanelSrc) && /data-chip="30days"/.test(bcPanelSrc),
  '10.6a.5: quick range chips still in bed calendar tab');
check(/bc-grid-wrap|renderBedCalendar/.test(src),
  '10.6a.5: calendar grid still renders');

// 12. Summary stats row removed (Phase 10.6a.4)
check(!/id="bc-summary"|bc-rooms-count|bc-blocks-count/.test(src),
  'Calendar summary stats row removed (no rooms/beds/blocks/free strip)');

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

// 23. Stale booking-edits-disabled notice removed (10.6a.5)
check(!/Booking edits.*disabled|booking edits disabled/i.test(src),
  '10.6a.5: stale booking edits disabled notice absent');

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

// 38. Add-ons section in drawer (Phase 10.6a — inline panel, not h3)
check(/bc-add-ons-title|id="bc-add-ons-panel"/.test(src),
  'Add-ons section present in drawer (Stage 7.7i / 10.6a)');

// 39. Open conversation button present
check(/Open conversation|btn-open-conv/i.test(src),
  '"Open conversation" button present in drawer (Stage 7.7i)');

// 40. Stale booking edits disabled note absent (10.6a.5)
check(!/bc-detail-note[\s\S]{0,120}edits disabled/i.test(src),
  '10.6a.5: no bc-detail-note edits-disabled banner in drawer shell');

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

// 49. Legend shows source colors only (Phase 10.7b)
(function check107bLegend(){
  const legendStart = src.indexOf('id="bc-legend"');
  const legendSlice = legendStart >= 0 ? src.slice(legendStart, legendStart + 1200) : '';
  check(/bc-legend-sw-confirmed/.test(legendSlice) && />Staff \/ manual</.test(legendSlice),
    '10.7b: legend has Staff / manual (green) swatch');
  check(/bc-legend-sw-payment/.test(legendSlice) && />Luna</.test(legendSlice),
    '10.7b: legend has Luna (blue) swatch');
  check(!/bc-legend-sw-hold/.test(legendSlice) && !/bc-legend-sw-review/.test(legendSlice) &&
        !/bc-legend-sw-operator/.test(legendSlice) && !/bc-legend-sw-balance/.test(legendSlice) &&
        !/bc-legend-sw-cancelled/.test(legendSlice),
    '10.7b: legend omits hold/review/operator/balance/cancelled swatches');
  check(!/>Confirmed</.test(legendSlice) && !/>Payment pending</.test(legendSlice) &&
        !/>Cancelled</.test(legendSlice) && !/>Operator block</.test(legendSlice) &&
        !/>Balance due</.test(legendSlice),
    '10.7b: legend omits old status-color labels');
})();

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

// 54. Summary stats not rendered after calendar load (Phase 10.6a.4)
check(!/el\('bc-summary'\)\.style\.display\s*=\s*'flex'/.test(src),
  'renderBedCalendar does not show summary stats strip');

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

// 64. Nights badge removed from drawer header (Phase 10.6a.3)
check(/bc-detail-meta|bcDetailHeaderMetaHtml/.test(src) &&
      !/ctx-nights-badge/.test(
        src.match(/function bcDetailHeaderMetaHtml[\s\S]*?function updateBcDetailHeader/)?.[0] || ''
      ),
  'Drawer header has meta without nights badge (Phase 10.6a.3)');

// 65. Balance label present (Stage 8.3b, updated 8.4.12: label renamed to "Balance due")
check(/Remaining balance|Balance due/i.test(src),
  'Balance label present in drawer (Stage 8.3b / 8.4.12)');

// 66. Total paid / Paid label present (Stage 8.3b)
check(/ctx-pay-label.*Total|Total.*ctx-pay|kvBC.*Total|kvBC.*Paid|ctx-pay-row/i.test(src),
  'Total / Paid payment row labels present in drawer (Stage 8.3b)');

// 67–68. Stale planned-ops block removed (Phase 10.6a.4)
check(!/Planned operations \(not enabled in staging\)/.test(src),
  '10.6a.4: Planned operations stale banner removed from drawer');
check(!/renderBookingContextDrawer[\s\S]*ctx-planned/.test(src),
  '10.6a.4: ctx-planned block not rendered in booking drawer');

// 69. Move/cancel handlers wired in drawer (Phase 10.6a.3+)
check(/function bcRunMoveWrite/.test(src) && /bcInitBookingCancelShell/.test(src),
  'Move booking and cancel handlers present in drawer (Phase 10.6a.3)');

// 70. Add-ons title in drawer (Phase 10.6a)
check(/bc-add-ons-title|>Add-ons</.test(src),
  'Add-ons title present in drawer (Phase 10.6a)');

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

// 93. Selected Stay date/nights fields present (Stage 8.3d; room/bed rows removed 8.7.24/8.7.25)
check(/id="bc-sel-cin"/.test(src) && /id="bc-sel-cout"/.test(src) && /id="bc-sel-nights"/.test(src),
  'Check-in, check-out, and nights fields present in Selected Stay (Stage 8.3d)');

// 94. Payment choice select present (Stage 10.6d — replaces bk-payment-status)
check(/id="bk-payment-choice"/.test(src),
  'Payment choice select (bk-payment-choice) present (Stage 10.6d)');

// 95. Legacy payment-status / deposit fields removed (10.6g.1)
check(!/id="bk-payment-status"/.test(src) && !/id="bk-deposit"/.test(src),
  'Legacy bk-payment-status and bk-deposit fields removed');

// 96. Quote preview guidance (replaces preview-only banner)
check(/bk-preview-not-run|Select beds, dates, and package, then click Calculate Quote/i.test(src),
  'Calculate Quote guidance shown before quote runs');

// 97. Flag-aware create note (replaces staging write-gate banner)
check(/MANUAL_BOOKING_ENABLED|bc-create-note/.test(src),
  'Flag-aware manual booking create note present');

// 98. Payment choice hint — nothing sent automatically (10.6g.1)
check(/nothing is sent automatically/i.test(src),
  'Payment choice hint: Stripe links not auto-sent');

// 99. Create New Booking + Calculate Quote actions (10.6g.1)
check(/id="bc-sel-create"/.test(src) && /Create New Booking/.test(src),
  'Create New Booking button present');
check(/id="bc-sel-quote"/.test(src) && /Calculate Quote/.test(src),
  'Calculate Quote button present');

// 100. Preview Conflicts UI removed (10.6g.1)
check(!/id="bc-sel-conflicts"/.test(src) && !/function runPreviewConflicts/.test(src),
  'Preview Conflicts button and handler removed');

// 101. Create checks availability internally (10.6g.1)
check(/function bcFetchManualBookingAvailability/.test(src) &&
      /Checking availability/.test(src.match(/function runManualBookingCreate[\s\S]*?\n\}/)?.[0] || ''),
  'Create New Booking checks availability before POST create');

// 102. Create button disabled until quote/fields ready (Stage 8.3d)
check(/disabled[^>]*id="bc-sel-create"|id="bc-sel-create"[^>]*disabled/.test(src),
  'Create New Booking button starts disabled (Stage 8.3d)');

// 103. No form submit that could POST data (Stage 8.3d)
check(!/form[^>]*action\s*=\s*['"](?!#)[^'"]*['"]/.test(src) && !/form[^>]*method\s*=\s*['"]post['"]/i.test(src),
  'No form element with POST action or method=post (Stage 8.3d)');

// 104. bcClearSelection resets form fields (Stage 8.3d)
(function checkClearResetsForm(){
  const fnStart = src.indexOf('function bcClearSelection');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bk-guest-name/.test(fnSrc) && /bc-quote-result/.test(fnSrc),
    'bcClearSelection resets booking form and quote result (Stage 10.6g.1)');
})();

// 105. bcApplySelectionHighlight prefills stay fields and bed chips (Stage 8.3d)
(function checkStayPrefill(){
  const fnStart = src.indexOf('function bcApplySelectionHighlight');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bc-sel-cin/.test(fnSrc) && /bc-sel-beds-list/.test(fnSrc),
    'bcApplySelectionHighlight prefills stay fields and bed chips (Stage 8.3d)');
})();

// ── Stage 8.3a regression fix — embedded JS syntax safety ─────────────────

// 57. No bare \n (unescaped newline escape) in renderBookingBlock tip string
//     Template literals interpret \n as real newlines, breaking browser JS strings.
const rbStart = src.indexOf('function renderBookingBlock');
const rbEnd   = rbStart > 0 ? src.indexOf('\nfunction ', rbStart + 10) : -1;
const rbSrc   = rbStart > 0 && rbEnd > 0 ? src.slice(rbStart, rbEnd) : '';
check(rbStart > 0 && !/'\s*\\n\s*'/.test(rbSrc),
  "No bare '\\n' string in renderBookingBlock tip (would break template literal — Stage 8.3a fix)");

// 58. Embedded JS is syntax-clean (extract from source — Stage 8.7.20)
(function checkEmbeddedJs(){
  const vm = require('vm');
  function extractEmbeddedUiScript(source) {
    const buildStart = source.indexOf('function buildUiHtml');
    const searchFrom = buildStart >= 0 ? buildStart : 0;
    const scriptTag = source.indexOf('<script>', searchFrom);
    if (scriptTag < 0) return null;
    const fnStart = source.indexOf('(function(){', scriptTag);
    if (fnStart < 0) return null;
    const endTag = source.indexOf('</script>', fnStart);
    if (endTag < 0) return null;
    const beforeClose = source.slice(fnStart, endTag);
    const relEnd = beforeClose.lastIndexOf('})();');
    if (relEnd < 0) return null;
    return beforeClose.slice(0, relEnd + '})();'.length);
  }
  const raw = extractEmbeddedUiScript(src);
  if (!raw) {
    check(false, 'Embedded JS syntax: could not find UI <script> block (Stage 8.7.20)');
    return;
  }
  const js = raw
    .replace(/\$\{STAFF_ACTIONS_ENABLED\}/g, 'false')
    .replace(/\$\{MANUAL_BOOKING_ENABLED\}/g, 'false')
    .replace(/\$\{STRIPE_LINKS_ENABLED\}/g, 'false');
  try {
    new vm.Script(js);
    check(true, 'Embedded UI script passes parse check (Stage 8.7.20)');
  } catch (e) {
    check(false, 'Embedded UI script SyntaxError: ' + (e.message || e) + ' (Stage 8.7.20)');
  }
  check(/window\.switchToTab\s*=\s*switchToTab/.test(js),
    'Embedded script exposes window.switchToTab (Stage 8.7.20)');
  check(/window\.switchToTabOnly\s*=\s*switchToTabOnly/.test(js),
    'Embedded script exposes window.switchToTabOnly (Stage 8.7.20)');
})();

// ─────────────────────────────────────────────────────────────────────────────

// ── Stage 8.3l / 10.6g.1 — quote preview + create wiring (conflicts preview removed) ─

// 108. Preview endpoint only via internal availability helper (10.6g.1)
check(/function bcFetchManualBookingAvailability/.test(src) &&
      /fetch\s*\(\s*['"]\/staff\/manual-bookings\/preview['"]/.test(
        src.match(/function bcFetchManualBookingAvailability[\s\S]*?\n\}/)?.[0] || ''
      ),
  'manual-bookings/preview fetch only in bcFetchManualBookingAvailability (10.6g.1)');

// 109. /staff/manual-bookings/create fetch IS wired in UI (Stage 8.4.8, gated by flags)
check(/fetch\s*\(\s*['"]\/staff\/manual-bookings\/create['"]/.test(src),
  'fetch to /staff/manual-bookings/create present in UI (Stage 8.4.8 — wired with flag gate)');

// 110. bc-preview-result element removed; quote uses bc-quote-result (10.6g.1)
check(!/id="bc-preview-result"/.test(src) && /id="bc-quote-result"/.test(src),
  'Quote result uses bc-quote-result (bc-preview-result removed)');

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
check(/preview_only|creates_booking|no_write_performed/.test(src) || /\/staff\/quote-preview/.test(src),
  'Quote preview is read-only (quote-preview / preview_only awareness) (Stage 8.3l)');

// 116. Create button starts disabled until quote/fields ready (Stage 8.3l)
check(/disabled[^>]*id="bc-sel-create"|id="bc-sel-create"[^>]*disabled/.test(src),
  'Create New Booking button has disabled attribute in HTML (Stage 8.3l)');

// 118. bcClearSelection resets quote result (10.6g.1)
(function checkClearResetsPreview(){
  const fnStart = src.indexOf('function bcClearSelection');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bc-quote-result/.test(fnSrc),
    'bcClearSelection resets bc-quote-result (Stage 10.6g.1)');
})();

// 119. bcApplySelectionHighlight enables Calculate Quote when cells selected (10.6g.1)
(function checkSelectionEnablesQuote(){
  const fnStart = src.indexOf('function bcApplySelectionHighlight');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bcUpdateQuoteButton\s*\(/.test(fnSrc) && /bcUpdateCreateButton\s*\(/.test(fnSrc),
    'bcApplySelectionHighlight refreshes quote/create button state (Stage 10.6g.1)');
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

// 125. Block type removed from block form (Stage 8.7.17)
(function checkOpBlockTypeRemoved(){
  const opIdx = src.indexOf('id="to-op-panel"');
  const opEnd = opIdx >= 0 ? src.indexOf('id="to-rr-panel"', opIdx) : -1;
  const opSrc = opIdx >= 0 && opEnd > opIdx ? src.slice(opIdx, opEnd) : '';
  check(!/id="to-op-block-type"/.test(opSrc),
    'Block type field removed from Tour Operator Block form (Stage 8.7.17)');
})();

// 126. Block form start/end dates present (Stage 8.7.17)
(function checkOpDates(){
  const opIdx = src.indexOf('id="to-op-panel"');
  const opEnd = opIdx >= 0 ? src.indexOf('id="to-rr-panel"', opIdx) : -1;
  const opSrc = opIdx >= 0 && opEnd > opIdx ? src.slice(opIdx, opEnd) : '';
  check(/id="to-op-cin"/.test(opSrc) && /id="to-op-cout"/.test(opSrc),
    'Block form has start/end date fields (Stage 8.7.17)');
})();

// 127. Block form room dropdown (Stage 8.7.17)
(function checkOpRoomSelect(){
  const opIdx = src.indexOf('id="to-op-panel"');
  const opEnd = opIdx >= 0 ? src.indexOf('id="to-rr-panel"', opIdx) : -1;
  const opSrc = opIdx >= 0 && opEnd > opIdx ? src.slice(opIdx, opEnd) : '';
  check(/<select[^>]*id="to-op-room"/.test(opSrc),
    'Block form room field is a select dropdown (Stage 8.7.17)');
})();

// 128. Nights/Beds/Est guest count removed from block form (Stage 8.7.17)
(function checkOpRemovedFields(){
  const opIdx = src.indexOf('id="to-op-panel"');
  const opEnd = opIdx >= 0 ? src.indexOf('id="to-rr-panel"', opIdx) : -1;
  const opSrc = opIdx >= 0 && opEnd > opIdx ? src.slice(opIdx, opEnd) : '';
  check(!/id="to-op-nights"/.test(opSrc) && !/id="to-op-bed"/.test(opSrc) && !/id="to-op-guest-count"/.test(opSrc),
    'Nights, Beds, Est guest count removed from block form (Stage 8.7.17)');
})();

// 129. Block defaults not displayed to staff (Stage 8.7.17)
(function checkOpDefaultsHidden(){
  const opIdx = src.indexOf('id="to-op-panel"');
  const opEnd = opIdx >= 0 ? src.indexOf('id="to-rr-panel"', opIdx) : -1;
  const opSrc = opIdx >= 0 && opEnd > opIdx ? src.slice(opIdx, opEnd) : '';
  check(!/Block Defaults/.test(opSrc) && !/value="Operator"/.test(opSrc) &&
        !/Guest messaging[\s\S]{0,80}Disabled/i.test(opSrc) &&
        !/Not triggered/.test(opSrc),
    'Block form defaults section not displayed (Stage 8.7.17)');
  check(/TO_OP_BLOCK_DEFAULTS/.test(src),
    'Block defaults kept internally in TO_OP_BLOCK_DEFAULTS (Stage 8.7.17)');
})();

// 130. Create Operator Block button enabled via JS when fields complete (Phase 10.7a)
check(/id="to-op-create-btn"/.test(src) &&
      !/disabled[^>]*id="to-op-create-btn"|id="to-op-create-btn"[^>]*disabled/.test(toTab),
  'Create Operator Block button present and not hard-disabled in HTML (Phase 10.7a)');
check(/function toOpFormReady/.test(toJs) && /function toUpdateOpButtons/.test(toJs) &&
      /create\.disabled = !ready/.test(toJs),
  'Create Operator Block button gated by toOpFormReady/toUpdateOpButtons (Phase 10.7a)');

// 131. Preview Operator Block button enabled via JS (Phase 10.7a)
check(/id="to-op-preview-btn"/.test(src) &&
      !/disabled[^>]*id="to-op-preview-btn"|id="to-op-preview-btn"[^>]*disabled/.test(toTab),
  'Preview Operator Block button present and not hard-disabled in HTML (Phase 10.7a)');
check(/toOpPreview/.test(toJs) && /prev\.disabled = !ready/.test(toJs),
  'Preview Operator Block wired and JS-gated (Phase 10.7a)');

// 132. Stale shadow copy removed from Tour Operator tab (Phase 10.7a)
check(!/no operator block will be created|Preview only.*coming soon|approval gates before they can be enabled|READ-ONLY.*writes disabled/i.test(toTab),
  'Tour Operator tab has no stale shadow/disabled copy (Phase 10.7a)');

// 133. Tour Operator actions do not call n8n/webhooks (Phase 10.7a)
check(!/n8n\.cloud|\/webhook\/|graph\.facebook\.com/i.test(toJs),
  'Tour Operator JS has no n8n/webhook/WhatsApp URLs (Phase 10.7a)');

// 134. Tour Operator create uses staff API POST (Phase 10.7a)
check(/\/staff\/tour-operator\/blocks\/preview/.test(toJs) &&
      /\/staff\/tour-operator\/blocks\/create/.test(toJs),
  'Tour Operator block panel JS posts to tour-operator blocks API (Phase 10.7a)');

// 135. No n8n or webhook URL called from operator block actions (Stage 8.3u / 10.7a)
(function checkOpNoN8n(){
  check(!/n8n.*webhook|webhook.*n8n|\.n8n\.|n8n\.cloud|\/webhook\//i.test(toJs),
    'No n8n/webhook URL called from operator block actions (Phase 10.7a)');
})();

// 136. Tour Operator tab exists (Stage 8.3u)
check(/data-tab="tour-operator"/.test(src),
  'Tour Operator nav tab (data-tab="tour-operator") present (Stage 8.3u)');

// 137. Tour Operator tab panel exists (Stage 8.3u)
check(/id="tab-tour-operator"/.test(src),
  'Tour Operator tab panel (id="tab-tour-operator") present (Stage 8.3u)');

// 138. Room dropdowns load from rooms API with calendar fallback (Phase 10.7a)
check(/function toRefreshRoomSelects/.test(toJs) && /to-op-room/.test(toJs) &&
      /function toLoadRooms/.test(toJs) && /\/staff\/tour-operator\/rooms/.test(toJs) &&
      /bcData\.rooms/.test(toJs),
  'toLoadRooms/toRefreshRoomSelects use tour-operator rooms API and calendar fallback (Phase 10.7a)');

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

// 145. Operator block dropdown present (Stage 8.7.17)
check(/id="to-rr-block-select"/.test(src),
  'Operator block select dropdown (to-rr-block-select) present (Stage 8.7.17)');

// 146. Release type and beds removed (Stage 8.7.17)
(function checkRrRemovedFields(){
  const rrIdx = src.indexOf('id="to-rr-panel"');
  const rrEnd = rrIdx >= 0 ? src.indexOf('</div><!-- /tab-tour-operator -->', rrIdx) : -1;
  const rrSrc = rrIdx >= 0 ? src.slice(rrIdx, rrEnd > rrIdx ? rrEnd : rrIdx + 12000) : '';
  check(!/id="to-rr-release-type"/.test(rrSrc) && !/id="to-rr-bed"/.test(rrSrc) &&
        !/id="to-rr-block-code"/.test(rrSrc),
    'Release type, beds, and block-code text field removed (Stage 8.7.17)');
})();

// 147. Reason for release field present (Stage 8.3u)
check(/id="to-rr-reason"/.test(src),
  'Reason for release field (to-rr-reason) present (Stage 8.3u)');

// 148. Room release room dropdown (Stage 8.7.17)
(function checkRrRoomSelect(){
  const rrIdx = src.indexOf('id="to-rr-panel"');
  const rrEnd = rrIdx >= 0 ? src.indexOf('</div><!-- /tab-tour-operator -->', rrIdx) : -1;
  const rrSrc = rrIdx >= 0 ? src.slice(rrIdx, rrEnd > rrIdx ? rrEnd : rrIdx + 12000) : '';
  check(/<select[^>]*id="to-rr-room"/.test(rrSrc),
    'Room release form has room select dropdown (Stage 8.7.17)');
})();

// 149. Release nights display-only (Stage 8.7.17)
(function checkRrNightsReadonly(){
  const rrIdx = src.indexOf('id="to-rr-panel"');
  const rrEnd = rrIdx >= 0 ? src.indexOf('</div><!-- /tab-tour-operator -->', rrIdx) : -1;
  const rrSrc = rrIdx >= 0 ? src.slice(rrIdx, rrEnd > rrIdx ? rrEnd : rrIdx + 12000) : '';
  check(/id="to-rr-nights"[^>]*readonly/.test(rrSrc) && /toCalcReleaseNights/.test(src),
    'Release nights calculated display-only (Stage 8.7.17)');
})();

// 150. Release Dates button enabled via JS (Phase 10.7a)
check(/id="to-rr-release-btn"/.test(src) &&
      !/disabled[^>]*id="to-rr-release-btn"|id="to-rr-release-btn"[^>]*disabled/.test(toTab),
  'Release Dates button present and not hard-disabled in HTML (Phase 10.7a)');
check(/function toRrFormReady/.test(toJs) && /rel\.disabled = !ready/.test(toJs),
  'Release Dates button gated by toRrFormReady/toUpdateRrButtons (Phase 10.7a)');

// 151. Preview Release button enabled via JS (Phase 10.7a)
check(/id="to-rr-preview-btn"/.test(src) &&
      !/disabled[^>]*id="to-rr-preview-btn"|id="to-rr-preview-btn"[^>]*disabled/.test(toTab),
  'Preview Release button present and not hard-disabled in HTML (Phase 10.7a)');
check(/toRrPreview/.test(toJs),
  'Preview Release handler wired (Phase 10.7a)');

// 152. Stale room-release shadow copy removed (Phase 10.7a)
check(!/no dates will be released|Preview only.*no room will be released/i.test(toTab),
  'Room release form has no stale preview-only shadow copy (Phase 10.7a)');

// 153. Operator blocks load from API for release dropdown (Phase 10.7a)
check(/function toLoadBlocks/.test(toJs) && /\/staff\/tour-operator\/blocks/.test(toJs) &&
      /function toRenderBlockSelect/.test(toJs),
  'Release form loads operator blocks from tour-operator blocks API (Phase 10.7a)');

// 154. Room release defaults not displayed (Stage 8.7.17)
(function checkRrDefaultsHidden(){
  const rrIdx = src.indexOf('id="to-rr-panel"');
  const rrEnd = rrIdx >= 0 ? src.indexOf('</div><!-- /tab-tour-operator -->', rrIdx) : -1;
  const rrSrc = rrIdx >= 0 ? src.slice(rrIdx, rrEnd > rrIdx ? rrEnd : rrIdx + 12000) : '';
  check(!/bk-form-section-title">Defaults/.test(rrSrc) &&
        !/Guest messaging[\s\S]{0,80}Disabled/i.test(rrSrc) &&
        !/Staff write status/.test(rrSrc),
    'Room release defaults section not displayed (Stage 8.7.17)');
})();

// 155. Block dates read-only placeholders in release form (Stage 8.7.17)
(function checkRrBlockDatesReadonly(){
  const rrIdx = src.indexOf('id="to-rr-panel"');
  const rrEnd = rrIdx >= 0 ? src.indexOf('</div><!-- /tab-tour-operator -->', rrIdx) : -1;
  const rrSrc = rrIdx >= 0 ? src.slice(rrIdx, rrEnd > rrIdx ? rrEnd : rrIdx + 12000) : '';
  check(/id="to-rr-orig-cin"[^>]*readonly/.test(rrSrc) && /id="to-rr-orig-cout"[^>]*readonly/.test(rrSrc),
    'Block start/end dates read-only in room release form (Stage 8.7.17)');
})();

// 156. No POST/PATCH/DELETE fetch in room release panel (Stage 8.3u / 8.7.17)
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

// 160. Create Operator Block enabled in Tour Operator tab (Phase 10.7a regression)
check(/id="to-op-create-btn"/.test(src) && /toOpCreate/.test(toJs) &&
      !/disabled[^>]*id="to-op-create-btn"|id="to-op-create-btn"[^>]*disabled/.test(toTab),
  'Create Operator Block enabled via JS in Tour Operator tab (Phase 10.7a)');

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

// 181. Quote preview is read-only (no booking write from quote path)
check(/\/staff\/quote-preview/.test(src) && !/fetch[^)]*manual-bookings\/create[^)]*preview/.test(src),
  'Quote preview uses /staff/quote-preview only (Stage 8.4.5)');

// 182. Quote result shows totals / line items (10.6g.1)
check(/function renderQuoteResult/.test(src) && /line_items|invoice total|deposit_required_cents/i.test(
  src.match(/function renderQuoteResult[\s\S]*?\n\}/)?.[0] || ''
),
  'renderQuoteResult shows quote totals and line items (Stage 8.4.5)');

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

// 187. Payment choice select has staff payment choices (10.6d)
(function checkPaymentChoiceSelect(){
  const pcIdx = src.indexOf('id="bk-payment-choice"');
  const pcSrc = pcIdx >= 0 ? src.slice(pcIdx, pcIdx + 700) : '';
  check(/value="stripe_deposit"/.test(pcSrc) && /value="stripe_full"/.test(pcSrc) &&
        /value="paid_cash"/.test(pcSrc) && /value="no_payment_yet"/.test(pcSrc),
    'Payment choice select (bk-payment-choice) has stripe/cash/bank/none options (Stage 10.6d)');
})();

// 188. Duplicate assignment detail rows removed (Stage 8.7.6)
(function checkNoDuplicateBedRows(){
  const fnSrc = extractRenderBookingContextDrawer(src);
  check(/bcRenderMoveSourcePillsHtml\(moveAssigns\)/.test(fnSrc),
    'renderBookingContextDrawer uses move pills for bed assignments (Stage 8.7.6)');
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
  check(/value="shared"/.test(rtSrc) && /value="private"/.test(rtSrc),
    'Room type select has shared / private options (Stage 8.4.6 / 8.7.18)');
  check(!/value="double"/.test(rtSrc),
    'Room type select has no double option (Stage 8.7.18)');
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

// 196. Add-ons section present in manual booking form (qty-only since 8.7.15)
check(/id="bk-ao-ws-combo-days"/.test(src) && /id="bk-ao-wetsuit-days"/.test(src),
  'Add-ons section with combo and individual rental qty inputs present (Stage 8.4.7)');

// 197. All expected add-on qty controls present
(function checkAddOnControls(){
  check(/id="bk-ao-ws-combo-days"/.test(src),   'Wetsuit+Soft top combo days input present (Stage 8.4.7)');
  check(/id="bk-ao-wb-combo-days"/.test(src),   'Wetsuit+Hard board combo days input present (Stage 8.4.7)');
  check(/id="bk-ao-wetsuit-days"/.test(src),    'Wetsuit rental days input present (Stage 8.4.7)');
  check(/id="bk-ao-softtop-days"/.test(src),    'Soft top rental days input present (Stage 8.4.7)');
  check(/id="bk-ao-hardboard-days"/.test(src),  'Hard board rental days input present (Stage 8.4.7)');
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
  check(/aoQtyInput/.test(fnSrc) && /> 0/.test(fnSrc),
    'buildAddOns uses aoQtyInput and qty > 0 selection (Stage 8.4.7 / 8.7.15)');
  check(!/\.checked/.test(fnSrc),
    'buildAddOns does not use checkbox .checked (Stage 8.7.15)');
})();

// 200. runQuotePreview calls buildAddOns() (not hardcoded [])
(function checkPayloadUsesBuilder(){
  const fnStart = src.indexOf('function runQuotePreview');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction renderQuoteResult', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/buildAddOns\s*\(\s*\)/.test(fnSrc),
    'runQuotePreview calls buildAddOns() for add_ons payload (Stage 8.4.7)');
})();

// 201. bcClearSelection resets add-on qty inputs to 0 (Stage 8.4.7 / 8.7.15)
(function checkClearResetsAddOns(){
  const fnStart = src.indexOf('function bcClearSelection');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bk-ao-wetsuit-days/.test(fnSrc) && /bk-ao-yoga/.test(fnSrc),
    'bcClearSelection resets add-on qty controls (Stage 8.4.7)');
  check(/inp\.value\s*=\s*['"]0['"]/.test(fnSrc),
    'bcClearSelection sets add-on qty inputs to 0 (Stage 8.7.15)');
})();

// 202. bcInitAddOns removed — qty > 0 replaces checkbox wiring (Stage 8.7.15)
check(!/function bcInitAddOns/.test(src),
  'bcInitAddOns removed; qty > 0 selects add-ons (Stage 8.4.7 / 8.7.15)');

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

// 216. Create result shows payment link copy (inline; no separate Stripe button — 10.6g.1)
(function checkCreateResultPaymentLink(){
  const fnStart = src.indexOf('function renderCreateResult');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction run', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(!/bc-sel-stripe-link/.test(fnSrc),
    '216: renderCreateResult no longer uses bc-sel-stripe-link button (10.6g.1)');
  check(/payment_link_url/.test(fnSrc) && /bc-create-payment-link-copy-btn/.test(fnSrc),
    '216b: renderCreateResult shows payment link URL with copy icon (10.6g.1)');
  check(/payment_id/.test(fnSrc),
    '216c: renderCreateResult shows payment_id from response (Stage 8.4.10)');
})();

// 217. No direct Stripe API calls from UI code
check(!/stripe\.charges|stripe\.paymentIntents|Stripe\s*\(|loadStripe\s*\(/.test(src.slice(src.indexOf('function renderBedCalendar') || 0)),
  '217: No direct Stripe API calls from browser UI code (Stage 8.4.10)');

// 218. runManualBookingCreate sets bcLastPaymentId
(function checkRunCreateSetsPaymentId(){
  const fnStart = src.indexOf('function runManualBookingCreate');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bcLastPaymentId\s*=/.test(fnSrc) || /payment_id/.test(fnSrc),
    '218: runManualBookingCreate tracks payment from create response (Stage 8.4.10)');
  check(!/bc-sel-stripe-link/.test(fnSrc),
    '218b: runManualBookingCreate does not wire removed bc-sel-stripe-link button (10.6g.1)');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Stage 8.4.12 — payment truth panel in booking drawer
// ─────────────────────────────────────────────────────────────────────────────

// 219. renderBookingContextDrawer payment truth section
(function checkDrawerPaymentTruth(){
  const drawerFn = extractRenderBookingContextDrawer(src);
  const payFn = extractBcRenderRunningInvoiceHtml(src);
  const payUi = drawerFn + payFn;

  check(drawerFn.length > 500,
    '219: renderBookingContextDrawer function found and non-trivial');

  check(/paid_at/.test(payFn),
    '219a: drawer shows paid_at (Stage 8.4.12)');
  check(/amount_paid_cents/.test(payFn),
    '219b: drawer shows amount_paid_cents (Stage 8.4.12)');
  check(/balance_due/.test(payFn),
    '219c: drawer shows balance_due (Stage 8.4.12)');
  check(/checkout_url/.test(payFn) || /bcPaymentLedgerRowLinkUrl/.test(payFn),
    '219d: drawer shows checkout_url (Stage 8.4.12)');
  let libSrc219 = '';
  try { libSrc219 = fs.readFileSync(path.join(__dirname, 'lib', 'staff-booking-detail-queries.js'), 'utf8'); } catch(_){}
  check(/payment_kind/.test(libSrc219),
    '219e: payment_kind available in booking payments query (Stage 8.4.12)');
  check(/stripe_checkout_session_id/.test(payFn),
    '219f: drawer shows stripe_checkout_session_id (Stage 8.4.12)');
  check(/stripe_payment_intent_id/.test(payFn),
    '219g: drawer shows stripe_payment_intent_id (Stage 8.4.12)');

  check(/deposit_paid|Deposit paid/.test(payUi),
    '219h: drawer has deposit-paid label (Stage 8.4.12)');
  check(/Paid in full|paid-in-full/.test(payUi),
    '219i: drawer has paid-in-full label (Stage 8.4.12)');
  check(/bcPaymentLedgerRowDisplayLabel|Stripe paid|Paid cash/.test(payFn),
    '219j: drawer uses user-facing payment row labels (Stage 10.6f.1)');
  check(/No payment record yet|No payment/.test(payFn),
    '219k: drawer shows "No payment record yet" when no rows (Stage 8.4.12)');

  check(/btn-bc-copy-link-icon/.test(payFn) && /bcCopyPaymentLinkIcon/.test(src),
    '219l: drawer uses bcCopyPaymentLinkIcon for payment link copy (Stage 10.7c)');

  check(!/stripe\.(checkout|charges|paymentIntents|sessions)\.create/i.test(payUi),
    '219m: drawer does not make Stripe API calls (Stage 8.4.12)');
  check(!/sendWhatsApp|twilio|n8n.*webhook|triggerN8n/i.test(payUi),
    '219n: drawer does not call WhatsApp/n8n (Stage 8.4.12)');
  check(!/pg\.query.*UPDATE|pg\.query.*INSERT/i.test(payUi),
    '219o: drawer does not perform DB writes (Stage 8.4.12)');

  check(/payment_status === 'paid'|ctx-pay-record-paid/.test(payFn),
    '219p: drawer has paid state flags for banner rendering (Stage 8.4.12)');

  check(/bcPaymentLedgerRowDisplayLabel/.test(src),
    '219q: drawer uses bcPaymentLedgerRowDisplayLabel for payment status (Stage 10.6f.1)');
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

// ── Stage 8.5.18 / 10.6g.5 — Luna confirmation draft hidden from drawer ─────
(function(){
  const fnStart = src.indexOf('function renderBookingContextDrawer');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 100) : -1;
  const drawerFn = (fnStart > 0 && fnEnd > fnStart) ? src.slice(fnStart, fnEnd) : '';

  check(!/ctx-luna-confirmation-draft|bc-luna-confirmation-draft/.test(drawerFn),
    '10.6g.5: Luna confirmation draft panel not in normal drawer');
  check(!/Luna confirmation draft ready/.test(drawerFn),
    '10.6g.5: no Luna confirmation draft ready heading in drawer');
  check(!/Draft only — not sent/.test(drawerFn),
    '10.6g.5: no draft-only dry-run copy in drawer');
  check(!/whatsapp_dry_run:\s*<code>true<\/code>/.test(drawerFn),
    '10.6g.5: no whatsapp_dry_run dry-run panel in drawer');
  check(!/sends_whatsapp:\s*<code>false<\/code>/.test(drawerFn),
    '10.6g.5: no sends_whatsapp dry-run panel in drawer');
  check(!/Send confirmation|send-confirmation|confirmation-send|bc-send-confirmation/i.test(drawerFn),
    '10.6g.5: drawer has no confirmation send button');

  check(/confirmation_draft/.test(src) &&
        (/metadata\.confirmation_draft|bkMetadata\.confirmation_draft/.test(src)),
    '10.6g.5: booking context API still exposes confirmation_draft backend');
  check(/SELECT b\.metadata/.test(src),
    '10.6g.5: booking context still loads bookings.metadata');
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
  check(!/ctx-luna-confirmation-draft|bc-luna-confirmation-draft/.test(drawerFn),
    '10.6g.5: Luna confirmation draft panel hidden (Stage 8.7.6 layout)');
  check(!/Send confirmation|send-confirmation|confirmation-send|bc-send-confirmation/i.test(drawerFn),
    '223e: drawer still has no send button (Stage 8.7.6)');
  check(!/graph\.facebook\.com/.test(drawerFn),
    '223f: drawer has no graph.facebook.com (Stage 8.7.6)');
  check(!(/fetch[\s\S]{0,120}n8n|n8n[\s\S]{0,120}fetch/.test(drawerFn)),
    '223g: drawer makes no n8n calls (Stage 8.7.6)');
})();

// ── Stage 8.7.8 — bed calendar load + selection UX ─────────────────────────
(function(){
  check(/function bcOnBedCalendarTabOpen/.test(src),
    '224: bcOnBedCalendarTabOpen present (Stage 8.7.8)');
  check(/bed-calendar['"]\)\s*bcOnBedCalendarTabOpen|target === 'bed-calendar'[\s\S]{0,80}bcOnBedCalendarTabOpen/.test(src),
    '224b: Bed Calendar tab open triggers bcOnBedCalendarTabOpen (Stage 8.7.8)');
  (function checkBcTabAutoLoad(){
    const fnStart = src.indexOf('function bcOnBedCalendarTabOpen');
    const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction bcSetRange', fnStart) : -1;
    const fnSrc   = fnStart > 0 && fnEnd > fnStart ? src.slice(fnStart, fnEnd) : '';
    check(/30 \* 86400000|'30days'/.test(fnSrc) && (/loadBedCalendar\(\)/.test(fnSrc) || /bcSetRange/.test(fnSrc)),
      '224c: tab open uses next-30-days default load path (Stage 8.7.8)');
  })();
  check(/function showBlockDetail[\s\S]{0,200}bcClearSelection/.test(src),
    '224d: showBlockDetail clears manual booking panel (Stage 8.7.8)');
  check(/function bcHandleCellClick[\s\S]{0,600}bc-sel[\s\S]{0,400}bcClearSelection/.test(src),
    '224e: selected empty cell can be toggled/deselected (Stage 8.7.8)');
  check(/id="bc-load"/.test(src),
    '224f: Load button still present (Stage 8.7.8)');
  check(!/graph\.facebook\.com/.test(src),
    '224g: bed calendar UI has no graph.facebook.com (Stage 8.7.8)');
  check(!/api\.stripe\.com/.test(src),
    '224h: bed calendar UI has no api.stripe.com (Stage 8.7.8)');
  check(!(/fetch[\s\S]{0,80}n8n|https?:\/\/[^"'\\s]*n8n/i.test(src)),
    '224i: bed calendar UI has no n8n URL fetch (Stage 8.7.8)');
})();

// ── Stage 8.7.11 — payment box + compact add-ons layout ───────────────────
(function check8711PaymentAndAddOns(){
  const drawerSrc = extractRenderBookingContextDrawer(src);
  const paySrc = extractBcRenderRunningInvoiceHtml(src);
  const payUi = drawerSrc + paySrc;

  check(/\.ctx-pay-box/.test(src),
    '225: ctx-pay-box CSS present (Stage 8.7.11)');
  check(/ctx-pay-box/.test(paySrc),
    '225b: payment section wrapped in ctx-pay-box (Stage 8.7.11)');
  check(/ctx-pay-record-paid/.test(src) && /ctx-pay-record/.test(paySrc),
    '225c: payment records use contained card classes (Stage 8.7.11)');
  check(!/margin-top:8px;padding:8px 10px;background:#F3FAF1/.test(payUi),
    '225d: no full-width inline green payment card stretch (Stage 8.7.11)');
  check(/Invoice total|Balance due|bcPaymentLedgerPaidTotalCents/.test(paySrc) &&
        /Payment history|stripe_checkout_session_id/.test(paySrc),
    '225e: running invoice payment truth still renders in drawer (Stage 10.4d)');
  check(!/bc-luna-confirmation-draft/.test(drawerSrc),
    '10.6g.5: Luna confirmation draft panel hidden (Stage 8.7.11)');
  check(!/sendConfirmation|Send confirmation/i.test(drawerSrc),
    '225g: drawer still has no send button (Stage 8.7.11)');

  check(/\.bk-ao-row\{display:grid/.test(src),
    '225h: add-ons use compact grid rows (Stage 8.7.11)');
  check(!/\.bk-ao-label\{flex:1/.test(src),
    '225i: add-ons label no longer flex:1 stretch (Stage 8.7.11)');
  check(/id="bk-ao-meals"/.test(src),
    '225j: meals add-on input present (Stage 8.7.11)');
  check(!/not priced in quote yet/i.test(src),
    '225k: legacy meals on-site-only copy removed (Stage 10.6d)');

  const fnStart = src.indexOf('function buildAddOns');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/bk-ao-meals/.test(fnSrc) && /code:\s*['"]meals['"]/.test(fnSrc),
    '225l: buildAddOns includes meals as priced add-on when qty > 0 (Stage 10.6d)');

  const clearStart = src.indexOf('function bcClearSelection');
  const clearEnd   = clearStart > 0 ? src.indexOf('\nfunction ', clearStart + 10) : -1;
  const clearSrc   = clearStart > 0 && clearEnd > 0 ? src.slice(clearStart, clearEnd) : '';
  check(/bk-ao-meals/.test(clearSrc),
    '225m: bcClearSelection resets meals input (Stage 8.7.11)');

  check(!/graph\.facebook\.com/.test(src),
    '225n: bed calendar UI has no graph.facebook.com (Stage 8.7.11)');
  check(!/api\.stripe\.com/.test(src),
    '225o: bed calendar UI has no api.stripe.com (Stage 8.7.11)');
  check(!(/fetch[\s\S]{0,80}n8n|https?:\/\/[^"'\\s]*n8n/i.test(src)),
    '225p: bed calendar UI has no n8n URL fetch (Stage 8.7.11)');
})();

// ── Stage 8.7.15 — clean manual booking notes + add-ons layout ───────────────
(function check8715NotesAndAddOns(){
  const aoStart = src.indexOf('<!-- Section: Add-ons');
  const aoEnd   = aoStart > 0 ? src.indexOf('<!-- Section: Quote Preview', aoStart) : -1;
  const aoSrc   = aoStart > 0 && aoEnd > 0 ? src.slice(aoStart, aoEnd) : '';

  check(/\.bk-notes-block/.test(src),
    '226: bk-notes-block CSS present (Stage 8.7.15)');
  check(/class="bk-notes-block"/.test(src) && /for="bk-notes"/.test(src),
    '226b: staff notes use stacked bk-notes-block near label (Stage 8.7.15)');
  check(!/Notes[\s\S]{0,400}bk-form-row[\s\S]{0,120}bk-notes/.test(src),
    '226c: notes textarea not in wide bk-form-row layout (Stage 8.7.15)');

  check(!/type="checkbox"/.test(aoSrc),
    '226d: no add-on checkboxes in manual booking form (Stage 8.7.15)');
  check(/\.bk-ao-grid\{display:flex/.test(src) && /\.bk-ao-row\{display:grid/.test(src),
    '226e: add-ons compact left-aligned grid (Stage 8.7.15)');
  check(/\.bk-ao-unit/.test(src) && /class="bk-ao-unit">days/.test(aoSrc) &&
        /class="bk-ao-unit">lessons/.test(aoSrc) && /class="bk-ao-unit">classes/.test(aoSrc) &&
        /class="bk-ao-unit">meals/.test(aoSrc),
    '226f: day/lesson/class/meals unit labels visible beside inputs (Stage 8.7.15)');

  (function checkQtyDefaults(){
    ['bk-ao-ws-combo-days','bk-ao-wb-combo-days','bk-ao-wetsuit-days','bk-ao-softtop-days',
     'bk-ao-hardboard-days','bk-ao-surf-lessons','bk-ao-yoga','bk-ao-meals'].forEach(function(id){
      check(new RegExp('id="' + id + '"[^>]*value="0"').test(aoSrc),
        '226g: ' + id + ' defaults to 0 (Stage 8.7.15)');
    });
  })();

  const fnStart = src.indexOf('function buildAddOns');
  const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction ', fnStart + 10) : -1;
  const fnSrc   = fnStart > 0 && fnEnd > 0 ? src.slice(fnStart, fnEnd) : '';
  check(/function aoQtyInput/.test(src) && /aoQtyInput\(/.test(fnSrc) && /> 0/.test(fnSrc),
    '226h: buildAddOns uses aoQtyInput and qty > 0 (Stage 8.7.15)');
  check(/bk-ao-meals/.test(fnSrc) && /code:\s*['"]meals['"]/.test(fnSrc),
    '226i: meals qty > 0 sent via buildAddOns (Stage 10.6d)');

  check(!/graph\.facebook\.com/.test(src),
    '226j: bed calendar UI has no graph.facebook.com (Stage 8.7.15)');
  check(!/api\.stripe\.com/.test(src),
    '226k: bed calendar UI has no api.stripe.com (Stage 8.7.15)');
  check(!(/fetch[\s\S]{0,80}n8n|https?:\/\/[^"'\\s]*n8n/i.test(src)),
    '226l: bed calendar UI has no n8n URL fetch (Stage 8.7.15)');
})();

// ── Phase 10.7a — enabled Tour Operator forms (supersedes 8.7.17 skeleton) ───
(function check107aTourOperator(){
  check(/data-tab="tour-operator"/.test(src) && /id="to-op-panel"/.test(src) && /id="to-rr-panel"/.test(src),
    '227: Tour Operator tab and both panels present (Phase 10.7a)');

  check(/\/staff\/tour-operator\/blocks\/create/.test(toJs) &&
        /\/staff\/tour-operator\/release/.test(toJs),
    '227b: Tour Operator JS fetches create/release staff API endpoints (Phase 10.7a)');

  check(!/graph\.facebook\.com/.test(toJs + toTab) && !/api\.stripe\.com/.test(toJs + toTab),
    '227c: Tour Operator UI slice has no graph.facebook.com or api.stripe.com (Phase 10.7a)');

  check(/function toRenderBlockSelect/.test(toJs) && /data-cin/.test(toJs),
    '227d: operator block dropdown populated with readable labels and dates (Phase 10.7a)');

  check(/\/staff\/tour-operator\/rooms/.test(toJs) && /function toOnTourOperatorTabOpen/.test(toJs),
    '227e: room/blocks load via tour-operator API on tab open (Phase 10.7a)');

  check(/function toAfterMutation/.test(toJs) && /loadBedCalendar/.test(toJs),
    '227f: calendar reload after successful create/release (Phase 10.7a)');
})();

// ── Stage 8.7.18 — align manual booking guest + payment sections ─────────────
(function check8718GuestPaymentLayout(){
  const panelStart = src.indexOf('id="bc-sel-panel"');
  const panelEnd   = panelStart > 0 ? src.indexOf('<!-- Section: Notes', panelStart) : -1;
  const panelSrc   = panelStart > 0 && panelEnd > panelStart ? src.slice(panelStart, panelEnd) : '';

  const guestStart = panelSrc.indexOf('<!-- Section: Guest');
  const payStart   = panelSrc.indexOf('<!-- Section: Payment');
  const guestSrc   = guestStart >= 0 && payStart > guestStart ? panelSrc.slice(guestStart, payStart) : '';
  const payEnd     = panelSrc.indexOf('<!-- Section: Notes');
  const paySrc     = payStart >= 0 ? panelSrc.slice(payStart, payEnd > payStart ? payEnd : panelSrc.length) : '';

  check(/\.bk-compact-grid/.test(src) && /\.bk-compact-row/.test(src),
    '228: bk-compact-grid CSS present (Stage 8.7.18)');

  check(/class="bk-compact-grid"/.test(guestSrc) && /class="bk-compact-grid"/.test(paySrc),
    '228b: Guest and Payment sections use bk-compact-grid (Stage 8.7.18)');

  check(!/Guest[\s\S]{0,1200}bk-form-row[\s\S]{0,80}bk-guest-name/.test(panelSrc),
    '228c: Guest name not in wide bk-form-row layout (Stage 8.7.18)');

  check(/id="bk-guest-name"[^>]*bk-input-sm/.test(guestSrc) &&
        /id="bk-phone"[^>]*bk-input-sm/.test(guestSrc) &&
        /id="bk-email"[^>]*bk-input-sm/.test(guestSrc),
    '228d: guest name / phone / email use compact bk-input-sm (not full-width) (Stage 8.7.18)');

  check(!/Payment[\s\S]{0,900}bk-form-row[\s\S]{0,80}bk-payment-choice/.test(panelSrc),
    '228e: Payment fields not in wide bk-form-row layout (Stage 8.7.18)');

  check(/bk-compact-hint/.test(paySrc) && !/padding-left:158px/.test(src.match(/\.bk-compact-hint[\s\S]{0,120}/)?.[0] || ''),
    '228f: payment hint uses compact left-aligned style (Stage 8.7.18)');

  const quoteStart = src.indexOf('function runQuotePreview');
  const quoteEnd   = quoteStart > 0 ? src.indexOf('\nfunction ', quoteStart + 10) : -1;
  const quoteSrc   = quoteStart > 0 && quoteEnd > quoteStart ? src.slice(quoteStart, quoteEnd) : '';
  check(/bk-room-type/.test(quoteSrc) && /room_type/.test(quoteSrc),
    '228g: runQuotePreview still reads bk-room-type for payload (Stage 8.7.18)');

  check(!/graph\.facebook\.com/.test(src) && !/api\.stripe\.com/.test(src),
    '228h: bed calendar UI has no graph.facebook.com or api.stripe.com (Stage 8.7.18)');
  check(!(/fetch[\s\S]{0,80}n8n|https?:\/\/[^"'\\s]*n8n/i.test(src)),
    '228i: bed calendar UI has no n8n URL fetch (Stage 8.7.18)');
})();

// ── Stage 8.7.23 / 10.6a.4 — Bed Calendar range chips + Selected Stay layout ─
(function check8723RangeAndStayLayout(){
  const chipsStart = src.indexOf('id="bc-chips"');
  const chipsEnd   = chipsStart > 0 ? src.indexOf('</div>', src.indexOf('sep-oct', chipsStart)) : -1;
  const chipsSrc   = chipsStart > 0 && chipsEnd > chipsStart ? src.slice(chipsStart, chipsEnd + 6) : '';

  check(!/data-chip="today"|data-chip='today'/.test(chipsSrc),
    '229: Today range chip absent from Bed Calendar (Stage 8.7.23)');
  check(/data-chip="week"/.test(chipsSrc),
    '229b: This week chip still present (Stage 8.7.23)');
  check(/data-chip="30days"/.test(chipsSrc),
    '229c: Next 30 days chip still present (Stage 8.7.23)');
  check(/data-chip="apr-may"[^>]*>Apr - May</.test(chipsSrc),
    '10.7c: Apr - May chip present');
  check(/data-chip="may-jun"[^>]*>May - Jun</.test(chipsSrc),
    '10.7c: May - Jun chip present');
  check(/data-chip="jun-jul"[^>]*>Jun - Jul</.test(chipsSrc),
    '10.6a.4: Jun - Jul chip present (3-letter months)');
  check(/data-chip="jul-aug"[^>]*>Jul - Aug</.test(chipsSrc),
    '10.6a.4: Jul - Aug chip present (3-letter months)');
  check(/data-chip="aug-sept"[^>]*>Aug - Sep</.test(chipsSrc),
    '10.6a.4: Aug - Sep chip present (3-letter months)');
  check(/data-chip="sep-oct"[^>]*>Sep - Oct</.test(chipsSrc),
    '10.7b: Sep - Oct chip present');
  check(/data-chip="week"[\s\S]*?data-chip="30days"[\s\S]*?data-chip="apr-may"[\s\S]*?data-chip="may-jun"[\s\S]*?data-chip="jun-jul"[\s\S]*?data-chip="jul-aug"[\s\S]*?data-chip="aug-sept"[\s\S]*?data-chip="sep-oct"/.test(chipsSrc),
    '10.7c: quick range chips in desired order including Apr-May and May-Jun');
  check(/bc-chip-active[\s\S]*?data-chip="30days"|data-chip="30days"[\s\S]*?bc-chip-active/.test(chipsSrc),
    '10.6a.4: Next 30 days remains default active chip in markup');

  check(/bcSetRange/.test(src) && /loadBedCalendar/.test(src.match(/function bcSetRange[\s\S]*?\n\}/)?.[0] || ''),
    '10.6a.4: quick range chips call bcSetRange which loads calendar');
  check(/key === 'jun-jul'[\s\S]{0,120}bcSetRange\('2026-06-01', '2026-07-31', 'jun-jul'\)/.test(src),
    '10.6a.4: Jun - Jul chip sets 2026-06-01 to 2026-07-31');
  check(/key === 'aug-sept'[\s\S]{0,120}bcSetRange\('2026-08-01', '2026-09-30', 'aug-sept'\)/.test(src),
    '10.6a.4: Aug - Sep chip sets 2026-08-01 to 2026-09-30');
  check(/key === 'sep-oct'[\s\S]{0,120}bcSetRange\('2026-09-01', '2026-10-31', 'sep-oct'\)/.test(src),
    '10.7b: Sep - Oct chip sets 2026-09-01 to 2026-10-31');
  check(/key === 'apr-may'[\s\S]{0,120}bcSetRange\('2026-04-01', '2026-05-31', 'apr-may'\)/.test(src),
    '10.7c: Apr - May chip sets 2026-04-01 to 2026-05-31');
  check(/key === 'may-jun'[\s\S]{0,120}bcSetRange\('2026-05-01', '2026-06-30', 'may-jun'\)/.test(src),
    '10.7c: May - Jun chip sets 2026-05-01 to 2026-06-30');

  (function checkBcTabAutoLoad(){
    const fnStart = src.indexOf('function bcOnBedCalendarTabOpen');
    const fnEnd   = fnStart > 0 ? src.indexOf('\nfunction bcSetRange', fnStart) : -1;
    const fnSrc   = fnStart > 0 && fnEnd > fnStart ? src.slice(fnStart, fnEnd) : '';
    check(/30 \* 86400000|'30days'/.test(fnSrc) && (/loadBedCalendar\(\)/.test(fnSrc) || /bcSetRange/.test(fnSrc)),
      '229e: default auto-load Next 30 days unchanged (Stage 8.7.23)');
  })();

  const panelStart = src.indexOf('id="bc-sel-panel"');
  const guestStart = panelStart > 0 ? src.indexOf('<!-- Section: Guest', panelStart) : -1;
  const stayStart  = panelStart > 0 ? src.indexOf('<!-- Section: Selected Stay', panelStart) : -1;
  const staySrc    = stayStart >= 0 && guestStart > stayStart ? src.slice(stayStart, guestStart) : '';

  check(/Selected Stay[\s\S]{0,400}class="bk-compact-grid"/.test(staySrc),
    '229f: Selected Stay uses bk-compact-grid (Stage 8.7.23)');
  check(!/Selected Stay[\s\S]{0,1200}bk-form-row/.test(staySrc),
    '229g: Selected Stay not in wide bk-form-row layout (Stage 8.7.23)');
  check(/id="bc-sel-beds-list"/.test(staySrc) && /bc-sel-bed-tag/.test(src),
    '229h: selected bed chips still render (Stage 8.7.23)');

  check(!/graph\.facebook\.com/.test(src) && !/api\.stripe\.com/.test(src),
    '229i: bed calendar UI has no graph.facebook.com or api.stripe.com (Stage 8.7.23)');
  check(!(/fetch[\s\S]{0,80}n8n|https?:\/\/[^"'\\s]*n8n/i.test(src)),
    '229j: bed calendar UI has no n8n URL fetch (Stage 8.7.23)');
})();

// ── Stage 8.7.24 — Selected Stay: remove redundant Bed field ────────────────
(function check8724SelectedStayBedField(){
  const panelStart = src.indexOf('id="bc-sel-panel"');
  const guestStart = panelStart > 0 ? src.indexOf('<!-- Section: Guest', panelStart) : -1;
  const stayStart  = panelStart > 0 ? src.indexOf('<!-- Section: Selected Stay', panelStart) : -1;
  const staySrc    = stayStart >= 0 && guestStart > stayStart ? src.slice(stayStart, guestStart) : '';

  check(!/for="bc-sel-bed"|id="bc-sel-bed"/.test(staySrc),
    '230: Selected Stay has no redundant Bed field row (Stage 8.7.24)');
  check(/id="bc-sel-cin"/.test(staySrc) && /id="bc-sel-cout"/.test(staySrc) &&
        /id="bc-sel-nights"/.test(staySrc),
    '230b: check-in/check-out/nights still in Selected Stay (Stage 8.7.24)');
  check(/id="bc-sel-beds-list"/.test(staySrc) && /bc-sel-bed-tag/.test(src),
    '230c: selected bed chips still render (Stage 8.7.24)');

  (function checkQuoteCreateBeds(){
    const quoteStart = src.indexOf('function runQuotePreview');
    const quoteEnd   = quoteStart > 0 ? src.indexOf('\nfunction ', quoteStart + 1) : -1;
    const quoteSrc   = quoteStart > 0 && quoteEnd > quoteStart ? src.slice(quoteStart, quoteEnd) : '';
    const createStart = src.indexOf('function runManualBookingCreate');
    const createEnd   = createStart > 0 ? src.indexOf('\nfunction ', createStart + 1) : -1;
    const createSrc   = createStart > 0 && createEnd > createStart ? src.slice(createStart, createEnd) : '';
    check(/bcSelectedBeds\.map\(function\(b\)\{ return b\.bed_code; \}\)/.test(quoteSrc) &&
          /selected_bed_codes:\s*bcSelectedBeds\.map/.test(createSrc),
      '230d: quote/create still use bcSelectedBeds for selected_bed_codes (Stage 8.7.24)');
    check(/var bcSelectedBeds/.test(src),
      '230e: internal bcSelectedBeds selection state preserved (Stage 8.7.24)');
  })();

  check(!/graph\.facebook\.com/.test(src) && !/api\.stripe\.com/.test(src),
    '230f: bed calendar UI has no graph.facebook.com or api.stripe.com (Stage 8.7.24)');
  check(!(/fetch[\s\S]{0,80}n8n|https?:\/\/[^"'\\s]*n8n/i.test(src)),
    '230g: bed calendar UI has no n8n URL fetch (Stage 8.7.24)');
})();

// ── Stage 8.7.25 — Selected Stay: remove redundant Room field ───────────────
(function check8725SelectedStayRoomField(){
  const panelStart = src.indexOf('id="bc-sel-panel"');
  const guestStart = panelStart > 0 ? src.indexOf('<!-- Section: Guest', panelStart) : -1;
  const stayStart  = panelStart > 0 ? src.indexOf('<!-- Section: Selected Stay', panelStart) : -1;
  const staySrc    = stayStart >= 0 && guestStart > stayStart ? src.slice(stayStart, guestStart) : '';

  check(!/for="bc-sel-room"|id="bc-sel-room"/.test(staySrc),
    '231: Selected Stay has no redundant Room field row (Stage 8.7.25)');
  check(!/for="bc-sel-bed"|id="bc-sel-bed"/.test(staySrc),
    '231b: Selected Stay has no redundant Bed field row (Stage 8.7.25)');
  check(/id="bc-sel-cin"/.test(staySrc) && /id="bc-sel-cout"/.test(staySrc) &&
        /id="bc-sel-nights"/.test(staySrc),
    '231c: check-in/check-out/nights still in Selected Stay (Stage 8.7.25)');
  check(/id="bc-sel-beds-list"/.test(staySrc) && /bc-sel-bed-tag/.test(src) &&
        /escHtml\(b\.room_code\)/.test(src),
    '231d: selected bed chips still render with room/bed info (Stage 8.7.25)');

  (function checkQuoteCreateBeds(){
    const quoteStart = src.indexOf('function runQuotePreview');
    const quoteEnd   = quoteStart > 0 ? src.indexOf('\nfunction ', quoteStart + 1) : -1;
    const quoteSrc   = quoteStart > 0 && quoteEnd > quoteStart ? src.slice(quoteStart, quoteEnd) : '';
    const createStart = src.indexOf('function runManualBookingCreate');
    const createEnd   = createStart > 0 ? src.indexOf('\nfunction ', createStart + 1) : -1;
    const createSrc   = createStart > 0 && createEnd > createStart ? src.slice(createStart, createEnd) : '';
    check(/bcSelectedBeds\.map\(function\(b\)\{ return b\.bed_code; \}\)/.test(quoteSrc) &&
          /selected_bed_codes:\s*bcSelectedBeds\.map/.test(createSrc),
      '231e: quote/create still use bcSelectedBeds for selected_bed_codes (Stage 8.7.25)');
    check(/var bcSelectedBeds/.test(src) && /room_code/.test(src.slice(src.indexOf('var bcSelectedBeds'), src.indexOf('var bcSelectedBeds') + 120)),
      '231f: internal bcSelectedBeds room/bed data preserved (Stage 8.7.25)');
  })();

  check(!/graph\.facebook\.com/.test(src) && !/api\.stripe\.com/.test(src),
    '231g: bed calendar UI has no graph.facebook.com or api.stripe.com (Stage 8.7.25)');
  check(!(/fetch[\s\S]{0,80}n8n|https?:\/\/[^"'\\s]*n8n/i.test(src)),
    '231h: bed calendar UI has no n8n URL fetch (Stage 8.7.25)');
})();

// ── Stage 8.8.14 — Services & add-ons panel in booking drawer ───────────────
(function check8814BookingServiceRecordsDrawer(){
  const svcPanel = extractBcRenderRunningInvoiceHtml(src);

  check(/service_records:/.test(src) && /service_records_available:/.test(src),
    '232: booking context API returns service_records + service_records_available (Stage 8.8.14)');

  let libSrc = '';
  try { libSrc = fs.readFileSync(path.join(__dirname, 'lib', 'staff-booking-detail-queries.js'), 'utf8'); } catch(_){}
  const qMatch = libSrc.match(/function getBookingServiceRecordsQuery[\s\S]{0,2500}/);
  const qSrc = qMatch ? qMatch[0] : '';
  check(/FROM booking_service_records/.test(qSrc),
    '232b: getBookingServiceRecordsQuery reads booking_service_records (Stage 8.8.14)');
  check(/booking_id = b\.id/.test(qSrc) && /booking_code = b\.booking_code/.test(qSrc),
    '232c: service records query uses booking_id + booking_code fallback (Stage 8.8.14)');
  check(/ORDER BY sr\.service_date/.test(qSrc) && /service_type/.test(qSrc),
    '232d: service records ordered by service_date then service_type (Stage 8.8.14)');

  check(/isMissingBookingServiceRecordsTable|42P01/.test(src) &&
        /service_records_available/.test(src),
    '232e: table-missing safe fallback for service_records (Stage 8.8.14)');
  check(/loadBookingServiceRecords/.test(src),
    '232f: loadBookingServiceRecords helper exists (Stage 8.8.14)');

  check(/bcRenderRunningInvoiceHtml|id="bc-inv-addons"/.test(svcPanel),
    '232g: running invoice shows add-on lines from service_records (Stage 10.4d)');
  check(!/id="bc-service-records"/.test(svcPanel),
    '232h: legacy bc-service-records panel removed (Stage 10.4d)');
  check(/bcRunningInvoiceSvcLineText|amount_due_cents/.test(svcPanel),
    '232i: running invoice renders service record amounts (Stage 10.4d)');
  check(/No add-ons recorded/.test(svcPanel),
    '232j: running invoice empty add-ons copy (Stage 10.4d)');

  check(!/Add service|Add add-on|Edit service|Edit add-on|Send payment|payment link sent/i.test(svcPanel),
    '232k: running invoice has no Add/Edit/Send payment link buttons (Stage 8.8.14)');

  const ctxFnMatch = src.match(/async function handleBookingContext[\s\S]{0,4500}/);
  const ctxFn = ctxFnMatch ? ctxFnMatch[0] : '';
  check(!/conversations|conversation_messages|chat_log/.test(qSrc),
    '232l: service records query does not read chat/conversation logs (Stage 8.8.14)');
  check(!/INSERT|UPDATE|DELETE/.test(ctxFn.match(/loadBookingServiceRecords[\s\S]{0,800}/) ?
        ctxFn.match(/loadBookingServiceRecords[\s\S]{0,800}/)[0] : ctxFn),
    '232m: booking context service load has no INSERT/UPDATE/DELETE (Stage 8.8.14)');

  check(!/graph\.facebook\.com/.test(svcPanel) && !/api\.stripe\.com/.test(svcPanel),
    '232n: service panel has no graph.facebook.com or api.stripe.com (Stage 8.8.14)');
  check(!(/fetch[\s\S]{0,80}n8n|https?:\/\/[^"'\\s]*n8n/i.test(svcPanel)),
    '232o: service panel has no n8n URL fetch (Stage 8.8.14)');
})();

// ── Phase 10.6g — Bed calendar payment badges ───────────────────────────────
(function check106gCalendarPaymentBadges(){
  const calPaySlice = src.match(/\/\* Phase 10\.6g — bed calendar payment badges[\s\S]*?function bcColorClass/)?.[0] || '';
  const buildSlice = src.match(/function buildCalendarBlocks[\s\S]*?async function handleBedCalendar/)?.[0] || '';
  const ledgerSlice = src.match(/Phase 10\.6g\.2 — invoice \+ ledger payment truth[\s\S]*?PAYMENT_LEDGER_CANCELLABLE/)?.[0] || '';
  const staleSlice = src.match(/function bcPaymentLinkIntendedAmountCents[\s\S]*?function bcPaymentLedgerRowSortGroup/)?.[0] || '';

  check(/function bcCalendarBlockPaymentState/.test(src) && /function calendarBlockPaymentState/.test(src),
    '10.6g: client and server calendar payment state helpers');
  check(/bookingLedgerInvoicePaidBalance/.test(ledgerSlice) && /ledger_paid_cents/.test(buildSlice),
    '10.6g.2: calendar uses invoice + ledger paid totals (not booking.payment_status alone)');
  check(/booking_service_records/.test(src.match(/BED_CALENDAR_BOOKING_LEDGER_SQL[\s\S]*?;/)?.[0] || ''),
    '10.6g.2: calendar ledger SQL includes service_record sums');
  check(/status = 'paid'::payment_record_status/.test(src.match(/BED_CALENDAR_BOOKING_LEDGER_SQL[\s\S]*?;/)?.[0] || ''),
    '10.6g.2: calendar paid total sums paid payment rows only');
  check(/show_deposit_paid/.test(calPaySlice) && /bc-block-pay-deposit/.test(src),
    '10.6g.2: Deposit paid secondary badge when deposit threshold met');
  check(/balance_due/.test(calPaySlice) && /bc-block-pay-balance/.test(src),
    '10.6g.2: Balance due badge takes priority over Paid');
  check(/bc-block-pay-link/.test(src) && /Link sent/.test(calPaySlice),
    '10.6g.2: Link sent is secondary badge, not replacement for balance due');
  check(/deposit_only/.test(staleSlice) && /deposit_required_cents/.test(staleSlice),
    '10.6g.2: deposit link stale compares to deposit_required, not full balance');
  check(/paymentLinkIntendedAmountCents/.test(ledgerSlice),
    '10.6g.2: server payment-link intended amount helper');
  check(/bcPaymentLinkIntendedAmountCents/.test(staleSlice),
    '10.6g.2: drawer payment-link intended amount helper');
  check(!/status:\s*'balance_due'|status:\s*"balance_due"|'balance_due'::booking_status/.test(src),
    '10.6g: no new booking.status balance_due');
  check(!/>Cancelled<\/span>/.test(src.slice(src.indexOf('id="bc-legend"'), src.indexOf('id="bc-legend"') + 1200)),
    '10.6g: Cancelled legend item absent');
  check(!/>Balance due</.test(src.slice(src.indexOf('id="bc-legend"'), src.indexOf('id="bc-legend"') + 1200)),
    '10.7b: Balance due removed from main legend (badges remain in blocks)');
  check(/function showBlockDetail/.test(src) && /bcCalendarBlockInnerHtml/.test(src),
    '10.6g: calendar block click/drawer with payment badge markup');
  check(/BED_CALENDAR_BOOKING_LEDGER_SQL/.test(src) && /BED_CALENDAR_UNPAID_LINK_SQL/.test(src),
    '10.6g.2: calendar enriches blocks with ledger SELECTs only');
  check(/mergeBedCalendarPaymentSnapshots/.test(src),
    '10.6g.2: calendar merges ledger + link rows before badge state');
  check(!/stripe\.checkout|graph\.facebook\.com/.test(buildSlice + calPaySlice),
    '10.6g: no Stripe/WhatsApp in calendar payment badge slice');
  check(!/INSERT INTO|UPDATE bookings|UPDATE payments/.test(buildSlice.match(/handleBedCalendar[\s\S]*/)?.[0] || ''),
    '10.6g: bed calendar handler has no payment writes');
})();

// ── Phase 10.6g.6 — calendar block guest name label ─────────────────────────
(function check106g6CalendarGuestLabel(){
  const qFile = fs.readFileSync(require('path').join(__dirname, 'lib', 'staff-bed-calendar-queries.js'), 'utf8');
  const pickFn = src.match(/function pickCalendarGuestDisplayName[\s\S]*?\n\}/)?.[0] || '';
  const calPaySlice = src.match(/function bcCalendarBlockDisplayLabel[\s\S]*?function bcTurnoverVisibleLabel/)?.[0] || '';
  const blockLabelFn = src.match(/function bcBlockLabel[\s\S]*?\n\}/)?.[0] || '';
  const buildSlice = src.match(/function buildCalendarBlocks[\s\S]*?\n\}/)?.[0] || '';

  check(/b\.guest_name/.test(qFile) && /bed_guest_name/.test(qFile),
    '10.6g.6: bed calendar SELECT includes guest_name fields');
  check(/function bcCalendarBlockDisplayLabel/.test(src),
    '10.6g.6: client calendar display label helper');
  check(/function calendarBlockDisplayLabel/.test(src),
    '10.6g.6: server calendar display label helper');
  check(/bookingGuest \|\| bedGuest/.test(pickFn),
    '10.6g.6: label prefers guest_name / bed_guest_name over booking_code');
  check(/return code/.test(pickFn),
    '10.6g.6: booking_code remains fallback');
  check(/bcCalendarBlockDisplayLabel\(blk\)/.test(blockLabelFn),
    '10.6g.6: bcBlockLabel uses display label helper');
  check(!/codeShort/.test(blockLabelFn),
    '10.6g.6: short-span path no longer prefers booking_code shortcut');
  check(/pickCalendarGuestDisplayName\(row\)/.test(buildSlice),
    '10.6g.6: API block label uses guest-first helper');
  check(/label\.length > 16/.test(blockLabelFn),
    '10.6g.6: narrow blocks truncate guest name instead of swapping to code');

  check(/bookingGuest \|\| bedGuest \|\| planning/.test(pickFn),
    '10.6g.6: regression — human guest name wins when present');
})();

// ── Phase 10.6h.1 — preserve guest name after date-change calendar reload ───
(function check106h1CalendarGuestNameAfterDates(){
  const pickFn = src.match(/function pickCalendarGuestDisplayName[\s\S]*?\n\}/)?.[0] || '';
  const buildSlice = src.match(/function buildCalendarBlocks[\s\S]*?\n\}/)?.[0] || '';
  const datesSaveFn = src.match(/function bcFieldEditRunDatesSave[\s\S]*?\n\}/)?.[0] || '';

  check(/function pickCalendarGuestDisplayName/.test(src),
    '10.6h.1: shared pickCalendarGuestDisplayName helper');
  check(/toLowerCase\(\) === code\.toLowerCase\(\)/.test(pickFn),
    '10.6h.1: skips guest_name when it equals booking_code');
  check(/bed_guest_name/.test(pickFn) && /planning_row_label/.test(pickFn),
    '10.6h.1: label prefers bed/planning names before booking_code fallback');
  check(/pickCalendarGuestDisplayName\(row\)/.test(buildSlice),
    '10.6h.1: API blocks resolve guest label via pick helper');
  check(/bed_guest_name:/.test(buildSlice) && /planning_row_label:/.test(buildSlice),
    '10.6h.1: calendar blocks expose bed/planning guest fields for client render');
  check(/bcCalendarBlockDisplayLabel[\s\S]*pickCalendarGuestDisplayName/.test(src),
    '10.6h.1: client block label uses same pick helper');
  check(/calendarBlockDisplayLabel[\s\S]*pickCalendarGuestDisplayName/.test(src),
    '10.6h.1: server block label uses same pick helper');
  check(/loadBedCalendar/.test(datesSaveFn),
    '10.6h.1: date save success reloads bed calendar');
  check(/loadBlockDetail\(code\)/.test(datesSaveFn),
    '10.6h.1: date save success reloads booking drawer');
  check(/bcCalendarPaymentBadgesHtml/.test(src),
    '10.6h.1: payment badges helper still present');
  check(/Balance due|Deposit paid|bc-block-pay-paid|bc-block-pay-link/.test(src),
    '10.6h.1: payment badge labels still present');
})();

// ── Phase 10.6h hotfix — pickCalendarGuestDisplayName in browser bundle ─────
(function check106hClientPickGuestBundle(){
  const vm = require('vm');
  function extractEmbeddedUiScript(source) {
    const buildStart = source.indexOf('function buildUiHtml');
    const searchFrom = buildStart >= 0 ? buildStart : 0;
    const scriptTag = source.indexOf('<script>', searchFrom);
    if (scriptTag < 0) return null;
    const fnStart = source.indexOf('(function(){', scriptTag);
    if (fnStart < 0) return null;
    const endTag = source.indexOf('</script>', fnStart);
    if (endTag < 0) return null;
    const beforeClose = source.slice(fnStart, endTag);
    const relEnd = beforeClose.lastIndexOf('})();');
    if (relEnd < 0) return null;
    return beforeClose.slice(0, relEnd + '})();'.length);
  }
  const js = extractEmbeddedUiScript(src);
  if (!js) {
    check(false, '10.6h hotfix: could not extract embedded UI script');
    return;
  }
  const pickIdx = js.indexOf('function pickCalendarGuestDisplayName');
  const displayIdx = js.indexOf('function bcCalendarBlockDisplayLabel');
  check(pickIdx >= 0, '10.6h hotfix: browser bundle defines pickCalendarGuestDisplayName');
  check(pickIdx >= 0 && displayIdx > pickIdx,
    '10.6h hotfix: pickCalendarGuestDisplayName defined before bcCalendarBlockDisplayLabel');
  check(/bed_guest_name/.test(js.slice(pickIdx, pickIdx + 600)) && /planning_row_label/.test(js.slice(pickIdx, pickIdx + 800)),
    '10.6h hotfix: client pick helper includes bed/planning fallbacks');

  const pickSrc = js.match(/function pickCalendarGuestDisplayName[\s\S]*?\n\}/)?.[0] || '';
  if (pickSrc) {
    const pick = vm.runInNewContext(pickSrc + '; pickCalendarGuestDisplayName;');
    check(typeof pick === 'function', '10.6h hotfix: client pick helper is callable');
    check(pick({ booking_code: 'MB-WOLFHO-20260627-7b47a6', guest_name: 'MB-WOLFHO-20260627-7b47a6', bed_guest_name: 'Jimmy' }) === 'Jimmy',
      '10.6h hotfix: code-as-guest_name falls back to bed_guest_name Jimmy');
    check(pick({ booking_code: 'MB-X', guest_name: 'Alice' }) === 'Alice',
      '10.6h hotfix: real guest_name renders guest_name');
    check(pick({ booking_code: 'MB-FALLBACK' }) === 'MB-FALLBACK',
      '10.6h hotfix: booking_code fallback when no guest fields');
    check(/function bcCalendarPaymentBadgesHtml/.test(js),
      '10.6h hotfix: payment badge helper still in browser bundle');
    check(!/graph\.facebook\.com/.test(js) && !/n8n\.cloud.*activate/i.test(js),
      '10.6h hotfix: no WhatsApp/n8n in browser calendar bundle');
  } else {
    check(false, '10.6h hotfix: could not extract client pickCalendarGuestDisplayName');
  }
})();

// ── Phase 10.6g.5 — calendar badge inline layout ────────────────────────────
(function check106g5CalendarBadgeLayout(){
  const blockCss = src.match(/\.bc-block\{[^}]+\}/)?.[0] || '';
  const labelCss = src.match(/\.bc-block-label\{[^}]+\}/)?.[0] || '';
  const payCss = src.match(/\.bc-block-pay-wrap\{[^}]+\}/)?.[0] || '';
  const innerFn = src.match(/function bcCalendarBlockInnerHtml[\s\S]*?\n\}/)?.[0] || '';

  check(/flex-wrap:wrap/.test(blockCss),
    '10.6g.5: booking block uses flex-wrap for contained badges');
  check(!/flex:\s*1\s+1\s+auto/.test(labelCss),
    '10.6g.5: booking label not flex-grow (badges not pushed to far right)');
  check(/flex:0\s+1\s+auto/.test(labelCss),
    '10.6g.5: booking label stays inline before badges');
  check(/flex-wrap:wrap/.test(payCss) && /max-width:100%/.test(payCss),
    '10.6g.5: badge wrap is contained inside block');
  check(!/max-width:58%/.test(payCss),
    '10.6g.5: badge wrap not capped at far-right 58% column');
  check(!/margin-left:\s*auto/.test(payCss),
    '10.6g.5: badges not margin-left auto aligned');
  check(/bc-block-label/.test(innerFn) && /bcCalendarPaymentBadgesHtml/.test(innerFn),
    '10.6g.5: title/name renders before payment badges in block HTML');
  check(/bc-block-pay-deposit/.test(src) && /bc-block-pay-balance/.test(src) && /bc-block-pay-link/.test(src),
    '10.6g.5: Deposit paid / Balance due / Link sent badge classes preserved');
  check(/handleStripeCheckoutSuccessLanding/.test(src) && /\/staff\/payment\/success/.test(src),
    '10.6g.5: Stripe checkout landing routes preserved');
})();

// ── Phase 10.6a.4 — drawer/move/add-ons regressions + safety ───────────────
(function check106a4DrawerAndSafety(){
  check(/function loadBedCalendar/.test(src) && /renderBedCalendar/.test(src),
    '10.6a.4: bed calendar load/render still present');
  check(!/ctx-nights-badge/.test(
    src.match(/function bcDetailHeaderMetaHtml[\s\S]*?function updateBcDetailHeader/)?.[0] || ''
  ),
    '10.6a.4: drawer header nights badge still removed');
  check(/id="bc-add-ons-panel"/.test(src) && /bcRenderAddServicePanelHtml[\s\S]*?bcRenderRunningInvoiceHtml/.test(
    src.match(/function renderBookingContextDrawer[\s\S]*?return html;/)?.[0] || ''
  ),
    '10.6a.4: add-ons panel still above Payment in drawer');
  check(/id="bc-move-booking-btn"/.test(src) && />Move Bed</.test(src) && !/>Move booking</.test(
    src.match(/function renderBookingContextDrawer[\s\S]*?return html;/)?.[0] || ''
  ),
    '10.6g.5: visible Move Bed button label in drawer');
  check(/BC_BOOKING_MOVE_WRITE = true/.test(src),
    '10.6a.4: move write still enabled in drawer');
  check(!/graph\.facebook\.com/.test(src) && !/api\.stripe\.com/.test(src),
    '10.6a.4: no WhatsApp/Stripe URLs in staff bundle');
  check(!/INSERT INTO booking_service_records|UPDATE payments|DELETE FROM booking_beds/i.test(
    src.match(/function loadBedCalendar[\s\S]*?function bcIso/)?.[0] || ''
  ),
    '10.6a.4: calendar load path has no DB mutation');
})();

// ── Phase 10.7b — source-based calendar block colors + Sep-Oct chip ─────────
(function check107bSourceColors(){
  const colorFn = src.match(/function bedCalendarIsLunaBotSource[\s\S]*?function computeBlockSpan/)?.[0] || '';
  check(/function bedCalendarIsLunaBotSource/.test(colorFn) && /function bedCalendarColorType/.test(colorFn),
    '10.7b: source color helpers present');
  check(!/payment_status|balance_due|deposit_paid|cancelled/.test(
    src.match(/function bedCalendarColorType[\s\S]*?\n\}/)?.[0] || ''
  ),
    '10.7b: bedCalendarColorType does not depend on payment/status fields');
  check(/metadata_source|bot_source|metadata_created_by/.test(
    src.match(/handleBedCalendar[\s\S]*?buildCalendarBlocks/)?.[0] || ''
  ),
    '10.7b: calendar enrichment pulls metadata source fields');

  const lunaSrc = colorFn.match(/function bedCalendarIsLunaBotSource[\s\S]*?\n\}/)?.[0] || '';
  const colorTypeSrc = src.match(/function bedCalendarColorType[\s\S]*?\n\}/)?.[0] || '';
  if (lunaSrc && colorTypeSrc) {
    const vm = require('vm');
    const colorType = vm.runInNewContext(lunaSrc + '\n' + colorTypeSrc + '; bedCalendarColorType;');
    check(typeof colorType === 'function',
      '10.7b: source color helpers are callable');
    check(colorType({ booking_source: 'manual_staff' }) === 'confirmed',
      '10.7b: manual_staff maps to confirmed green');
    check(colorType({ booking_source: 'operator' }) === 'confirmed',
      '10.7b: operator block maps to confirmed green');
    check(colorType({ booking_source: 'tour_operator' }) === 'confirmed',
      '10.7b: tour_operator maps to confirmed green');
    check(colorType({ booking_source: 'manual_staff', metadata_source: 'bot_booking_stage854' }) === 'payment_pending',
      '10.7b: bot metadata on staff source maps to Luna blue');
    check(colorType({ booking_source: 'luna' }) === 'payment_pending',
      '10.7b: luna source maps to payment_pending blue');
    check(colorType({ channel: 'whatsapp' }) === 'payment_pending',
      '10.7b: whatsapp channel maps to Luna blue');
    check(colorType({ payment_status: 'paid', booking_status: 'cancelled' }) === 'confirmed',
      '10.7b: payment_status/cancelled do not drive main block color');
  } else {
    check(false, '10.7b: could not extract source color helpers for runtime checks');
  }

  check(/bc-block-pay-balance/.test(src) && /bc-block-pay-deposit/.test(src) &&
        /bc-block-pay-link/.test(src) && /Refund review/.test(src),
    '10.7b: payment/status badges still in block markup');
  check(!/graph\.facebook\.com/.test(src) && !/api\.stripe\.com/.test(src),
    '10.7b: no WhatsApp/Stripe URLs in staff bundle');
  check(!(/fetch[\s\S]{0,80}n8n|https?:\/\/[^"'\\s]*n8n/i.test(src)),
    '10.7b: no n8n URL fetch in staff bundle');
  check(!/INSERT INTO|UPDATE bookings|UPDATE payments/.test(
    src.match(/async function handleBedCalendar[\s\S]*?\n\/\/ ── Phase 10\.7a/)?.[0] || ''
  ),
    '10.7b: bed calendar handler has no DB writes');
})();

// ── Phase 10.7c — Apr-May / May-Jun chips + source legend preserved ─────────
(function check107cRangeChipsAndLegend(){
  const legendSlice = (() => {
    const s = src.indexOf('id="bc-legend"');
    return s >= 0 ? src.slice(s, s + 800) : '';
  })();
  check(/>Staff \/ manual</.test(legendSlice) && />Luna</.test(legendSlice),
    '10.7c: source legend still Staff/manual + Luna only');
  check(!/>Confirmed</.test(legendSlice) && !/>Payment pending</.test(legendSlice),
    '10.7c: old status-color legend entries still absent');
  check(/bcCalendarPaymentBadgesHtml/.test(src),
    '10.7c: payment badges helper still present');
})();

// ─────────────────────────────────────────────────────────────────────────────

console.log('\nResult: ' + passes + ' passed, ' + failures + ' failed\n');
if (failures > 0) process.exit(1);
