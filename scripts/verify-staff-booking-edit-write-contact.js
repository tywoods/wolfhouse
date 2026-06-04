/**
 * Phase 10.5b — Static verifier for gated booking contact edit write API.
 *
 * Usage:
 *   npm run verify:staff-booking-edit-write-contact
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');
const MIG_DIR  = path.join(__dirname, '..', 'database', 'migrations');
const DOCS_DIR = path.join(__dirname, '..', 'docs');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

console.log('\nverify-staff-booking-edit-write-contact.js  (Phase 10.5b)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

const handlerMatch = src.match(/async function handleBookingEditWrite\(req[\s\S]*?async function handleQuotePreview/);
const previewHandlerMatch = src.match(/async function handleBookingEditPreview[\s\S]*?async function handleBookingEditWritePackage/);
const handlerBlock = handlerMatch ? handlerMatch[0] : '';
const routeIdx = src.indexOf("if (pathname === '/staff/bookings/edit')");
const routeSlice = routeIdx >= 0 ? src.slice(routeIdx, routeIdx + 800) : '';
const fieldBlock = src.match(/\/\* Phase 10\.4e — field edit UI shell[\s\S]*?function bcInitFieldEditShell[\s\S]*?\n  if \(cout\)/)?.[0] || '';
const previewHandlerBlock = previewHandlerMatch ? previewHandlerMatch[0] : '';
const contactUpdateSql = src.match(/const EDIT_WRITE_CONTACT_UPDATE_SQL = `([\s\S]*?)`;/);
const contactUpdateBlock = contactUpdateSql ? contactUpdateSql[1] : '';

console.log('\nA. Route + gate');

check(/\/staff\/bookings\/edit/.test(src), 'POST /staff/bookings/edit route present');
check(/handleBookingEditWrite\s*\(/.test(src), 'handleBookingEditWrite handler defined');
check(/pathname === '\/staff\/bookings\/edit'/.test(src), 'edit write pathname wired in router');
check(/BOOKING_EDIT_WRITE_ENABLED/.test(src), 'BOOKING_EDIT_WRITE_ENABLED gate exists');
check(/process\.env\.BOOKING_EDIT_WRITE_ENABLED === 'true'/.test(src),
  'BOOKING_EDIT_WRITE_ENABLED defaults OFF unless env true');
check(/booking_edit_write_disabled/.test(handlerBlock),
  'disabled gate returns booking_edit_write_disabled');
check(/enabled:\s*false/.test(handlerBlock), 'disabled gate returns enabled:false');
check(/updated:\s*false/.test(handlerBlock), 'disabled gate returns updated:false');
check(/requireAuth\(req, res, 'operator'\)/.test(routeSlice),
  'edit write route requires operator auth');

console.log('\nB. Request validation');

check(handlerBlock.length > 500, 'edit write handler block extracted');
check(/idempotency_key is required/.test(handlerBlock), 'idempotency_key required');
check(/client_slug is required/.test(handlerBlock), 'client_slug required');
check(/booking_id or booking_code is required/.test(handlerBlock), 'booking_id or booking_code required');
check(/edit_type is required/.test(handlerBlock), 'edit_type required');
check(/at least one of guest_name, phone, or email is required/.test(handlerBlock),
  'at least one contact field required');
check(/guest_name must not be empty/.test(handlerBlock), 'guest_name non-empty when provided');
check(/guest_name cannot be null/.test(handlerBlock), 'guest_name cannot be null');
check(/editWriteNormalizeOptionalContactField/.test(src), 'optional phone/email normalize helper');
check(/editWriteParseContactPatch/.test(src), 'contact patch parser with hasOwnProperty');
check(/trimmed === '' \? null : trimmed/.test(src), 'empty phone/email string normalizes to null');
check(!/phone must not be empty/.test(handlerBlock), 'phone may be cleared (no must-not-be-empty)');
check(!/email must not be empty/.test(handlerBlock), 'email may be cleared (no must-not-be-empty)');
check(/contactPatch\.phone !== undefined && contactPatch\.phone !== null/.test(handlerBlock),
  'phone validated only when non-null value');
check(/contactPatch\.email !== undefined && contactPatch\.email !== null/.test(handlerBlock),
  'email validated only when non-null value');
check(/editPreviewLightEmailOk/.test(handlerBlock), 'contact email validation');
check(/editPreviewLightNameOk/.test(handlerBlock), 'contact name validation');
check(/editPreviewLightPhoneOk/.test(handlerBlock), 'contact phone validation');
check(/editWriteContactFieldsMatch/.test(handlerBlock), 'idempotent match helper for contact fields');
check(/phone:\s*patch\.phone !== undefined/.test(src) || /patch\.phone !== undefined/.test(handlerBlock),
  'merge applies explicit phone patch including null clear');
check(/email:\s*patch\.email !== undefined/.test(src) || /patch\.email !== undefined/.test(handlerBlock),
  'merge applies explicit email patch including null clear');

console.log('\nC. Contact write scope (10.5b path)');

check(/EDIT_WRITE_SUPPORTED_TYPES/.test(src) && /'contact'/.test(src),
  'contact remains in EDIT_WRITE_SUPPORTED_TYPES');
check(/handleBookingEditWritePackage/.test(src),
  'package write lives in separate handler (10.5c)');
check(/if \(editType === 'package'\)/.test(handlerBlock),
  'main handler routes package before contact patch');
check(/edit_type_not_supported_in_phase_10_5c/.test(handlerBlock),
  'dates/guests rejected in write handler');
check(/editType === 'dates'/.test(previewHandlerBlock),
  'dates remains edit-preview only');
check(!/check_in\s*=|check_out\s*=/.test(contactUpdateBlock),
  'contact UPDATE does not set check_in/check_out');
check(/EDIT_WRITE_PACKAGE_UPDATE_SQL/.test(src) &&
  !/EDIT_WRITE_PACKAGE_UPDATE_SQL/.test(handlerBlock),
  'package UPDATE SQL not in contact handler tail');
check(/if \(editType === 'guests'\)|editType === 'guests'/.test(previewHandlerBlock) ||
  /\/\/ edit_type === 'guests'/.test(previewHandlerBlock),
  'guest decrease remains preview-only in edit-preview');
check(!/if \(editType === 'guests'\)/.test(handlerBlock) &&
  !/guest_count/.test(contactUpdateBlock),
  'no guest write in contact slice');

console.log('\nD. Mutation — bookings contact fields only');

check(/EDIT_WRITE_CONTACT_UPDATE_SQL/.test(src), 'contact UPDATE SQL constant present');
check(/guest_name = \$3/.test(contactUpdateBlock) && /phone\s*=\s*\$4/.test(contactUpdateBlock) &&
  /email\s*=\s*\$5/.test(contactUpdateBlock),
  'UPDATE sets guest_name, phone, email only');
check(!/UPDATE booking_beds/i.test(handlerBlock),
  'no booking_beds mutation in contact write handler');
check(!/UPDATE payments|INSERT INTO payments|DELETE FROM payments/i.test(handlerBlock),
  'no payments mutation in contact write handler');
check(!/booking_service_records/i.test(handlerBlock),
  'no booking_service_records mutation in contact write handler');
check(!/UPDATE bookings[\s\S]*package_code|guest_count|check_in|check_out/i.test(handlerBlock) ||
  !/SET[\s\S]*package_code/.test(handlerBlock),
  'no dates/package/guest_count columns in contact UPDATE');

console.log('\nE. Response + audit');

check(/before,/.test(handlerBlock) && /after:/.test(handlerBlock),
  'response includes before/after contact fields');
check(/guest_name/.test(handlerBlock) && /phone/.test(handlerBlock) && /email/.test(handlerBlock),
  'before/after include guest_name, phone, email');
check(/invoice_impact/.test(handlerBlock), 'response includes invoice_impact');
check(/payment_mutation:\s*false/.test(handlerBlock), 'invoice_impact payment_mutation:false');
check(/stripe_mutation:\s*false/.test(handlerBlock), 'invoice_impact stripe_mutation:false');
check(/requires_reprice:\s*false/.test(handlerBlock), 'invoice_impact requires_reprice:false');
check(/No payment, bed, service, Stripe, n8n, or WhatsApp changes were made/.test(handlerBlock),
  'success message documents no payment/bed/service/Stripe/n8n/WhatsApp changes');
check(/audit:\s*auditResponse|audit: auditResponse/.test(handlerBlock),
  'response includes audit object');
check(/actor:\s*actorLabel/.test(handlerBlock), 'audit includes actor');
check(/idempotency_key:\s*idempotencyKey/.test(handlerBlock), 'audit includes idempotency_key');
check(/reason,/.test(handlerBlock), 'audit includes reason');

console.log('\nF. Idempotency');

check(/idempotent:\s*true/.test(handlerBlock),
  'idempotent already-matching path present');
check(/already match the requested values/.test(handlerBlock),
  'idempotent message for matching contact values');
check(/updated:\s*false/.test(handlerBlock) && /editWriteContactFieldsMatch/.test(handlerBlock),
  'idempotent path skips UPDATE when values already match');
check(/hasOwnProperty\.call\(body, 'phone'\)/.test(src) &&
  /hasOwnProperty\.call\(body, 'email'\)/.test(src),
  'phone/email clear uses explicit body keys (null idempotent when already null)');
check(/editWriteMergeContactFields\(bookingRow, contactPatch\)/.test(handlerBlock),
  'merge uses parsed patch so email:null / phone:null clear correctly');

console.log('\nG. Preview + UI unchanged');

check(/handleBookingEditPreview/.test(src), 'edit-preview handler still present');
check(/\/staff\/bookings\/edit-preview/.test(src), 'edit-preview route still present');
check(/preview_only:\s*true/.test(previewHandlerBlock),
  'edit-preview still returns preview_only:true');
check(/bcFieldEditRunContactSave/.test(src) && /fetch\('\/staff\/bookings\/edit'/.test(src),
  'contact Save UI wired to gated write (10.5f-lite)');
check(/\/staff\/bookings\/edit-preview/.test(fieldBlock),
  'non-contact field edit UI still uses edit-preview');

console.log('\nH. Safety — no forbidden integrations');

check(!/graph\.facebook\.com/.test(handlerBlock),
  'contact write handler has no graph.facebook.com');
check(!/api\.stripe\.com/.test(handlerBlock),
  'contact write handler has no api.stripe.com');
check(!/n8n\.cloud|activate.*workflow/i.test(handlerBlock),
  'contact write handler has no n8n activation URL');
check(!/resolveNaturalLanguageIntent|function alAsk/.test(handlerBlock),
  'no Ask Luna logic in contact write handler');

console.log('\nI. No docs / migration changes');

if (fs.existsSync(MIG_DIR)) {
  const migFiles = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
  const migHit = migFiles.some((f) => {
    const body = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    return /BOOKING_EDIT_WRITE|booking_edit_write|\/staff\/bookings\/edit/i.test(body);
  });
  check(!migHit, 'no migration references booking edit write');
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
    pkg.scripts && pkg.scripts['verify:staff-booking-edit-write-contact'] ===
      'node scripts/verify-staff-booking-edit-write-contact.js',
    'package.json has verify:staff-booking-edit-write-contact script'
  );
} else {
  fail('package.json exists');
}

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
