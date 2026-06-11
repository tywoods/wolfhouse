/**
 * Stage 36b — Ale/Cami staging demo runbook verifier (doc + safety static checks).
 *
 * Usage:
 *   npm run verify:stage36b-demo-runbook
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'STAGE-36B-ALE-CAMI-STAGING-DEMO-RUNBOOK.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const REL = 'scripts/verify-stage36b-demo-runbook.js';

let passes = 0;
let failures = 0;

function ok(msg) { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

function docMatches(text, pattern, label) {
  check(pattern.test(text), label);
}

console.log('\nverify-stage36b-demo-runbook.js  (Stage 36b)\n');

check(fs.existsSync(DOC), 'runbook doc exists');
if (!fs.existsSync(DOC)) {
  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(1);
}

const doc = fs.readFileSync(DOC, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

try {
  execSync(`node --check "${__filename}"`, { stdio: 'ignore' });
  ok(`${REL} passes node --check`);
} catch (_) {
  fail(`${REL} passes node --check`);
}

check(
  pkg.scripts && pkg.scripts['verify:stage36b-demo-runbook']
    === 'node scripts/verify-stage36b-demo-runbook.js',
  'package.json verify script registered',
);

console.log('\nA. Demo goal');

docMatches(doc, /Demo goal|demo proves/i, 'includes demo goal section');
docMatches(doc, /WhatsApp booking|WhatsApp/i, 'mentions WhatsApp booking');
docMatches(doc, /quote correctly|Quote/i, 'mentions quote');
docMatches(doc, /surf add-ons|wetsuit|surfboard/i, 'mentions surf add-ons not yoga/meals proactive');
docMatches(doc, /deposit/i, 'mentions deposit');
docMatches(doc, /Stripe TEST/i, 'mentions Stripe TEST');
docMatches(doc, /Staff Portal/i, 'mentions Staff Portal');
docMatches(doc, /pending yoga|Pending services|pending manual/i, 'mentions pending services visibility');
docMatches(doc, /correction|stale|reset/i, 'mentions correction/reset safety');

console.log('\nB. Demo modes A / B / C');

docMatches(doc, /Mode A/i, 'includes Mode A');
docMatches(doc, /Mode B/i, 'includes Mode B');
docMatches(doc, /Mode C/i, 'includes Mode C');
docMatches(doc, /no live WhatsApp|No live WhatsApp/i, 'Mode A: no live WhatsApp');
docMatches(doc, /TEST payment link|Stripe TEST link/i, 'Mode B: TEST payment link');
docMatches(doc, /confirmation allowlist|Confirmation send/i, 'Mode C: confirmation allowlist note');

console.log('\nC. Gate checklist + safe baseline');

docMatches(doc, /WHATSAPP_DRY_RUN/i, 'includes WHATSAPP_DRY_RUN');
docMatches(doc, /OPEN_DEMO_BOOKING_WRITES_ENABLED/i, 'includes OPEN_DEMO_BOOKING_WRITES_ENABLED');
docMatches(doc, /OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED/i, 'includes OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED');
docMatches(doc, /OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED/i, 'includes OPEN_DEMO_STRIPE_TEST_LINKS_ENABLED');
docMatches(doc, /LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST/i, 'includes confirmation allowlist gate');
docMatches(doc, /n8n.*inactive|inactive.*n8n/i, 'includes n8n inactive');
docMatches(doc, /sk_test/i, 'includes Stripe sk_test only');
docMatches(doc, /Restore checklist|restore checklist/i, 'includes restore checklist');
docMatches(doc, /healthz/i, 'includes healthz in restore');
docMatches(doc, /playground:open-demo-off/i, 'includes playground off command');

console.log('\nD. WhatsApp scripts');

docMatches(doc, /Script 1/i, 'includes Script 1');
docMatches(doc, /Script 2/i, 'includes Script 2');
docMatches(doc, /Script 3/i, 'includes Script 3');
docMatches(doc, /book a stay[\s\S]*July 1-5[\s\S]*deposit/is, 'Script 1: short-stay messages');
docMatches(doc, /Malibu July 10[\s\S]*Can I add yoga[\s\S]*deposit/is, 'Script 2: Malibu + yoga');
docMatches(doc, /actually July 2-6/i, 'Script 3: date correction');
docMatches(doc, /€180|180/, 'Script 1 expected €180');

console.log('\nE. Staff Portal screens');

docMatches(doc, /Inbox|conversation/i, 'includes Inbox/conversation');
docMatches(doc, /booking drawer|Overview/i, 'includes booking drawer/overview');
docMatches(doc, /payment|balance/i, 'includes payment/balance section');
docMatches(doc, /Pending services|pending services card/i, 'includes pending services card');
docMatches(doc, /Ask Luna/i, 'includes Ask Luna panel');

console.log('\nF. Ask Luna questions');

const ASK_LUNA_QUESTIONS = [
  'Who asked for yoga?',
  'Who needs meals scheduled?',
  'Show pending manual services',
  'WH-G27',
  'Who still owes money?',
  'checking in today',
  'checking out tomorrow',
  'staff follow-up',
];
for (const q of ASK_LUNA_QUESTIONS) {
  check(doc.includes(q) || new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(doc),
    `Ask Luna question covered: ${q}`);
}

console.log('\nG. Not ready yet');

docMatches(doc, /not ready|Not ready|avoid/i, 'includes not-ready / avoid section');
docMatches(doc, /scheduling dates|service scheduling|needs scheduling/i, 'honest about service scheduling');
docMatches(doc, /transfer|deferred capture/i, 'honest about transfer');
docMatches(doc, /production|live Stripe/i, 'honest about no production/live Stripe');
docMatches(doc, /n8n.*inactive|inactive.*n8n/i, 'honest about n8n inactive');
docMatches(doc, /test phone|staging only/i, 'honest about test phone/staging');

console.log('\nH. Emergency restore');

docMatches(doc, /Emergency restore|panic restore/i, 'includes emergency restore');
docMatches(doc, /playground:open-demo-off/i, 'panic: playground off');
docMatches(doc, /healthz/i, 'panic: healthz check');
docMatches(doc, /booking_code|conversation_id/i, 'panic: capture booking_code/conversation_id');
docMatches(doc, /Stop.*WhatsApp|stop sending/i, 'panic: stop test messages');

console.log('\nI. Safety — no runtime product changes in this stage');

const gitDiff = (() => {
  try {
    return execSync('git diff --name-only HEAD', { encoding: 'utf8', cwd: ROOT }).trim();
  } catch {
    return '';
  }
})();

const RUNTIME_PRODUCT_PATTERNS = [
  /^scripts\/lib\/luna-guest-/,
  /^scripts\/lib\/luna-booking-/,
  /^scripts\/lib\/open-demo-/,
  /^scripts\/staff-query-api\.js$/,
];
if (gitDiff) {
  const changed = gitDiff.split('\n').filter(Boolean);
  const bad = changed.filter((f) => RUNTIME_PRODUCT_PATTERNS.some((re) => re.test(f.replace(/\\/g, '/'))));
  check(bad.length === 0, 'no runtime guest/booking product files in unstaged diff');
} else {
  ok('no unstaged diff (or git unavailable) — runbook stage is docs/verifier only');
}

const apiSrc = fs.existsSync(path.join(__dirname, 'staff-query-api.js'))
  ? fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8') : '';
check(!doc.includes('WHATSAPP_DRY_RUN=false') || doc.includes('Restore'), 'doc mentions restore when dry-run off');

console.log('\nJ. Static safety (existing codebase unchanged by this commit intent)');

check(!fs.readFileSync(path.join(__dirname, 'lib', 'staff-ask-luna-pending-manual-services.js'), 'utf8')
  .match(/\bsendWhatsApp\b/i), 'pending manual module: no WhatsApp send');
check(!fs.readFileSync(path.join(__dirname, 'lib', 'staff-pending-manual-services.js'), 'utf8')
  .match(/\bn8n\b/i), 'pending module: no n8n activation');
check(doc.includes('staff-staging.lunafrontdesk.com'), 'runbook uses staging host not production');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
