'use strict';
/**
 * verify-staff-bot-pause-api.js — Phase 9.4b / 9.6.1
 *
 * Static verifier for:
 *   GET  /staff/bot/pause-state
 *   POST /staff/bot/pause
 *   POST /staff/bot/resume
 *
 * Route blocks use pathname === anchors so Inbox client fetch('/staff/bot/pause-state')
 * does not false-match server route registration (Phase 9.5).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const API_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
const SQL_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staff-bot-pause-sql.js'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const MIGRATION = fs.readFileSync(
  path.join(ROOT, 'database', 'migrations', '012_bot_pause_states.sql'),
  'utf8',
);

let passed = 0;
let failed = 0;

function check(id, desc, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  [${id}] ${desc}`);
  } else {
    failed++;
    console.error(`  FAIL  [${id}] ${desc}${detail ? ' — ' + detail : ''}`);
  }
}

function findRouteBlock(pathnameLiteral) {
  const anchor = `if (pathname === '${pathnameLiteral}')`;
  const idx = API_SRC.indexOf(anchor);
  return idx > -1 ? API_SRC.slice(idx, idx + 600) : '';
}

const pauseStateBlock = findRouteBlock('/staff/bot/pause-state');
const pauseRouteBlock = findRouteBlock('/staff/bot/pause');
const resumeRouteBlock = findRouteBlock('/staff/bot/resume');

const pauseStateRouteIdx = pauseStateBlock.length > 0 ? API_SRC.indexOf("if (pathname === '/staff/bot/pause-state')") : -1;
const pauseRouteIdx = pauseRouteBlock.length > 0 ? API_SRC.indexOf("if (pathname === '/staff/bot/pause')") : -1;
const resumeRouteIdx = resumeRouteBlock.length > 0 ? API_SRC.indexOf("if (pathname === '/staff/bot/resume')") : -1;

const getStart = API_SRC.indexOf('async function handleBotPauseStateGet(');
const getEnd = API_SRC.indexOf('async function handleBotPausePost(', getStart + 100);
const getText = getStart > -1 && getEnd > -1 ? API_SRC.slice(getStart, getEnd) : '';

const pauseStart = API_SRC.indexOf('async function handleBotPausePost(');
const pauseEnd = API_SRC.indexOf('async function handleBotResumePost(', pauseStart + 100);
const pauseText = pauseStart > -1 && pauseEnd > -1 ? API_SRC.slice(pauseStart, pauseEnd) : '';

const resumeStart = API_SRC.indexOf('async function handleBotResumePost(');
const resumeEnd = API_SRC.indexOf('// Route: POST /staff/bot/booking-preview', resumeStart + 100);
const resumeText = resumeStart > -1 && resumeEnd > -1 ? API_SRC.slice(resumeStart, resumeEnd) : '';

const handlerStrip = (getText + pauseText + resumeText)
  .replace(/\/\/[^\n]*/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

console.log('\nA. Routes');
check('A1', "GET route '/staff/bot/pause-state' registered (pathname anchor)", pauseStateRouteIdx > -1);
check('A2', "POST route '/staff/bot/pause' registered (pathname anchor)", pauseRouteIdx > -1);
check('A3', "POST route '/staff/bot/resume' registered (pathname anchor)", resumeRouteIdx > -1);
check('A4', 'pause-state dispatches handleBotPauseStateGet', pauseStateBlock.includes('handleBotPauseStateGet'));
check('A5', 'pause dispatches handleBotPausePost', pauseRouteBlock.includes('handleBotPausePost'));
check('A6', 'resume dispatches handleBotResumePost', resumeRouteBlock.includes('handleBotResumePost'));
check('A7', 'Inbox fetchBotPauseState does not substitute for route block',
  API_SRC.includes("fetch('/staff/bot/pause-state'")
  && pauseStateBlock.includes("requireAuth(req, res, 'viewer')")
  && !pauseStateBlock.includes('fetchBotPauseState'));

console.log('\nB. Auth');
check('B1', 'pause-state uses requireAuth viewer', pauseStateBlock.includes("requireAuth(req, res, 'viewer')"));
check('B2', 'pause uses requireAuth operator', pauseRouteBlock.includes("requireAuth(req, res, 'operator')"));
check('B3', 'resume uses requireAuth operator', resumeRouteBlock.includes("requireAuth(req, res, 'operator')"));

console.log('\nC. Env gate');
check('C1', 'BOT_PAUSE_CONTROLS_ENABLED flag defined', API_SRC.includes('BOT_PAUSE_CONTROLS_ENABLED'));
check('C2', 'gate defaults off (=== true)', /BOT_PAUSE_CONTROLS_ENABLED\s*=\s*process\.env\.BOT_PAUSE_CONTROLS_ENABLED\s*===\s*'true'/.test(API_SRC));
check('C3', 'bot_pause_controls_disabled response', API_SRC.includes("'bot_pause_controls_disabled'"));
check('C4', 'pause blocked when gate disabled', pauseText.includes('!BOT_PAUSE_CONTROLS_ENABLED'));
check('C5', 'resume blocked when gate disabled', resumeText.includes('!BOT_PAUSE_CONTROLS_ENABLED'));
check('C6', 'disabled response includes enabled:false', API_SRC.includes('enabled:           false'));

console.log('\nD. bot_pause_states source of truth');
check('D1', 'staff-bot-pause-sql required', API_SRC.includes("require('./lib/staff-bot-pause-sql')"));
check('D2', 'getPauseState helper used', getText.includes('getPauseState'));
check('D3', 'pauseConversation helper used', pauseText.includes('pauseConversation'));
check('D4', 'resumeConversation helper used', resumeText.includes('resumeConversation'));
check('D5', 'SQL module references bot_pause_states', /bot_pause_states/.test(SQL_SRC));
check('D6', 'default_active source in GET handler', getText.includes("'default_active'") || getText.includes('default_active'));
check('D7', 'bot_paused true when paused row found', getText.includes('bot_paused:        true') || API_SRC.includes('bot_paused:        true'));

console.log('\nE. No conversations.bot_mode mutation');
check('E1', 'handlers do not UPDATE conversations', !/\bUPDATE\s+conversations\b/i.test(handlerStrip));
check('E2', 'handlers do not SET bot_mode', !/\bbot_mode\s*=/.test(handlerStrip));
check('E3', 'SQL module does not query/update conversations table',
  !/\b(FROM|INTO|UPDATE)\s+conversations\b/i.test(SQL_SRC));

console.log('\nF. No booking/payment/service mutation in pause handlers');
check('F1', 'no UPDATE bookings in handlers', !/\bUPDATE\s+bookings\b/i.test(handlerStrip));
check('F2', 'no UPDATE payments in handlers', !/\bUPDATE\s+payments\b/i.test(handlerStrip));
check('F3', 'no booking_service_records writes in handlers', !/\bbooking_service_records\b/i.test(handlerStrip));

console.log('\nG. Safety — no Stripe / WhatsApp / n8n / deploy');
check('G1', 'pause handlers no stripe', !/\bstripe\b/i.test(handlerStrip));
check('G2', 'pause handlers no whatsapp send', !/\bsends_whatsapp:\s*true/i.test(handlerStrip));
check('G3', 'pause handlers no graph.facebook.com', !/graph\.facebook\.com/.test(handlerStrip));
check('G4', 'pause handlers no n8n fetch', !/fetch\([^)]*n8n/i.test(handlerStrip));
check('G5', 'verifier does not invoke run-sql', !/run-sql\.js/i.test(fs.readFileSync(__filename, 'utf8') + API_SRC.slice(0, 500)));
check('G6', 'migration not modified in this verifier slice', MIGRATION.includes('NOT YET APPLIED'));

console.log('\nH. UI unchanged (no write buttons)');
check('H1', 'no Pause Luna button text', !/Pause Luna/.test(API_SRC));
check('H2', 'no Resume Luna button text', !/Resume Luna/.test(API_SRC));

console.log('\nI. package.json + syntax');
check('I1', 'verify:staff-bot-pause-api script present',
  PKG.scripts && PKG.scripts['verify:staff-bot-pause-api']
  === 'node scripts/verify-staff-bot-pause-api.js');

try {
  execSync('node --check scripts/staff-query-api.js', { cwd: ROOT, stdio: 'pipe' });
  check('I2', 'staff-query-api.js passes node --check', true);
} catch (e) {
  check('I2', 'staff-query-api.js passes node --check', false, e.message);
}

try {
  execSync('node --check scripts/lib/staff-bot-pause-sql.js', { cwd: ROOT, stdio: 'pipe' });
  check('I3', 'staff-bot-pause-sql.js passes node --check', true);
} catch (e) {
  check('I3', 'staff-bot-pause-sql.js passes node --check', false, e.message);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('verify-staff-bot-pause-api PASS');
  process.exit(0);
}
console.log('verify-staff-bot-pause-api FAIL');
process.exit(1);
