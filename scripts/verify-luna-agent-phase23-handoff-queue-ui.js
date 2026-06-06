/**
 * Phase 23b — Static verifier for Needs staff handoff queue UI panel.
 *
 * Usage:
 *   npm run verify:luna-agent-phase23-handoff-queue-ui
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(ROOT, 'package.json');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-luna-agent-phase23-handoff-queue-ui.js  (Phase 23b)\n');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'pipe' });
  pass('0', 'staff-query-api.js passes node --check');
} catch {
  fail('0', 'staff-query-api.js syntax error');
}

const src = fs.readFileSync(API_FILE, 'utf8');
const htmlMatch = src.match(/function buildUiHtml\(port\)\s*\{([\s\S]*?)^function handleUI/m);
const htmlSrc = htmlMatch ? htmlMatch[1] : src;

const hqPanel = htmlSrc.match(/id="handoff-queue-panel"[\s\S]{0,2400}/);
const hqPanelHtml = hqPanel ? hqPanel[0] : '';

const hqJsMatch = src.match(/function buildHandoffsQueueUrl\(\)[\s\S]*?function wireHandoffsQueuePanel\(\)[\s\S]*?\n\}/);
const hqJs = hqJsMatch ? hqJsMatch[0] : '';

section('A. Panel markup');

if (hqPanelHtml.includes('Needs staff')) pass('A1', 'Needs staff panel title present');
else fail('A1', 'panel title missing');

if (hqPanelHtml.includes('id="hq-table-wrap"')) pass('A2', 'table container present');
else fail('A2', 'table container missing');

if (/Read-only Meta handoff queue/.test(hqPanelHtml)) pass('A3', 'read-only note present');
else fail('A3', 'read-only note missing');

if (hqPanelHtml.includes('id="hq-refresh"')) pass('A4', 'refresh button present');
else fail('A4', 'refresh button missing');

if (hqPanelHtml.includes('id="hq-filter-phone"')) pass('A5', 'phone filter present');
else fail('A5', 'phone filter missing');

section('B. API fetch wiring');

if (hqJs.includes('/staff/inbox/handoffs')) pass('B1', 'fetches /staff/inbox/handoffs');
else fail('B1', 'API path missing');

if (/client_slug=/.test(hqJs) && /getClient\(\)/.test(hqJs)) {
  pass('B2', 'includes client_slug via getClient()');
} else fail('B2', 'client_slug wiring missing');

if (hqJs.includes('r.status === 401')) pass('B3', '401 session handling present');
else fail('B3', '401 handling missing');

if (hqJs.includes('loadHandoffsQueue')) pass('B4', 'loadHandoffsQueue defined');
else fail('B4', 'load function missing');

section('C. Rendered fields + copy');

if (hqJs.includes('queue_reason') && hqJs.includes('suggested_reply')) {
  pass('C1', 'renders queue_reason and suggested_reply');
} else fail('C1', 'core fields missing');

if (hqJs.includes('booking_write_result') || hqJs.includes('booking_write_preview')) {
  pass('C2', 'renders booking context when present');
} else fail('C2', 'booking context missing');

if (/Copy reply|hq-copy-btn/.test(hqJs)) pass('C3', 'copy suggested reply button present');
else fail('C3', 'copy button missing');

if (hqJs.includes('copyTextToClipboard') || hqJs.includes('clipboard')) {
  pass('C4', 'clipboard copy wiring present');
} else fail('C4', 'clipboard wiring missing');

section('D. Safety — no send/resolve/external');

if (!hqPanelHtml.includes('handoff.resolve') && !/Resolve/.test(hqPanelHtml)) {
  pass('D1', 'no resolve button in panel');
} else fail('D1', 'resolve button should not exist');

if (!/Approve\s*&amp;\s*Send|btn-send/.test(hqPanelHtml + hqJs)) {
  pass('D2', 'no send button in handoff panel');
} else fail('D2', 'send button found in handoff panel');

if (!hqJs.includes('/staff/bot/guest-reply-send')) {
  pass('D3', 'handoff panel does not call guest-reply-send');
} else fail('D3', 'guest-reply-send must not be called');

if (!hqJs.includes('graph.facebook.com') && !hqJs.includes('api.stripe.com')) {
  pass('D4', 'no Graph/Stripe fetch in handoff panel JS');
} else fail('D4', 'external API fetch found');

if (src.includes('wireHandoffsQueuePanel')) pass('D5', 'panel wired on init');
else fail('D5', 'wireHandoffsQueuePanel missing');

section('E. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts['verify:luna-agent-phase23-handoff-queue-ui']) {
  pass('E1', 'npm script registered');
} else fail('E1', 'npm script missing');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
