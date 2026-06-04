/**
 * Phase 11a.2 — Verifier for Staff Ask Luna AI intent fallback (registry-only).
 *
 * Usage:
 *   npm run verify:staff-ask-luna-ai-intent-fallback
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const AI_FILE  = path.join(__dirname, 'lib', 'staff-ask-luna-ai-intent.js');
const BAL_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-balance-due.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

console.log('\nverify-staff-ask-luna-ai-intent-fallback.js  (Phase 11a.2)\n');

for (const f of [API_FILE, AI_FILE, BAL_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const aiSrc  = fs.readFileSync(AI_FILE, 'utf8');
const pkg    = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

try {
  execSync(`node --check "${AI_FILE}"`, { stdio: 'ignore' });
  ok('staff-ask-luna-ai-intent.js passes node --check');
} catch (_) {
  fail('staff-ask-luna-ai-intent.js passes node --check');
}

check(
  pkg.scripts && pkg.scripts['verify:staff-ask-luna-ai-intent-fallback']
    === 'node scripts/verify-staff-ask-luna-ai-intent-fallback.js',
  'package.json verify:staff-ask-luna-ai-intent-fallback script',
);

console.log('\nA. Wiring');

check(apiSrc.includes('classifyAskLunaIntentWithAi'), 'staff-query-api imports AI classifier');
check(apiSrc.includes('async function resolveAskLunaIntent('), 'resolveAskLunaIntent async wrapper');
check(apiSrc.includes('await resolveAskLunaIntent(question)'), 'handleAskLuna awaits resolveAskLunaIntent');
check(aiSrc.includes('getAskLunaAiAllowedIntents'), 'allowed intents from registry');
check(aiSrc.includes('parseAndValidateClassifierOutput'), 'strict JSON validation helper');
check(aiSrc.includes('isAskLunaAiEnabled'), 'AI gated by env flag');

console.log('\nB. Safety — no writes / integrations in classifier');

check(!aiSrc.match(/\b(INSERT|UPDATE|DELETE)\b.*bookings/i), 'classifier lib has no booking writes');
check(
  !aiSrc.match(/FROM\s+conversations|message_log|chat_log/i),
  'classifier does not query conversation/chat logs',
);
check(aiSrc.includes('Do not generate SQL'), 'prompt forbids SQL generation');
check(aiSrc.includes('Do not answer the question'), 'prompt forbids answering');
check(aiSrc.includes('SQL_OR_TOOL_RE'), 'SQL/tool output rejection');

const askStart = apiSrc.indexOf('async function handleAskLuna(');
const askEnd   = apiSrc.indexOf('function readBody(req)', askStart);
const askBlock = apiSrc.slice(askStart, askEnd > -1 ? askEnd : askStart + 12000);
check(
  !askBlock.slice(askBlock.indexOf('resolveAskLunaIntent')).match(/\b(stripe|whatsapp|n8n)\b/i),
  'AI fallback path in handler has no Stripe/WhatsApp/n8n',
);

console.log('\nC. Validation rules');

const {
  parseAndValidateClassifierOutput,
  classifyAskLunaIntentWithAi,
  getAskLunaAiAllowedIntents,
  isAskLunaAiEnabled,
} = require('./lib/staff-ask-luna-ai-intent');
const { resolveBalanceDueIntentKey } = require('./lib/staff-ask-luna-balance-due');
const { REGISTRY_BY_KEY } = require('./lib/staff-query-registry');

const allowed = new Set(getAskLunaAiAllowedIntents());
check(allowed.has('payments.balance_due'), 'payments.balance_due in allowed AI intents');

const validJson = JSON.stringify({
  intent: 'payments.balance_due',
  confidence: 0.91,
  reason: 'Question asks which active bookings have unpaid balances.',
});
const parsed = parseAndValidateClassifierOutput(validJson, allowed);
check(parsed && parsed.intent === 'payments.balance_due', 'valid JSON accepted');

check(parseAndValidateClassifierOutput('{not-json', allowed) === null, 'invalid JSON rejected');
check(
  parseAndValidateClassifierOutput(
    JSON.stringify({ intent: 'payments.balance_due', confidence: 0.5, reason: 'low' }),
    allowed,
  ) === null,
  'low confidence rejected',
);
check(
  parseAndValidateClassifierOutput(
    JSON.stringify({ intent: 'payments.not_real', confidence: 0.95, reason: 'x' }),
    allowed,
  ) === null,
  'unregistered intent rejected',
);
check(
  parseAndValidateClassifierOutput(
    '{"intent":"payments.balance_due","confidence":0.9,"reason":"x"} SELECT * FROM bookings',
    allowed,
  ) === null,
  'SQL in raw output rejected',
);
check(
  parseAndValidateClassifierOutput(
    JSON.stringify({ intent: 'payments.balance_due', confidence: 0.9, reason: 'tool_call sql' }),
    allowed,
  ) === null,
  'tool-call-looking reason rejected',
);

console.log('\nD. Deterministic routing still works');

const DETERMINISTIC_PHRASES = [
  'Who owes money?',
  'Who still needs to pay?',
  'Outstanding balances',
  'Who has unpaid balance?',
  'payments.balance_due',
];
for (const p of DETERMINISTIC_PHRASES) {
  check(
    resolveBalanceDueIntentKey(p, REGISTRY_BY_KEY) === 'payments.balance_due',
    `deterministic still routes: ${p}`,
  );
}

console.log('\nE. AI fallback examples (mock provider)');

const AI_EXAMPLE_RESPONSES = {
  "who hasn't settled up yet": {
    intent: 'payments.balance_due',
    confidence: 0.91,
    reason: 'Staff asking which guests have not fully paid.',
  },
  'who owes us money right now': {
    intent: 'payments.balance_due',
    confidence: 0.88,
    reason: 'Outstanding guest balances.',
  },
  'which guests still need to pay': {
    intent: 'payments.balance_due',
    confidence: 0.9,
    reason: 'Unpaid booking balances.',
  },
  'any unpaid guests': {
    intent: 'payments.balance_due',
    confidence: 0.86,
    reason: 'Guests with payment still due.',
  },
};

async function mockProvider(question) {
  const key = String(question || '').toLowerCase().replace(/[?!.,]/g, '').trim();
  for (const [pattern, payload] of Object.entries(AI_EXAMPLE_RESPONSES)) {
    if (key.includes(pattern)) return JSON.stringify(payload);
  }
  return JSON.stringify({ intent: null, confidence: 0, reason: 'unsure' });
}

(async function runAsyncTests() {
  const prevEnabled = process.env.STAFF_ASK_LUNA_AI_ENABLED;
  process.env.STAFF_ASK_LUNA_AI_ENABLED = 'true';

  for (const [question, expected] of Object.entries({
    "Who hasn't settled up yet?": 'payments.balance_due',
    'Who owes us money right now?': 'payments.balance_due',
    'Which guests still need to pay?': 'payments.balance_due',
    'Any unpaid guests?': 'payments.balance_due',
  })) {
    const result = await classifyAskLunaIntentWithAi(question, { provider: mockProvider });
    check(result && result.intent === expected, `AI mock maps: ${question}`);
  }

  const low = await classifyAskLunaIntentWithAi('random unrelated question', {
    provider: async () => JSON.stringify({ intent: 'payments.balance_due', confidence: 0.4, reason: 'weak' }),
  });
  check(low === null, 'mock low confidence rejected at runtime');

  console.log('\nF. Disabled-by-default');

  process.env.STAFF_ASK_LUNA_AI_ENABLED = 'false';
  check(!isAskLunaAiEnabled(), 'STAFF_ASK_LUNA_AI_ENABLED=false disables classifier');
  const disabled = await classifyAskLunaIntentWithAi("Who hasn't settled up yet?", { provider: mockProvider });
  check(disabled === null, 'AI fallback returns null when disabled');
  process.env.STAFF_ASK_LUNA_AI_ENABLED = 'true';
  check(isAskLunaAiEnabled(), 'STAFF_ASK_LUNA_AI_ENABLED=true enables classifier');
  if (prevEnabled != null) process.env.STAFF_ASK_LUNA_AI_ENABLED = prevEnabled;
  else delete process.env.STAFF_ASK_LUNA_AI_ENABLED;

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  fail(`async tests: ${e.message}`);
  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(1);
});
