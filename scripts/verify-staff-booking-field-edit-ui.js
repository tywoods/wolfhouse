/**
 * Phase 10.4e — Static verifier for Staff Portal booking drawer field edit UI shell.
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

console.log('\nverify-staff-booking-field-edit-ui.js  (Phase 10.4e)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

const fieldBlock = src.match(/\/\* Phase 10\.4e — field edit UI shell[\s\S]*?function bcInitFieldEditShell[\s\S]*?\n\}/)?.[0] || '';
const renderField = src.match(/function bcRenderFieldEditSectionsHtml[\s\S]*?function bcFieldEditRestoreForms/)?.[0] || '';
const actionsHtml = src.match(/function bcRenderFieldEditActionsHtml[\s\S]*?\n\}/)?.[0] || '';
const drawerFn = src.match(/function renderBookingContextDrawer[\s\S]*?\n\}/)?.[0] || '';

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

console.log('\nB. Contact edit shell');

check(/id="bc-field-contact-name"/.test(renderField), 'contact name input');
check(/id="bc-field-contact-email"/.test(renderField), 'contact email input');
check(/data-bc-field-save=/.test(actionsHtml) && /Save<\/button>/.test(actionsHtml), 'Save control in actions helper');
check(/data-bc-field-cancel=/.test(actionsHtml) && /Cancel<\/button>/.test(actionsHtml), 'Cancel control in actions helper');

console.log('\nC. Dates edit shell');

check(/id="bc-field-dates-check-in"/.test(renderField) && /type="date"/.test(renderField),
  'check-in date input');
check(/id="bc-field-dates-check-out"/.test(renderField), 'check-out date input');
check(/bcFieldEditUpdateDatesPreview/.test(fieldBlock), 'dates preview updater');
check(/bcStayNightsFromCheckInOut/.test(fieldBlock), 'nights calculation in dates shell');
check(/check-out must be after check-in|Check-out must be after check-in/i.test(renderField + fieldBlock),
  'check_out > check_in validation copy');
check(/cout\.value <= cin\.value|check_out.*check_in/.test(fieldBlock),
  'check_out after check_in client validation');

console.log('\nD. Package edit shell');

check(/id="bc-field-package-select"/.test(renderField), 'package dropdown');
check(/bcFieldEditPackageOptions/.test(src), 'package options helper');
check(/malibu|uluwatu|waimea/.test(src.match(/function bcFieldEditPackageOptions[\s\S]*?\n\}/)?.[0] || ''),
  'known package fallback options');
check(/Temporary.*manual-create|10\.4f/i.test(src), 'package fallback documented as temporary');

console.log('\nE. Guests edit shell');

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

console.log('\nF. Save / Cancel behavior');

check(/Preview\/save coming next/.test(renderField + fieldBlock), 'save placeholder copy');
check(/btn\.disabled = true/.test(fieldBlock), 'Save buttons disabled');
check(/data-bc-field-save/.test(actionsHtml + renderField), 'Save buttons marked');
check(!/fetch\([^)]*\/staff\/bookings\/[^)]*edit|booking-edit-write|BOOKING_EDIT_WRITE/.test(fieldBlock),
  'field edit shell Save does not call write API');
check(/bcFieldEditRestoreForms/.test(fieldBlock), 'Cancel restores form snapshot');
check(/bcFieldEditCloseAll/.test(fieldBlock), 'Cancel closes edit shell');

console.log('\nG. Preserve existing drawer features');

check(/bcRenderRunningInvoiceHtml\(bk, svcRows, pmt\)/.test(drawerFn),
  'running invoice display preserved');
check(/id="bc-move-bed"/.test(drawerFn), 'Move bed panel preserved');
check(/bcInitMovePanel\(res\.data\)/.test(src), 'move panel init preserved');
check(/loadBlockDetail/.test(src), 'booking drawer reload preserved');

console.log('\nH. Safety boundaries');

check(!/api\.stripe\.com/.test(fieldBlock + renderField), 'no Stripe API URL in field edit slice');
check(!/graph\.facebook\.com/.test(fieldBlock + renderField), 'no WhatsApp URL in field edit slice');
check(!(/fetch[\s\S]{0,80}n8n|https?:\/\/[^"'\\s]*n8n/i.test(fieldBlock)), 'no n8n fetch in field edit slice');
check(!/INSERT INTO booking_service_records|UPDATE booking_service_records|UPDATE bookings|UPDATE booking_beds|UPDATE payments/.test(fieldBlock),
  'no mutation SQL in field edit shell');
check(!/ask-luna|alAsk|resolveNaturalLanguageIntent/.test(fieldBlock),
  'no Ask Luna changes in field edit slice');
check(!/Add service|Add add-on|create-payment-link/.test(fieldBlock + renderField),
  'no add-ons creation UI in field edit slice');
check(!/handleBookingEdit|\/staff\/bookings\/.*\/edit/.test(src.match(/bcInitFieldEditShell[\s\S]*?\n\}/)?.[0] || ''),
  'no booking edit write endpoint in init');

console.log('\nI. Package script');

try {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(pkg.scripts && pkg.scripts['verify:staff-booking-field-edit-ui'],
    'package.json has verify:staff-booking-field-edit-ui script');
} catch (_) {
  fail('package.json readable for script check');
}

console.log('\nJ. No docs / migration changes');

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
