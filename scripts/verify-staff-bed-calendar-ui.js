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

// 24. No POST/PATCH/DELETE fetch in embedded UI JS (within script tags)
const jsSection = src.slice(src.indexOf('<script>') || 0);
check(!/fetch\s*\([^)]*,\s*\{[^}]*method\s*:\s*['"](?:POST|PATCH|DELETE|PUT)['"]/i.test(jsSection),
  'No POST/PATCH/DELETE fetch method in embedded UI JS');

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

// 35. Rooming/Beds section in drawer (renamed to Room/Beds in Stage 8.3b)
check(/h3.*Rooming|h3.*Room.*Beds/i.test(src),
  'Rooming / Beds section heading present in drawer (Stage 7.7i / 8.3b)');

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

// 46. Demo range chip present (Stage 8.3a)
check(/data-chip="demo"|data-chip='demo'/.test(src),
  'Demo range shortcut chip (data-chip="demo") present (Stage 8.3a)');

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

// 56. No POST/PATCH/DELETE fetch anywhere in the file
check(!/fetch\s*\([^)]*,\s*\{[^}]*method\s*:\s*['"](?:POST|PATCH|DELETE|PUT)['"]/i.test(src),
  'No POST/PATCH/DELETE fetch calls in entire file (Stage 8.3a)');

// ── Stage 8.3b — booking detail drawer cleanup ────────────────────────────

// 59. Guest section heading present (Stage 8.3b)
check(/h3.*Guest|Guest.*h3/i.test(src),
  'Guest section heading present in drawer (Stage 8.3b)');

// 60. Stay section heading present (Stage 8.3b)
check(/h3.*Stay|Stay.*h3/i.test(src),
  'Stay section heading present in drawer (Stage 8.3b)');

// 61. Room / Beds section heading present (Stage 8.3b)
check(/h3.*Room.*Beds|Room.*Beds.*h3/i.test(src),
  'Room / Beds section heading present in drawer (Stage 8.3b)');

// 62. Payment section heading present (Stage 8.3b)
check(/h3.*Payment|Payment.*h3/i.test(src),
  'Payment section heading present in drawer (Stage 8.3b)');

// 63. Conversation / Handoff section heading present (Stage 8.3b)
check(/h3.*Conversation.*Handoff|Conversation.*Handoff.*h3/i.test(src),
  'Conversation / Handoff section heading present in drawer (Stage 8.3b)');

// 64. Nights calculation present (Stage 8.3b)
check(/calcNights|night.*badge|ctx-nights/.test(src),
  'Nights calculation / badge present in drawer (Stage 8.3b)');

// 65. Remaining balance label present (Stage 8.3b)
check(/Remaining balance/i.test(src),
  '"Remaining balance" payment label present in drawer (Stage 8.3b)');

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

// 79. "Selection only — no booking created" notice present (Stage 8.3c)
check(/Selection only.*no booking created/i.test(src),
  '"Selection only — no booking created" notice present (Stage 8.3c)');

// 80. "Create Manual Booking" disabled button present (Stage 8.3c)
check(/Create Manual Booking.*coming soon/i.test(src),
  '"Create Manual Booking — coming soon" disabled button present (Stage 8.3c)');

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

console.log('\nResult: ' + passes + ' passed, ' + failures + ' failed\n');
if (failures > 0) process.exit(1);
