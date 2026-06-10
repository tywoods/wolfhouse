/**
 * Stage 30b — composer side-question coverage verifier.
 *
 * Usage:
 *   npm run verify:stage30b-composer-side-question-coverage
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });
const { withPgClient } = require('./lib/pg-connect');

const ROOT = path.join(__dirname, '..');
const COMPOSER = path.join(__dirname, 'lib', 'luna-guest-reply-composer.js');
const CONTRACT = path.join(__dirname, 'lib', 'luna-guest-reply-style-contract.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage30b-composer-side-question-coverage';

const {
  COMPOSER_STATES,
  resolveComposerState,
  buildReplyForState,
  needsPackageChoice,
  buildExplainPackagesReply,
  buildComposerServiceReply,
  buildComposerTransferReply,
} = require('./lib/luna-guest-reply-composer');
const { isForbiddenGuestCopy, isFormDevCopy } = require('./lib/luna-guest-reply-style-contract');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage30b-composer-side-question-coverage.js  (Stage 30b)\n`);

section('A. Files + package');

check('A1', fs.existsSync(COMPOSER), 'composer exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A2', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);
check('A3', fs.existsSync(path.join(FIXTURE_DIR, 'seven-night-step-by-step-package-choice.json')), 'step-by-step fixture exists');

const composerSrc = fs.readFileSync(COMPOSER, 'utf8');
const orchSrc = fs.readFileSync(ORCH, 'utf8');

section('B. Composer states');

check('B1', COMPOSER_STATES.includes('ask_package_choice'), 'ask_package_choice state');
check('B2', COMPOSER_STATES.includes('explain_service_addon'), 'explain_service_addon state');
check('B3', COMPOSER_STATES.includes('explain_transfer'), 'explain_transfer state');
check('B4', composerSrc.includes('needsPackageChoice'), 'package choice helper');
check('B5', composerSrc.includes('buildPackageExplainerReply'), 'uses package explainer facts');
check('B6', composerSrc.includes('buildServiceSideQuestionReply'), 'uses service facts');
check('B7', composerSrc.includes('buildTransferSideQuestionReply'), 'uses transfer facts');

section('C. ask_package_choice copy');

const pkgChoice = buildReplyForState('ask_package_choice', {
  lang: 'en',
  fields: { check_in: '2026-07-10', check_out: '2026-07-17', guest_count: 1 },
  quote: {}, plan: {}, pc: {}, result: {}, availability: {}, stripe: {}, facts: {},
});
check('C1', pkgChoice && /Malibu.*Uluwatu.*Waimea/is.test(pkgChoice), 'mentions all packages');
check('C2', pkgChoice && pkgChoice.includes('July 10'), 'preserves dates');
check('C3', pkgChoice && !isForbiddenGuestCopy(pkgChoice), 'no forbidden terms');
check('C4', needsPackageChoice(
  { check_in: '2026-07-10', check_out: '2026-07-17', guest_count: 1 },
  { package_night_rule: 'weekly_explain_before_choice' },
  { quote_status: 'not_ready' },
), 'weekly stay needs package choice');
check('C5', !needsPackageChoice(
  { check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1, package_interest: 'accommodation_only' },
  { package_night_rule: 'short_stay_accommodation' },
  { quote_status: 'not_ready' },
), 'short-stay accommodation skips package prompt');

section('D. Package explain return');

const explain = buildExplainPackagesReply('en', 'overview', {
  check_in: '2026-07-10', check_out: '2026-07-17', guest_count: 1,
});
check('D1', explain && explain.includes('Malibu') && explain.includes('Waimea'), 'overview names packages');
check('D2', explain && explain.includes('July 10'), 'returns to booking context');
check('D3', explain && !isFormDevCopy(explain), 'no form/dev copy');

section('E. Service + transfer side questions');

const svc = buildComposerServiceReply('en', 'wetsuit', {
  check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1,
}, { short_stay_addons_pending: true });
check('E1', svc && /wetsuit|€5/i.test(svc), 'service facts from module');
check('E2', svc && !/I am not adding/i.test(svc), 'strips action disclaimers');
check('E3', svc && /just the stay/i.test(svc), 'returns to add-ons question');

const xfer = buildComposerTransferReply('en', 'is airport transfer included?', {
  check_in: '2026-07-10', check_out: '2026-07-17', guest_count: 1, package_interest: 'malibu',
}, {});
check('E4', xfer && /transfer|Santander/i.test(xfer), 'transfer facts used');
check('E5', xfer && /hold/i.test(xfer), 'non-blocking hold prompt');
check('E6', xfer && !isForbiddenGuestCopy(xfer), 'no forbidden terms');

section('F. Safety');

check('F1', !composerSrc.includes('sendLunaBookingConfirmation'), 'no confirmation send');
check('F2', !composerSrc.match(/\bactivate.*n8n\b/i), 'no n8n activation');
check('F3', !composerSrc.includes('stripe.checkout.sessions.create'), 'no Stripe creation');
check('F4', orchSrc.includes('tryComposeBookingReply'), 'orchestrator composer-first');

section('G. Orchestrator step-by-step flow');

(async () => {
  const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
  function ctxFrom(o) {
    return {
      message_lane: o.result && o.result.message_lane,
      extracted_fields: o.result && o.result.extracted_fields,
      quote: o.quote,
      payment_choice: o.payment_choice,
      availability: o.availability,
      result: { ...(o.result || {}), proposed_luna_reply: o.proposed_luna_reply },
      contact_name: 'Marco',
      whatsapp_guest_name: 'Marco',
    };
  }
  let ctx = {};
  const turns = ['hi', 'book a stay', 'July 10-17', '1', 'Malibu', 'deposit'];
  let last = null;
  for (const message_text of turns) {
    last = await withPgClient((pg) => runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      message_text,
      guest_phone: '+491726422307',
      guest_name: 'Marco',
      contact_name: 'Marco',
      guest_context: ctx,
      reference_date: '2026-06-10',
    }, { reference_date: '2026-06-10', pg, guest_name: 'Marco', contact_name: 'Marco' }));
    ctx = ctxFrom(last);
  }
  const turn4 = await withPgClient(async (pg) => {
    let c = {};
    for (const m of ['hi', 'book a stay', 'July 10-17']) {
      const o = await runGuestAutomationOrchestratorDryRun({
        client_slug: 'wolfhouse-somo', channel: 'whatsapp', message_text: m,
        guest_phone: '+491726422307', guest_name: 'Marco', contact_name: 'Marco',
        guest_context: c, reference_date: '2026-06-10',
      }, { reference_date: '2026-06-10', pg, guest_name: 'Marco', contact_name: 'Marco' });
      c = ctxFrom(o);
    }
    return runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo', channel: 'whatsapp', message_text: '1',
      guest_phone: '+491726422307', guest_name: 'Marco', contact_name: 'Marco',
      guest_context: c, reference_date: '2026-06-10',
    }, { reference_date: '2026-06-10', pg, guest_name: 'Marco', contact_name: 'Marco' });
  });

  check('G1', turn4.result?.conversation_brain?.composer_state === 'ask_package_choice', 'turn 4 ask_package_choice');
  check('G2', turn4.result?.conversation_brain?.final_reply_source === 'luna_reply_composer', 'turn 4 composer-owned');
  check('G3', last.payment_choice?.payment_choice === 'deposit', 'deposit captured');
  check('G4', last.result?.conversation_brain?.final_reply_source === 'luna_reply_composer', 'final turn composer');

  section('H. Syntax');
  for (const f of [COMPOSER, CONTRACT, ORCH, __filename]) {
    try {
      execSync(`node --check "${f}"`, { stdio: 'pipe' });
      pass('H', `${path.basename(f)} passes node --check`);
    } catch {
      fail('H', `${path.basename(f)} syntax error`);
    }
  }

  section('Summary');
  console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
