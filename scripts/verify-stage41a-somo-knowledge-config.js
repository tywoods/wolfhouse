/**
 * Stage 41a — Somo/Wolfhouse knowledge config verifier.
 *
 * Usage:
 *   npm run verify:stage41a-somo-knowledge-config
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KNOWLEDGE_CONFIG = path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.knowledge.json');
const KNOWLEDGE_HELPER = path.join(__dirname, 'lib', 'luna-guest-knowledge-config.js');
const COMPOSER = path.join(__dirname, 'lib', 'luna-guest-reply-composer.js');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage41a-somo-knowledge-config';
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine');

const REQUIRED_CATEGORIES = [
  'location', 'towels_sheets', 'wetsuit_info', 'lesson_times', 'transfer_how',
  'payments_info', 'board_care', 'gate_code', 'packing', 'house_rules',
  'yoga_meals_info', 'checkin_checkout', 'rentals_info',
];

const REQUIRED_FIXTURES = [
  'faq-location-public.json',
  'faq-towels-sheets.json',
  'faq-wetsuit.json',
  'faq-lesson-times.json',
  'faq-transfer-how-it-works.json',
  'faq-gate-code-private.json',
  'faq-mid-booking-preserves-context.json',
  'faq-board-care.json',
];

const {
  loadKnowledgeConfig,
  detectGuestKnowledgeIntent,
  buildGuestKnowledgeReply,
  canRevealPrivateBookingDetails,
  listKnowledgeCategories,
  knowledgeConfigHasMapsLink,
} = require('./lib/luna-guest-knowledge-config');
const { composeLunaGuestReply } = require('./lib/luna-guest-reply-composer');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage41a-somo-knowledge-config.js  (Stage 41a)\n');

section('A. Config + helper files');
check('A1', fs.existsSync(KNOWLEDGE_CONFIG), 'knowledge config exists');
check('A2', fs.existsSync(KNOWLEDGE_HELPER), 'knowledge helper exists');
const composerSrc = fs.readFileSync(COMPOSER, 'utf8');
const routerSrc = fs.readFileSync(ROUTER, 'utf8');
check('A3', composerSrc.includes('explain_house_knowledge'), 'composer FAQ state wired');
check('A4', routerSrc.includes('luna-guest-knowledge-config'), 'router knowledge detection wired');

section('B. Categories + facts');
const config = loadKnowledgeConfig('wolfhouse-somo');
const cats = listKnowledgeCategories('wolfhouse-somo');
for (const id of REQUIRED_CATEGORIES) {
  check(`B-${id}`, cats.includes(id), `category ${id}`);
}
check('B-maps', knowledgeConfigHasMapsLink('wolfhouse-somo'), 'maps link in config');
check('B-towels', JSON.stringify(config).includes('not towels') || JSON.stringify(config).includes('not provided'), 'towels fact');
check('B-wetsuit', JSON.stringify(config).includes('4/3'), 'wetsuit thickness fact');
check('B-lessons', JSON.stringify(config).includes('08:30'), 'lesson schedule fact');
check('B-transfer', JSON.stringify(config).includes('flight number'), 'transfer fact');
check('B-board', JSON.stringify(config).includes('rinse'), 'board care fact');
check('B-gate-private', (config.private_fields || []).includes('gate_code'), 'gate_code marked private');

section('C. Intent + privacy guardrails');
check('C1', detectGuestKnowledgeIntent('Where is Wolfhouse?') === 'location', 'location intent');
check('C2', detectGuestKnowledgeIntent('Do I need to bring towels?') === 'towels_sheets', 'towels intent');
check('C3', detectGuestKnowledgeIntent('What is the gate code?') === 'gate_code', 'gate code intent');

const gatePublic = buildGuestKnowledgeReply({
  client_slug: 'wolfhouse-somo',
  category_id: 'gate_code',
  lang: 'en',
  guest_context: {},
});
check('C4', gatePublic.reply && !/2684/.test(gatePublic.reply), 'public FAQ does not reveal gate code');
check('C5', !canRevealPrivateBookingDetails({}), 'private details blocked without booking context');

section('D. Composer FAQ without booking mutation');
const composed = composeLunaGuestReply({
  client_slug: 'wolfhouse-somo',
  message_text: 'Where is Wolfhouse?',
  prior_guest_context: {},
  payload: {
    result: { message_lane: 'general_question', detected_language: 'en' },
    quote: {},
    payment_choice: {},
    availability: {},
    gate: { gate_status: 'allowed_dry_run' },
  },
});
check('D1', composed.covered && composed.composer_state === 'explain_house_knowledge', 'composer answers location FAQ');
check('D2', composed.reply && composed.reply.includes('maps.app.goo.gl'), 'composer includes maps link');

const midFaq = buildGuestKnowledgeReply({
  client_slug: 'wolfhouse-somo',
  category_id: 'towels_sheets',
  lang: 'en',
  fields: { check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1 },
  quote: { quote_status: 'ready', payment_choice_needed: true },
  payment_choice: { payment_choice_needed: true },
  guest_context: { check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1 },
});
check('D3', midFaq.reply && /towel/i.test(midFaq.reply), 'mid-booking towels answer');
check('D4', midFaq.reply && /deposit|booking|stay/i.test(midFaq.reply), 'mid-booking FAQ preserves flow tail');

section('E. Cami tone + personality');
check('E1', composed.reply && /🌊|😊/.test(composed.reply), 'warm Cami-style emoji tone');

section('F. Fixtures + package');
for (const f of REQUIRED_FIXTURES) {
  check(`F-${f}`, fs.existsSync(path.join(FIXTURE_DIR, f)), `${f} exists`);
}
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('F9', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

section('G. Safety — not included / no live paths');
const helperSrc = fs.readFileSync(KNOWLEDGE_HELPER, 'utf8');
const orchSrc = fs.readFileSync(ORCH, 'utf8');
check('G1', !helperSrc.includes('stormglass') && !helperSrc.includes('surf report'), 'no surf API');
check('G2', !helperSrc.includes('vector') && !helperSrc.includes('scraper'), 'no vector/scraper');
check('G3', !orchSrc.includes('sendWhatsApp') && !orchSrc.includes('whatsapp.send'), 'no WhatsApp send');
check('G4', !orchSrc.includes('stripe.checkout.sessions.create'), 'no Stripe path');
check('G5', !orchSrc.includes('runGuestConfirmationSend') && !orchSrc.includes('sendConfirmationMessage'), 'no confirmation send');
check('G6', !orchSrc.includes('n8n.activate'), 'no n8n activation');
check('G7', !orchSrc.includes('deployToProduction'), 'no production changes');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Stage 41a verifier: ${failures === 0 ? 'PASS' : 'FAIL'} (${passes} passed, ${failures} failed)\n`);
process.exit(failures === 0 ? 0 : 1);
