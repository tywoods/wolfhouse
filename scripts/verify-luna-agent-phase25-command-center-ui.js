/**
 * Phase 25i — Verifier for Command Center Staff Portal UI.
 *
 * Usage:
 *   npm run verify:luna-agent-phase25-command-center-ui
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const ANSWER = path.join(__dirname, 'lib', 'owner-command-center-answer.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-25i-COMMAND-CENTER-OWNER-UI.md');
const PKG = path.join(ROOT, 'package.json');

const DOWNSTREAM = [
  'verify:luna-agent-phase25-owner-command-center-answer',
  'verify:luna-agent-phase25-owner-plan-execute',
  'verify:luna-agent-phase25-owner-whatsapp-router',
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch { return ''; }
}

console.log('\nverify-luna-agent-phase25-command-center-ui.js  (Phase 25i)\n');

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'staff-query-api.js passes node --check');
} catch {
  fail('0', 'staff-query-api syntax check failed');
}

const src = readOrEmpty(API);
const answerSrc = readOrEmpty(ANSWER);
const pkg = JSON.parse(readOrEmpty(PKG) || '{}');

const ccStart = src.indexOf('<!-- ── Command Center tab');
const ccEnd = src.indexOf('</div><!-- /tab-ask-luna -->', ccStart);
const ccPanel = ccStart >= 0 && ccEnd > ccStart ? src.slice(ccStart, ccEnd) : '';

const jsStart = src.indexOf('COMMAND CENTER TAB — Operations');
const jsEnd = src.indexOf('QUERY TOOLS TAB — existing staff query interface', jsStart);
const ccJs = jsStart >= 0 && jsEnd > jsStart ? src.slice(jsStart, jsEnd) : '';

section('A. Command Center naming');

if (src.includes('data-tab="ask-luna">Command Center</button>')) {
  pass('A1', 'tab button labeled Command Center');
} else fail('A1', 'Command Center tab label missing');

if (ccPanel.includes('al-hero-title">Command Center</div>')) {
  pass('A2', 'hero heading says Command Center');
} else fail('A2', 'hero heading missing Command Center');

if (!/tab-btn[^>]*>Ask Luna</.test(src) && !ccPanel.includes('al-hero-title">Luna</div>')) {
  pass('A3', 'user-facing Ask Luna tab/hero label removed');
} else fail('A3', 'Ask Luna user-facing label still present');

section('B. Operations panel');

if (ccPanel.includes('cc-section-hdr">Operations</div>') && ccPanel.includes('id="al-input"')) {
  pass('B1', 'Operations section with existing input');
} else fail('B1', 'Operations section missing');

if (ccJs.includes("fetch('/staff/ask-luna'") && ccJs.includes('function alAsk')) {
  pass('B2', 'Operations still calls /staff/ask-luna');
} else fail('B2', 'Operations route missing');

if (ccJs.includes('getClient()') && ccJs.includes("fetch('/staff/ask-luna'")) {
  pass('B3', 'Operations uses current client slug');
} else fail('B3', 'Operations client slug wiring');

section('C. Owner Insights panel');

if (ccPanel.includes('Owner Insights') && ccPanel.includes('id="oi-input"') && ccPanel.includes('id="oi-btn"')) {
  pass('C1', 'Owner Insights panel exists');
} else fail('C1', 'Owner Insights panel missing');

if (ccPanel.includes('data-oi-q="Who hasn\'t settled up?"')
  && ccPanel.includes('data-oi-q="How much revenue this month?"')
  && ccPanel.includes('data-oi-q="Which package is most popular?"')
  && ccPanel.includes('data-oi-q="List recent guest messages for Wolfhouse"')) {
  pass('C2', 'owner example questions present');
} else fail('C2', 'owner examples incomplete');

if (ccJs.includes("fetch('/staff/owner/sql/plan-and-execute'") && ccJs.includes('function oiAsk')) {
  pass('C3', 'Owner Insights calls plan-and-execute');
} else fail('C3', 'plan-and-execute fetch missing');

if (ccJs.includes('max_rows: 50') && ccJs.includes('timeout_ms: 3000')) {
  pass('C4', 'plan-and-execute body includes row cap + timeout');
} else fail('C4', 'plan-and-execute params missing');

section('D. Answer display + safety');

if (ccJs.includes('data.answer') && ccJs.includes('row_count') && ccJs.includes('planner_source')) {
  pass('D1', 'answer display includes answer text and metadata');
} else fail('D1', 'answer display incomplete');

if (ccJs.includes('Read-only') && ccJs.includes('No writes')) {
  pass('D2', 'read_only / no_write indicators in UI');
} else fail('D2', 'safety badges missing');

if (ccJs.includes('<details') && ccJs.includes('sql_summary')) {
  pass('D3', 'details accordion with SQL summary (not full SQL default)');
} else fail('D3', 'details accordion missing');

if (ccJs.includes("can't answer that from the allowed owner data")) {
  pass('D4', 'blocked response safe copy');
} else fail('D4', 'blocked copy missing');

if (!ccJs.includes('graph.facebook') && !ccJs.includes('/staff/bot/guest-reply-send')
  && !ccJs.includes('stripe.com')) {
  pass('D5', 'UI JS does not call WhatsApp/Stripe send routes');
} else fail('D5', 'forbidden send route in UI JS');

section('E. Currency + untouched guest flow');

if (answerSrc.includes('guardEuroCurrency') && answerSrc.includes('Never use $ or USD')) {
  pass('E1', 'formatter prefers EUR/€ and guards against $');
} else fail('E1', 'EUR currency guard missing');

const guestDraft = readOrEmpty(path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'));
if (guestDraft && !guestDraft.includes('oiAsk') && !guestDraft.includes('Owner Insights')) {
  pass('E2', 'guest reply draft untouched');
} else fail('E2', 'guest draft touched');

if (ccPanel.includes('TODO(owner-role)')) {
  pass('E3', 'owner-only role TODO documented in UI');
} else fail('E3', 'role TODO comment missing');

section('F. Docs + npm script');

if (fs.existsSync(DOC)) pass('F1', 'PHASE-25i doc exists');
else fail('F1', 'doc missing');

if (pkg.scripts && pkg.scripts['verify:luna-agent-phase25-command-center-ui']) {
  pass('F2', 'npm script registered');
} else fail('F2', 'npm script missing');

section('G. Downstream listed (not run)');
for (const s of DOWNSTREAM) {
  if (pkg.scripts && pkg.scripts[s]) pass('G', `downstream registered: ${s}`);
  else fail('G', `missing downstream: ${s}`);
}

console.log('\n' + '─'.repeat(60));
if (failures === 0) {
  console.log(`PASS  (${passes} checks)\n`);
  process.exit(0);
}
console.log(`FAIL  (${passes} passed, ${failures} failed)\n`);
process.exit(1);
