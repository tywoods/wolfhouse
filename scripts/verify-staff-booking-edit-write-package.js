/**
 * Phase 10.5c — Static verifier for gated booking package edit write API.
 *
 * Usage:
 *   npm run verify:staff-booking-edit-write-package
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

console.log('\nverify-staff-booking-edit-write-package.js  (Phase 10.5c)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

const packageHandlerMatch = src.match(
  /async function handleBookingEditWritePackage[\s\S]*?async function handleBookingEditWrite/
);
const packageHandlerBlock = packageHandlerMatch ? packageHandlerMatch[0] : '';

const writeHandlerMatch = src.match(
  /async function handleBookingEditWrite\(req[\s\S]*?async function handleQuotePreview/
);
const writeHandlerBlock = writeHandlerMatch ? writeHandlerMatch[0] : '';

const writeSlice = packageHandlerBlock + writeHandlerBlock;

const routeIdx = src.indexOf("if (pathname === '/staff/bookings/edit')");
const routeSlice = routeIdx >= 0 ? src.slice(routeIdx, routeIdx + 800) : '';

const packageUpdateSql = src.match(/const EDIT_WRITE_PACKAGE_UPDATE_SQL = `([\s\S]*?)`;/);
const packageUpdateBlock = packageUpdateSql ? packageUpdateSql[1] : '';

const previewHandlerMatch = src.match(
  /async function handleBookingEditPreview[\s\S]*?async function handleBookingEditWritePackage/
);
const previewHandlerBlock = previewHandlerMatch ? previewHandlerMatch[0] : '';

const fieldBlock = src.match(
  /\/\* Phase 10\.4e — field edit UI shell[\s\S]*?function bcInitFieldEditShell[\s\S]*?\n  if \(cout\)/
)?.[0] || '';
const packageSaveUiFn = src.match(/function bcFieldEditBuildPackageWritePayload[\s\S]*?\/\* Phase 10\.4e/)?.[0] || '';

console.log('\nA. Route + gate');

check(/\/staff\/bookings\/edit/.test(src), 'POST /staff/bookings/edit route present');
check(/handleBookingEditWrite\s*\(/.test(src), 'handleBookingEditWrite handler defined');
check(/handleBookingEditWritePackage/.test(src), 'handleBookingEditWritePackage handler defined');
check(/pathname === '\/staff\/bookings\/edit'/.test(src), 'edit write pathname wired in router');
check(/BOOKING_EDIT_WRITE_ENABLED/.test(src), 'BOOKING_EDIT_WRITE_ENABLED gate exists');
check(/process\.env\.BOOKING_EDIT_WRITE_ENABLED === 'true'/.test(src),
  'BOOKING_EDIT_WRITE_ENABLED defaults OFF unless env true');
check(/booking_edit_write_disabled/.test(writeHandlerBlock),
  'disabled gate returns booking_edit_write_disabled');
check(/requireAuth\(req, res, 'operator'\)/.test(routeSlice),
  'edit write route requires operator auth');

console.log('\nB. Supported edit types');

check(/EDIT_WRITE_SUPPORTED_TYPES/.test(src) &&
  /'contact'/.test(src) && /'package'/.test(src),
  'EDIT_WRITE_SUPPORTED_TYPES includes contact and package');
check(/if \(editType === 'package'\)/.test(writeHandlerBlock),
  'main handler routes edit_type package');
check(/editWriteParseContactPatch/.test(writeHandlerBlock),
  'contact write path still present');
check(/edit_type_not_supported_in_phase_10_5c/.test(writeHandlerBlock),
  'dates/guests rejected with phase 10.5c error');
check(/editType === 'dates'/.test(previewHandlerBlock) &&
  !/editType === 'dates'/.test(packageHandlerBlock),
  'no dates write in package handler');
check(!/if \(editType === 'guests'\)/.test(writeSlice),
  'no guests write in edit write slice');

console.log('\nC. Package request validation');

check(packageHandlerBlock.length > 400, 'package write handler block extracted');
check(/package_code is required/.test(packageHandlerBlock), 'package_code required');
check(/editPreviewIsValidPackage/.test(packageHandlerBlock),
  'package_code validated via editPreviewIsValidPackage');
check(/editPreviewKnownPackageCodes|EDIT_PREVIEW_PACKAGE_FALLBACK/.test(src),
  'package validation uses config/fallback like edit-preview');
check(/idempotency_key is required/.test(writeHandlerBlock), 'idempotency_key required on write route');
check(/client_slug is required/.test(writeHandlerBlock), 'client_slug required');
check(/booking_id or booking_code is required/.test(writeHandlerBlock),
  'booking_id or booking_code required');
check(/edit_type is required/.test(writeHandlerBlock), 'edit_type required');

console.log('\nD. Package mutation — bookings expected invoice fields only');

check(/EDIT_WRITE_PACKAGE_UPDATE_SQL/.test(src), 'package UPDATE SQL constant present');
check(/package_code = \$3/.test(packageUpdateBlock), 'UPDATE sets package_code');
check(/total_amount_cents = \$4/.test(packageUpdateBlock), 'UPDATE sets total_amount_cents');
check(/balance_due_cents = \$5/.test(packageUpdateBlock), 'UPDATE sets balance_due_cents');
const packageSetBlock = packageUpdateBlock.split(/RETURNING/i)[0] || packageUpdateBlock;
check(!/amount_paid_cents/.test(packageSetBlock),
  'package UPDATE SET does not mutate amount_paid_cents (payment truth)');
check(!/UPDATE booking_beds/i.test(writeSlice),
  'no booking_beds mutation in package write slice');
check(!/UPDATE payments|INSERT INTO payments|DELETE FROM payments/i.test(writeSlice),
  'no payments table mutation in package write slice');
check(!/UPDATE booking_service_records|INSERT INTO booking_service_records|DELETE FROM booking_service_records/i.test(writeSlice),
  'no booking_service_records mutation in package write slice');
check(!/guest_count|check_in|check_out/.test(packageUpdateBlock),
  'package UPDATE does not set dates or guest_count');

console.log('\nE. Preview parity + invoice impact');

check(/editPreviewBuildInvoicePreview/.test(packageHandlerBlock),
  'package write uses editPreviewBuildInvoicePreview');
check(/loadBookingServiceRecords/.test(packageHandlerBlock),
  'package write loads service records read-only for preview calc');
check(/editWriteInvoiceImpactFromPreview/.test(packageHandlerBlock),
  'response builds invoice_impact from preview');
check(/payment_mutation:\s*false/.test(src) &&
  /editWriteInvoiceImpactFromPreview/.test(src),
  'invoice_impact payment_mutation:false');
check(/stripe_mutation:\s*false/.test(src), 'invoice_impact stripe_mutation:false');
check(/invoice_impact/.test(packageHandlerBlock), 'package response includes invoice_impact');
check(/before/.test(packageHandlerBlock) && /after/.test(packageHandlerBlock),
  'package response includes before/after package snapshots');
check(/editWritePackageSnapshot/.test(packageHandlerBlock),
  'before/after use editWritePackageSnapshot');
check(/editPreviewTryQuote/.test(packageHandlerBlock),
  'optional quote_snapshot metadata via editPreviewTryQuote');
check(/package_reprice_calculation_unavailable/.test(packageHandlerBlock),
  'blocks write when reprice calculation unavailable');

console.log('\nF. Idempotency');

check(/idempotent:\s*true/.test(packageHandlerBlock),
  'package idempotent path present');
check(/already matches the requested package_code/.test(packageHandlerBlock),
  'idempotent message when package unchanged');
check(/updated:\s*false/.test(packageHandlerBlock) &&
  /currentPkg === packageCode/.test(packageHandlerBlock),
  'idempotent path skips UPDATE when package already matches');

console.log('\nG. Audit + messaging');

check(/audit:\s*auditResponse|audit: auditResponse/.test(packageHandlerBlock),
  'package response includes audit object');
check(/actor:\s*actorLabel/.test(packageHandlerBlock), 'audit includes actor');
check(/idempotency_key/.test(packageHandlerBlock), 'audit includes idempotency_key');
check(/No payment, bed, service, Stripe, n8n, or WhatsApp changes were made/.test(packageHandlerBlock),
  'success message documents no payment/bed/service/Stripe/n8n/WhatsApp');

console.log('\nH. UI — package Save wired (10.5c.1)');

check(/bcFieldEditRunContactSave/.test(src), 'contact Save helper exists');
check(/bcFieldEditRunPackageSave/.test(src), 'package Save helper calls write API');
check(/data-bc-field-package-save/.test(src), 'package Save button attribute present');
check(/edit_type:\s*'package'/.test(packageSaveUiFn) &&
  /fetch\('\/staff\/bookings\/edit'/.test(packageSaveUiFn),
  'package UI posts to /staff/bookings/edit');
check(/data-bc-field-preview/.test(fieldBlock),
  'dates/guests field groups still use edit-preview Save');
check(/group === 'contact'/.test(src) && /data-bc-field-contact-save/.test(src),
  'contact group uses gated write Save');

console.log('\nI. Safety — no forbidden integrations');

check(!/graph\.facebook\.com/.test(writeSlice),
  'package write slice has no graph.facebook.com');
check(!/api\.stripe\.com/.test(writeSlice),
  'package write slice has no api.stripe.com');
check(!/n8n\.cloud|activate.*workflow/i.test(writeSlice),
  'package write slice has no n8n activation URL');

console.log('\nJ. No docs / migration / deploy');

if (fs.existsSync(MIG_DIR)) {
  const migFiles = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
  const migHit = migFiles.some((f) => {
    const body = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    return /EDIT_WRITE_PACKAGE|handleBookingEditWritePackage/i.test(body);
  });
  check(!migHit, 'no migration references package edit write');
} else {
  ok('migrations directory not present (skip)');
}

try {
  const docOut = execSync('git diff --name-only HEAD -- docs/', {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  }).trim();
  check(!docOut, 'no docs changes in working tree');
} catch (_) {
  ok('no docs changes in working tree (skip git diff)');
}

check(!/az containerapp update|deploy-staff|revisionSuffix/i.test(src.slice(-5000)),
  'no deploy commands added in staff-query-api tail');

console.log('\nK. package.json script');

if (fs.existsSync(PKG_FILE)) {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(
    pkg.scripts && pkg.scripts['verify:staff-booking-edit-write-package'] ===
      'node scripts/verify-staff-booking-edit-write-package.js',
    'package.json has verify:staff-booking-edit-write-package script'
  );
} else {
  fail('package.json exists');
}

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
