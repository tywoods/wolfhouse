/**
 * Phase 11a.3 — Verifier for Staff Ask Luna AI balance-due answer formatter.
 *
 * Usage:
 *   npm run verify:staff-ask-luna-ai-answer-formatter
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_FILE  = path.join(__dirname, 'staff-query-api.js');
const FMT_FILE  = path.join(__dirname, 'lib', 'staff-ask-luna-ai-answer-format.js');
const BAL_FILE  = path.join(__dirname, 'lib', 'staff-ask-luna-balance-due.js');
const AI_FILE   = path.join(__dirname, 'lib', 'staff-ask-luna-ai-intent.js');
const PKG_FILE  = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

console.log('\nverify-staff-ask-luna-ai-answer-formatter.js  (Phase 11a.3)\n');

for (const f of [API_FILE, FMT_FILE, BAL_FILE, AI_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const fmtSrc = fs.readFileSync(FMT_FILE, 'utf8');
const balSrc = fs.readFileSync(BAL_FILE, 'utf8');
const pkg    = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

const balBefore = balSrc;

try {
  execSync(`node --check "${FMT_FILE}"`, { stdio: 'ignore' });
  ok('staff-ask-luna-ai-answer-format.js passes node --check');
} catch (_) {
  fail('staff-ask-luna-ai-answer-format.js passes node --check');
}

check(
  pkg.scripts && pkg.scripts['verify:staff-ask-luna-ai-answer-formatter']
    === 'node scripts/verify-staff-ask-luna-ai-answer-formatter.js',
  'package.json verify script registered',
);

console.log('\nA. Wiring — structured query unchanged');

check(apiSrc.includes('computeBalanceDueRows'), 'handleAskLuna still uses computeBalanceDueRows');
check(apiSrc.includes('formatBalanceDueAnswerNatural'), 'balance due uses formatBalanceDueAnswerNatural');
check(!apiSrc.includes('formatAskLunaBalanceDueAnswer(balanceRows)'),
  'balance due path does not call deterministic formatter directly');
check(balSrc === balBefore, 'staff-ask-luna-balance-due.js unchanged (no SQL/math edits)');

console.log('\nB. Formatter input and prompt');

check(fmtSrc.includes('buildBalanceDueFormatterSummary'), 'structured summary builder');
check(fmtSrc.includes('JSON.stringify(summary'), 'formatter sends summary JSON only');
check(
  !fmtSrc.match(/FROM\s+bookings|FROM\s+payments|FROM\s+conversations|message_log|chat_log/i),
  'formatter does not query SQL or chat logs',
);
check(fmtSrc.includes('Use only the structured rows provided'), 'prompt: use only structured rows');
check(fmtSrc.includes('Do not invent facts'), 'prompt: do not invent facts');
check(fmtSrc.includes('Do not generate SQL'), 'prompt: do not generate SQL');
check(fmtSrc.includes('not a table'), 'prompt: not a table');
check(fmtSrc.includes('total_outstanding_display'), 'summary includes total outstanding');

console.log('\nC. Gating and fallback');

check(fmtSrc.includes('isAskLunaAiEnabled'), 'formatter gated by STAFF_ASK_LUNA_AI_ENABLED');
check(fmtSrc.includes('formatAskLunaBalanceDueAnswer'), 'falls back to deterministic formatter');
check(fmtSrc.includes('BALANCE_DUE_EMPTY_ANSWER'), 'empty answer constant');

console.log('\nD. Safety');

const askStart = apiSrc.indexOf("if (intentKey === 'payments.balance_due')");
const askEnd   = apiSrc.indexOf('const registryEntry = getEntry(intentKey)', askStart);
const balBlock = askStart > -1 ? apiSrc.slice(askStart, askEnd) : '';
check(
  !balBlock.match(/\b(INSERT|UPDATE|DELETE)\b/) && !balBlock.match(/\b(stripe|whatsapp|n8n)\b/i),
  'balance-due answer path has no writes/Stripe/WhatsApp/n8n',
);

const {
  buildBalanceDueFormatterSummary,
  buildBalanceDueFormatterSystemPrompt,
  validateBalanceDueFormatterOutput,
  formatBalanceDueAnswerWithAi,
  formatBalanceDueAnswerNatural,
  BALANCE_DUE_EMPTY_ANSWER,
} = require('./lib/staff-ask-luna-ai-answer-format');

const sampleRows = [
  {
    guest_name: 'Jimmy',
    booking_code: 'DEMO-R1',
    check_in: '2026-06-19',
    check_out: '2026-06-25',
    bed_summary: 'DEMO-R1',
    balance_due_cents: 30000,
    payment_state_label: 'Deposit paid / Link sent',
  },
  {
    guest_name: 'Anna',
    booking_code: 'DEMO-R2-B1',
    check_in: '2026-06-22',
    check_out: '2026-06-26',
    bed_summary: 'DEMO-R2-B1',
    balance_due_cents: 12000,
    payment_state_label: 'No active link',
  },
];

const summary = buildBalanceDueFormatterSummary(sampleRows);
check(summary.booking_count === 2, 'summary booking count');
check(summary.total_outstanding_cents === 42000, 'summary total cents');
check(summary.bookings[0].guest_name === 'Jimmy', 'summary sorted by largest balance first');

const prompt = buildBalanceDueFormatterSystemPrompt();
check(prompt.includes('Do not mention chat logs'), 'prompt mentions no chat logs');

const validOut = validateBalanceDueFormatterOutput(
  'There are 2 active bookings with money still owed.\n\n'
  + 'Jimmy still owes €300 for Jun 19–25 in DEMO-R1. Deposit paid / Link sent.\n\n'
  + 'Anna still owes €120 for Jun 22–26 in DEMO-R2-B1. No active link.\n\n'
  + 'Total outstanding: €420.',
  summary,
);
check(validOut != null, 'valid natural answer accepted');

check(validateBalanceDueFormatterOutput('SELECT * FROM bookings', summary) === null, 'SQL output rejected');
check(
  validateBalanceDueFormatterOutput(
    JSON.stringify({ intent: 'payments.balance_due', confidence: 0.9 }),
    summary,
  ) === null,
  'tool/json-only output rejected',
);
check(
  validateBalanceDueFormatterOutput(
    'Jimmy owes €999 for DEMO-R1. Total outstanding: €420.',
    summary,
  ) === null,
  'invented balance amount rejected',
);

(async function runAsync() {
  const prev = process.env.STAFF_ASK_LUNA_AI_ENABLED;
  process.env.STAFF_ASK_LUNA_AI_ENABLED = 'false';
  const disabled = await formatBalanceDueAnswerNatural(sampleRows);
  check(disabled.answer_format_source === 'deterministic', 'disabled → deterministic source');
  check(disabled.answer.includes('Total outstanding'), 'deterministic fallback includes total');

  const empty = await formatBalanceDueAnswerNatural([]);
  check(empty.answer === BALANCE_DUE_EMPTY_ANSWER, 'empty rows → stable empty answer');
  check(empty.answer_format_source === 'deterministic', 'empty uses deterministic path');

  process.env.STAFF_ASK_LUNA_AI_ENABLED = 'true';
  const mockAnswer = [
    'There are 2 active bookings with money still owed.',
    '',
    'Jimmy has the largest balance: €300 due for Jun 19–25 in DEMO-R1.',
    'Deposit paid / Link sent.',
    '',
    'Anna still owes €120 for Jun 22–26 in DEMO-R2-B1.',
    'No active link.',
    '',
    'Total outstanding: €420.',
  ].join('\n');
  const aiFmt = await formatBalanceDueAnswerNatural(sampleRows, {
    provider: async () => mockAnswer,
  });
  check(aiFmt.answer_format_source === 'ai', 'mock provider → ai format source');
  check(aiFmt.answer.includes('Total outstanding: €420'), 'AI formatted answer includes total');

  const badProvider = await formatBalanceDueAnswerNatural(sampleRows, {
    provider: async () => 'DROP TABLE bookings; Total outstanding: €420',
  });
  check(badProvider.answer_format_source === 'deterministic', 'bad AI output → deterministic fallback');

  if (prev != null) process.env.STAFF_ASK_LUNA_AI_ENABLED = prev;
  else delete process.env.STAFF_ASK_LUNA_AI_ENABLED;

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  fail(`async: ${e.message}`);
  process.exit(1);
});
