'use strict';

/**
 * verify:sunset-admin-i18n
 *
 * Fails when embedded Admin UI references portalT keys missing from EN/ES catalogs.
 *
 * Run: node scripts/verify-sunset-admin-i18n.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const EN_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js');
const ES_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es-sunset.js');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

function collectPortalKeys(src, prefixes) {
  const keys = new Set();
  const re = /portalT\('([^']+)'\)/g;
  let m;
  while ((m = re.exec(src))) {
    const key = m[1];
    if (prefixes.some((p) => key.startsWith(p))) keys.add(key);
  }
  return keys;
}

function missingKeys(catalogSrc, keys) {
  const missing = [];
  for (const k of keys) {
    if (!catalogSrc.includes(`'${k}'`)) missing.push(k);
  }
  return missing;
}

console.log('\nverify:sunset-admin-i18n — Admin + schedule Admin surface keys\n');

const api = fs.readFileSync(API_PATH, 'utf8');
const en = fs.readFileSync(EN_PATH, 'utf8');
const es = fs.readFileSync(ES_PATH, 'utf8');

const prefixes = ['admin.', 'schedule.card.surfPacks', 'schedule.packs.'];
const keys = collectPortalKeys(api, prefixes);

const missingEn = missingKeys(en, keys);
const missingEs = missingKeys(es, keys);

assert('staff-query-api.js readable', api.length > 1000);
assert(`admin/schedule keys scanned (${keys.size})`, keys.size > 0);
assert('missing EN admin keys (0)', missingEn.length === 0, missingEn.slice(0, 8).join(', '));
assert('missing ES admin keys (0)', missingEs.length === 0, missingEs.slice(0, 8).join(', '));

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-admin-i18n — FAILED');
  process.exit(1);
}
console.log('verify:sunset-admin-i18n — ALL CHECKS PASSED');
