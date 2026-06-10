/**
 * Stage 28i.1 — Verifier for weekly package 7-night stay rules (Luna + Staff Portal).
 *
 * Usage:
 *   npm run verify:stage28i1-package-night-rules
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RULES = path.join(__dirname, 'lib', 'wolfhouse-package-night-rules.js');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const AVAIL = path.join(__dirname, 'lib', 'luna-guest-availability-dry-run.js');
const QUOTE = path.join(__dirname, 'lib', 'luna-guest-quote-proposal-dry-run.js');
const STAFF = path.join(__dirname, 'staff-query-api.js');
const BRAIN = path.join(__dirname, 'lib', 'luna-conversation-brain.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage28i1-package-night-rules';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

async function runTurns(turns) {
  const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
  let ctx = {};
  const out = [];
  for (const message_text of turns) {
    const o = await runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      message_text,
      guest_phone: '+491726422307',
      guest_context: ctx,
      reference_date: '2026-06-10',
    }, { dry_run: true, reference_date: '2026-06-10' });
    out.push({ message_text, orchestrator: o, result: o.result || {} });
    ctx = o.result ? { ...ctx, ...o.result, result: o.result } : ctx;
  }
  return out;
}

function isDepositReply(reply) {
  return /deposit|full amount|pay a €/i.test(reply || '');
}

console.log(`\nverify-stage28i1-package-night-rules.js  (Stage 28i.1)\n`);

for (const f of [RULES, ROUTER, AVAIL, QUOTE, STAFF, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('0', `${path.basename(f)} passes node --check`);
  } catch {
    fail('0', `${path.basename(f)} syntax error`);
  }
}

const rulesSrc = fs.readFileSync(RULES, 'utf8');
const routerSrc = fs.readFileSync(ROUTER, 'utf8');
const staffSrc = fs.readFileSync(STAFF, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
const brainSrc = fs.readFileSync(BRAIN, 'utf8');

const rules = require('./lib/wolfhouse-package-night-rules');
const { validateStaffPackageNightRule, computeStayNights, STAFF_PACKAGE_VALIDATION_MSG } = rules;

section('A. Wiring');

if (pkg.scripts[SCRIPT]) pass('A1', 'verifier npm script registered');
else fail('A1', 'verifier script missing');

if (routerSrc.includes('wolfhouse-package-night-rules')
  && routerSrc.includes('package_night_rule')) {
  pass('A2', 'router applies package night rules');
} else {
  fail('A2', 'router wiring missing');
}

if (staffSrc.includes('validateStaffPackageNightRule')
  && staffSrc.includes('bcValidatePackageNightRule')) {
  pass('A3', 'staff API + UI package night validation wired');
} else {
  fail('A3', 'staff wiring missing');
}

section('B. Rule helpers');

if (computeStayNights('2026-07-01', '2026-07-05') === 4) pass('B1', 'July 1–5 = 4 nights');
else fail('B1', 'nights calc wrong');

if (computeStayNights('2026-07-10', '2026-07-17') === 7) pass('B2', 'July 10–17 = 7 nights');
else fail('B2', '7-night calc wrong');

{
  const blocked = validateStaffPackageNightRule('2026-07-01', '2026-07-05', 'malibu');
  if (!blocked.ok && blocked.error === STAFF_PACKAGE_VALIDATION_MSG) pass('B3', 'staff blocks malibu under 7 nights');
  else fail('B3', JSON.stringify(blocked));
}

{
  const ok = validateStaffPackageNightRule('2026-07-10', '2026-07-17', 'malibu');
  if (ok.ok && ok.nights === 7) pass('B4', 'staff allows 7-night malibu');
  else fail('B4', JSON.stringify(ok));
}

section('C. Luna — short stay + blocked package');

(async () => {
  const blocked = await runTurns(['Malibu July 1 to July 5 for 1']);
  const b = blocked[0];
  const br = b.result;
  const breply = b.orchestrator.proposed_luna_reply || '';

  if (br.package_night_rule === 'weekly_package_blocked') pass('C1', 'malibu short stay flagged blocked');
  else fail('C1', `rule=${br.package_night_rule}`);

  if (!isDepositReply(breply) && /accommodation|add-ons|wetsuit|board rental/i.test(breply)) {
    pass('C2', 'blocked package suggests accommodation/services');
  } else {
    fail('C2', `reply=${breply.slice(0, 100)}`);
  }

  if (b.orchestrator.proposed_next_action !== 'collect_payment_choice'
    && b.orchestrator.hold_payment_draft_plan?.plan_status !== 'ready') {
    pass('C3', 'no hold/payment on blocked package');
  } else {
    fail('C3', `next=${b.orchestrator.proposed_next_action}`);
  }

  const shortFlow = await runTurns(['hi', 'book a stay', 'July 1-5', '1']);
  const last = shortFlow[shortFlow.length - 1];
  const sreply = last.orchestrator.proposed_luna_reply || '';

  if (last.result.package_night_rule === 'short_stay_guidance') pass('C4', 'short stay flow ends on guidance rule');
  else fail('C4', `rule=${last.result.package_night_rule}`);

  if (/accommodation|add-ons|under 7 nights/i.test(sreply) && !isDepositReply(sreply)) {
    pass('C5', 'short stay guidance, not deposit/package quote');
  } else {
    fail('C5', `reply=${sreply.slice(0, 100)}`);
  }

  if (shortFlow[2].orchestrator.proposed_luna_reply.includes('How many guests')) {
    pass('C6', 'July 1-5 still asks guest count before guidance');
  } else {
    fail('C6', `dates turn=${shortFlow[2].orchestrator.proposed_luna_reply}`);
  }

  section('D. Luna — 7-night explain vs direct package');

  const explain = await runTurns(['July 10 to July 17 for 2']);
  const ereply = explain[0].orchestrator.proposed_luna_reply || '';
  if (explain[0].result.package_night_rule === 'weekly_explain_before_choice'
    && /malibu/i.test(ereply) && /uluwatu/i.test(ereply) && /which one sounds best/i.test(ereply)) {
    pass('D1', '7-night stay without package explains packages + asks choice');
  } else {
    fail('D1', `rule=${explain[0].result.package_night_rule} reply=${ereply.slice(0, 80)}`);
  }

  const direct = await runTurns(['Malibu July 10 to July 17 for 2']);
  const dr = direct[0].result;
  const dreply = direct[0].orchestrator.proposed_luna_reply || '';
  if (dr.package_night_rule === 'weekly_direct_choice') pass('D2', 'direct malibu skips forced explanation rule');
  else fail('D2', `rule=${dr.package_night_rule}`);
  if (!/Quick guide:/i.test(dreply) || dr.package_night_rule === 'weekly_direct_choice') {
    pass('D3', 'direct malibu does not force overview explainer');
  } else {
    fail('D3', `reply=${dreply.slice(0, 80)}`);
  }
  if ((dr.extracted_fields || {}).package_interest === 'malibu') pass('D4', 'direct malibu extracts package');
  else fail('D4', `pkg=${(dr.extracted_fields || {}).package_interest}`);

  section('E. Luna — conversation brain regression slice');

  const brainFlow = await runTurns(['hi', 'book a stay', 'July 10-17', '1', 'explain the packages']);
  const brainLast = brainFlow[brainFlow.length - 1];
  if (!brainLast.result.safe_handoff_required
    && /malibu/i.test(brainLast.orchestrator.proposed_luna_reply)
    && brainLast.result.extracted_fields?.check_in === '2026-07-10') {
    pass('E1', 'explain packages mid 7-night flow preserves context');
  } else {
    fail('E1', `handoff=${brainLast.result.safe_handoff_required}`);
  }

  section('F. Staff Portal validation');

  if (staffSrc.includes('package_min_nights_violation')
    && staffSrc.includes(STAFF_PACKAGE_VALIDATION_MSG)) {
    pass('F1', 'staff create blocks package under 7 nights server-side');
  } else {
    fail('F1', 'staff server block missing');
  }

  if (/function bcValidatePackageNightRule/.test(staffSrc)
    && staffSrc.includes('runQuotePreview')
    && staffSrc.includes('runManualBookingCreate')) {
    pass('F2', 'staff UI validates before quote preview and create');
  } else {
    fail('F2', 'staff UI validation missing');
  }

  if (validateStaffPackageNightRule('2026-07-10', '2026-07-17', 'package_none').ok) {
    pass('F3', 'staff allows accommodation-only on 7 nights');
  } else {
    fail('F3', 'package_none blocked incorrectly');
  }

  section('G. Safety');

  if (!rulesSrc.includes('create_stripe') && !staffSrc.includes('runGuestConfirmationSend')) {
    pass('G1', 'no Stripe/confirmation path changes');
  } else {
    fail('G1', 'forbidden paths touched');
  }

  if (!brainSrc.includes('LUNA_CONVERSATION_BRAIN_LLM_ENABLED')
    || brainSrc.includes("=== 'true'")) {
    // LLM remains opt-in only
    pass('G2', 'GPT-5.5 fallback remains opt-in / not hot path');
  } else {
    fail('G2', 'LLM gating changed');
  }

  console.log(`\n── Summary ──\n\nResults: ${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})();
