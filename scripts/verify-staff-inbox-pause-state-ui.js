/**
 * Phase 9.5 — Static verifier for Inbox live Luna pause-state read wiring
 * embedded in scripts/staff-query-api.js (buildUiHtml / loadConvDetail).
 *
 * Usage:
 *   node scripts/verify-staff-inbox-pause-state-ui.js
 *   npm run verify:staff-inbox-pause-state-ui
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)  { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg){ console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

console.log('\nverify-staff-inbox-pause-state-ui.js  (Phase 9.5)\n');

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

const htmlMatch = src.match(/function buildUiHtml\(port\)\s*\{([\s\S]*?)^function handleUI/m);
const htmlSrc = htmlMatch ? htmlMatch[1] : src;

console.log('\nA. Live pause-state read wiring');

check(/function fetchBotPauseState/.test(htmlSrc),
  'fetchBotPauseState() helper present (Phase 9.5)');
check(/\/staff\/bot\/pause-state/.test(htmlSrc),
  'Inbox references GET /staff/bot/pause-state');
check(/client_slug/.test(htmlSrc) && /conversation_id/.test(htmlSrc),
  'pause-state query uses client_slug and conversation_id');
check(/fetchBotPauseState\s*\(\s*client\s*,\s*convId\s*\)/.test(htmlSrc),
  'loadConvDetail calls fetchBotPauseState(client, convId)');
check(/isLunaGuestAutomationPaused\s*\(\s*\[\s*pauseData/.test(htmlSrc),
  'pause API response passed first to isLunaGuestAutomationPaused');

console.log('\nB. Read path unchanged (Phase 9.5b write buttons — see verify-staff-inbox-pause-buttons-ui)');

check(/function fetchBotPauseState/.test(htmlSrc),
  'fetchBotPauseState() still present for live read (Phase 9.5)');
check(/\/staff\/bot\/pause-state/.test(htmlSrc),
  'Inbox still references GET /staff/bot/pause-state');
check(/fetchBotPauseState\s*\(\s*client\s*,\s*convId\s*\)/.test(htmlSrc),
  'loadConvDetail still calls fetchBotPauseState(client, convId)');

console.log('\nC. Display strings and fallback');

check(/Luna active/.test(htmlSrc) && /Luna paused/.test(htmlSrc),
  'Luna active/paused display strings present');
check(/function isLunaGuestAutomationPaused/.test(htmlSrc),
  'isLunaGuestAutomationPaused() helper present');
check(/fetchBotPauseState[\s\S]{0,320}\.catch\s*\(\s*function\s*\(\s*\)\s*\{\s*return\s*\{\s*success\s*:\s*false/.test(htmlSrc),
  'pause-state fetch failure defaults to success:false (Luna active fallback)');

console.log('\nD. Safety — no Stripe / n8n / WhatsApp additions');

check(!/api\.stripe\.com/.test(htmlSrc),
  'Inbox UI has no api.stripe.com');
check(!/graph\.facebook\.com/.test(htmlSrc),
  'Inbox UI has no graph.facebook.com');
check(!(/fetch[\s\S]{0,80}n8n|https?:\/\/[^"'\\s]*n8n/i.test(htmlSrc)),
  'Inbox UI has no n8n URL fetch');

console.log('\nE. package.json script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check(
  pkg.scripts && pkg.scripts['verify:staff-inbox-pause-state-ui']
    === 'node scripts/verify-staff-inbox-pause-state-ui.js',
  'package.json has verify:staff-inbox-pause-state-ui script',
);

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
if (failures > 0) process.exit(1);
console.log('verify-staff-inbox-pause-state-ui PASS');
