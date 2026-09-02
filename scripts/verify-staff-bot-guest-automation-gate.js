'use strict';
/**
 * verify-staff-bot-guest-automation-gate.js — Phase 9.6
 *
 * Static verifier for:
 *   POST /staff/bot/check-guest-automation-gate
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const API_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
const SQL_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staff-bot-pause-sql.js'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

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

console.log('\nverify-staff-bot-guest-automation-gate.js  (Phase 9.6)\n');

/**
 * Source window for one top-level declaration, ending at the next one.
 *
 * The end used to be a named neighbour — handleBotPauseStateGet — which #509 extracted into
 * lib/staff-bot-pause-state-handler.js. That collapsed every window to '', so the ten
 * "handler must NOT do X" assertions below went on passing against an empty string. A
 * structural end survives a neighbour moving out; a missing start anchor is reported, never
 * swallowed into an empty window.
 */
const NEXT_TOP_LEVEL = /\n(?:async function|function|const|let|var|class)\s/g;

function topLevelBlock(anchor, label) {
  const start = API_SRC.indexOf(anchor);
  if (start === -1) {
    check(label, `anchor still resolves in staff-query-api.js: ${anchor}`, false);
    return '';
  }
  NEXT_TOP_LEVEL.lastIndex = start + 1;
  const next = NEXT_TOP_LEVEL.exec(API_SRC);
  return API_SRC.slice(start, next ? next.index : API_SRC.length);
}

const routeIdx = API_SRC.indexOf("'/staff/bot/check-guest-automation-gate'");
const routeBlock = routeIdx > -1 ? API_SRC.slice(routeIdx, routeIdx + 600) : '';

const helperText = topLevelBlock('async function checkGuestAutomationPauseState(', 'slice:helper');
const buildText = topLevelBlock('function buildGuestAutomationGateResponse(', 'slice:build');
const handlerText = topLevelBlock('async function handleBotCheckGuestAutomationGate(', 'slice:handler');
const gateText = buildText + handlerText;

const handlerStrip = (helperText + gateText)
  .replace(/\/\/[^\n]*/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

console.log('A. Route');
check('A1', "POST route '/staff/bot/check-guest-automation-gate' registered", routeIdx > -1);
check('A2', 'route dispatches handleBotCheckGuestAutomationGate', routeBlock.includes('handleBotCheckGuestAutomationGate'));
check('A3', 'route requires POST', routeBlock.includes("method !== 'POST'"));

console.log('\nB. Helper + source of truth');
check('B1', 'checkGuestAutomationPauseState helper present', helperText.length > 0);
check('B2', 'helper uses getPauseState', helperText.includes('getPauseState'));
check('B3', 'helper returns bot_paused and live_send_blocked', /bot_paused:\s*true/.test(helperText) && /live_send_blocked:\s*true/.test(helperText));
check('B4', 'helper returns default_active when not paused', helperText.includes("'default_active'"));
check('B5', 'handler uses checkGuestAutomationPauseState', handlerText.includes('checkGuestAutomationPauseState'));
check('B6', 'SQL module references bot_pause_states', /bot_pause_states/.test(SQL_SRC));

console.log('\nC. Response contract');
check('C1', 'response includes can_continue_guest_automation', handlerText.includes('can_continue_guest_automation'));
check('C2', 'can_continue false when agent paused (bot_paused), not merely live_send_blocked',
  /can_continue_guest_automation:\s*!agentBlocked/.test(buildText)
  || /can_continue_guest_automation:\s*!gate\.bot_paused/.test(buildText)
  || /can_continue_guest_automation:\s*!blocked/.test(buildText));
check('C3', 'response includes bot_paused', handlerText.includes('bot_paused'));
check('C4', 'response includes live_send_blocked', handlerText.includes('live_send_blocked'));
check('C5', 'draft_reply_preserved when draft provided', gateText.includes('draft_reply_preserved'));
check('C6', 'draft_reply echoed without send', gateText.includes('draft_reply'));
check('C7', 'helper blocks WhatsApp send when channel mode is not auto',
  /inbox_channel_modes/.test(helperText)
  && /whatsapp_channel_mode/.test(helperText)
  && /inbox_channel_mode_draft/.test(helperText)
  && /inbox_channel_mode_off/.test(helperText)
  && /stage_outbound_as_draft/.test(helperText));
check('C8', 'existing tenant with missing channel-mode key defaults to auto',
  /if \(raw == null\) whatsappChannelMode = 'auto'/.test(helperText));
check('C9', 'Draft keeps agent drafting (bot_paused false) while live_send_blocked',
  /whatsappChannelMode === 'draft'[\s\S]{0,400}bot_paused:\s*false/.test(helperText)
  && /whatsappChannelMode === 'draft'[\s\S]{0,400}live_send_blocked:\s*true/.test(helperText));
check('C10', 'Off keeps bot_paused true',
  /whatsappChannelMode === 'off'[\s\S]{0,400}bot_paused:\s*true/.test(helperText));
check('C11', 'channel-mode query errors fail closed rather than defaulting Auto',
  /channel_mode_lookup_error/.test(helperText)
  && !/catch\s*\([^)]*\)\s*\{\s*whatsappChannelMode\s*=\s*'auto'/.test(helperText));
check('C12', 'missing tenant row fails closed',
  /!modeRes\.rows\[0\][\s\S]{0,100}channelModeLookupFailure/.test(helperText));
check('C13', 'invalid non-null channel mode fails closed',
  /else if \(raw === 'auto'[\s\S]{0,200}else return channelModeLookupFailure/.test(helperText));

console.log('\nD. Auth + gate independence');
check('D1', 'route uses requireBotAuth (bot dry-run pattern)', routeBlock.includes('requireBotAuth'));
check('D2', 'NOT gated by BOT_PAUSE_CONTROLS_ENABLED', !handlerText.includes('BOT_PAUSE_CONTROLS_ENABLED'));

console.log('\nE. No mutations');
check('E1', 'handler does not UPDATE conversations', !/\bUPDATE\s+conversations\b/i.test(handlerStrip));
check('E2', 'handler does not SET bot_mode', !/\bbot_mode\s*=/.test(handlerStrip));
check('E3', 'no UPDATE bookings in handler', !/\bUPDATE\s+bookings\b/i.test(handlerStrip));
check('E4', 'no UPDATE payments in handler', !/\bUPDATE\s+payments\b/i.test(handlerStrip));
check('E5', 'no booking_service_records writes', !/\bbooking_service_records\b/i.test(handlerStrip));
check('E6', 'no pauseConversation/resumeConversation writes', !/pauseConversation|resumeConversation/.test(handlerStrip));

console.log('\nF. Safety — no WhatsApp / Stripe / n8n / send');
check('F1', 'sends_whatsapp false', gateText.includes('sends_whatsapp:                false'));
check('F2', 'whatsapp_dry_run true', gateText.includes('whatsapp_dry_run:              true'));
check('F3', 'no_write_performed true', gateText.includes('no_write_performed:            true'));
check('F4', 'no graph.facebook.com', !/graph\.facebook\.com/.test(handlerStrip));
check('F5', 'no stripe in handler', !/\bstripe\b/i.test(handlerStrip));
check('F6', 'no n8n fetch', !/fetch\([^)]*n8n/i.test(handlerStrip));
check('F7', 'no n8n activation', !/activate.*n8n|n8n.*activ/i.test(handlerStrip));

console.log('\nG. Inbox UI (gate handler unchanged — buttons allowed Phase 9.5b)');

check('G1', 'gate handler has no Pause Luna button text', !/Pause Luna/.test(handlerText));
check('G2', 'gate handler has no Resume Luna button text', !/Resume Luna/.test(handlerText));

console.log('\nH. package.json + syntax');
check('H1', 'verify:staff-bot-guest-automation-gate script present',
  PKG.scripts && PKG.scripts['verify:staff-bot-guest-automation-gate']
  === 'node scripts/verify-staff-bot-guest-automation-gate.js');

try {
  execSync('node --check scripts/staff-query-api.js', { cwd: ROOT, stdio: 'pipe' });
  check('H2', 'staff-query-api.js passes node --check', true);
} catch (e) {
  check('H2', 'staff-query-api.js passes node --check', false, e.message);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('verify-staff-bot-guest-automation-gate PASS');
  process.exit(0);
}
console.log('verify-staff-bot-guest-automation-gate FAIL');
process.exit(1);
