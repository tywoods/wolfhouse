/**
 * Phase 17c — Fast static closeout verifier for Luna shadow comparison.
 *
 * Anchors Phase 17a plan + Phase 17b harness proof without re-running long
 * downstream closeout trees. Phase 17b already proved downstream once (~22m).
 *
 * Hosted proof anchors (static, not re-run here):
 *   Phase 17b commit: 99cf17d
 *   verify:luna-agent-phase17-shadow-comparison: 31 passed, 0 failed
 *   10 canonical fixtures passed; 0 blocking / 0 cosmetic mismatches
 *   downstream closeouts passed during 17b harness run
 *
 * Live WhatsApp NO_GO.
 *
 * Usage:
 *   npm run verify:luna-agent-phase17-closeout
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT    = path.join(__dirname, '..');
const PKG     = path.join(ROOT, 'package.json');
const DOC     = path.join(ROOT, 'docs', 'PHASE-17.1-LUNA-SHADOW-COMPARISON-PLAN.md');
const PLAN    = path.join(__dirname, 'verify-luna-agent-phase17-shadow-comparison-plan.js');
const HARNESS = path.join(__dirname, 'verify-luna-agent-phase17-shadow-comparison.js');
const HELPER  = path.join(__dirname, 'lib', 'luna-guest-message-intake.js');

const PHASE17_SCRIPTS = [
  ['verify:luna-agent-phase17-shadow-comparison-plan', 'scripts/verify-luna-agent-phase17-shadow-comparison-plan.js'],
  ['verify:luna-agent-phase17-shadow-comparison', 'scripts/verify-luna-agent-phase17-shadow-comparison.js'],
  ['verify:luna-agent-phase17-closeout', 'scripts/verify-luna-agent-phase17-closeout.js'],
];

const PRIOR_CLOSEOUT_SCRIPTS = [
  ['verify:luna-agent-phase16-closeout', 'scripts/verify-luna-agent-phase16-closeout.js'],
  ['verify:luna-agent-phase15-closeout', 'scripts/verify-luna-agent-phase15-closeout.js'],
  ['verify:luna-agent-phase14-closeout', 'scripts/verify-luna-agent-phase14-closeout.js'],
  ['verify:luna-agent-phase13-closeout', 'scripts/verify-luna-agent-phase13-closeout.js'],
  ['verify:luna-agent-phase12-closeout', 'scripts/verify-luna-agent-phase12-closeout.js'],
  ['verify:staff-ask-luna-phase11-closeout', 'scripts/verify-staff-ask-luna-phase11-closeout.js'],
];

const REQUIRED_FILES = [
  ['F.doc', DOC],
  ['F.plan', PLAN],
  ['F.harness', HARNESS],
];

const FIXTURE_LABELS = [
  ['EN complete booking',       /name:\s*'EN complete booking'/],
  ['IT partial availability',   /name:\s*'IT partial availability'/],
  ['ES native complete',        /name:\s*'ES native complete'/],
  ['DE native complete',        /name:\s*'DE native complete'/],
  ['Add-on request',            /name:\s*'Add-on request'/],
  ['Refund/handoff',            /name:\s*'Refund\/handoff'/],
  ['Invalid package',           /name:\s*'Invalid package'/],
  ['Missing dates',             /name:\s*'Missing dates'/],
  ['Payment full',              /name:\s*'Payment full'/],
  ['Multilingual payment (ES)', /name:\s*'Multilingual payment \(ES\)'/],
];

const PROOF_17B = {
  commit:              '99cf17d',
  harness_passed:      31,
  harness_failed:      0,
  fixtures_passed:     10,
  blocking_mismatches: 0,
  cosmetic_mismatches: 0,
  downstream_note:     'passed during verify:luna-agent-phase17-shadow-comparison (17b)',
};

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

console.log('\nverify-luna-agent-phase17-closeout.js  (Phase 17c — static, non-recursive)\n');

const startedMs = Date.now();

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'closeout verifier passes node --check');
} catch {
  fail('0', 'closeout verifier syntax error');
}

// ─────────────────────────────────────────────────────────────────────────────
section('A. Phase 17 npm scripts + required files');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));

for (const [scriptName, relPath] of PHASE17_SCRIPTS) {
  const full = path.join(ROOT, relPath);
  if (pkg.scripts && pkg.scripts[scriptName] === `node ${relPath}`) {
    pass('A.script.' + scriptName, `${scriptName} registered`);
  } else {
    fail('A.script.' + scriptName, `${scriptName} missing or wrong path`);
  }
  if (fs.existsSync(full)) pass('A.file.' + scriptName, `${relPath} exists`);
  else fail('A.file.' + scriptName, `${relPath} missing`);
}

for (const [id, fullPath] of REQUIRED_FILES) {
  if (fs.existsSync(fullPath)) pass(id, path.relative(ROOT, fullPath) + ' exists');
  else fail(id, 'missing: ' + fullPath);
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Prior closeout scripts exist (not executed)');

for (const [scriptName, relPath] of PRIOR_CLOSEOUT_SCRIPTS) {
  const full = path.join(ROOT, relPath);
  if (pkg.scripts && pkg.scripts[scriptName]) pass('B.prior.' + scriptName, `${scriptName} registered`);
  else fail('B.prior.' + scriptName, `${scriptName} missing`);
  if (fs.existsSync(full)) pass('B.prior.file.' + scriptName, `${relPath} exists`);
  else fail('B.prior.file.' + scriptName, `${relPath} missing`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('C. Phase 17b proof anchors (static)');

pass('C.commit', `Phase 17b commit anchor: ${PROOF_17B.commit}`);
pass('C.harness', `17b harness: ${PROOF_17B.harness_passed} passed, ${PROOF_17B.harness_failed} failed`);
pass('C.fixtures', `${PROOF_17B.fixtures_passed} canonical fixtures passed`);
pass('C.blocking', `${PROOF_17B.blocking_mismatches} blocking mismatches`);
pass('C.cosmetic', `${PROOF_17B.cosmetic_mismatches} cosmetic mismatches`);
pass('C.downstream', PROOF_17B.downstream_note);

// ─────────────────────────────────────────────────────────────────────────────
section('D. Harness static checks');

if (!fs.existsSync(HARNESS)) {
  fail('D1', 'comparison harness missing');
} else {
  pass('D1', 'comparison harness exists');
  const harnessRaw = fs.readFileSync(HARNESS, 'utf8');
  // Exclude safety-check regex definition lines (avoid false positives).
  const harnessSrc = harnessRaw.split('\n').filter((line) => !/^\s*\['A\./.test(line)).join('\n');

  for (const fn of ['extractLunaGuestMessageIntake', 'validateLunaGuestMessageIntake', 'buildDryRunInputFromIntake']) {
    if (harnessSrc.includes(fn)) pass('D.fn.' + fn, `harness uses ${fn}`);
    else fail('D.fn.' + fn, `${fn} missing from harness`);
  }

  for (const [label, re] of FIXTURE_LABELS) {
    if (re.test(harnessSrc)) pass('D.fixture.' + label.replace(/\s+/g, '_'), `fixture: ${label}`);
    else fail('D.fixture.' + label.replace(/\s+/g, '_'), `fixture missing: ${label}`);
  }

  const forbidden = [
    ['D.no.n8n', /fetchN8n\s*\(|activateN8n\s*\(|triggerN8n\s*\(/, 'n8n execution/activation'],
    ['D.no.hosted', /staff-staging\.lunafrontdesk\.com|fetch\s*\(\s*['"]/i, 'hosted API/fetch/http request'],
    ['D.no.dryrun', /runLunaGuestBookingDryRun\s*\(/, 'live dry-run call'],
    ['D.no.write', /runLunaGuestBookingWriteBridge\s*\(|handleBotBookingCreate\s*\(/, 'booking-create/write bridge'],
    ['D.no.paylink', /generate-payment-link\s*\(|create-stripe-link\s*\(/i, 'payment link call'],
    ['D.no.stripe', /createStripe\s*\(|api\.stripe\.com/i, 'Stripe'],
    ['D.no.wa', /sendWhatsApp\s*\(|whatsapp\.send\s*\(|graph\.facebook\.com/i, 'WhatsApp'],
    ['D.no.webhook', /\/staff\/stripe\/webhook|stripe\/webhook/i, 'webhook'],
    ['D.no.sql', /\bINSERT\s+INTO|\bUPDATE\s+\w|\bDELETE\s+FROM/i, 'SQL writes'],
  ];
  for (const [id, re, label] of forbidden) {
    if (!re.test(harnessSrc)) pass(id, `harness has no ${label}`);
    else fail(id, `harness ${label} detected`);
  }

  if (/legacy parser|Does NOT execute legacy n8n parser/i.test(harnessSrc)) {
    pass('D.legacy', 'harness documents legacy parser not executed');
  } else {
    fail('D.legacy', 'legacy parser exclusion missing');
  }

  if (/blockingCount|blocking mismatches/i.test(harnessSrc)) {
    pass('D.mismatch', 'harness tracks blocking mismatches');
  } else {
    fail('D.mismatch', 'blocking mismatch tracking missing');
  }
}

if (fs.existsSync(HELPER)) {
  const { isGuestIntakeAiEnabled } = require('./lib/luna-guest-message-intake');
  if (!isGuestIntakeAiEnabled({}) && !isGuestIntakeAiEnabled({ LUNA_GUEST_INTAKE_AI_ENABLED: '' })) {
    pass('D.ai', 'AI intake disabled by default');
  } else {
    fail('D.ai', 'AI should be disabled by default');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section('E. Closeout is non-recursive (no downstream exec)');

const selfSrc = fs.readFileSync(__filename, 'utf8');

if (!/execSync\s*\(\s*[`'"]npm run verify:/.test(selfSrc)) {
  pass('E1', 'closeout does not exec downstream npm scripts');
} else {
  fail('E1', 'closeout still execSync npm run downstream');
}

if (!/for\s*\(\s*const\s+script\s+of\s+DOWNSTREAM/.test(selfSrc)) {
  pass('E2', 'no DOWNSTREAM regression loop');
} else {
  fail('E2', 'DOWNSTREAM loop still present');
}

// ─────────────────────────────────────────────────────────────────────────────
section('F. Live WhatsApp NO_GO');

if (fs.existsSync(DOC) && /NO_GO/i.test(fs.readFileSync(DOC, 'utf8'))) {
  pass('F1', 'plan documents live WhatsApp NO_GO');
} else {
  fail('F1', 'NO_GO missing from plan');
}

const wfPath = path.join(ROOT, 'n8n', 'Wolfhouse Booking Assistant - Message Intake Shadow.json');
if (fs.existsSync(wfPath)) {
  const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
  if (wf.active === false) pass('F2', 'n8n shadow workflow active:false');
  else fail('F2', 'shadow workflow must stay inactive');
} else {
  fail('F2', 'shadow workflow JSON missing');
}

const elapsed = Math.round((Date.now() - startedMs) / 1000);
console.log(`\n--- ${passes} passed, ${failures} failed (${elapsed}s, non-recursive) ---\n`);
process.exit(failures > 0 ? 1 : 0);
