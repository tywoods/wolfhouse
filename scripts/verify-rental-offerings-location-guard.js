'use strict';

/**
 * verify:rental-offerings-location-guard
 *
 * Blocker #4 (Captain handoff): the /staff/admin/config/rental-offerings CRUD
 * endpoints used to pass ?location straight through — a missing or arbitrary
 * location silently created a mis-scoped (or client-wide NULL) catalog row.
 *
 * The guard now lives in resolveRentalOfferingLocationScope() and is shared by
 * the GET/POST/PATCH/DELETE handlers. This asserts its contract offline (no DB,
 * no API key, no network) plus that staff-query-api.js actually wires it in and
 * 400s on failure.
 *
 * Run:
 *   node scripts/verify-rental-offerings-location-guard.js
 */

const fs = require('fs');
const path = require('path');
const {
  resolveRentalOfferingLocationScope,
} = require('./lib/sunset-school-locations');

let pass = 0;
let fail = 0;
function assert(label, condition, detail) {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; return; }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

console.log('\nverify:rental-offerings-location-guard — CRUD location scope contract\n');

console.log('[sunset] multi-location tenant MUST supply a known location');
for (const [label, loc, expectId] of [
  ['valid Somo', 'sunset-somo', 'sunset-somo'],
  ['valid Sardinero', 'sunset-sardinero', 'sunset-sardinero'],
  ['valid Somo w/ padding + case', '  SUNSET-SOMO  ', 'sunset-somo'],
]) {
  const r = resolveRentalOfferingLocationScope('sunset', loc);
  assert(`sunset ${label} → accepted as ${expectId}`,
    r.ok === true && r.locationId === expectId, JSON.stringify(r));
}

for (const [label, loc] of [
  ['missing (null)', null],
  ['missing (undefined)', undefined],
  ['empty string', ''],
  ['whitespace', '   '],
  ['typo', 'sunset-sardienro'],
  ['arbitrary', 'atlantis'],
  ['other-tenant location', 'lawave-main'],
]) {
  const r = resolveRentalOfferingLocationScope('sunset', loc);
  assert(`sunset ${label} → rejected invalid_location`,
    r.ok === false && r.error === 'invalid_location', JSON.stringify(r));
  assert(`sunset ${label} → no locationId leaked`,
    r.locationId === undefined, JSON.stringify(r));
}

console.log('\n[single-site] tenant catalog is client-wide (NULL); stray location rejected');
for (const [label, loc, ok] of [
  ['no location → client-wide NULL', null, true],
  ['empty string → client-wide NULL', '', true],
  ['whitespace → client-wide NULL', '   ', true],
]) {
  const r = resolveRentalOfferingLocationScope('wolfhouse-somo', loc);
  assert(`wolfhouse ${label}`,
    r.ok === ok && r.locationId === null, JSON.stringify(r));
}
for (const [label, loc] of [
  ['stray location', 'somewhere'],
  ['a sunset location on wrong tenant', 'sunset-somo'],
]) {
  const r = resolveRentalOfferingLocationScope('wolfhouse-somo', loc);
  assert(`wolfhouse ${label} → rejected invalid_location`,
    r.ok === false && r.error === 'invalid_location', JSON.stringify(r));
}

console.log('\n[wiring] staff-query-api.js routes the guard and fails closed');
const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
assert('imports resolveRentalOfferingLocationScope from the locations lib',
  /resolveRentalOfferingLocationScope,\s*\n\s*}\s*=\s*require\('\.\/lib\/sunset-school-locations'\)/.test(apiSrc)
  || /resolveRentalOfferingLocationScope[\s\S]{0,80}require\('\.\/lib\/sunset-school-locations'\)/.test(apiSrc),
  'import not found');
assert('GET handler calls the guard',
  /handleAdminConfigRentalOfferingsGet[\s\S]*?resolveRentalOfferingLocation\(clientSlug, query\)/.test(apiSrc),
  'GET wiring not found');
assert('write handler calls the guard',
  /handleAdminConfigRentalOfferingWrite[\s\S]*?resolveRentalOfferingLocation\(clientSlug, query\)/.test(apiSrc),
  'write wiring not found');
const guardHits = (apiSrc.match(/if \(!loc\.ok\) return sendJSON\(res, 400, \{ success: false, error: loc\.error \}\)/g) || []).length;
assert('both handlers 400 on invalid_location (2 fail-closed sites)',
  guardHits >= 2, `found ${guardHits}`);
assert('legacy passthrough rentalOfferingLocation() no longer trusts raw query',
  !/const raw = query\.location != null \? String\(query\.location\)\.trim\(\) : '';\s*\n\s*return raw \|\| null;/.test(apiSrc),
  'old passthrough still present');

console.log(`\n── verify:rental-offerings-location-guard ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass}/${pass + fail}) ──\n`);
process.exit(fail > 0 ? 1 : 0);
