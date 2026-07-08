'use strict';

/**
 * verify:manual-booking-per-guest-package
 *
 * Offline checks for feat/per-guest-package-only:
 *   - booking-level package selector (bk-package) and its manual-price-override
 *     row (bk-manual-price-row) are fully removed from the staff portal source.
 *   - per-guest package dropdowns are rendered from a per-client option list
 *     (bcGuestPackageOptions) with the hardcoded list as fallback.
 *   - the manual-booking create payload sends guest_packages and a null
 *     booking-level package_code (backend derives the majority).
 *   - buildClientProfilesMap / loadClientPortalProfile expose
 *     manual_booking_packages, and wolfhouse yields malibu/uluwatu/waimea +
 *     package_none.
 *
 * Run:
 *   node scripts/verify-manual-booking-per-guest-package.js
 */

const fs = require('fs');
const path = require('path');

const {
  loadClientPortalProfile,
  buildClientProfilesMap,
} = require('./lib/staff-portal-clients');

const ROOT = path.join(__dirname, '..');
const STAFF_API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

console.log('\nverify:manual-booking-per-guest-package — per-guest package offline checks\n');

const apiSrc = fs.readFileSync(STAFF_API_PATH, 'utf8');

console.log('[1] Booking-level package selector removed');
assert('no id="bk-package" in source', !apiSrc.includes('id="bk-package"'));
assert('no bk-manual-price-row in source', !apiSrc.includes('bk-manual-price-row'));
assert('no bk-manual-price-night in source', !apiSrc.includes('bk-manual-price-night'));

// No lingering readers of the removed dom id. Count occurrences of the exact
// element id token bk-package (with a word boundary) — must be zero.
const bkPackageMatches = (apiSrc.match(/bk-package\b/g) || []).length;
assert('no lingering bk-package readers (count === 0)', bkPackageMatches === 0,
  `found ${bkPackageMatches}`);
assert('bcUpdateManualPriceOverrideVisibility removed',
  !apiSrc.includes('function bcUpdateManualPriceOverrideVisibility'));
assert('bcSyncGuestPackagesToTop removed',
  !apiSrc.includes('function bcSyncGuestPackagesToTop'));
assert('no calendar.create.missing.package gate',
  !apiSrc.includes("t('calendar.create.missing.package')"));

console.log('\n[2] Per-guest package options are per-client with fallback');
assert('bcGuestPackageOptions defined',
  apiSrc.includes('function bcGuestPackageOptions('));
assert('bcGuestPackageOptions reads staffPortalClientProfiles',
  /function bcGuestPackageOptions\([\s\S]{0,600}manual_booking_packages/.test(apiSrc));
assert('BC_GUEST_PACKAGE_OPTIONS fallback still present',
  apiSrc.includes('var BC_GUEST_PACKAGE_OPTIONS = ['));
assert('bcRenderGuestNameInputs renders from bcGuestPackageOptions()',
  /function bcRenderGuestNameInputs\([\s\S]*?bcGuestPackageOptions\(\)\.forEach/.test(apiSrc));
assert('bcRenderGuestNameInputs no longer uses BC_GUEST_PACKAGE_OPTIONS.forEach',
  !/function bcRenderGuestNameInputs\([\s\S]*?BC_GUEST_PACKAGE_OPTIONS\.forEach/.test(apiSrc));

console.log('\n[3] Create + quote payloads send guest_packages / null package_code');
assert('create payload sends guest_packages',
  /runManualBookingCreate\([\s\S]*?guest_packages:\s*bcCollectGuestPackages\(\)/.test(apiSrc));
assert('create payload package_code is null',
  /runManualBookingCreate\([\s\S]*?package_code:\s*null/.test(apiSrc));
assert('quote payload includes guest_packages',
  /runQuotePreview\([\s\S]*?payload\.guest_packages/.test(apiSrc));
assert('bcMajorityGuestPackage helper present',
  apiSrc.includes('function bcMajorityGuestPackage('));

console.log('\n[4] buildClientProfilesMap / loadClientPortalProfile — manual_booking_packages');

function assertWolfhousePackages(label, opts) {
  const values = (opts || []).map((o) => o.value);
  const ok = Array.isArray(opts)
    && values.includes('malibu')
    && values.includes('uluwatu')
    && values.includes('waimea')
    && values.includes('package_none')
    && values[values.length - 1] === 'package_none';
  assert(label, ok, JSON.stringify(values));
}

const whProfile = loadClientPortalProfile('wolfhouse-somo');
assert('loadClientPortalProfile exposes manual_booking_packages',
  Array.isArray(whProfile.manual_booking_packages));
assertWolfhousePackages('wolfhouse manual_booking_packages = malibu/uluwatu/waimea + package_none',
  whProfile.manual_booking_packages);

// Unit-test buildClientProfilesMap directly with a wolfhouse-scoped user.
const wolfUser = {
  email: 'ops@wolfhouse.test',
  client_slug: 'wolfhouse-somo',
  role: 'owner',
};
// Access is email-driven; fall back to null (all clients) if the test email has
// no explicit grant. Either way the wolfhouse-somo profile must exist and match.
let map = buildClientProfilesMap(wolfUser);
if (!map['wolfhouse-somo']) map = buildClientProfilesMap(null);
assert('buildClientProfilesMap includes wolfhouse-somo profile',
  !!map['wolfhouse-somo']);
assertWolfhousePackages('buildClientProfilesMap wolfhouse manual_booking_packages',
  map['wolfhouse-somo'] && map['wolfhouse-somo'].manual_booking_packages);

console.log('\n[5] Client JS block parses (escaping sanity)');
try {
  const lines = apiSrc.split('\n');
  // Main client <script> block. Locate the largest script region.
  let bestStart = -1;
  let bestEnd = -1;
  let bestLen = -1;
  let openIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('<script>') && !lines[i].includes('</script>')) openIdx = i;
    else if (lines[i].includes('</script>') && openIdx >= 0) {
      const len = i - openIdx;
      if (len > bestLen) { bestLen = len; bestStart = openIdx; bestEnd = i; }
      openIdx = -1;
    }
  }
  const block = lines.slice(bestStart + 1, bestEnd).join('\n');
  // Neutralize server-side ${...} interpolations (balanced braces) to a literal.
  let out = '';
  let i = 0;
  while (i < block.length) {
    if (block[i] === '$' && block[i + 1] === '{') {
      let depth = 0;
      let j = i + 1;
      for (; j < block.length; j++) {
        if (block[j] === '{') depth++;
        else if (block[j] === '}') { depth--; if (depth === 0) break; }
      }
      out += '0';
      i = j + 1;
    } else {
      out += block[i];
      i++;
    }
  }
  // eslint-disable-next-line no-new-func
  new Function(out);
  assert('client <script> block parses via new Function', true);
} catch (e) {
  assert('client <script> block parses via new Function', false, e.message);
}

console.log(`\nDONE — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
