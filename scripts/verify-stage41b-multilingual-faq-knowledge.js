/**
 * Stage 41b — Multilingual Wolfhouse FAQ knowledge verifier.
 *
 * Usage:
 *   npm run verify:stage41b-multilingual-faq-knowledge
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KNOWLEDGE_CONFIG = path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.knowledge.json');
const KNOWLEDGE_HELPER = path.join(__dirname, 'lib', 'luna-guest-knowledge-config.js');
const COMPOSER = path.join(__dirname, 'lib', 'luna-guest-reply-composer.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine');
const SCRIPT = 'verify:stage41b-multilingual-faq-knowledge';

const REQUIRED_CATEGORIES = [
  'location', 'checkin_checkout', 'packing', 'wetsuit_info', 'rentals_info',
  'lesson_times', 'yoga_info', 'meals_dinner', 'transfer_how', 'payments_info',
  'house_rules', 'board_care', 'rooms_beds', 'local_area', 'gate_code',
];

const MULTILINGUAL_CATEGORIES = [
  'location', 'towels_sheets', 'wetsuit_info', 'lesson_times', 'transfer_how',
  'payments_info', 'yoga_info', 'meals_dinner', 'gate_code', 'board_care',
];

const MULTILINGUAL_FIXTURES = [
  'faq-it-towels-sheets.json',
  'faq-it-wetsuit.json',
  'faq-it-lesson-times.json',
  'faq-es-payment-cash.json',
  'faq-es-transfer.json',
  'faq-es-packing.json',
  'faq-de-towels-sheets.json',
  'faq-de-lesson-times.json',
  'faq-de-payment-cash.json',
  'faq-mid-booking-it-wetsuit-preserves-context.json',
  'faq-mid-booking-es-transfer-preserves-context.json',
  'faq-private-gate-code-multilingual.json',
];

const LANGS = ['en', 'it', 'es', 'de'];

const {
  loadKnowledgeConfig,
  detectGuestKnowledgeIntent,
  buildGuestKnowledgeReply,
  shouldPrioritizeKnowledgeOverService,
  listKnowledgeCategories,
  categoryHasMultilingualTemplates,
  resolveKnowledgeLanguage,
} = require('./lib/luna-guest-knowledge-config');
const { composeLunaGuestReply } = require('./lib/luna-guest-reply-composer');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage41b-multilingual-faq-knowledge.js  (Stage 41b)\n');

section('A. Expanded config');
check('A1', fs.existsSync(KNOWLEDGE_CONFIG), 'knowledge config exists');
check('A2', fs.existsSync(KNOWLEDGE_HELPER), 'knowledge helper exists');
const config = loadKnowledgeConfig('wolfhouse-somo');
const cats = listKnowledgeCategories('wolfhouse-somo');
for (const id of REQUIRED_CATEGORIES) {
  check(`A-${id}`, cats.includes(id), `category ${id}`);
}

section('B. Multilingual templates');
for (const id of MULTILINGUAL_CATEGORIES) {
  if (id === 'yoga_info' || id === 'meals_dinner') {
    check(`B-${id}`, categoryHasMultilingualTemplates(id, LANGS), `${id} EN/IT/ES/DE templates`);
  } else {
    check(`B-${id}`, categoryHasMultilingualTemplates(id, LANGS), `${id} EN/IT/ES/DE templates`);
  }
}
const towelsCat = config.categories.find((c) => c.id === 'towels_sheets');
check('B-towels-it', towelsCat && towelsCat.templates.it.includes('asciugamani'), 'IT towels fact');

section('C. Multilingual intent routing');
const routingCases = [
  ['devo portare asciugamani?', 'towels_sheets'],
  ['le lenzuola sono incluse?', 'towels_sheets'],
  ['serve la muta?', 'wetsuit_info'],
  ['a che ora sono le lezioni?', 'lesson_times'],
  ['posso pagare in contanti?', 'payments_info'],
  ['puedo pagar en efectivo?', 'payments_info'],
  ['necesito toallas?', 'towels_sheets'],
  ['Brauche ich ein Handtuch?', 'towels_sheets'],
  ['Kann ich bar bezahlen?', 'payments_info'],
  ['Wann sind die Surfkurse?', 'lesson_times'],
  ['Qual è il codice del cancello?', 'gate_code'],
];
for (const [msg, exp] of routingCases) {
  check(`C-${exp}-${msg.slice(0, 12)}`, detectGuestKnowledgeIntent(msg) === exp, `"${msg.slice(0, 30)}" → ${exp}`);
}

section('D. Private gate code guardrails');
for (const lang of LANGS) {
  const gate = buildGuestKnowledgeReply({
    client_slug: 'wolfhouse-somo',
    category_id: 'gate_code',
    lang,
    guest_context: {},
  });
  check(`D-gate-${lang}`, gate.reply && !/2684/.test(gate.reply), `${lang} gate reply hides 2684#`);
}
check('D-bed', !/\bbed\s*(?:number|#)\s*\d/i.test(JSON.stringify(config.categories.map((c) => c.templates))), 'no bed numbers in guest templates');

section('E. Mid-booking context preservation');
const midTowels = buildGuestKnowledgeReply({
  client_slug: 'wolfhouse-somo',
  category_id: 'towels_sheets',
  lang: 'it',
  message_text: 'devo portare asciugamani?',
  fields: { check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 2 },
  quote: { quote_status: 'ready', payment_choice_needed: false, short_stay_addons_pending: true },
  guest_context: { check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 2 },
});
check('E1', midTowels.reply && /muta|tavola|soggiorno/i.test(midTowels.reply), 'IT mid-booking FAQ tail preserves flow');

section('F. Composer + fixtures');
for (const f of MULTILINGUAL_FIXTURES) {
  check(`F-${f}`, fs.existsSync(path.join(FIXTURE_DIR, f)), `${f} exists`);
}
const composerSrc = fs.readFileSync(COMPOSER, 'utf8');
check('F-composer', composerSrc.includes('explain_house_knowledge'), 'composer FAQ state');

section('G. Payment FAQ without active quote');
check('G1', shouldPrioritizeKnowledgeOverService('puedo pagar en efectivo?', 'payments_info', {}), 'ES cash FAQ without quote');
const payReply = buildGuestKnowledgeReply({
  message_text: 'puedo pagar en efectivo?',
  guest_context: {},
});
check('G2', payReply.reply && /efectivo/i.test(payReply.reply), 'ES cash grounded answer');

section('H. Safety');
const helperSrc = fs.readFileSync(KNOWLEDGE_HELPER, 'utf8');
const orchSrc = fs.readFileSync(ORCH, 'utf8');
check('H1', !helperSrc.includes('stormglass') && !helperSrc.includes('vector'), 'no surf API / vector');
check('H2', !helperSrc.includes('scraper') && !helperSrc.includes('cheerio'), 'no website scraper');
check('H3', !orchSrc.includes('sendWhatsApp'), 'no WhatsApp send');
check('H4', !orchSrc.includes('stripe.checkout.sessions.create'), 'no Stripe path');
check('H5', !orchSrc.includes('runGuestConfirmationSend'), 'no confirmation send');
check('H6', !orchSrc.includes('n8n.activate'), 'no n8n activation');
check('H7', !orchSrc.includes('deployToProduction'), 'no production changes');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('H8', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

console.log(`\n${'─'.repeat(60)}`);
console.log(`Stage 41b verifier: ${failures === 0 ? 'PASS' : 'FAIL'} (${passes} passed, ${failures} failed)\n`);
process.exit(failures === 0 ? 0 : 1);
