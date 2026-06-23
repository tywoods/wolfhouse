'use strict';

/**
 * verify:sunset-package-runtime
 *
 * Offline guard: Sunset staging Docker image must start via npm run staff:api.
 * Prevents sparse-clone package.json from dropping runtime scripts.
 *
 * Run: node scripts/verify-sunset-package-runtime.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');
const LOCK = path.join(ROOT, 'package-lock.json');

const REQUIRED_SCRIPTS = [
  'staff:api',
  'verify:sunset-admin',
  'verify:sunset-admin-i18n',
  'verify:sunset-admin-pure',
  'verify:sunset-admin-helper-parity',
];

let pass = 0;
let fail = 0;

function assert(label, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

function main() {
  console.log('\nverify:sunset-package-runtime — package deploy guard\n');

  assert('package.json exists', fs.existsSync(PKG));
  assert('package-lock.json exists', fs.existsSync(LOCK));

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  } catch (e) {
    assert('package.json parses', false, e.message);
    process.exit(1);
  }

  const scripts = pkg.scripts || {};
  for (const name of REQUIRED_SCRIPTS) {
    assert(`scripts["${name}"] defined`, typeof scripts[name] === 'string' && scripts[name].length > 0);
  }


  const browserUi = path.join(ROOT, 'scripts', 'browser', 'sunset-admin-ui.js');
  const staffApi = path.join(ROOT, 'scripts', 'staff-query-api.js');
  const staffSrc = fs.readFileSync(staffApi, 'utf8');
  const uiSrc = fs.readFileSync(browserUi, 'utf8');

  assert('scripts/browser/sunset-admin-ui.js exists', fs.existsSync(browserUi));
  assert('getSunsetAdminUiBrowserSource() wired in staff-query-api.js',
    staffSrc.includes('getSunsetAdminUiBrowserSource()'));
  assert('extracted file starts with adminConfigCache',
    uiSrc.includes('var adminConfigCache = null;'));
  assert('extracted file defines wireAdminTab',
    /function wireAdminTab\s*\(/.test(uiSrc));
  assert('staff-query-api.js has no inline adminConfigCache',
    !staffSrc.includes('var adminConfigCache = null;'));
  assert('staff-query-api.js has no duplicate wireAdminTab',
    !/function wireAdminTab\s*\(/.test(staffSrc));

  assert('staff:api runs staff-query-api.js', scripts['staff:api'] === 'node scripts/staff-query-api.js');

  console.log('\n' + '─'.repeat(48));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error('verify:sunset-package-runtime — FAILED');
    process.exit(1);
  }
  console.log('verify:sunset-package-runtime — ALL CHECKS PASSED');
}

main();
