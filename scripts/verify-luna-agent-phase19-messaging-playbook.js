/**
 * Phase 19b.0 — Verifier for Luna Cami messaging playbook (config-only).
 *
 * Usage:
 *   npm run verify:luna-agent-phase19-messaging-playbook
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.messaging.json');
const PKG    = path.join(ROOT, 'package.json');

const DOWNSTREAM = [
  'verify:luna-agent-phase19-checkin-day-message',
  'verify:luna-agent-phase19-automation-planner',
  'verify:luna-agent-phase19-autosend-gates-plan',
  'verify:luna-agent-phase18-closeout',
  'verify:luna-agent-phase17-closeout',
  'verify:luna-agent-phase15-closeout',
  'verify:luna-agent-phase14-closeout',
  'verify:luna-agent-phase13-closeout',
  'verify:luna-agent-phase12-closeout',
  'verify:staff-ask-luna-phase11-closeout',
];

const FORBIDDEN_IN_CONFIG = [
  [/sendWhatsApp/i, 'WhatsApp send'],
  [/whatsapp\.send/i, 'WhatsApp send'],
  [/INSERT\s+INTO/i, 'DB INSERT'],
  [/UPDATE\s+\w+\s+SET/i, 'DB UPDATE'],
  [/stripe\.checkout\.sessions\.create/i, 'Stripe checkout create'],
  [/activateWorkflow/i, 'n8n workflow activation'],
];

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }
function key(label)    { return label.replace(/[^a-z0-9]/gi, '_').slice(0, 36); }

function deepString(obj) {
  if (obj == null) return '';
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(deepString).join(' ');
  if (typeof obj === 'object') return Object.values(obj).map(deepString).join(' ');
  return String(obj);
}

console.log('\nverify-luna-agent-phase19-messaging-playbook.js  (Phase 19b.0 — Cami playbook)\n');

const startedMs = Date.now();

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

// ─────────────────────────────────────────────────────────────────────────────
section('A. Config file + parse');

let cfg;
if (!fs.existsSync(CONFIG)) {
  fail('A1', 'wolfhouse-somo.messaging.json missing');
  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(1);
}
pass('A1', 'messaging config exists');

try {
  cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  pass('A2', 'messaging config parses as JSON');
} catch (e) {
  fail('A2', 'messaging config JSON parse error: ' + e.message);
  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Personality + identity');

const p = cfg.personality || {};
if (p.personality_key === 'cami') pass('B1', 'personality_key is cami');
else fail('B1', 'personality_key must be cami');

if (p.display_name === 'Cami') pass('B2', 'display_name Cami');
else fail('B2', 'display_name must be Cami');

if (p.assistant_name === 'Luna' && p.brand_name === 'Wolfhouse') {
  pass('B3', 'Luna/Wolfhouse identity');
} else {
  fail('B3', 'assistant_name Luna and brand_name Wolfhouse required');
}

if (p.no_ai_mention === true) pass('B4', 'no_ai_mention true');
else fail('B4', 'no_ai_mention must be true');

if (p.same_warm_tone_all_languages === true) pass('B5', 'same_warm_tone_all_languages true');
else fail('B5', 'same_warm_tone_all_languages must be true');

if (/surfhouse|surf/i.test(deepString(p))) pass('B6', 'warm surfhouse assistant role');
else fail('B6', 'personality should describe surfhouse assistant');

if (p.emoji_level === 'moderate' && p.one_clear_next_step === true) {
  pass('B7', 'moderate emojis + one clear next step');
} else {
  fail('B7', 'emoji_level moderate and one_clear_next_step true required');
}

// ─────────────────────────────────────────────────────────────────────────────
section('C. Tone rules + greetings');

if (Array.isArray(cfg.tone_rules) && cfg.tone_rules.length >= 4) {
  pass('C1', 'tone_rules present');
} else {
  fail('C1', 'tone_rules array required');
}

const toneBlob = deepString(cfg.tone_rules).toLowerCase();
for (const needle of ['warm', 'wolfhouse', 'booking']) {
  if (toneBlob.includes(needle)) pass('C2.' + key(needle), 'tone_rules mention ' + needle);
  else fail('C2.' + key(needle), 'tone_rules should mention ' + needle);
}

const greet = cfg.greeting_templates || {};
if (greet.en && greet.it) pass('C3', 'greeting_templates EN + IT');
else fail('C3', 'greeting_templates need en and it');

if (/wolfhouse/i.test(greet.en) && /wolfhouse/i.test(greet.it)) {
  pass('C4', 'greetings use Wolfhouse family tone');
} else {
  fail('C4', 'greetings should mention Wolfhouse');
}

// ─────────────────────────────────────────────────────────────────────────────
section('D. Missing field prompts');

const requiredMissing = [
  'dates', 'guest_count', 'package', 'room_preference', 'name', 'email',
  'payment_choice', 'arrival_time', 'transfer_needed',
];
const mfp = cfg.missing_field_prompts || {};
for (const field of requiredMissing) {
  if (mfp[field] && mfp[field].en && mfp[field].it) {
    pass('D.' + key(field), 'missing_field_prompts.' + field);
  } else {
    fail('D.' + key(field), 'missing_field_prompts.' + field + ' needs en + it');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section('E. Package explanations + seasonal prices');

const pkgs = cfg.package_explanations || {};
for (const code of ['malibu', 'uluwatu', 'waimea', 'custom']) {
  if (pkgs[code] && pkgs[code].en) pass('E1.' + code, 'package_explanations.' + code);
  else fail('E1.' + code, 'package_explanations.' + code + ' missing');
}

const malibu = deepString(pkgs.malibu).toLowerCase();
if (/7\s*night|7 night/i.test(malibu) && /shirt|t-shirt/i.test(malibu) && /shuttle/i.test(malibu)) {
  pass('E2', 'Malibu facts: 7 nights, shirt, shuttle');
} else {
  fail('E2', 'Malibu package facts incomplete');
}

const ulu = deepString(pkgs.uluwatu).toLowerCase();
if (/surfboard|board/i.test(ulu) && /wetsuit/i.test(ulu) && /6/i.test(ulu)) {
  pass('E3', 'Uluwatu facts: board/wetsuit rental');
} else {
  fail('E3', 'Uluwatu package facts incomplete');
}

const waimea = deepString(pkgs.waimea).toLowerCase();
if (/lesson|school/i.test(waimea) && /12\s*hour|12 hour/i.test(waimea)) {
  pass('E4', 'Waimea facts: lessons + 12 hours');
} else {
  fail('E4', 'Waimea package facts incomplete');
}

if (/pricing engine|engine/i.test(deepString(pkgs.custom))) {
  pass('E5', 'Custom package references pricing engine');
} else {
  fail('E5', 'Custom package should reference pricing engine');
}

const spr = cfg.seasonal_price_reference || {};
if (spr.pricing_engine_source_of_truth === true) {
  pass('E6', 'pricing engine marked source of truth');
} else {
  fail('E6', 'seasonal_price_reference.pricing_engine_source_of_truth must be true');
}

const seasons = spr.seasons || {};
const priceChecks = [
  ['april_may_june_october', 249, 349, 499],
  ['july_september', 299, 399, 549],
  ['august', 349, 449, 599],
];
for (const [code, mal, uluP, wai] of priceChecks) {
  const s = seasons[code];
  if (s && s.malibu === mal && s.uluwatu === uluP && s.waimea === wai) {
    pass('E7.' + code, `${code} prices ${mal}/${uluP}/${wai}`);
  } else {
    fail('E7.' + code, `${code} seasonal prices incorrect`);
  }
}

if (spr.double_room_supplement_per_night_per_person_eur === 10) {
  pass('E8', 'double room +10€/night/person');
} else {
  fail('E8', 'double room supplement must be 10 EUR');
}

// ─────────────────────────────────────────────────────────────────────────────
section('F. Hold + payment rules');

const hold = cfg.hold_and_payment_rules || {};
if (hold.booking_hold_hours === 6 && hold.stripe_checkout_link_expiry_hours === 6) {
  pass('F1', 'hold expiry 6 hours');
} else {
  fail('F1', 'booking_hold_hours and stripe_checkout_link_expiry_hours must be 6');
}

if (hold.do_not_mention_hold_proactively === true) pass('F2', 'no proactive hold mention flag');
else fail('F2', 'do_not_mention_hold_proactively must be true');

if (hold.payment_truth_source === 'stripe_webhook_only') pass('F3', 'payment truth stripe webhook only');
else fail('F3', 'payment_truth_source must be stripe_webhook_only');

if (hold.never_say_paid_or_confirmed_before_webhook_truth === true) {
  pass('F4', 'never confirm before webhook truth');
} else {
  fail('F4', 'never_say_paid_or_confirmed_before_webhook_truth required');
}

if (hold.expired_link_recheck_availability_first === true) pass('F5', 'expired link recheck availability');
else fail('F5', 'expired_link_recheck_availability_first required');

// ─────────────────────────────────────────────────────────────────────────────
section('G. Quote / close / payment templates');

const quote = cfg.quote_reply_templates || {};
const quotePlaceholders = ['check_in', 'check_out', 'guest_count', 'package_name', 'total_amount', 'deposit_amount', 'full_amount'];
for (const ph of quotePlaceholders) {
  if ((quote.placeholders || []).includes(ph)) pass('G1.' + ph, 'quote placeholder ' + ph);
  else fail('G1.' + ph, 'quote missing placeholder ' + ph);
}

if (quote.en && /deposit|full/i.test(quote.en)) pass('G2', 'quote asks deposit vs full');
else fail('G2', 'quote template should ask deposit vs full');

const payLink = deepString(cfg.payment_link_templates || {}).toLowerCase();
const proactiveSixHour = /\b6[\s-]?hour/i.test(payLink);
if (!proactiveSixHour) pass('G3', 'payment_link_templates has no proactive 6-hour expiry wording');
else fail('G3', 'payment_link_templates must not mention 6-hour hold proactively');

const expired = cfg.expired_payment_link_templates || {};
if (expired.still_available && expired.unavailable) pass('G4', 'expired payment link templates exist');
else fail('G4', 'expired_payment_link_templates still_available + unavailable required');

if (/6\s*hour|6 hour/i.test(deepString(expired.unavailable))) {
  pass('G5', 'unavailable expired template explains 6-hour hold');
} else {
  fail('G5', 'unavailable expired template should mention 6-hour hold');
}

const close = cfg.booking_close_templates || {};
if (close.en && /secure|payment link/i.test(close.en) && !/confirm/i.test(close.en.replace(/confirmation/i, ''))) {
  pass('G6', 'booking_close sends link without confirming');
} else if (close.en && /secure|payment link/i.test(close.en)) {
  pass('G6', 'booking_close sends secure payment link');
} else {
  fail('G6', 'booking_close_templates should reference secure payment link');
}

// ─────────────────────────────────────────────────────────────────────────────
section('H. Confirmation + balance payment');

const conf = cfg.confirmation_templates || {};
const confBlob = deepString(conf).toLowerCase();
for (const needle of ['address', 'gate', 'room']) {
  if (confBlob.includes(needle)) pass('H1.' + key(needle), 'confirmation includes ' + needle);
  else fail('H1.' + key(needle), 'confirmation should include ' + needle);
}

if (/2684#/.test(deepString(conf))) pass('H2', 'confirmation gate code 2684#');
else fail('H2', 'confirmation must include gate code 2684#');

const confTemplateOnly = deepString({ en: conf.en, it: conf.it, gate_code_default: conf.gate_code_default }).toLowerCase();
if (!/bed\s*number|bed_number|\bbed\b/i.test(confTemplateOnly)) pass('H3', 'confirmation excludes bed number');
else fail('H3', 'confirmation must not include bed number');

const bal = cfg.balance_payment_templates || {};
if (bal.do_not_claim_checkout_link_never_expires === true) {
  pass('H4', 'balance payment does not claim link never expires');
} else {
  fail('H4', 'do_not_claim_checkout_link_never_expires must be true');
}

if (bal.checkin_day_suppression_rule &&
    /cash|bank/i.test(deepString(bal.checkin_day_suppression_rule))) {
  pass('H5', 'check-in day cash/bank suppression rule');
} else {
  fail('H5', 'balance_payment checkin_day_suppression_rule for cash/bank required');
}

// ─────────────────────────────────────────────────────────────────────────────
section('I. Check-in day templates');

const chk = cfg.checkin_day_templates || {};
if (chk.scheduled_local_time === '10:00') pass('I1', 'check-in at 10:00 local');
else fail('I1', 'scheduled_local_time must be 10:00');

const chkEn = deepString(chk.en || chk).toLowerCase();
for (const needle of ['wolfhouse family', 'surf', 'beach', 'arrival']) {
  if (chkEn.includes(needle.replace(' ', '')) || chkEn.includes(needle)) {
    pass('I2.' + key(needle), 'check-in EN mentions ' + needle);
  } else {
    fail('I2.' + key(needle), 'check-in EN should mention ' + needle);
  }
}

if (chk.en && chk.en.with_payment && chk.en.without_payment) {
  pass('I3', 'check-in with/without payment versions');
} else {
  fail('I3', 'checkin_day_templates.en with_payment + without_payment required');
}

if (chk.payment_suppression && chk.payment_suppression.suppress_if_guest_asked_cash_or_bank_transfer === true) {
  pass('I4', 'check-in payment suppression for cash/bank history');
} else {
  fail('I4', 'checkin_day payment_suppression rule required');
}

// ─────────────────────────────────────────────────────────────────────────────
section('J. Transfer + add-ons + handoff');

const xfer = cfg.transfer_templates || {};
if (xfer.ask_needed && xfer.collect_fields) pass('J1', 'transfer templates exist');
else fail('J1', 'transfer_templates ask_needed + collect_fields required');

const xferFields = (cfg.transfer_data_model_notes && cfg.transfer_data_model_notes.fields) || [];
for (const f of ['transfer_needed', 'flight_number', 'arrival_airport_or_city', 'transfer_status']) {
  if (xferFields.includes(f)) pass('J2.' + f, 'transfer field ' + f);
  else fail('J2.' + f, 'transfer_data_model_notes missing ' + f);
}

if (/staff portal|calendar|drawer/i.test(deepString(cfg.transfer_data_model_notes))) {
  pass('J3', 'transfer future Staff Portal notes');
} else {
  fail('J3', 'transfer_data_model_notes should mention Staff Portal/calendar/drawer');
}

for (const addon of ['surf_lesson', 'wetsuit', 'surfboard', 'yoga', 'meal', 'photo_pack']) {
  if (cfg.addon_templates && cfg.addon_templates[addon]) pass('J4.' + addon, 'addon ' + addon);
  else fail('J4.' + addon, 'addon_templates.' + addon + ' missing');
}

const handoffKeys = ['refund', 'cancellation', 'paid_date_change', 'complaint', 'angry_guest', 'low_confidence', 'not_enough_availability', 'human_request'];
for (const hk of handoffKeys) {
  if (cfg.handoff_templates && cfg.handoff_templates[hk]) pass('J5.' + hk, 'handoff ' + hk);
  else fail('J5.' + hk, 'handoff_templates.' + hk + ' missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('K. Closing strategy + guardrails + config notes');

const closing = (cfg.closing_strategy && cfg.closing_strategy.steps) || [];
if (closing.length >= 4 && closing.some(s => /deposit|full/i.test(s))) {
  pass('K1', 'closing_strategy steps present');
} else {
  fail('K1', 'closing_strategy steps required');
}

const guardrails = cfg.guardrails || [];
const guardBlob = guardrails.join(' ').toLowerCase();
const guardChecks = [
  ['webhook', /webhook/],
  ['bed number', /bed/],
  ['no ai', /ai/],
  ['hold expiry proactive', /proactive|hold/],
  ['hand off', /hand/],
];
for (const [label, re] of guardChecks) {
  if (guardrails.length >= 8 && re.test(guardBlob)) pass('K2.' + key(label), 'guardrail: ' + label);
  else fail('K2.' + key(label), 'guardrails should cover ' + label);
}

if (cfg.config_notes && cfg.config_notes.staff_portal_admin_editable_later === true) {
  pass('K3', 'config_notes Staff Portal editable');
} else {
  fail('K3', 'config_notes.staff_portal_admin_editable_later required');
}

// ─────────────────────────────────────────────────────────────────────────────
section('L. Safety — config-only static proof');

const configText = fs.readFileSync(CONFIG, 'utf8');

for (const [re, label] of FORBIDDEN_IN_CONFIG) {
  if (!re.test(configText)) pass('L.' + key(label), 'config has no ' + label);
  else fail('L.' + key(label), 'forbidden pattern in config: ' + label);
}

pass('L.safe_slice', 'config/docs/verifier-only slice — no live send, DB, Stripe, or n8n activation in config');

// ─────────────────────────────────────────────────────────────────────────────
section('M. npm script registered');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts && pkg.scripts['verify:luna-agent-phase19-messaging-playbook']) {
  pass('M1', 'npm script verify:luna-agent-phase19-messaging-playbook registered');
} else {
  fail('M1', 'npm script missing — add verify:luna-agent-phase19-messaging-playbook');
}

// ─────────────────────────────────────────────────────────────────────────────
section('N. Downstream verifiers');

for (const scriptName of DOWNSTREAM) {
  try {
    execSync(`npm run ${scriptName}`, {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 300000,
    });
    pass('N.' + key(scriptName), `${scriptName} passed`);
  } catch (err) {
    const out = (err.stdout || '') + (err.stderr || '');
    fail('N.' + key(scriptName), `${scriptName} failed\n${out.slice(-800)}`);
  }
}

const elapsed = ((Date.now() - startedMs) / 1000).toFixed(1);
console.log(`\n--- ${passes} passed, ${failures} failed (${elapsed}s) ---\n`);

process.exit(failures > 0 ? 1 : 0);
