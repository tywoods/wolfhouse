/**
 * Phase 9.5b — Static verifier for Inbox Luna Pause/Resume buttons
 * embedded in scripts/staff-query-api.js (buildUiHtml / loadConvDetail).
 *
 * Usage:
 *   npm run verify:staff-inbox-pause-buttons-ui
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

console.log('\nverify-staff-inbox-pause-buttons-ui.js  (Phase 9.5b)\n');

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

const botStateCardMatch = htmlSrc.match(/<h3>Bot state<\/h3>[\s\S]{0,1400}/);
const botStateCard = botStateCardMatch ? botStateCardMatch[0] : '';

console.log('\nA. Pause/Resume buttons');

check(/Pause Luna/.test(htmlSrc) && /Resume Luna/.test(htmlSrc),
  'Pause Luna and Resume Luna button labels present');
check(/id=["']btn-luna-pause["']/.test(htmlSrc) && /id=["']btn-luna-resume["']/.test(htmlSrc),
  'btn-luna-pause and btn-luna-resume elements present');
check(/function wireLunaPauseControlButton/.test(htmlSrc),
  'wireLunaPauseControlButton() helper present');

console.log('\nB. API wiring');

check(/['"]\/staff\/bot\/pause['"]/.test(htmlSrc) && /#btn-luna-pause/.test(htmlSrc),
  'UI calls POST /staff/bot/pause');
check(/['"]\/staff\/bot\/resume['"]/.test(htmlSrc) && /#btn-luna-resume/.test(htmlSrc),
  'UI calls POST /staff/bot/resume');
check(/\/staff\/bot\/pause-state/.test(htmlSrc),
  'UI still calls GET /staff/bot/pause-state');
check(/client_slug:\s*getClient\s*\(\s*\)/.test(htmlSrc),
  'pause/resume body uses client_slug: getClient()');
check(/conversation_id:\s*convId/.test(htmlSrc),
  'pause/resume body uses conversation_id: convId');
check(/Paused from Staff Portal Inbox/.test(htmlSrc),
  'pause_reason uses Staff Portal Inbox copy');
check(/loadConvDetail\s*\(\s*convId/.test(htmlSrc.match(/function wireLunaPauseControlButton[\s\S]*?\n\}/)?.[0] || ''),
  'success reloads selected conversation via loadConvDetail');

console.log('\nC. Button safety + errors');

check(/\.disabled\s*=\s*true/.test(htmlSrc.match(/function wireLunaPauseControlButton[\s\S]*?\n\}/)?.[0] || ''),
  'button disabled while request in flight');
check(/if\s*\(\s*btn\.disabled\s*\)\s*return/.test(htmlSrc),
  'double-click guard on pause/resume button');
check(/Pause controls are disabled\./.test(htmlSrc),
  'gate-disabled error copy present');
check(/Updating Luna status/.test(htmlSrc),
  'in-flight status copy present');

console.log('\nD. Bot state card cleanup');

check(!/kv\s*\(\s*['"]Mode['"]/.test(botStateCard),
  'Mode line removed from Bot state card');
check(!/kv\s*\(\s*['"]Needs human['"]/.test(botStateCard),
  'Needs human line removed from Bot state card');
check(/Luna active/.test(botStateCard) && /Luna paused/.test(htmlSrc),
  'Luna active/paused labels retained');
check(/Automation status: active\./.test(htmlSrc),
  'active helper copy retained');
check(/Automated guest replies should stay blocked while paused\./.test(htmlSrc),
  'paused helper copy retained');

console.log('\nE. Needs Human filter preserved');

check(/Needs human|needs-human|setInboxFilter\s*\(\s*['"]needs-human['"]/.test(htmlSrc),
  'Inbox Needs Human filter still present');

console.log('\nF. Safety — no WhatsApp / Stripe / n8n / mutations');

check(!/api\.stripe\.com/.test(htmlSrc),
  'Inbox UI has no api.stripe.com');
check(!/graph\.facebook\.com/.test(htmlSrc),
  'Inbox UI has no graph.facebook.com');
check(!(/fetch[\s\S]{0,80}n8n|https?:\/\/[^"'\\s]*n8n/i.test(htmlSrc)),
  'Inbox UI has no n8n URL fetch');
check(!/\bbot_mode\s*=/.test(htmlSrc.match(/function wireLunaPauseControlButton[\s\S]*?\n\}/)?.[0] || ''),
  'pause/resume UI does not mutate conversations.bot_mode');
check(!/\bUPDATE\s+bookings\b/i.test(htmlSrc.match(/function wireLunaPauseControlButton[\s\S]*?\n\}/)?.[0] || ''),
  'pause/resume UI has no booking mutation');
check(!/\bUPDATE\s+payments\b/i.test(htmlSrc.match(/function wireLunaPauseControlButton[\s\S]*?\n\}/)?.[0] || ''),
  'pause/resume UI has no payment mutation');
check(!/\bbooking_service_records\b/.test(htmlSrc.match(/function wireLunaPauseControlButton[\s\S]*?\n\}/)?.[0] || ''),
  'pause/resume UI has no service record mutation');

console.log('\nG. package.json script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check(
  pkg.scripts && pkg.scripts['verify:staff-inbox-pause-buttons-ui']
    === 'node scripts/verify-staff-inbox-pause-buttons-ui.js',
  'package.json has verify:staff-inbox-pause-buttons-ui script',
);

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
if (failures > 0) process.exit(1);
console.log('verify-staff-inbox-pause-buttons-ui PASS');
