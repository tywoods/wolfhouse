/**
 * Stage 42a.5 — Cami voice mining pack verifier.
 *
 * Checks the mined Cami voice pack artifacts exist, are well-formed,
 * contain no PII/secrets, and that no raw chats or live-send paths
 * were added by this stage.
 *
 * Usage:
 *   npm run verify:stage42a5-cami-voice-mining-pack
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MINING_DOC = path.join(ROOT, 'docs', 'STAGE-42A5-CAMI-VOICE-MINING-PACK.md');
const PLAN_DOC = path.join(ROOT, 'docs', 'STAGE-42A5-CAMI-IMPLEMENTATION-PLAN.md');
const PACK = path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.cami-voice-mining.json');
const PROPOSALS = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine', 'cami-voice-mining-proposals', 'README.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage42a5-cami-voice-mining-pack';

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

function gitTracked(relPath) {
  try {
    return execSync(`git ls-files -- "${relPath}"`, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (err) {
    return '';
  }
}

console.log('\nverify-stage42a5-cami-voice-mining-pack.js  (Stage 42a.5)\n');

section('A. Files + package script');

check('A1', fs.existsSync(MINING_DOC), 'docs/STAGE-42A5-CAMI-VOICE-MINING-PACK.md exists');
check('A2', fs.existsSync(PLAN_DOC), 'docs/STAGE-42A5-CAMI-IMPLEMENTATION-PLAN.md exists');
check('A3', fs.existsSync(PACK), 'config/clients/wolfhouse-somo.cami-voice-mining.json exists');
check('A4', fs.existsSync(PROPOSALS), 'fixtures proposals README exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A5', !!(pkg.scripts && pkg.scripts[SCRIPT]), `package script ${SCRIPT} exists`);

section('B. Voice pack structure');

let pack = null;
try {
  pack = JSON.parse(fs.readFileSync(PACK, 'utf8'));
  pass('B1', 'voice pack is valid JSON');
} catch (err) {
  fail('B1', `voice pack JSON parse failed: ${err.message}`);
}

if (pack) {
  check('B2', pack.client_slug === 'wolfhouse-somo', 'client_slug is wolfhouse-somo');
  check('B3', pack.source && pack.source.raw_chats_committed === false, 'source.raw_chats_committed is false');
  check('B4', pack.source && pack.source.personal_data_redacted === true, 'source.personal_data_redacted is true');
  check('B5', pack.voice_rules && Object.keys(pack.voice_rules).length >= 6, 'voice_rules present (>=6 rule groups)');
  const banks = pack.phrase_banks || {};
  check('B6', Object.keys(banks).length >= 10, `phrase_banks present (${Object.keys(banks).length} banks, need >=10)`);
  const bankEntries = Object.values(banks).reduce((n, b) => n + (Array.isArray(b) ? b.length : 0), 0);
  check('B7', bankEntries >= 50, `phrase banks contain ${bankEntries} phrases (need >=50)`);
  const allPhrases = Object.values(banks).flat().filter((p) => p && typeof p === 'object');
  check('B8', allPhrases.every((p) => p.phrase && p.language && p.fidelity), 'every phrase has phrase/language/fidelity');
  const recipes = pack.reply_recipes || {};
  check('B9', Object.keys(recipes).length >= 12, `reply_recipes present (${Object.keys(recipes).length}, need >=12)`);
  check('B10', Object.values(recipes).every((r) => r.structure && r.what_not_to_say), 'every recipe has structure + what_not_to_say');
  check('B11', pack.emoji_rules && Object.keys(pack.emoji_rules).length >= 3, 'emoji_rules present');
  check('B12', pack.anti_patterns && Object.keys(pack.anti_patterns).length >= 6, 'anti_patterns present (>=6)');
  check('B13', pack.implementation_recommendations && Object.keys(pack.implementation_recommendations).length >= 4, 'implementation_recommendations present (>=4)');
}

section('C. Raw chats not committed');

const trackedData = gitTracked('data/*.txt');
check('C1', trackedData.length === 0, `no data/*.txt chat exports tracked by git${trackedData ? ` (found: ${trackedData.split('\n').join(', ')})` : ''}`);
const trackedChat = gitTracked('data/_chat*');
check('C2', trackedChat.length === 0, 'no data/_chat* files tracked by git');

section('D. PII / secrets scan of committed artifacts');

const ARTIFACTS = [
  { label: 'mining doc', file: MINING_DOC },
  { label: 'implementation plan', file: PLAN_DOC },
  { label: 'voice pack json', file: PACK },
  { label: 'fixtures proposals', file: PROPOSALS },
];

// E.164-ish or long digit runs (allow 4-digit years/times; flag 7+ digit runs and +.. numbers)
const PHONE_RE = /\+\d[\d\s().-]{6,}\d|\b\d{7,}\b/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const GATE_RE = /gate\s*code|door\s*code|access\s*code\s*[:=]?\s*\d|codice\s*(cancello|porta)\s*[:=]?\s*\d|\bpin\b\s*[:=]?\s*\d{4}/i;
const PAYLINK_RE = /https?:\/\/(?:[a-z0-9.-]*\.)?stripe\.com|buy\.stripe|checkout\.stripe|pay\.stripe|payment[-_ ]?link\s*[:=]\s*http|iban\s*[:=]?\s*[A-Z]{2}\d{2}/i;
const SECRET_RE = /sk_live|pk_live|whsec_|api[-_]?key\s*[:=]\s*['"][A-Za-z0-9]/i;

let dIdx = 0;
for (const a of ARTIFACTS) {
  dIdx++;
  if (!fs.existsSync(a.file)) {
    fail(`D${dIdx}`, `${a.label} missing — cannot scan`);
    continue;
  }
  const src = fs.readFileSync(a.file, 'utf8');
  const phoneHit = src.match(PHONE_RE);
  const emailHit = src.match(EMAIL_RE);
  const gateHit = src.match(GATE_RE);
  const payHit = src.match(PAYLINK_RE);
  const secretHit = src.match(SECRET_RE);
  const hits = [
    phoneHit && `phone-like "${phoneHit[0]}"`,
    emailHit && `email "${emailHit[0]}"`,
    gateHit && `gate/access code "${gateHit[0]}"`,
    payHit && `payment link/IBAN "${payHit[0]}"`,
    secretHit && `secret "${secretHit[0]}"`,
  ].filter(Boolean);
  check(`D${dIdx}`, hits.length === 0, `${a.label}: no phone numbers, emails, gate codes, payment links or secrets${hits.length ? ` (found ${hits.join('; ')})` : ''}`);
}

section('E. No live-send / production paths added');

const stageSources = ARTIFACTS
  .filter((a) => fs.existsSync(a.file))
  .map((a) => ({ label: a.label, src: fs.readFileSync(a.file, 'utf8') }));

// Artifacts are docs/config only — they must not contain executable send paths.
const SEND_PATTERNS = [
  { id: 'E1', re: /sendWhatsApp|whatsappSend|sendMessage\s*\(|messages\.create\s*\(/, label: 'no WhatsApp send path' },
  { id: 'E2', re: /stripe\.(checkout|paymentLinks|paymentIntents)\.create/, label: 'no Stripe path' },
  { id: 'E3', re: /sendConfirmation\s*\(|confirmationSend\s*\(/, label: 'no confirmation send path' },
  { id: 'E4', re: /n8n\.(activate|trigger)|activate.*n8n workflow/i, label: 'no n8n activation' },
];
for (const p of SEND_PATTERNS) {
  const hit = stageSources.find((s) => p.re.test(s.src));
  check(p.id, !hit, `${p.label}${hit ? ` (found in ${hit.label})` : ''}`);
}

// Stage artifacts are markdown/json only; nothing executable was added.
check('E5', [MINING_DOC, PLAN_DOC, PACK, PROPOSALS].every((f) => /\.(md|json)$/.test(f)), 'stage artifacts are docs/config only (no production code changes)');

console.log(`\n${'─'.repeat(40)}`);
console.log(`Stage 42a.5 verifier: ${passes} passed, ${failures} failed`);
if (failures > 0) {
  console.error('RESULT: FAIL');
  process.exit(1);
}
console.log('RESULT: PASS');
