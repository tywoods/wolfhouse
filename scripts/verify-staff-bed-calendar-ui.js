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

// 23. "Booking edits are disabled" notice
check(/Booking edits are disabled/i.test(src),
  '"Booking edits are disabled" notice present in detail panel');

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

// 34. Payments section in drawer
check(/ctx-section.*Payments|Payments.*ctx-section/i.test(src) || /h3.*Payments/i.test(src),
  'Payments section present in drawer (Stage 7.7i)');

// 35. Rooming section in drawer
check(/h3.*Rooming/i.test(src),
  'Rooming / Beds section present in drawer (Stage 7.7i)');

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

// 40. Booking edits disabled note still present
check(/Booking edits are disabled/i.test(src),
  '"Booking edits are disabled" note still present (Stage 7.7i)');

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

// ─────────────────────────────────────────────────────────────────────────────

console.log('\nResult: ' + passes + ' passed, ' + failures + ' failed\n');
if (failures > 0) process.exit(1);
