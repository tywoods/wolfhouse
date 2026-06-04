/**
 * Phase 10.4f.2 — Static verifier for Staff Portal Today screen navigation.
 *
 * Usage:
 *   npm run verify:staff-today-navigation-ui
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const vm   = require('vm');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

function extractEmbeddedUiScript(source) {
  const buildStart = source.indexOf('function buildUiHtml');
  const searchFrom = buildStart >= 0 ? buildStart : 0;
  const scriptTag = source.indexOf('<script>', searchFrom);
  if (scriptTag < 0) return null;
  const fnStart = source.indexOf('(function(){', scriptTag);
  if (fnStart < 0) return null;
  const endTag = source.indexOf('</script>', fnStart);
  if (endTag < 0) return null;
  const beforeClose = source.slice(fnStart, endTag);
  const relEnd = beforeClose.lastIndexOf('})();');
  if (relEnd < 0) return null;
  return beforeClose.slice(0, relEnd + '})();'.length);
}

function extractTodayHtml(source) {
  const m = source.match(/<!-- Needs Attention tiles -->[\s\S]*?<\/div>\s*<div id="today-load-state"/);
  return m ? m[0] : '';
}

console.log('\nverify-staff-today-navigation-ui.js  (Phase 10.4f.2)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

const todayHtml = extractTodayHtml(src);
const rawJs = extractEmbeddedUiScript(src);
const js = rawJs
  ? rawJs
      .replace(/\$\{STAFF_ACTIONS_ENABLED\}/g, 'false')
      .replace(/\$\{MANUAL_BOOKING_ENABLED\}/g, 'false')
      .replace(/\$\{STRIPE_LINKS_ENABLED\}/g, 'false')
      .replace(/\$\{BOOKING_MOVE_WRITE_ENABLED\}/g, 'false')
  : '';

console.log('\nA. Today tiles and handlers');

check(/id="tile-needs-human"/.test(todayHtml), 'Needs Human tile present');
check(/id="tile-inbox-tile"/.test(todayHtml), 'Open Conversations tile present');
check(/onclick="switchToTab\('conversations','handoffs'\)"/.test(todayHtml),
  'Needs Human tile uses switchToTab(conversations, handoffs)');
check(/onclick="switchToTab\('conversations','inbox'\)"/.test(todayHtml),
  'Open Conversations tile uses switchToTab(conversations, inbox)');
check(/onclick="switchToTabOnly\('bed-calendar'\)"/.test(todayHtml),
  'Bed Calendar tile uses switchToTabOnly(bed-calendar)');

check(!/SyncToTabOnly|syncToTabOnly/i.test(todayHtml + src),
  'no misspelled SyncToTabOnly onclick reference');
check(!/onclick="[^"]*switchToTabOnly/i.test(todayHtml) ||
      /onclick="switchToTabOnly\('bed-calendar'\)"/.test(todayHtml),
  'Bed Calendar onclick uses correct switchToTabOnly name');

console.log('\nB. Tab switch globals');

check(/function switchToTab\(tab, subtab\)/.test(src), 'switchToTab function defined');
check(/function switchToTabOnly\(tab\)/.test(src), 'switchToTabOnly function defined');
check(/window\.switchToTab\s*=\s*switchToTab/.test(src), 'window.switchToTab assignment');
check(/window\.switchToTabOnly\s*=\s*switchToTabOnly/.test(src), 'window.switchToTabOnly assignment');
check(/subtab === 'handoffs'\)\s*setInboxFilter\('needs-human'\)/.test(src),
  'handoffs subtab sets needs-human inbox filter');

console.log('\nC. Embedded script parse + field-edit syntax guard');

if (!rawJs) {
  fail('embedded UI <script> block not found');
} else {
  try {
    new vm.Script(js);
    ok('embedded UI script parses without SyntaxError');
  } catch (e) {
    fail('embedded UI script SyntaxError: ' + (e.message || e));
  }
  check(/window\.switchToTabOnly\s*=\s*switchToTabOnly/.test(js),
    'embedded script exposes window.switchToTabOnly');
  check(/function bcFieldEditActivate\(group\)/.test(js),
    'bcFieldEditActivate declared (10.4f.2 parse fix)');
  check(!/function bcFieldEditCloseAll\([\s\S]{0,400}\}\s+if \(!group\) return;/.test(js),
    'no orphaned activate body after bcFieldEditCloseAll');
}

console.log('\nD. Preserve drawer / portal features');

check(/bcRenderRunningInvoiceHtml/.test(src), 'running invoice markers preserved');
check(/bcRenderFieldEditSectionsHtml/.test(src), 'field edit preview UI markers preserved');
check(/\/staff\/bookings\/edit-preview/.test(src), 'edit-preview API route preserved');
check(/id="bc-move-bed"/.test(src), 'move bed panel marker preserved');
check(/function bcInitMovePanel/.test(src), 'move panel init preserved');
check(/function alAsk/.test(src), 'Ask Luna handler present (unchanged)');

const askSlice = src.match(/function alAsk[\s\S]*?\n\}/)?.[0] || '';
check(askSlice.length > 0 && !/function bcFieldEditActivate/.test(askSlice),
  'Ask Luna block not mixed with field-edit activate fix');

console.log('\nE. Safety boundaries');

const uiSlice = todayHtml + (js || '');
check(!/api\.stripe\.com/.test(uiSlice), 'no Stripe API URL in Today/nav slice');
check(!/graph\.facebook\.com/.test(uiSlice), 'no WhatsApp URL in Today/nav slice');
check(!/https?:\/\/[^"'\\s]*n8n[^"'\\s]*/i.test(todayHtml), 'no n8n activation URL in Today HTML');
check(!/INSERT INTO bookings|UPDATE bookings|UPDATE booking_beds|UPDATE payments|INSERT INTO booking_service_records/i.test(todayHtml),
  'no booking/payment/service mutation SQL in Today HTML');
check(!/handleBookingEditWrite|\/staff\/bookings\/[^'"]+\/edit[^\-p]/.test(todayHtml),
  'no booking edit write in Today HTML');

console.log('\nF. Package script');

try {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  check(pkg.scripts && pkg.scripts['verify:staff-today-navigation-ui'],
    'package.json has verify:staff-today-navigation-ui script');
} catch (_) {
  fail('package.json readable for script check');
}

console.log('\nG. No docs / migration changes');

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
