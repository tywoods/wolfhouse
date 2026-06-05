/**
 * Phase 12i — Aggregate closeout verifier for Luna guest booking dry-run foundation.
 *
 * Chains static proof across:
 *   12a entrypoints → 12b orchestrator → 12c Staff API route → 12d n8n workflow
 *   → 12f from mapping → 12h proof script
 *
 * Usage:
 *   npm run verify:luna-agent-phase12-closeout
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const PKG    = path.join(ROOT, 'package.json');
const API    = path.join(__dirname, 'staff-query-api.js');
const ORCH   = path.join(__dirname, 'lib', 'luna-guest-booking-dry-run.js');
const PROOF  = path.join(__dirname, 'proof-luna-booking-dry-run-route.js');
const WF     = path.join(ROOT, 'n8n', 'Wolfhouse Booking Assistant - Main - Shared Engine Dry Run.json');

const PHASE12_SCRIPTS = [
  ['verify:luna-agent-dry-run-entrypoints', 'scripts/verify-luna-agent-dry-run-entrypoints.js'],
  ['verify:luna-agent-dry-run-orchestrator', 'scripts/verify-luna-agent-dry-run-orchestrator.js'],
  ['verify:luna-agent-booking-dry-run-route', 'scripts/verify-luna-agent-booking-dry-run-route.js'],
  ['verify:luna-agent-n8n-dry-run-workflow', 'scripts/verify-luna-agent-n8n-dry-run-workflow.js'],
  ['proof:luna-booking-dry-run-route', 'scripts/proof-luna-booking-dry-run-route.js'],
  ['verify:luna-agent-phase12-closeout', 'scripts/verify-luna-agent-phase12-closeout.js'],
];

const RUNTIME_SCAN_TARGETS = [
  { label: 'orchestrator', path: ORCH, kind: 'js-runtime' },
  { label: 'proof-script', path: PROOF, kind: 'js-runtime' },
];

const SAFETY_FLAG_CHECKS = [
  ['dry_run', /dry_run:\s*true/],
  ['preview_only', /preview_only:\s*true/],
  ['no_write_performed', /no_write_performed:\s*true/],
  ['creates_booking', /creates_booking:\s*false/],
  ['creates_payment', /creates_payment:\s*false/],
  ['creates_stripe_link', /creates_stripe_link:\s*false/],
  ['sends_whatsapp', /sends_whatsapp:\s*false/],
  ['calls_n8n', /calls_n8n:\s*false/],
];

const FORBIDDEN_LIVE_FRAGMENTS = [
  ['/staff/bot/bookings/create', 'bot booking create'],
  ['/staff/manual-bookings/create', 'manual booking create'],
  ['/staff/bookings/generate-payment-link', 'generate-payment-link'],
  ['/staff/bot/payments/', 'bot stripe link'],
  ['/staff/stripe/webhook', 'stripe webhook'],
  ['api.stripe.com', 'Stripe API'],
  ['checkout.sessions.create', 'Stripe checkout session'],
  ['graph.facebook.com', 'WhatsApp Graph API'],
  ['n8n.cloud', 'n8n cloud activation'],
  ['workflows/activate', 'n8n workflow activation'],
];

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function hasWriteSql(src) {
  const body = stripJsComments(src);
  return /\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)\b/i.test(body);
}

function stripOrchForbiddenDocs(src) {
  return stripJsComments(src).replace(/const\s+LIVE_FORBIDDEN_ROUTES\s*=\s*\[[\s\S]*?\];/, '');
}

function hasForbiddenLiveInvocation(src, label) {
  const body = label === 'orchestrator' ? stripOrchForbiddenDocs(src) : stripJsComments(src);
  return FORBIDDEN_LIVE_FRAGMENTS.filter(([frag]) => body.includes(frag));
}

function sliceHandler(src, fnName) {
  const start = src.indexOf(`async function ${fnName}(`);
  if (start < 0) return '';
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start, start + 8000);
}

console.log('\nverify-luna-agent-phase12-closeout.js  (Phase 12i)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'closeout verifier passes node --check');
} catch {
  fail('0', 'closeout verifier syntax error');
}

// ─────────────────────────────────────────────────────────────────────────────
section('A. Phase 12 npm scripts');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
for (const [scriptName, relPath] of PHASE12_SCRIPTS) {
  if (pkg.scripts && pkg.scripts[scriptName] === `node ${relPath.replace(/\\/g, '/')}`) {
    pass('A.' + scriptName, `${scriptName} registered`);
  } else {
    fail('A.' + scriptName, `${scriptName} missing or wrong path in package.json`);
  }
  const abs = path.join(ROOT, relPath);
  if (fs.existsSync(abs)) pass('A.file.' + scriptName, relPath + ' exists');
  else fail('A.file.' + scriptName, relPath + ' missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Dry-run orchestrator (12b)');

if (fs.existsSync(ORCH)) {
  pass('B1', 'luna-guest-booking-dry-run.js exists');
  try {
    const mod = require(ORCH);
    if (typeof mod.runLunaGuestBookingDryRun === 'function') {
      pass('B2', 'exports runLunaGuestBookingDryRun');
    } else {
      fail('B2', 'runLunaGuestBookingDryRun export missing');
    }
    if (mod.DRY_RUN_ANCHOR_ROUTES && mod.DRY_RUN_SAFETY_FLAGS) {
      pass('B3', 'exports DRY_RUN_ANCHOR_ROUTES + DRY_RUN_SAFETY_FLAGS');
    } else {
      fail('B3', 'orchestrator anchor/safety exports missing');
    }
  } catch (e) {
    fail('B2', 'orchestrator module load failed: ' + e.message);
  }
  const orchSrc = fs.readFileSync(ORCH, 'utf8');
  if (!orchSrc.includes("require('./staff-query-api')")) {
    pass('B4', 'orchestrator does not import staff-query-api');
  } else {
    fail('B4', 'orchestrator imports staff-query-api (live dispatch risk)');
  }
} else {
  fail('B1', 'orchestrator module missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('C. Staff API route (12c)');

const apiSrc = fs.readFileSync(API, 'utf8');
const routeIdx = apiSrc.indexOf("'/staff/bot/booking-dry-run'");
const routeBlock = routeIdx > -1 ? apiSrc.slice(routeIdx, routeIdx + 650) : '';
const handler = sliceHandler(apiSrc, 'handleBotBookingDryRun');

if (routeIdx > -1) pass('C1', 'POST /staff/bot/booking-dry-run registered');
else fail('C1', 'booking-dry-run route missing');

if (routeBlock.includes('requireBotAuth')) pass('C2', 'route uses requireBotAuth');
else fail('C2', 'requireBotAuth not on route');

if (handler.includes('runLunaGuestBookingDryRun')) pass('C3', 'handler calls runLunaGuestBookingDryRun');
else fail('C3', 'handler does not call orchestrator');

if (handler.includes('withPgClient')) pass('C4', 'handler uses read-only withPgClient');
else fail('C4', 'withPgClient missing in handler');

for (const [flag] of SAFETY_FLAG_CHECKS) {
  if (handler.includes(flag) || fs.readFileSync(ORCH, 'utf8').includes(flag)) {
    pass('C5.' + flag, `dry-run safety flag ${flag} in stack`);
  } else {
    fail('C5.' + flag, `safety flag ${flag} not found in handler/orchestrator`);
  }
}

if (!hasWriteSql(handler)) pass('C6', 'handler has no write SQL');
else fail('C6', 'write SQL in booking-dry-run handler');

// ─────────────────────────────────────────────────────────────────────────────
section('D. Inactive n8n workflow (12d/12f)');

let wf;
let wfRaw = '';
let wfNodesStr = '[]';
if (fs.existsSync(WF)) {
  wfRaw = fs.readFileSync(WF, 'utf8');
  wf = JSON.parse(wfRaw);
  wfNodesStr = JSON.stringify(wf.nodes || []);
  pass('D1', 'Shared Engine Dry Run workflow JSON exists');
} else {
  fail('D1', 'n8n dry-run workflow JSON missing');
  wf = { nodes: [], active: null };
}

if (wf.active === false) pass('D2', 'workflow active: false');
else fail('D2', 'workflow not inactive (active=' + wf.active + ')');

const httpNodes = (wf.nodes || []).filter((n) => n.type === 'n8n-nodes-base.httpRequest');
const dryRunHttp = httpNodes.filter((n) => JSON.stringify(n.parameters || {}).includes('/staff/bot/booking-dry-run'));
const staffApiHttp = httpNodes.filter((n) => {
  const u = JSON.stringify(n.parameters || {});
  return u.includes('staff-staging.lunafrontdesk.com') || u.includes('/staff/bot/');
});

if (dryRunHttp.length === 1) pass('D3', 'exactly one booking-dry-run HTTP node');
else fail('D3', 'expected 1 booking-dry-run HTTP node, got ' + dryRunHttp.length);

if (staffApiHttp.length === 1) pass('D4', 'exactly one Staff API HTTP node total');
else fail('D4', 'expected 1 Staff API HTTP node, got ' + staffApiHttp.length);

const parseNode = (wf.nodes || []).find((n) => (n.name || '').includes('Parse Booking Fields'));
const parseCode = parseNode?.parameters?.jsCode || '';
if (parseCode.includes('body.from') && parseCode.includes('body.guest_phone || body.phone || body.from')) {
  pass('D5', 'from fallback mapping in parse node (guest_phone → phone → from)');
} else {
  fail('D5', 'from phone fallback mapping missing or wrong order');
}

const hasWaSend = (wf.nodes || []).some((n) =>
  (n.type || '').toLowerCase().includes('whatsapp') && (n.name || '').toLowerCase().includes('send'));
if (!hasWaSend) pass('D6', 'no WhatsApp send node');
else fail('D6', 'WhatsApp send node present');

if (!wfNodesStr.includes('api.stripe.com')) pass('D7', 'no Stripe API in workflow nodes');
else fail('D7', 'Stripe API reference in workflow nodes');

const cred = dryRunHttp[0]?.credentials?.httpHeaderAuth;
if (cred && cred.name && cred.name.includes('Luna Bot Internal Token') && !wfRaw.match(/Bearer\s+[A-Za-z0-9._-]{20,}/)) {
  pass('D8', 'credential placeholder bound, no hardcoded token');
} else {
  fail('D8', 'credential binding or hardcoded token issue');
}

for (const field of ['reply_draft', 'planned_actions', 'dry_run', 'sends_whatsapp', 'whatsapp_sent']) {
  if (wfRaw.includes(field)) pass('D9.' + field, 'workflow preserves ' + field);
  else fail('D9.' + field, field + ' missing from workflow output mapping');
}

for (const [frag, label] of FORBIDDEN_LIVE_FRAGMENTS) {
  if (!wfNodesStr.includes(frag)) pass('D10.' + label, 'n8n workflow nodes exclude ' + label);
  else fail('D10.' + label, 'forbidden ' + label + ' in n8n workflow nodes');
}

// ─────────────────────────────────────────────────────────────────────────────
section('E. Proof script (12h)');

const proofSrc = fs.existsSync(PROOF) ? fs.readFileSync(PROOF, 'utf8') : '';
if (proofSrc.includes('/staff/bot/booking-dry-run')) pass('E1', 'proof posts to booking-dry-run');
else fail('E1', 'proof route missing');

const proofAsserts = ['dry_run', 'preview_only', 'no_write_performed', 'creates_booking',
  'creates_payment', 'creates_stripe_link', 'sends_whatsapp', 'calls_n8n', 'planned_actions', 'reply_draft', 'next_action'];
const missingAssert = proofAsserts.filter((f) => !proofSrc.includes(f));
if (!missingAssert.length) pass('E2', 'proof asserts all safety/plan fields');
else fail('E2', 'proof missing assertions: ' + missingAssert.join(', '));

if (!/writeFileSync|createWriteStream|appendFileSync/i.test(proofSrc)) {
  pass('E3', 'proof does not write files');
} else {
  fail('E3', 'proof writes files');
}

if (!/console\.(log|error)\s*\([^)]*\bTOKEN\b|console\.(log|error)\s*\([^)]*LUNA_BOT_INTERNAL_TOKEN/i.test(proofSrc)) {
  pass('E4', 'proof does not log secrets');
} else {
  fail('E4', 'proof may log secrets');
}

if (proofSrc.includes('LUNA_BOT_INTERNAL_TOKEN') && proofSrc.includes('X-Luna-Bot-Token')) {
  pass('E5', 'proof uses bot auth env + header');
} else {
  fail('E5', 'proof auth wiring unclear');
}

// ─────────────────────────────────────────────────────────────────────────────
section('F. Phase 12 runtime artifacts — safety scan');

for (const target of RUNTIME_SCAN_TARGETS) {
  if (!fs.existsSync(target.path)) {
    fail('F.missing.' + target.label, target.path + ' missing');
    continue;
  }
  const src = fs.readFileSync(target.path, 'utf8');
  if (!hasWriteSql(src)) pass('F.sql.' + target.label, target.label + ': no write SQL');
  else fail('F.sql.' + target.label, target.label + ': write SQL detected');

  const hits = hasForbiddenLiveInvocation(src, target.label);
  if (!hits.length) pass('F.live.' + target.label, target.label + ': no live route/integration calls');
  else fail('F.live.' + target.label, target.label + ': forbidden ' + hits.map((h) => h[1]).join(', '));
}

if (!hasWriteSql(handler)) pass('F.handler.sql', 'handleBotBookingDryRun: no write SQL');
else fail('F.handler.sql', 'write SQL in handler');

const handlerHits = hasForbiddenLiveInvocation(handler, 'handler');
if (!handlerHits.length) pass('F.handler.live', 'handler: no live route/integration calls');
else fail('F.handler.live', 'handler: forbidden ' + handlerHits.map((h) => h[1]).join(', '));

const wfHits = FORBIDDEN_LIVE_FRAGMENTS.filter(([frag]) => wfNodesStr.includes(frag));
if (!wfHits.length) pass('F.wf.live', 'n8n nodes: no live route/integration calls');
else fail('F.wf.live', 'n8n nodes: forbidden ' + wfHits.map((h) => h[1]).join(', '));

// ─────────────────────────────────────────────────────────────────────────────
section('G. Dry-run safety flags (orchestrator + workflow)');

const orchSrc = fs.readFileSync(ORCH, 'utf8');
for (const [flag, re] of SAFETY_FLAG_CHECKS) {
  if (re.test(orchSrc)) pass('G.orch.' + flag, 'orchestrator asserts ' + flag);
  else fail('G.orch.' + flag, 'orchestrator missing ' + flag);
}

if (wfRaw.includes('sends_whatsapp: false') && wfRaw.includes('whatsapp_sent: false')) {
  pass('G.wf', 'n8n output forces sends_whatsapp + whatsapp_sent false');
} else {
  fail('G.wf', 'n8n WhatsApp safety flags not forced false');
}

// ─────────────────────────────────────────────────────────────────────────────
section('H. Shared engine anchors (12a/12b)');

const anchors = [
  ['gate', /check-guest-automation-gate|getPauseState/],
  ['booking preview / quote', /booking-preview|calculateWolfhouseQuote/],
  ['availability preview', /availability-check|getBedCalendar/],
  ['add-on preview', /addon-request-preview|addon_preview/],
];

for (const [label, re] of anchors) {
  if (re.test(orchSrc)) pass('H.' + label, 'orchestrator reuses ' + label);
  else fail('H.' + label, 'anchor missing: ' + label);
}

if (orchSrc.includes('DRY_RUN_ANCHOR_ROUTES')) {
  pass('H.routes', 'DRY_RUN_ANCHOR_ROUTES documented');
} else {
  fail('H.routes', 'DRY_RUN_ANCHOR_ROUTES missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('I. Phase 11 closeout regression');

try {
  execSync('npm run verify:staff-ask-luna-phase11-closeout', {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  pass('I1', 'verify:staff-ask-luna-phase11-closeout passes');
} catch (e) {
  fail('I1', 'Phase 11 closeout failed');
  const out = (e.stdout || '') + (e.stderr || '');
  const tail = out.split('\n').slice(-5).join('\n');
  if (tail) console.error(tail);
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
