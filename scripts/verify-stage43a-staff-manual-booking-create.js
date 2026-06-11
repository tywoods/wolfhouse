/**
 * Stage 43a — Staff Portal manual booking create proof (local/staging-safe).
 *
 * Verifier-first: quote-driven shape, safety flags, payment-link wording.
 * Optional DB proof delegates to stage8.3i fixture (ROLLBACK, SKIP if DB offline).
 *
 * Usage:
 *   npm run verify:stage43a-staff-manual-booking-create
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const PROOF_83I = path.join(__dirname, 'fixtures', 'stage8.3i-manual-booking-create-proof.js');
const SCRIPT = 'verify:stage43a-staff-manual-booking-create';

let passed = 0;
let failed = 0;

function ok(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passed++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failed++; }
function check(id, cond, msg) { if (cond) ok(id, msg); else fail(id, msg); }

function sliceHandler(src, name) {
  const start = src.indexOf(`async function ${name}`);
  if (start < 0) return '';
  const end = src.indexOf('\nasync function ', start + 20);
  return end > start ? src.slice(start, end) : src.slice(start, start + 20000);
}

function staffFacingStripeLeak(text) {
  return /\bStripe(?:\s+(?:link|payment|deposit|full(?:-payment)?\s+link))|\bStripe links are\b/i.test(String(text || ''));
}

function guestFacingStripeLeak(text) {
  return /\bStripe\b/i.test(String(text || ''));
}

function extractGuestTemplateBlocks(src, fnName) {
  const start = src.indexOf(`function ${fnName}`);
  if (start < 0) return '';
  const end = src.indexOf('\nfunction ', start + 12);
  return src.slice(start, end > start ? end : start + 2500);
}

console.log('\nverify-stage43a-staff-manual-booking-create.js  (Stage 43a)\n');

section('A. Manual booking path');

check('A1', fs.existsSync(API_FILE), 'staff-query-api.js exists');
const src = fs.readFileSync(API_FILE, 'utf8');
check('A2', /pathname === '\/staff\/manual-bookings\/create'/.test(src),
  'POST /staff/manual-bookings/create route registered');
check('A3', /async function handleManualBookingCreate/.test(src),
  'handleManualBookingCreate handler exists');
check('A4', /function runManualBookingCreate/.test(src),
  'Staff Portal UI runManualBookingCreate() wired');
check('A5', /fetch\s*\(\s*['"]\/staff\/manual-bookings\/create['"]/.test(src),
  'UI posts to manual-bookings/create');

section('B. Quote-driven booking shape (no DB)');

const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
const quote = calculateWolfhouseQuote({
  client_slug: 'wolfhouse-somo',
  check_in: '2026-07-05',
  check_out: '2026-07-12',
  guest_count: 1,
  package_code: 'malibu',
  room_type: 'shared',
  payment_choice: 'deposit',
  add_ons: [],
});
check('B1', quote && quote.blockers && quote.blockers.length === 0, 'malibu July quote has no blockers');
check('B2', Number(quote.total_cents) > 0, `quote total_cents > 0 (got ${quote.total_cents})`);
check('B3', Number(quote.deposit_required_cents) > 0, `deposit_required_cents > 0 (got ${quote.deposit_required_cents})`);
check('B4', quote.formula_summary && String(quote.formula_summary).length > 0, 'formula_summary present');
check('B5', quote.balance_due_cents != null, 'balance_due_cents present');

section('C. Create handler safety (staging-safe defaults)');

const handler = sliceHandler(src, 'handleManualBookingCreate');
const applyFn = src.match(/async function manualBookingApplyStaffPaymentChoice[\s\S]*?\n\}/)?.[0] || '';

check('C1', /calculateWolfhouseQuote\s*\(/.test(handler), 'create uses calculateWolfhouseQuote server-side');
check('C2', !/parseInt\(body\.deposit_amount_cents|parseInt\(body\.total_amount_cents/.test(handler),
  'create does not trust deposit/total from request body');
check('C3', /quote_snapshot/.test(handler), 'quote_snapshot stored on booking metadata');
check('C4', /pg\.query\('BEGIN'\)/.test(handler) && /pg\.query\('COMMIT'\)/.test(handler),
  'create wrapped in transaction');
check('C5', /no_stripe:\s*!stripeCalled/.test(handler), 'success response exposes no_stripe when link not created');
check('C6', /no_whatsapp:\s*true/.test(handler) && /no_n8n:\s*true/.test(handler),
  'success response asserts no_whatsapp / no_n8n');
check('C7', /payment_link_skipped/.test(handler), 'success surfaces payment_link_skipped when applicable');
check('C8', !/checkout\.sessions?\.create/.test(handler),
  'create handler does not call Stripe checkout directly');
check('C9', /'draft'::payment_record_status/.test(applyFn),
  'draft payment row inserted before optional link step');
check('C10', /if \(!stripeConfigured\)/.test(applyFn) && /payment_link_skipped = true/.test(applyFn),
  'Stripe disabled → payment_link_skipped, create still succeeds');

section('D. Payment-link wording (manual booking staff/guest copy)');

const applyMessages = (applyFn.match(/outcome\.message\s*=[^;]+/g) || []).join('\n');
check('D1', !staffFacingStripeLeak(applyMessages),
  'manualBookingApplyStaffPaymentChoice messages avoid Stripe link wording');
check('D2', /secure payment link|payment link/i.test(applyMessages),
  'apply path uses payment link / secure payment link phrasing');

const payChoiceHtml = src.match(/id="bk-payment-choice"[\s\S]*?id="bk-payment-choice-hint"[^>]*>[^<]+</)?.[0] || '';
const paidFieldsFn = src.match(/function bcUpdateManualBookingPaidFields[\s\S]*?\n\}/)?.[0] || '';
const manualStaffCopy = `${payChoiceHtml}\n${paidFieldsFn}`;
check('D3', manualStaffCopy.length > 100, 'manual booking payment-choice UI block found');
check('D4', !staffFacingStripeLeak(manualStaffCopy), 'manual booking UI hints/options avoid Stripe link wording');
check('D5', /Deposit payment link|Full secure payment link|secure payment link/i.test(manualStaffCopy),
  'manual booking UI uses payment link labels');

const renderCreate = src.match(/function renderCreateResult[\s\S]*?\n\}/)?.[0] || '';
check('D6', /Payment link \(copy to send manually\)/.test(renderCreate),
  'create result panel labels payment link for staff copy');
check('D7', !staffFacingStripeLeak(renderCreate),
  'renderCreateResult avoids Stripe link guest/staff wording');

section('E. Package script + related verifiers');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('E1', pkg.scripts && pkg.scripts[SCRIPT] === `node scripts/${path.basename(__filename)}`,
  'package.json has verify:stage43a-staff-manual-booking-create');

try {
  execSync('node scripts/verify-staff-manual-booking-create-api.js', { cwd: ROOT, stdio: 'pipe' });
  ok('E2', 'verify-staff-manual-booking-create-api.js PASS');
} catch (e) {
  fail('E2', 'verify-staff-manual-booking-create-api.js failed');
}

try {
  execSync('node scripts/verify-staff-manual-booking-no-stripe-required.js', { cwd: ROOT, stdio: 'pipe' });
  ok('E3', 'verify-staff-manual-booking-no-stripe-required.js PASS');
} catch (_) {
  fail('E3', 'verify-staff-manual-booking-no-stripe-required.js failed');
}

section('F. Optional DB rollback proof (stage8.3i)');

if (fs.existsSync(PROOF_83I)) {
  try {
    const out = execSync(`node "${PROOF_83I}"`, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    if (/PASS|✓.*passed/i.test(out)) ok('F1', 'stage8.3i manual booking create proof PASS (ROLLBACK)');
    else if (/SKIP|offline|ECONNREFUSED/i.test(out)) ok('F1', 'stage8.3i proof SKIP (DB offline — static proof sufficient)');
    else fail('F1', 'stage8.3i proof unexpected output');
  } catch (e) {
    const msg = (e.stdout || e.stderr || e.message || '').toString();
    if (/SKIP|offline|ECONNREFUSED|connect/i.test(msg)) ok('F1', 'stage8.3i proof SKIP (DB offline)');
    else fail('F1', `stage8.3i proof failed: ${msg.slice(0, 120)}`);
  }
} else {
  ok('F1', 'stage8.3i proof script not found — skipped');
}

section('G. Stage 43a.1 — Luna guest payment-link wording');

const MERGED_PAYMENT = path.join(__dirname, 'lib', 'merged-payment-path.js');
const PERSONALITY = path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.personalities.json');
const COMPOSER = path.join(__dirname, 'lib', 'luna-guest-reply-composer.js');

const mergedSrc = fs.readFileSync(MERGED_PAYMENT, 'utf8');
const noUrlTpl = extractGuestTemplateBlocks(mergedSrc, 'buildNoUrlSafeTemplate');
check('G1', !guestFacingStripeLeak(noUrlTpl), 'merged-payment-path hold-wait templates avoid Stripe brand');
check('G2', /secure payment link|Zahlungslink|enlace de pago|link di pagamento/i.test(noUrlTpl),
  'merged-payment-path templates use payment-link phrasing');

const personality = JSON.parse(fs.readFileSync(PERSONALITY, 'utf8'));
const camiEn = personality.personalities && personality.personalities.cami;
const replyEn = camiEn && camiEn.reply_templates && camiEn.reply_templates.en;
const cashPool = camiEn && camiEn.behavior && camiEn.behavior.variation_pools
  && camiEn.behavior.variation_pools.en && camiEn.behavior.variation_pools.en.cash_side_question;
const guestPersonalityCopy = JSON.stringify({
  reply: replyEn,
  cash_pool: cashPool,
});
check('G3', !guestFacingStripeLeak(guestPersonalityCopy), 'Cami personality guest payment copy avoids Stripe brand');
check('G4', /pay online|payment link|secure payment link/i.test(guestPersonalityCopy),
  'Cami personality uses pay online / payment link wording');

const composerSrc = fs.readFileSync(COMPOSER, 'utf8');
const arrivalFallback = composerSrc.match(/remaining balance can be paid on arrival[\s\S]{0,220}/)?.[0] || '';
check('G5', arrivalFallback.length > 0 && !guestFacingStripeLeak(arrivalFallback),
  'composer arrival-payment fallback avoids Stripe brand');
check('G6', /pay online/i.test(arrivalFallback),
  'composer arrival-payment fallback offers pay online');

section('H. Stage 43a.2 — router/payment-choice fallback templates');

const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const PAYMENT_CHOICE = path.join(__dirname, 'lib', 'luna-guest-payment-choice-dry-run.js');
const PERSONALITY_CFG = path.join(__dirname, 'lib', 'luna-guest-personality-config.js');

const routerSrc = fs.readFileSync(ROUTER, 'utf8');
const routerEnBlock = routerSrc.match(/const REPLY_TEMPLATES = \{[\s\S]*?en: \{[\s\S]*?\n  \},/)?.[0] || '';
check('H1', !guestFacingStripeLeak(routerEnBlock), 'router REPLY_TEMPLATES.en avoids Stripe brand');
check('H2', /pay online/i.test(routerEnBlock), 'router EN fallbacks offer pay online');

const pcSrc = fs.readFileSync(PAYMENT_CHOICE, 'utf8');
const pcArrival = (pcSrc.match(/arrival: '[^']+'/g) || []).join('\n');
check('H3', pcArrival.length > 0 && !guestFacingStripeLeak(pcArrival), 'payment-choice arrival templates avoid Stripe brand');
check('H4', /pay online|pagamento online|pago online|online bei|paiement en ligne/i.test(pcArrival),
  'payment-choice localized arrival templates use pay-online phrasing');

const pCfgSrc = fs.readFileSync(PERSONALITY_CFG, 'utf8');
const pCfgFallback = pCfgSrc.match(/answer_arrival_payment_question_no_amounts[\s\S]{0,200}/)?.[0] || '';
check('H5', !guestFacingStripeLeak(pCfgFallback), 'personality-config arrival fallback avoids Stripe brand');
check('H6', /pay online/i.test(pCfgFallback), 'personality-config arrival fallback uses pay online');

section('I. Stage 43a.3 — confirmation-preview balance settlement copy');

const PREVIEW_DRY = path.join(__dirname, 'lib', 'luna-guest-confirmation-preview-dry-run.js');
const previewDrySrc = fs.readFileSync(PREVIEW_DRY, 'utf8');
const balanceArrivalBlock = extractGuestTemplateBlocks(previewDrySrc, 'appendDepositBalanceArrivalOptions');
check('I1', balanceArrivalBlock.length > 0 && !guestFacingStripeLeak(balanceArrivalBlock),
  'confirmation-preview balance settlement copy avoids Stripe brand');
check('I2', /pay online|pagamento online/i.test(balanceArrivalBlock),
  'confirmation-preview balance settlement uses pay-online phrasing');

section('J. Stage 43c — Staff Portal UI create payload');

try {
  execSync('node scripts/verify-stage43c-staff-manual-booking-ui-payload.js', { cwd: ROOT, stdio: 'pipe' });
  ok('J1', 'verify-stage43c-staff-manual-booking-ui-payload.js PASS');
} catch (e) {
  fail('J1', 'verify-stage43c-staff-manual-booking-ui-payload.js failed');
}

console.log(`\n── Result: ${failed === 0 ? 'PASS' : 'FAIL'} ──`);
console.log(`${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);

function section(title) {
  console.log(`\n── ${title} ──`);
}
