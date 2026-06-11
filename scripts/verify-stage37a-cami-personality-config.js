/**
 * Stage 37a — Cami attachable personality config verifier.
 *
 * Usage:
 *   npm run verify:stage37a-cami-personality-config
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PERSONALITY_CONFIG = path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.personalities.json');
const PERSONALITY_LOADER = path.join(__dirname, 'lib', 'luna-guest-personality-config.js');
const COMPOSER = path.join(__dirname, 'lib', 'luna-guest-reply-composer.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const FIXTURE = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine', 'cami-personality-basic-copy.json');
const PKG_FILE = path.join(ROOT, 'package.json');
const ROADMAP = path.join(ROOT, 'docs', 'ROADMAP.md');
const PROJECT_STATE = path.join(ROOT, 'docs', 'PROJECT-STATE.md');
const SCRIPT = 'verify:stage37a-cami-personality-config';

const {
  loadClientPersonalityFile,
  resolveActivePersonality,
  buildPersonalityReplyLexicon,
  buildPersonalityResetReply,
  personalityAffectsCopyOnlySummary,
  configPathForClient,
} = require('./lib/luna-guest-personality-config');
const {
  composeLunaGuestReply,
  buildReplyForState,
} = require('./lib/luna-guest-reply-composer');
const {
  validateComposerFacts,
  isForbiddenGuestCopy,
} = require('./lib/luna-guest-reply-style-contract');
const { buildNewBookingResetReply } = require('./lib/luna-guest-message-router');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage37a-cami-personality-config.js  (Stage 37a)\n`);

section('A. Files + package');

check('A1', fs.existsSync(PERSONALITY_CONFIG), 'personality config exists');
check('A2', fs.existsSync(PERSONALITY_LOADER), 'personality loader exists');
check('A3', fs.existsSync(FIXTURE), 'cami-personality-basic-copy fixture exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A4', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

const composerSrc = fs.readFileSync(COMPOSER, 'utf8');
const orchSrc = fs.readFileSync(ORCH, 'utf8');
const routerSrc = fs.readFileSync(ROUTER, 'utf8');

section('B. Config structure');

const file = loadClientPersonalityFile('wolfhouse-somo');
check('B1', file && file.assistant_name === 'Luna', 'assistant_name remains Luna');
check('B2', file && file.active_personality === 'cami', 'active_personality is cami');
check('B3', file && file.personalities && file.personalities.cami, 'Cami personality exists');
check('B4', file && file.personalities.cami.personality_id === 'cami', 'personality_id cami');
check('B5', file && file.source_client === 'wolfhouse-somo', 'source_client wolfhouse-somo');

const cami = file && file.personalities && file.personalities.cami;
const langs = cami && cami.language_styles;
check('B6', langs && langs.en && langs.it && langs.es && langs.de, 'language_styles en/it/es/de');
check('B7', cami && Array.isArray(cami.tone_rules) && cami.tone_rules.length > 0, 'tone_rules exist');
check('B8', cami && cami.emoji_rules && cami.emoji_rules.level, 'emoji_rules exist');
check('B9', cami && Array.isArray(cami.repetition_rules) && cami.repetition_rules.length > 0, 'repetition_rules exist');
check('B10', cami && Array.isArray(cami.banned_phrases) && cami.banned_phrases.length > 0, 'banned_phrases exist');
check('B11', cami && cami.sample_replies && cami.sample_replies.welcome, 'welcome sample exists');
check('B12', cami && Array.isArray(cami.confirmation_style_rules)
  && cami.confirmation_style_rules.some((r) => /Wolfhouse/i.test(r)), 'confirmation rules mention Wolfhouse family');

section('C. Selection + wiring');

const resolved = resolveActivePersonality('wolfhouse-somo');
check('C1', resolved.active_personality_id === 'cami', 'wolfhouse-somo defaults to Cami');
check('C2', composerSrc.includes('luna-guest-personality-config'), 'composer imports personality loader');
check('C3', composerSrc.includes('buildPersonalityReplyLexicon'), 'composer uses personality lexicon');
check('C4', orchSrc.includes('client_slug'), 'orchestrator passes client_slug to composer');
check('C5', routerSrc.includes('buildPersonalityResetReply'), 'reset reply uses personality config');

const lex = buildPersonalityReplyLexicon('wolfhouse-somo', 'en');
check('C6', lex && lex.personality_id === 'cami', 'Cami lexicon selectable for wolfhouse-somo');
check('C7', resolveActivePersonality('unknown-client-xyz').personality === null, 'unknown client falls back safely');
check('C8', !buildPersonalityReplyLexicon(null, 'en'), 'no client_slug → no personality lexicon');

section('D. Copy only — facts remain code-owned');

check('D1', personalityAffectsCopyOnlySummary().includes('code-owned'), 'copy-only contract documented');
const noQuote = validateComposerFacts('ask_payment_choice', {});
check('D2', noQuote.includes('quote_or_deposit_cents_required'), 'payment choice still requires quote facts');
const noLink = validateComposerFacts('stripe_test_link_created', {
  quote_total_cents: 18000,
  deposit_amount_cents: 10000,
});
check('D3', noLink.includes('payment_link_url_required'), 'stripe link still requires URL fact');

const camiQuote = buildReplyForState('accommodation_quote_ready', {
  lang: 'en',
  client_slug: 'wolfhouse-somo',
  fields: { check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1 },
  quote: { quote_status: 'ready', quote_total_cents: 18000 },
  availability: { availability_status: 'available' },
  plan: {}, pc: {}, result: {}, stripe: {},
  facts: { quote_total_cents: 18000 },
});
check('D4', camiQuote && camiQuote.includes('€180'), 'Cami quote still includes engine €180');
check('D5', camiQuote && /good news|Yesss/i.test(camiQuote), 'Cami quote sounds warmer');
check('D6', camiQuote && !camiQuote.includes('July 1'), 'Cami quote avoids repeating dates');

section('E. Future roadmap notes — not implemented');

check('E1', file && file.future_roadmap && file.future_roadmap.owner_chat_upload_personality, 'owner upload roadmap note');
check('E2', file && file.future_roadmap.short_payment_links, 'short payment link roadmap note');
check('E3', file && file.future_roadmap.client_facing_surf_report, 'surf report roadmap note');
check('E4', file && file.future_roadmap.addon_service_payment_ledger, 'add-on ledger roadmap note');

const loaderSrc = fs.readFileSync(PERSONALITY_LOADER, 'utf8');
check('E5', !loaderSrc.match(/upload.*chat|generatePersonalityFromChats/i), 'no owner-chat upload feature');
check('E6', composerSrc.includes('luna-payment-short-link'), 'short payment link helper wired in composer');

section('F. Safety — no new send/deploy paths');

check('F1', !composerSrc.includes('sendWhatsApp') && !composerSrc.includes('graph.facebook.com'), 'composer no WhatsApp send');
check('F2', !composerSrc.includes('stripe.checkout.sessions.create'), 'composer no Stripe create');
check('F3', !composerSrc.includes('sendLunaBookingConfirmation'), 'composer no confirmation send');
check('F4', !composerSrc.match(/\bn8n\.(activate|trigger)/i), 'composer no n8n activation');
check('F5', !orchSrc.includes('production') || orchSrc.includes('dry_run'), 'orchestrator remains dry-run oriented');

section('G. Roadmap docs');

if (fs.existsSync(ROADMAP)) {
  const roadmap = fs.readFileSync(ROADMAP, 'utf8');
  check('G1', /Stage 37.*personality|37a.*Cami/i.test(roadmap), 'ROADMAP mentions Stage 37 personality');
  check('G2', /Stage 38|welcome.*confirmation/i.test(roadmap), 'ROADMAP mentions Stage 38');
  check('G3', /Stage 40|stress/i.test(roadmap), 'ROADMAP mentions stress testing stage');
} else {
  fail('G1', 'ROADMAP.md missing');
}

if (fs.existsSync(PROJECT_STATE)) {
  const ps = fs.readFileSync(PROJECT_STATE, 'utf8');
  check('G4', /Stage 37|Cami personality/i.test(ps), 'PROJECT-STATE mentions Stage 37');
} else {
  fail('G4', 'PROJECT-STATE.md missing');
}

section('H. Reset + welcome samples');

const reset = buildNewBookingResetReply('en', 'wolfhouse-somo');
check('H1', reset && /start fresh|ricominciamo/i.test(reset), 'Cami reset copy');
check('H2', reset && !isForbiddenGuestCopy(reset), 'reset has no forbidden terms');

const greeting = composeLunaGuestReply({
  client_slug: 'wolfhouse-somo',
  message_text: 'hi',
  payload: {
    gate: { gate_status: 'allowed_dry_run' },
    result: { greeting_only: true, message_lane: 'new_booking_inquiry', detected_language: 'en' },
    quote: {},
    availability: {},
    payment_choice: {},
  },
  allow_leading_intro: true,
});
check('H3', greeting && greeting.covered && greeting.personality_id === 'cami', 'greeting uses Cami personality');
check('H4', greeting && greeting.reply && /So happy|Heyyy/i.test(greeting.reply), 'welcome sounds warm');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
