/**
 * Phase 10.4f — Static verifier for booking edit preview API + UI wiring.
 *
 * Usage:
 *   npm run verify:staff-booking-edit-preview
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

console.log('\nverify-staff-booking-edit-preview.js  (Phase 10.4f)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

const handlerMatch = src.match(/async function handleBookingEditPreview[\s\S]*?\r?\n}\r?\n\r?\n\/\/ ──+/);
const handlerBlock = handlerMatch ? handlerMatch[0] : '';
const guestHelperMatch = src.match(/function editPreviewGuestBedRelease[\s\S]*?\n}/);
const guestHelperBlock = guestHelperMatch ? guestHelperMatch[0] : '';
const conflictHelperMatch = src.match(/function editPreviewDatesBuildConflicts[\s\S]*?\n}/);
const conflictHelperBlock = conflictHelperMatch ? conflictHelperMatch[0] : '';
const fieldBlock = src.match(/\/\* Phase 10\.4e — field edit UI shell[\s\S]*?function bcInitFieldEditShell[\s\S]*?\n  if \(cout\)/)?.[0] || '';
const fieldInitBlock = src.match(/function bcInitFieldEditShell[\s\S]*?\n  if \(cout\)/)?.[0] || '';
const routeSlice = src.slice(
  src.indexOf("if (pathname === '/staff/bookings/edit-preview')"),
  src.indexOf("if (pathname === '/staff/bookings/edit-preview')") + 700
);

console.log('\nA. Route + handler');

check(/\/staff\/bookings\/edit-preview/.test(src), 'POST /staff/bookings/edit-preview route present');
check(/handleBookingEditPreview\s*\(/.test(src), 'handleBookingEditPreview handler defined');
check(/pathname === '\/staff\/bookings\/edit-preview'/.test(src), 'edit-preview pathname wired in router');
check(/requireAuth\(req, res, 'operator'\)/.test(routeSlice), 'edit-preview route uses operator auth');
check(/method !== 'POST'/.test(routeSlice), 'edit-preview route accepts POST only');

console.log('\nB. Preview response contract');

check(handlerBlock.length > 500, 'edit-preview handler block extracted');
check(/preview_only:\s*true/.test(handlerBlock), 'handler returns preview_only:true');
check(/would_mutate:\s*false/.test(handlerBlock), 'handler returns would_mutate:false');
check(/payment_mutation:\s*false/.test(handlerBlock), 'handler returns payment_mutation:false');
check(/stripe_mutation:\s*false/.test(handlerBlock), 'handler returns stripe_mutation:false');
check(/invoice_preview/.test(handlerBlock), 'response includes invoice_preview');
check(/Edit preview calculated\. No changes were saved\./.test(handlerBlock), 'preview not-saved message present');

console.log('\nC. Edit types');

check(/EDIT_PREVIEW_VALID_TYPES/.test(src) && /contact/.test(handlerBlock) && /dates/.test(handlerBlock),
  'supports edit_type contact and dates');
check(/edit_type === 'package'|editType === 'package'/.test(handlerBlock), 'supports edit_type package');
check(/edit_type === 'guests'|editType === 'guests'/.test(handlerBlock), 'supports edit_type guests');

console.log('\nD. Contact preview');

check(/editPreviewLightEmailOk/.test(src), 'contact email shape validation');
check(/editPreviewLightNameOk/.test(src), 'contact name shape validation');
check(/editPreviewLightPhoneOk/.test(src), 'contact phone shape validation (10.4f.3)');
check(/body\.phone/.test(handlerBlock), 'contact preview accepts phone in request body');
check(/phone: bookingRow\.phone/.test(handlerBlock), 'contact preview current includes phone');
check(/phone: phone/.test(handlerBlock), 'contact preview proposed includes phone');
check(/no_pricing_change/.test(handlerBlock), 'contact has no pricing impact flag');

console.log('\nE. Dates preview');

check(/movePreviewHalfOpenOverlaps/.test(conflictHelperBlock + handlerBlock),
  'date preview uses half-open overlap helper');
check(/existingStart < targetCheckOut && existingEnd > targetCheckIn/.test(src),
  'same-day checkout/checkin allowed (half-open)');
check(/editPreviewDatesBuildConflicts/.test(src), 'multi-bed date conflict builder present');
check(/row\.booking_id !== sourceBookingId/.test(conflictHelperBlock),
  'excludes booking own assignment rows');
check(/requires_reprice|nights_delta/.test(handlerBlock), 'dates includes reprice/nights delta when needed');

console.log('\nF. Package preview');

check(/editPreviewIsValidPackage/.test(src), 'package preview validates package_code');
check(/editPreviewKnownPackageCodes/.test(src), 'package codes from config/fallback');

console.log('\nG. Guest decrease preview');

check(/guest_increase_not_supported/.test(handlerBlock), 'guest preview blocks increases');
check(/release_booking_bed_ids/.test(handlerBlock + guestHelperBlock), 'guest preview returns release_booking_bed_ids');
check(/released_beds/.test(handlerBlock + guestHelperBlock), 'guest preview returns released_beds labels');
check(/remaining_beds/.test(handlerBlock + guestHelperBlock), 'guest preview returns remaining_beds labels');
check(/slice\(-nRelease\)/.test(guestHelperBlock), 'release beds from end of assignment list');
check(/requires_manual_review/.test(handlerBlock + guestHelperBlock),
  'insufficient rows returns requires_manual_review');

console.log('\nH. Invoice preview');

check(/editPreviewBuildInvoicePreview/.test(src), 'invoice preview builder exists');
check(/payment_mutation:\s*false/.test(src.match(/function editPreviewBuildInvoicePreview[\s\S]*?\n}/)?.[0] || ''),
  'invoice_preview has payment_mutation:false');
check(/stripe_mutation:\s*false/.test(src.match(/function editPreviewBuildInvoicePreview[\s\S]*?\n}/)?.[0] || ''),
  'invoice_preview has stripe_mutation:false');
check(/calculation_warnings/.test(src), 'partial invoice can include calculation_warnings');

console.log('\nI. UI wiring');

check(/bcFieldEditRunPreview/.test(src), 'UI preview runner exists');
check(/fetch\('\/staff\/bookings\/edit-preview'/.test(src), 'field edit shells call /staff/bookings/edit-preview');
check(/data-bc-field-preview/.test(src), 'Save button uses preview attribute (10.4f.3)');
check(/>Save<\/button>/.test(src), 'UI button copy is Save (10.4f.3)');
check(!/>Preview<\/button>/.test(src.match(/function bcRenderFieldEditActionsHtml[\s\S]*?\n\}/)?.[0] || ''),
  'Preview label removed from field edit actions');
check(/Preview only.*not saved|Preview only \u2014 not saved/.test(src),
  'preview result says not saved');
check(!/fetch\([^)]*\/staff\/bookings\/[^)]*\/edit[^-]/.test(fieldInitBlock + fieldBlock),
  'no booking edit write endpoint in UI init');

console.log('\nJ. Write safety');

check(!/INSERT INTO|UPDATE\s+|DELETE FROM/i.test(handlerBlock),
  'no UPDATE/INSERT/DELETE in edit-preview handler');
check(!/BEGIN|COMMIT|ROLLBACK/i.test(handlerBlock),
  'no transaction mutations in edit-preview handler');
check(!/INSERT INTO bookings|UPDATE bookings|DELETE FROM booking_beds|UPDATE booking_beds|UPDATE payments|booking_service_records/i.test(handlerBlock),
  'handler does not mutate bookings, beds, payments, or service records');
check(!/api\.stripe\.com/.test(handlerBlock), 'no Stripe API URL in handler');
check(!/graph\.facebook\.com/.test(handlerBlock), 'no WhatsApp URL in handler');
check(!/n8n\.cloud|activate.*workflow/i.test(handlerBlock), 'no n8n activation URL in handler');
check(!/resolveNaturalLanguageIntent|function alAsk/.test(handlerBlock), 'no Ask Luna logic in handler');
check(/handleBookingEditWrite/.test(src) && /pathname === '\/staff\/bookings\/edit'/.test(src),
  'booking edit write route present (contact/package/dates)');
check(!/handleBookingEditWrite|handleBookingEditWriteDates|handleBookingEditWritePackage/.test(handlerBlock),
  'edit-preview handler does not invoke write path');
check(!/const BOOKING_EDIT_WRITE_ENABLED/.test(src),
  'no BOOKING_EDIT_WRITE_ENABLED env gate (10.5c.2+)');
check(!/if \(!BOOKING_EDIT_WRITE_ENABLED\)/.test(src),
  'write handler not gated by BOOKING_EDIT_WRITE_ENABLED');

console.log('\nK. Preserve existing features');

check(/bcRenderRunningInvoiceHtml\(bk, svcRows, pmt\)/.test(src), 'running invoice display preserved');
check(/id="bc-move-bed"/.test(src), 'Move bed panel preserved');
check(!/Add service|create-payment-link/.test(fieldBlock), 'no add-ons creation UI in field edit slice');

console.log('\nL. Package script');

try {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(
    pkg.scripts && pkg.scripts['verify:staff-booking-edit-preview'] ===
      'node scripts/verify-staff-booking-edit-preview.js',
    'package.json has verify:staff-booking-edit-preview script'
  );
} catch (_) {
  fail('package.json readable for script check');
}

console.log('\nM. No docs / migration changes');

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
