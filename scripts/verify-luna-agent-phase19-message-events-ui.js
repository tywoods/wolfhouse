/**
 * Phase 19g.10 — Static verifier for Message Events inbox panel UI.
 *
 * Usage:
 *   npm run verify:luna-agent-phase19-message-events-ui
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(ROOT, 'package.json');

const DOWNSTREAM = [
  'verify:luna-agent-phase19-message-events-read',
  'verify:luna-agent-phase19-meta-whatsapp-webhook',
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-luna-agent-phase19-message-events-ui.js  (Phase 19g.10)\n');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'pipe' });
  pass('0', 'staff-query-api.js passes node --check');
} catch {
  fail('0', 'staff-query-api.js syntax error');
}

if (!fs.existsSync(API_FILE)) {
  fail('file', 'staff-query-api.js missing');
  process.exit(1);
}

const src = fs.readFileSync(API_FILE, 'utf8');
const htmlMatch = src.match(/function buildUiHtml\(port\)\s*\{([\s\S]*?)^function handleUI/m);
const htmlSrc = htmlMatch ? htmlMatch[1] : src;

const mePanel = htmlSrc.match(/id="msg-events-panel"[\s\S]{0,2200}/);
const mePanelHtml = mePanel ? mePanel[0] : '';

const meJsMatch = src.match(/function buildMessageEventsUrl\(\)[\s\S]*?function wireMessageEventsPanel\(\)[\s\S]*?\n\}/);
const meJs = meJsMatch ? meJsMatch[0] : '';

section('A. Panel markup');

if (mePanelHtml.includes('Message Events')) pass('A1', 'Message Events panel title present');
else fail('A1', 'panel title missing');

if (mePanelHtml.includes('id="me-table-wrap"')) pass('A2', 'table container present');
else fail('A2', 'table container missing');

if (/Read-only Meta inbound events/.test(mePanelHtml)) pass('A3', 'read-only note present');
else fail('A3', 'read-only note missing');

section('B. API fetch wiring');

if (meJs.includes('/staff/inbox/message-events')) pass('B1', 'fetches /staff/inbox/message-events');
else fail('B1', 'API path missing');

if (/client_slug=/.test(meJs) && /wolfhouse-somo|getClient\(\)/.test(meJs)) {
  pass('B2', 'includes client_slug via getClient()');
} else fail('B2', 'client_slug wiring missing');

if (/limit=50|'&limit=50'|"&limit=50"/.test(meJs) || /limit=50/.test(meJs)) {
  pass('B3', 'includes limit=50');
} else fail('B3', 'limit missing');

if (meJs.includes('r.status === 401')) pass('B4', '401 session handling present');
else fail('B4', '401 handling missing');

section('C. Rendered fields');

if (meJs.includes('message_text') && meJs.includes('next_action')) {
  pass('C1', 'renders message_text and next_action');
} else fail('C1', 'core fields missing from render');

if (meJs.includes('handoff_required')) pass('C2', 'renders handoff_required badge');
else fail('C2', 'handoff badge missing');

if (meJs.includes('send_status')) pass('C3', 'renders send_status');
else fail('C3', 'send_status missing');

if (meJs.includes('send_blocked_reasons')) pass('C4', 'renders blocked reasons');
else fail('C4', 'blocked reasons missing');

if (meJs.includes('from_phone') && meJs.includes('profile_name')) {
  pass('C5', 'renders from_phone and profile_name');
} else fail('C5', 'phone/profile missing');

if (!meJs.includes('raw_payload') && !meJs.includes('normalized')) {
  pass('C6', 'does not render raw_payload/normalized');
} else fail('C6', 'heavy fields exposed in UI');

section('D. Filters');

if (mePanelHtml.includes('id="me-filter-handoff"')) pass('D1', 'handoff filter checkbox');
else fail('D1', 'handoff filter missing');

if (mePanelHtml.includes('id="me-filter-send"')) pass('D2', 'send attempted filter checkbox');
else fail('D2', 'send filter missing');

if (mePanelHtml.includes('id="me-filter-phone"')) pass('D3', 'from_phone search input');
else fail('D3', 'phone search missing');

if (meJs.includes('handoff_required=true') && meJs.includes('send_attempted=true')) {
  pass('D4', 'filter query params wired');
} else fail('D4', 'filter params missing');

if (meJs.includes('No message events found')) pass('D5', 'empty state copy present');
else fail('D5', 'empty state missing');

section('E. Safety — no send / external writes');

if (!/guest-reply-send/.test(meJs + mePanelHtml)) pass('E1', 'no guest-reply-send call');
else fail('E1', 'guest-reply-send found');

if (!/id="me-send"|Send WhatsApp|btn-send/.test(mePanelHtml)) pass('E1b', 'no send button in panel');
else fail('E1b', 'send button found in panel');

if (!/Send WhatsApp|send_whatsapp|graph\.facebook\.com/.test(meJs + mePanelHtml)) {
  pass('E2', 'no WhatsApp/Graph send wiring');
} else fail('E2', 'send/graph wiring found');

if (!/api\.stripe\.com/.test(meJs + mePanelHtml)) pass('E3', 'no Stripe');
else fail('E3', 'Stripe found');

if (!(/fetch[\s\S]{0,80}n8n|https?:\/\/[^"'\\s]*n8n/i.test(meJs + mePanelHtml))) {
  pass('E4', 'no n8n fetch');
} else fail('E4', 'n8n fetch found');

if (!/\bINSERT\b|\bUPDATE\b|\bDELETE\b/.test(meJs)) pass('E5', 'UI JS has no SQL writes');
else fail('E5', 'SQL writes in UI JS');

section('F. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts['verify:luna-agent-phase19-message-events-ui']) {
  pass('F1', 'npm script registered');
} else fail('F1', 'npm script missing');

section('G. Downstream verifiers (limited)');

for (const script of DOWNSTREAM) {
  try {
    execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 300000 });
    pass('G.' + script, `${script} still passes`);
  } catch (e) {
    fail('G.' + script, `${script} failed`);
    const out = (e.stdout || '') + (e.stderr || '');
    console.error(out.split('\n').slice(-8).join('\n'));
  }
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
