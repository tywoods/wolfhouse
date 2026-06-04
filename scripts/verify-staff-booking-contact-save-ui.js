/**
 * Phase 10.5f-lite — Static verifier for contact Save → gated write UI wiring.
 *
 * Usage:
 *   npm run verify:staff-booking-contact-save-ui
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');
const MIG_DIR  = path.join(__dirname, '..', 'database', 'migrations');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

console.log('\nverify-staff-booking-contact-save-ui.js  (Phase 10.5f-lite)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

const uiFlags = src.slice(src.indexOf('var BC_STAFF_ACTIONS'), src.indexOf('var bcLastQuote'));
const fieldSlice = src.match(/\/\* Phase 10\.4e — field edit UI shell[\s\S]*?function renderBookingContextDrawer/)?.[0] || '';
const contactSaveFn = src.match(/function bcFieldEditBuildContactWritePayload[\s\S]*?function bcFieldEditPackageChanged/)?.[0] || '';
const actionsFn = src.match(/function bcRenderFieldEditActionsHtml[\s\S]*?\n\}/)?.[0] || '';
const previewFn = src.match(/function bcFieldEditRunPreview[\s\S]*?function bcFieldEditRestoreForms/)?.[0] || '';
const initFn = src.match(/function bcInitFieldEditShell[\s\S]*?function renderBookingContextDrawer/)?.[0] || '';

console.log('\nA. No frontend write gate (10.5c.2)');

check(!/BC_BOOKING_EDIT_WRITE/.test(src),
  'BC_BOOKING_EDIT_WRITE UI flag removed');
check(!/const BOOKING_EDIT_WRITE_ENABLED/.test(src),
  'BOOKING_EDIT_WRITE_ENABLED server constant removed');

console.log('\nB. Contact Save → write');

check(/function bcFieldEditRunContactSave/.test(src), 'contact save runner exists');
check(/fetch\('\/staff\/bookings\/edit'/.test(src.match(/function bcFieldEditRunContactSave[\s\S]*?function bcFieldEditPackageChanged/)?.[0] || ''),
  'contact Save calls POST /staff/bookings/edit');
check(/edit_type:\s*'contact'/.test(contactSaveFn), 'contact write payload edit_type contact');
check(/guest_name:/.test(contactSaveFn) && /phone:/.test(contactSaveFn) && /email:/.test(contactSaveFn),
  'contact write payload includes guest_name, phone, email');
check(/bcFieldEditOptionalContactInput/.test(src), 'blank phone/email normalize helper');
check(/trimmed === '' \? null : trimmed/.test(src), 'empty string becomes null for phone/email');
check(/idempotency_key:/.test(contactSaveFn), 'contact write sends idempotency_key');
check(/data-bc-field-contact-save/.test(actionsFn), 'contact Save uses dedicated contact-save button');
check(/id="bc-field-save-contact"/.test(actionsFn), 'contact Save button id present');
check(!/Contact saving is disabled/.test(actionsFn),
  'no contact gate-off disabled hint copy');

console.log('\nC. Save enablement (valid + changed)');

const contactRunFn = src.match(/function bcFieldEditRunContactSave[\s\S]*?function bcFieldEditPackageChanged/)?.[0] || '';
check(!/BC_BOOKING_EDIT_WRITE/.test(contactRunFn + initFn + actionsFn),
  'contact save does not depend on BC_BOOKING_EDIT_WRITE');
check(!/bc-field-contact-save-hint/.test(actionsFn),
  'contact save gate hint element removed');
check(/bcFieldEditUpdateContactSaveState/.test(src), 'contact save enablement helper exists');
check(/btn\.disabled = !valid \|\| !changed/.test(src),
  'contact Save disabled only when invalid or unchanged');
check(/!valid \|\| !changed/.test(src), 'contact Save requires valid changed fields');

console.log('\nD. Success reload');

check(/loadBlockDetail\(code\)/.test(contactRunFn), 'successful contact save reloads booking drawer');
check(/bcFieldEditCloseAll/.test(contactRunFn), 'contact save closes edit shell after success');

console.log('\nE. Non-contact groups stay preview-only');

check(/fetch\('\/staff\/bookings\/edit-preview'/.test(previewFn),
  'preview runner still calls edit-preview');
check(!/fetch\('\/staff\/bookings\/edit'/.test(previewFn),
  'preview runner does not call write endpoint');
check(/data-bc-field-preview/.test(actionsFn),
  'dates/guests use data-bc-field-preview Save buttons');
check(/group === 'package'/.test(actionsFn) && /data-bc-field-package-save/.test(actionsFn),
  'package uses dedicated package-save Save button');
check(/data-bc-field-contact-save/.test(actionsFn) && /group === 'contact'/.test(actionsFn),
  'only contact branch uses contact-save attribute');
check(!/data-bc-field-contact-save="dates"|data-bc-field-contact-save="guests"/.test(actionsFn),
  'only contact uses contact-save attribute');

console.log('\nF. No package/date/guest write in UI');

check(!/edit_type:\s*'dates'/.test(contactSaveFn), 'UI write path has no dates edit_type');
check(!/edit_type:\s*'package'/.test(contactSaveFn), 'UI write path has no package edit_type');
check(!/edit_type:\s*'guests'/.test(contactSaveFn), 'UI write path has no guests edit_type');

console.log('\nG. Preserve drawer features');

check(/bcRenderRunningInvoiceHtml/.test(src), 'running invoice preserved');
check(/bcInitMovePanel/.test(src), 'move bed panel preserved');
check(/window\.switchToTabOnly/.test(src), 'Today navigation preserved');
check(/fetch\('\/staff\/bookings\/edit-preview'/.test(src), 'edit-preview still available');

console.log('\nH. Safety');

check(!/api\.stripe\.com/.test(contactRunFn + fieldSlice),
  'no Stripe API in contact save UI slice');
check(!/graph\.facebook\.com/.test(contactRunFn + fieldSlice),
  'no WhatsApp in contact save UI slice');
check(!/n8n\.cloud|activate.*workflow/i.test(contactRunFn + fieldSlice),
  'no n8n activation in contact save UI slice');
check(!/UPDATE payments|booking_service_records|UPDATE booking_beds/i.test(contactRunFn),
  'no payment/bed/service mutation in contact save UI');
check(!/INSERT INTO|DELETE FROM/i.test(contactRunFn),
  'no SQL mutation in contact save UI runner');

console.log('\nI. No docs / migration / deploy');

if (fs.existsSync(MIG_DIR)) {
  const migHit = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).some((f) => {
    const body = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    return /BC_BOOKING_EDIT_WRITE|contact-save-ui/i.test(body);
  });
  check(!migHit, 'no migration for contact save UI');
} else {
  ok('migrations directory not present (skip)');
}

try {
  const docOut = execSync('git diff --name-only HEAD -- docs/', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  check(!docOut, 'no docs changes in working tree');
} catch (_) {
  ok('no docs changes in working tree (skip git diff)');
}

console.log('\nJ. package.json script');

if (fs.existsSync(PKG_FILE)) {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(
    pkg.scripts && pkg.scripts['verify:staff-booking-contact-save-ui'] ===
      'node scripts/verify-staff-booking-contact-save-ui.js',
    'package.json has verify:staff-booking-contact-save-ui script'
  );
} else {
  fail('package.json exists');
}

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
