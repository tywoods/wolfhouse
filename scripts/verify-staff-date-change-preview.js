/**
 * Phase 10.4b — Static verifier for booking date-change preview endpoint.
 *
 * Usage:
 *   npm run verify:staff-date-change-preview
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

console.log('\nverify-staff-date-change-preview.js  (Phase 10.4b)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');
check(src.length > 10000, 'staff-query-api.js readable');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

const handlerMatch = src.match(/async function handleBookingDateChangePreview[\s\S]*?\r?\n}\r?\n\r?\n\/\/ ──+/);
const handlerBlock = handlerMatch ? handlerMatch[0] : '';
const pricingHelperMatch = src.match(/function dateChangePreviewPricingImpact[\s\S]*?\n}/);
const pricingHelperBlock = pricingHelperMatch ? pricingHelperMatch[0] : '';
const conflictHelperMatch = src.match(/function dateChangePreviewBuildConflicts[\s\S]*?\n}/);
const conflictHelperBlock = conflictHelperMatch ? conflictHelperMatch[0] : '';

console.log('\nA. Route + handler');

check(/\/staff\/bookings\/date-change-preview/.test(src),
  'POST /staff/bookings/date-change-preview route present');
check(/handleBookingDateChangePreview\s*\(/.test(src),
  'handleBookingDateChangePreview handler defined');
check(/pathname === '\/staff\/bookings\/date-change-preview'/.test(src),
  'date-change-preview pathname wired in router');
check(/requireAuth\(req, res, 'operator'\)/.test(
  src.slice(src.indexOf("if (pathname === '/staff/bookings/date-change-preview')"),
    src.indexOf("if (pathname === '/staff/bookings/date-change-preview')") + 700)
),
  'date-change-preview route uses operator auth');
check(/method !== 'POST'/.test(
  src.slice(src.indexOf("if (pathname === '/staff/bookings/date-change-preview')"),
    src.indexOf("if (pathname === '/staff/bookings/date-change-preview')") + 600)
),
  'date-change-preview route accepts POST only');

console.log('\nB. Preview response contract');

check(handlerBlock.length > 200,
  'date-change-preview handler block extracted');
check(/preview_only:\s*true/.test(handlerBlock),
  'handler returns preview_only:true');
check(/would_mutate:\s*false/.test(handlerBlock),
  'handler returns would_mutate:false');
check(/can_change_dates:/.test(handlerBlock),
  'handler returns can_change_dates flag');
check(/Date-change preview passed\. No changes were made\./.test(handlerBlock),
  'allowed preview message present');
check(/Current bed is not available for the proposed dates\. No changes were made\./.test(handlerBlock),
  'blocked preview message present');
check(/current:/.test(handlerBlock) && /proposed:/.test(handlerBlock),
  'response includes current and proposed stay blocks');
check(/nights_delta/.test(handlerBlock),
  'response includes nights_delta in proposed/pricing');
check(/pricing_impact:/.test(handlerBlock),
  'response includes pricing_impact');
check(/requires_reprice:/.test(pricingHelperBlock),
  'pricing_impact includes requires_reprice');
check(/payment_mutation:\s*false/.test(pricingHelperBlock),
  'pricing_impact includes payment_mutation:false');
check(/stripe_mutation:\s*false/.test(pricingHelperBlock),
  'pricing_impact includes stripe_mutation:false');

console.log('\nC. Input validation');

check(/client_slug is required/.test(handlerBlock),
  'client_slug required');
check(/booking_id or booking_code is required/.test(handlerBlock),
  'booking_id or booking_code required');
check(/new_check_in and new_check_out are required/.test(handlerBlock),
  'new_check_in and new_check_out required');
check(/new_check_out must be after new_check_in/.test(handlerBlock),
  'new_check_out after new_check_in enforced');
check(/target_bed_id must be a valid UUID/.test(handlerBlock),
  'target_bed_id UUID validated when provided');

console.log('\nD. Conflict logic');

check(/function movePreviewHalfOpenOverlaps/.test(src),
  'half-open overlap helper present');
check(/existingStart < targetCheckOut && existingEnd > targetCheckIn/.test(src),
  'half-open overlap uses strict < and > (same-day turnover allowed)');
check(/function dateChangePreviewBuildConflicts/.test(src),
  'date-change conflict builder present');
check(/row\.booking_id !== sourceBookingId/.test(conflictHelperBlock),
  'self-booking conflict exclusion present');
check(/MOVE_PREVIEW_NON_BLOCKING_STATUSES/.test(src),
  'cancelled/expired assignments excluded from conflicts');
check(/assignment_start_date < \$4::date/.test(src),
  'SQL overlap uses assignment_start_date < check_out');
check(/assignment_end_date\s+>\s+\$3::date/.test(src),
  'SQL overlap uses assignment_end_date > check_in');

console.log('\nE. Single-bed MVP scope');

check(/sourceBeds\.length !== 1/.test(handlerBlock),
  'single-bed booking requirement enforced');
check(/requires_manual_review:\s*true/.test(handlerBlock),
  'multi-bed/no-bed returns requires_manual_review:true');
check(/single_bed_booking_required/.test(handlerBlock),
  'multi-bed/no-bed returns reason single_bed_booking_required');

console.log('\nF. Write safety');

check(!/INSERT INTO|UPDATE\s+|DELETE FROM/i.test(handlerBlock),
  'no UPDATE/INSERT/DELETE in date-change-preview handler');
check(!/BEGIN|COMMIT|ROLLBACK/i.test(handlerBlock),
  'no transaction mutations in date-change-preview handler');
check(!/INSERT INTO bookings|UPDATE bookings|DELETE FROM booking_beds|UPDATE booking_beds/i.test(handlerBlock),
  'handler does not mutate bookings or booking_beds');
check(!/pathname === '\/staff\/bookings\/date-change'/.test(src.replace(/date-change-preview/g, '')) ||
  !/\/staff\/bookings\/date-change'/.test(src.replace(/\/staff\/bookings\/date-change-preview/g, '')),
  'no date-change write route added');
check(!/calculateWolfhouseQuote\s*\(/.test(handlerBlock),
  'handler does not calculate exact payment quote');

console.log('\nG. Safety — no forbidden integrations');

check(!/graph\.facebook\.com/.test(handlerBlock),
  'date-change-preview handler has no graph.facebook.com');
check(!/api\.stripe\.com/.test(handlerBlock),
  'date-change-preview handler has no api.stripe.com');
check(!/n8n\.cloud|activate.*workflow/i.test(handlerBlock),
  'date-change-preview handler has no n8n activation URL');
check(!/resolveNaturalLanguageIntent|function alAsk/.test(handlerBlock),
  'no Ask Luna logic in date-change-preview handler');
check(!/UPDATE payments|INSERT INTO payments|booking_service_records/i.test(handlerBlock),
  'no payment or service-record mutation in date-change-preview handler');
check(!/bc-move-preview-btn|bcMoveBooking|Move booking/.test(handlerBlock),
  'no UI changes in date-change-preview handler block');

console.log('\nH. Migrations unchanged');

if (fs.existsSync(MIG_DIR)) {
  const migFiles = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
  const migHasDateChange = migFiles.some((f) => {
    const body = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
    return /date-change-preview|booking_date_change/i.test(body);
  });
  check(!migHasDateChange, 'no new migration references date-change preview');
} else {
  ok('migrations directory not present (skip)');
}

console.log('\nI. package.json script');

if (fs.existsSync(PKG_FILE)) {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(
    pkg.scripts && pkg.scripts['verify:staff-date-change-preview'] ===
      'node scripts/verify-staff-date-change-preview.js',
    'package.json has verify:staff-date-change-preview script'
  );
} else {
  fail('package.json exists');
}

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
