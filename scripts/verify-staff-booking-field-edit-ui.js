/**
 * Phase 10.4e / 10.4f / 10.4f.3 — Static verifier for Staff Portal booking drawer field edit UI.
 *
 * UI shell from 10.4e; Preview flow wired in 10.4f; 10.4f.3 Save label + pencil icons + phone.
 *
 * Usage:
 *   npm run verify:staff-booking-field-edit-ui
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

console.log('\nverify-staff-booking-field-edit-ui.js  (Phase 10.4e / 10.4f / 10.4f.3)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

const renderField = src.match(/function bcRenderFieldEditPencilBtn[\s\S]*?function bcFieldEditRestoreForms/)?.[0] || '';
const actionsHtml = src.match(/function bcRenderFieldEditActionsHtml[\s\S]*?\n\}/)?.[0] || '';
const drawerFn = (() => {
  const i = src.indexOf('function renderBookingContextDrawer(data){');
  if (i < 0) return '';
  const j = src.indexOf('\n/* ── Tour Operator forms', i);
  return j > i ? src.slice(i, j) : '';
})();
const fieldUiSlice = src.match(/\/\* Phase 10\.4e — field edit UI shell[\s\S]*?function bcInitFieldEditShell[\s\S]*?\n  if \(cout\)/)?.[0] || '';
const previewRunner = src.match(/function bcFieldEditRunPreview[\s\S]*?\n\}/)?.[0] || '';
const previewResultFn = src.match(/function bcFieldEditRenderPreviewResult[\s\S]*?\n\}/)?.[0] || '';
const fieldInitBlock = src.match(/function bcInitFieldEditShell[\s\S]*?\n  if \(cout\)/)?.[0] || '';
const payloadFn = src.match(/function bcFieldEditBuildPreviewPayload[\s\S]*?\n\}/)?.[0] || '';
const fieldBlock = fieldUiSlice + previewRunner + previewResultFn;

console.log('\nA. Field edit structure');

check(/function bcRenderFieldEditSectionsHtml/.test(src), 'bcRenderFieldEditSectionsHtml exists');
check(/bcRenderFieldEditSectionsHtml\(data\)/.test(drawerFn), 'drawer renders field edit sections');
check(/function bcInitFieldEditShell/.test(src), 'bcInitFieldEditShell exists');
check(/bcInitFieldEditShell\(res\.data\)/.test(src), 'loadBlockDetail initializes field edit shell');
check(/btn-bc-field-edit/.test(renderField), 'edit buttons present');
check(/data-bc-field-group="contact"/.test(renderField), 'contact edit group');
check(/data-bc-field-group="dates"/.test(renderField), 'dates edit group');
check(/data-bc-field-group="package"/.test(renderField), 'package edit group');
check(/data-bc-field-group="guests"/.test(renderField), 'guests edit group');
check(/bcFieldEditState\.activeGroup/.test(fieldBlock), 'single active edit group state');
check(/bcFieldEditCloseAll/.test(fieldBlock) && /bcFieldEditActivate/.test(fieldBlock),
  'activate closes prior edit group');

console.log('\nB. Section titles removed (10.4f.3)');

check(!/ctx-field-header-label/.test(renderField),
  'standalone section titles GUEST/DATES/GUESTS/PACKAGE removed');
check(!/>Guest<\/span>[\s\S]{0,80}btn-bc-field-edit|ctx-field-header-label">Guest/.test(renderField),
  'no Guest section header label');
check(!/ctx-field-header-label">Dates/.test(renderField), 'no Dates section header label');
check(!/ctx-field-header-label">Guests/.test(renderField), 'no Guests section header label');
check(!/ctx-field-header-label">Package/.test(renderField), 'no Package section header label');
check(/kvBC\('Name'/.test(renderField) && /kvBC\('Phone'/.test(renderField) && /kvBC\('Email'/.test(renderField),
  'field labels Name / Phone / Email remain');
check(/kvBC\('Check-in'/.test(renderField) && /kvBC\('Check-out'/.test(renderField),
  'field labels Check-in / Check-out remain');
check(/kvBC\('Guests'/.test(renderField), 'field label Guests remains');
check(/kvBC\('Package'/.test(renderField), 'field label Package remains');

console.log('\nC. Pencil icon edit controls (10.4f.3)');

check(/function bcRenderFieldEditPencilBtn/.test(src), 'pencil edit button helper exists');
check(/\\u270E/.test(renderField), 'pencil icon character in edit buttons');
check(!/>Edit<\/button>/.test(renderField), 'visible Edit text removed from field buttons');
check(/bcRenderFieldEditPencilBtn\('contact', 'Edit contact'\)/.test(renderField),
  'accessible label for contact edit');
check(/bcRenderFieldEditPencilBtn\('dates', 'Edit dates'\)/.test(renderField),
  'accessible label for dates edit');
check(/bcRenderFieldEditPencilBtn\('guests', 'Edit guests'\)/.test(renderField),
  'accessible label for guests edit');
check(/bcRenderFieldEditPencilBtn\('package', 'Edit package'\)/.test(renderField),
  'accessible label for package edit');

console.log('\nD. Contact edit shell');

check(/id="bc-field-contact-name"/.test(renderField), 'contact name input');
check(/id="bc-field-contact-phone"/.test(renderField), 'contact phone input');
check(/id="bc-field-contact-email"/.test(renderField), 'contact email input');
check(/payload\.phone/.test(payloadFn), 'contact edit preview sends phone');
check(/bcFieldEditFormatContactLine/.test(previewResultFn),
  'contact preview renders current/proposed phone');
check(/data-bc-field-preview=/.test(actionsHtml) && />Save<\/button>/.test(actionsHtml),
  'Save control in actions helper (preview-only wiring)');
check(!/>Preview<\/button>/.test(actionsHtml), 'Preview label removed from actions helper');
check(/data-bc-field-cancel=/.test(actionsHtml) && /Cancel<\/button>/.test(actionsHtml),
  'Cancel control in actions helper');
check(!/data-bc-field-save=/.test(actionsHtml), 'no separate write save attribute');

console.log('\nE. Dates edit shell');

check(/id="bc-field-dates-check-in"/.test(renderField) && /type="date"/.test(renderField),
  'check-in date input');
check(/id="bc-field-dates-check-out"/.test(renderField), 'check-out date input');
check(/bcFieldEditUpdateDatesPreview/.test(fieldBlock), 'dates preview updater');
check(/bcStayNightsFromCheckInOut/.test(fieldBlock), 'nights calculation in dates shell');
check(/check-out must be after check-in|Check-out must be after check-in/i.test(renderField + fieldBlock),
  'check_out > check_in validation copy');
check(/cout\.value <= cin\.value|check_out.*check_in/.test(fieldBlock),
  'check_out after check_in client validation');

console.log('\nF. Package edit shell');

check(/id="bc-field-package-select"/.test(renderField), 'package dropdown');
check(/bcFieldEditPackageOptions/.test(src), 'package options helper');
check(/malibu|uluwatu|waimea/.test(src.match(/function bcFieldEditPackageOptions[\s\S]*?\n\}/)?.[0] || ''),
  'known package fallback options');
check(/Temporary.*manual-create|10\.4f/i.test(src), 'package fallback documented as temporary');

console.log('\nG. Guests edit shell');

check(/id="bc-field-guests-select"/.test(renderField), 'guest count dropdown');
check(/for \(var g = guestCount; g >= 1; g--\)/.test(renderField),
  'dropdown only from current guest count down to 1');
check(!/g <= guestCount \+ 1|guestCount \+ 1/.test(renderField),
  'no guest increase option in dropdown loop');
check(/bcFieldEditGuestReleasePreview/.test(src), 'guest bed release preview helper');
check(/Will release:/.test(fieldBlock), 'bed release preview copy');
check(/Remaining:/.test(fieldBlock), 'remaining beds preview copy');
check(/slice\(-nRelease\)|slice\(-n\)/.test(src), 'release beds from end of assignment list');
check(!/id="bc-field-guests-bed-select"|choose.*bed.*release|select which bed/i.test(renderField + fieldBlock),
  'no bed selection UI for guest reduction');

console.log('\nH. Save / preview behavior (10.4f.3)');

check(/bcFieldEditRunPreview/.test(src), 'preview runner function exists');
check(/fetch\('\/staff\/bookings\/edit-preview'/.test(previewRunner),
  'Save still calls calculate-only /staff/bookings/edit-preview');
check(/data-bc-field-preview/.test(actionsHtml + fieldInitBlock),
  'Save buttons wired via data-bc-field-preview');
check(!/fetch\([^)]*\/staff\/bookings\/edit[^\-p]/.test(previewRunner + fieldInitBlock),
  'no mutation fetch for Save');
check(/Preview only.*not saved|Preview only \\u2014 not saved/.test(fieldBlock),
  'preview result still says not saved');
check(/bcFieldEditClearPreviewResults/.test(fieldBlock),
  'Cancel/preview clear preview result panels');
check(/bcFieldEditRestoreForms/.test(fieldBlock), 'Cancel restores form snapshot');
check(/bcFieldEditCloseAll/.test(fieldBlock), 'Cancel closes edit shell');
check(/phone: bk\.phone/.test(fieldInitBlock), 'snapshot includes phone for cancel restore');

console.log('\nI. Edit-preview boundary (calculate-only; no write/save)');

check(/\/staff\/bookings\/edit-preview/.test(src),
  'edit-preview route exists in staff API');
check(/handleBookingEditPreview/.test(src),
  'edit-preview handler exists (calculate-only backend)');
check(!/fetch\([^)]*\/staff\/bookings\/[^)]*\/edit[^\-p]|booking-edit-write|BOOKING_EDIT_WRITE|handleBookingEditWrite/.test(fieldBlock),
  'field edit UI does not call booking edit write API');
check(!/INSERT INTO|UPDATE\s+|DELETE FROM/i.test(fieldBlock),
  'no UPDATE/INSERT/DELETE in field edit UI slice');

console.log('\nJ. Preserve existing drawer features');

check(/bcRenderRunningInvoiceHtml\(bk, svcRows, pmt\)/.test(drawerFn),
  'running invoice display preserved');
check(/id="bc-move-bed"/.test(drawerFn), 'Move bed panel preserved');
check(/bcInitMovePanel\(res\.data\)/.test(src), 'move panel init preserved');
check(/loadBlockDetail/.test(src), 'booking drawer reload preserved');
check(/window\.switchToTabOnly/.test(src), 'Today navigation globals preserved');

console.log('\nK. Safety boundaries');

check(!/api\.stripe\.com/.test(fieldBlock + renderField), 'no Stripe API URL in field edit slice');
check(!/graph\.facebook\.com/.test(fieldBlock + renderField), 'no WhatsApp URL in field edit slice');
check(!(/fetch[\s\S]{0,80}n8n|https?:\/\/[^"'\\s]*n8n/i.test(fieldBlock)), 'no n8n fetch in field edit slice');
check(!/INSERT INTO booking_service_records|UPDATE booking_service_records|UPDATE bookings|UPDATE booking_beds|UPDATE payments/.test(fieldBlock),
  'no mutation SQL in field edit shell');
check(!/ask-luna|alAsk|resolveNaturalLanguageIntent/.test(fieldBlock),
  'no Ask Luna changes in field edit slice');
check(!/Add service|Add add-on|create-payment-link/.test(fieldBlock + renderField),
  'no add-ons creation UI in field edit slice');
check(!/handleBookingEditWrite|\/staff\/bookings\/[^'"]+\/edit[^\-p]/.test(fieldInitBlock + previewRunner),
  'no booking edit write endpoint in field edit init/preview');

console.log('\nL. Package script');

try {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(pkg.scripts && pkg.scripts['verify:staff-booking-field-edit-ui'],
    'package.json has verify:staff-booking-field-edit-ui script');
} catch (_) {
  fail('package.json readable for script check');
}

console.log('\nM. Drawer spacing + stale warnings removed (10.6a.4)');

check(!/bc-detail-note/.test(src) || !/write gates approved/.test(src),
  '10.6a.4: bc-detail-note read-only gate banner removed');
check(!/Bed calendar is read-only/.test(src.match(/function showBlockDetail[\s\S]*?function loadBlockDetail/)?.[0] || ''),
  '10.6a.4: no read-only bed calendar banner in showBlockDetail');
check(!/Planned operations/.test(drawerFn),
  '10.6a.4: Planned operations stale block removed from drawer');
check(!/write gates not approved/.test(drawerFn),
  '10.6a.4: write gates not approved copy removed from drawer');
check(/ctx-field-edit-group/.test(renderField) && !/ctx-section ctx-field-edit-group/.test(renderField),
  '10.6a.4: field sections use compact ctx-field-edit-group without ctx-section chrome');
check(/#bc-ctx-body \.ctx-field-edit-group \.kv-grid/.test(src),
  '10.6a.4: field kv-grid uses compact single-column layout');
check(/ctx-field-guests-preview:empty|has-preview/.test(src),
  '10.6a.4: guests preview hidden until editing');
check(/id="bc-field-save-contact"/.test(renderField) && /id="bc-field-save-dates"/.test(renderField),
  '10.6a.4: contact and dates Save controls still present');
check(/id="bc-move-booking-btn"/.test(drawerFn) && /bcRenderAddServicePanelHtml/.test(drawerFn),
  '10.6a.4: Move bed and add-ons panel still in drawer');
check(/bcRenderAddServicePanelHtml[\s\S]*bcRenderRunningInvoiceHtml/.test(drawerFn),
  '10.6a.4: add-ons still above Payment');
check(/bcRenderBookingCancelFooterHtml/.test(drawerFn),
  '10.6a.4: cancel reservation footer still present');

console.log('\nN. No docs / migration changes');

let docsChanged = false;
let migChanged = false;
try {
  const docsOut = execSync('git diff --name-only -- docs', { encoding: 'utf8', cwd: path.join(__dirname, '..') }).trim();
  docsChanged = docsOut.length > 0;
  const migOut = execSync('git diff --name-only -- database/migrations', { encoding: 'utf8', cwd: path.join(__dirname, '..') }).trim();
  migChanged = migOut.length > 0;
} catch (_) { /* ok */ }
check(!docsChanged, 'no docs changes in working tree');
check(!migChanged, 'no database/migrations changes in working tree');

console.log('\nResult: ' + passes + ' passed, ' + failures + ' failed\n');
if (failures > 0) process.exit(1);
