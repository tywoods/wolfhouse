/**
 * Phase 25h — Verifier for owner Command Center answer formatter + WhatsApp wiring.
 *
 * Usage:
 *   npm run verify:luna-agent-phase25-owner-command-center-answer
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ANSWER = path.join(__dirname, 'lib', 'owner-command-center-answer.js');
const EXEC = path.join(__dirname, 'lib', 'owner-sql-plan-execute.js');
const OWNER = path.join(__dirname, 'lib', 'luna-owner-whatsapp-inbound.js');
const PROCESS = path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js');
const GUEST_DRAFT = path.join(__dirname, 'lib', 'luna-guest-reply-draft.js');
const API = path.join(__dirname, 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-25h-OWNER-COMMAND-CENTER-ANSWERS.md');
const PKG = path.join(ROOT, 'package.json');

const CLIENT = 'wolfhouse-somo';

const DOWNSTREAM = [
  'verify:luna-agent-phase25-owner-plan-execute',
  'verify:luna-agent-phase25-owner-whatsapp-router',
  'verify:luna-agent-phase25-owner-readonly-sql',
  'verify:luna-ai-provider',
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch { return ''; }
}

function mockPg(rows = [{ id: '1', sample: 'row' }]) {
  let selectCalls = 0;
  return {
    selectCalls: () => selectCalls,
    query: async (sql) => {
      const t = String(sql || '').trim();
      if (t === 'BEGIN READ ONLY') return {};
      if (t.startsWith('SET LOCAL statement_timeout')) return {};
      if (t === 'COMMIT') return {};
      if (t === 'ROLLBACK') return {};
      if (/^SELECT/i.test(t)) {
        selectCalls += 1;
        return { rows };
      }
      throw new Error(`unexpected query: ${t.slice(0, 50)}`);
    },
  };
}

console.log('\nverify-luna-agent-phase25-owner-command-center-answer.js  (Phase 25h)\n');

try {
  execSync(`node --check "${ANSWER}"`, { stdio: 'pipe' });
  pass('0', 'owner-command-center-answer.js passes node --check');
} catch {
  fail('0', 'syntax check failed');
}

const formatter = require('./lib/owner-command-center-answer');
const orchestrator = require('./lib/owner-sql-plan-execute');
const answerSrc = readOrEmpty(ANSWER);
const execSrc = readOrEmpty(EXEC);
const ownerSrc = readOrEmpty(OWNER);
const apiSrc = readOrEmpty(API);

section('A. Formatter exports + safety');

if (typeof formatter.formatOwnerCommandCenterAnswer === 'function') pass('A1', 'formatOwnerCommandCenterAnswer exported');
else fail('A1', 'formatOwnerCommandCenterAnswer missing');

if (typeof formatter.formatOwnerCommandCenterFallback === 'function') pass('A2', 'formatOwnerCommandCenterFallback exported');
else fail('A2', 'formatOwnerCommandCenterFallback missing');

if (answerSrc.includes('callLunaAiJsonChat') && answerSrc.includes('luna-ai-provider')) {
  pass('A3', 'AI formatter uses luna-ai-provider');
} else fail('A3', 'AI provider wiring missing');

if (!answerSrc.includes('raw_payload') || answerSrc.includes('Do not include raw_payload')) {
  pass('A4', 'prompt blocks raw_payload exposure');
} else fail('A4', 'raw_payload safety missing');

if (!/require\s*\([^)]*(stripe|whatsapp|n8n|meta-whatsapp)/i.test(answerSrc)) {
  pass('A5', 'formatter avoids Stripe/WhatsApp/Meta/n8n imports');
} else fail('A5', 'forbidden integration import');

section('B. Deterministic formatter');

const balanceRows = [
  { guest_name: 'Alex', booking_code: 'WH-01', balance_due_cents: 15000 },
  { guest_name: 'Sam', booking_code: 'WH-02', balance_due_cents: 8000 },
];
const balFmt = formatter.formatOwnerCommandCenterFallback({
  planResult: {
    plan: { template_id: 'outstanding_balances', mode: 'template' },
    validation: { valid: true },
    execution: { success: true, rows: balanceRows, row_count: 2 },
  },
});
if (balFmt.answer.includes('€') && balFmt.answer.includes('Alex') && balFmt.row_count === 2) {
  pass('B1', 'outstanding_balances concise answer with currency');
} else fail('B1', 'outstanding_balances format failed');

const revFmt = formatter.formatOwnerCommandCenterFallback({
  planResult: {
    plan: { template_id: 'revenue_summary_by_month', mode: 'template' },
    validation: { valid: true },
    execution: {
      success: true,
      rows: [{ revenue_month: '2026-06-01', paid_cents: 125000, payment_count: 4 }],
      row_count: 1,
    },
  },
});
if (/€1250|€1,250/.test(revFmt.answer) || revFmt.answer.includes('€1250')) {
  pass('B2', 'revenue answer formats cents as currency');
} else fail('B2', `revenue currency format failed: ${revFmt.answer}`);

const emptyFmt = formatter.formatOwnerCommandCenterFallback({
  planResult: {
    plan: { template_id: 'outstanding_balances', mode: 'template' },
    validation: { valid: true },
    execution: { success: true, rows: [], row_count: 0 },
  },
});
if (/didn't find|no matching/i.test(emptyFmt.answer)) {
  pass('B3', 'empty rows handled clearly');
} else fail('B3', 'empty rows message missing');

const blockedFmt = formatter.formatOwnerCommandCenterFallback({
  planResult: {
    plan: { mode: 'unsupported' },
    validation: { valid: false, blocked_reason: 'unsupported_question' },
    execution: { skipped: true, success: false },
  },
});
if (/can't answer that from the allowed owner data/i.test(blockedFmt.answer)) {
  pass('B4', 'blocked/unsupported safe message');
} else fail('B4', 'blocked message wrong');

section('C. AI formatter + fallback');

(async () => {
  const summary = formatter.buildOwnerAnswerSummary(
    'Who owes?',
    { plan: { template_id: 'outstanding_balances' }, planner_source: 'template_match' },
    { success: true, rows: balanceRows, row_count: 2 },
  );
  if (!JSON.stringify(summary).includes('raw_payload')) {
    pass('C1', 'AI summary excludes sensitive keys');
  } else fail('C1', 'AI summary leaked sensitive key');

  const mockAi = async () => '2 bookings owe money: Alex €150 and Sam €80 outstanding.';
  const aiOut = await formatter.formatOwnerCommandCenterAnswer({
    question: 'Who owes?',
    planResult: {
      plan: { template_id: 'outstanding_balances', mode: 'template' },
      validation: { valid: true },
      planner_source: 'template_match',
      execution: { success: true, rows: balanceRows, row_count: 2 },
    },
    env: { OPENAI_API_KEY: 'sk-mock', LUNA_AI_PROVIDER: 'openai' },
    aiCaller: mockAi,
  });
  if (aiOut.answer_format_source === 'ai' && aiOut.answer.length > 10) {
    pass('C2', 'AI formatter used when mock returns valid text');
  } else fail('C2', 'AI formatter path failed');

  const mockAiBad = async () => 'SELECT raw_payload FROM guest_message_events';
  const fbOut = await formatter.formatOwnerCommandCenterAnswer({
    question: 'Who owes?',
    planResult: {
      plan: { template_id: 'outstanding_balances', mode: 'template' },
      validation: { valid: true },
      execution: { success: true, rows: balanceRows, row_count: 2 },
    },
    env: { OPENAI_API_KEY: 'sk-mock', LUNA_AI_PROVIDER: 'openai' },
    aiCaller: mockAiBad,
  });
  if (fbOut.answer_format_source === 'deterministic' && fbOut.answer.includes('€')) {
    pass('C3', 'deterministic fallback when AI output invalid');
  } else fail('C3', 'AI invalid fallback failed');

  section('D. Plan-and-execute includes answer');

  if (execSrc.includes('formatOwnerCommandCenterAnswer') && execSrc.includes('answer_format_source')) {
    pass('D1', 'plan-execute orchestrator attaches answer');
  } else fail('D1', 'plan-execute answer wiring missing');

  const pg = mockPg(balanceRows);
  const pe = await orchestrator.planAndExecuteOwnerSqlQuestion(pg, {
    client_slug: CLIENT,
    question: "Who hasn't settled up?",
    env: { OPENAI_API_KEY: '', LUNA_AI_PROVIDER: 'openai' },
  });
  if (pe.answer && pe.answer_format_source && pe.row_count >= 0) {
    pass('D2', 'plan-and-execute returns answer + answer_format_source');
  } else fail('D2', 'plan-and-execute answer fields missing');

  if (apiSrc.includes('/staff/owner/sql/plan-and-execute') && apiSrc.includes('planAndExecuteOwnerSqlQuestion')) {
    pass('D3', 'staff API plan-and-execute route wired');
  } else fail('D3', 'API route missing');

  section('E. Owner WhatsApp routing');

  if (ownerSrc.includes('planAndExecuteOwnerSqlQuestion')) {
    pass('E1', 'owner handler imports plan-and-execute');
  } else fail('E1', 'plan-and-execute import missing');

  if (ownerSrc.includes('executeStaffAskLunaQuestion') && ownerSrc.includes('tryOwnerSqlPlanExecuteRoute')) {
    pass('E2', 'owner handler retains registry fallback after plan-execute try');
  } else fail('E2', 'registry fallback missing');

  if (!ownerSrc.includes('buildInboundBookingWritePreview')) {
    pass('E3', 'owner handler does not import booking_write_preview');
  } else fail('E3', 'booking_write_preview import forbidden');

  const revenueRows = [{ revenue_month: '2026-06-01', paid_cents: 9900, payment_count: 2 }];
  const pgRev = mockPg(revenueRows);
  const ownerMod = require('./lib/luna-owner-whatsapp-inbound');
  const ran = await ownerMod.runOwnerCommandCenterCore(pgRev, {
    WHATSAPP_DRY_RUN: 'true',
    OPENAI_API_KEY: '',
  }, {
    client_slug: CLIENT,
    message_text: 'How much revenue this month?',
    supported: true,
    wa_message_id: 'wamid.25h.test.revenue',
  }, { role: 'owner' });

  if (ran.askResult.owner_sql === true
    && ran.askResult.intent === 'owner_sql.revenue_summary_by_month'
    && trimStr(ran.askResult.answer).length > 0) {
    pass('E4', 'owner WhatsApp uses plan-execute for revenue question');
  } else fail('E4', `revenue owner route failed: ${ran.askResult.intent}`);

  // Registry fallback when planner unsupported — mock execute before loading owner handler
  const executeMod = require('./lib/staff-ask-luna-execute');
  const origExecute = executeMod.executeStaffAskLunaQuestion;
  let registryCalled = false;
  executeMod.executeStaffAskLunaQuestion = async () => {
    registryCalled = true;
    return {
      success: true,
      intent: 'operations.today',
      category: 'operations',
      answer: 'Today: 3 check-ins, 2 check-outs.',
      row_count: 5,
      read_only: true,
      no_write_performed: true,
    };
  };
  delete require.cache[require.resolve('./lib/luna-owner-whatsapp-inbound')];
  const ownerModFallback = require('./lib/luna-owner-whatsapp-inbound');

  const mockAiUnsupported = async () => JSON.stringify({
    mode: 'unsupported',
    template_id: null,
    sql: '',
    params: [CLIENT],
    explanation: 'Cannot answer safely',
    expected_result: '',
    confidence: 0,
  });

  const pgFallback = mockPg([]);
  const ranOps = await ownerModFallback.runOwnerCommandCenterCore(pgFallback, {
    WHATSAPP_DRY_RUN: 'true',
    OPENAI_API_KEY: 'sk-mock',
    LUNA_AI_PROVIDER: 'openai',
  }, {
    client_slug: CLIENT,
    message_text: 'What is happening today at the hostel?',
    supported: true,
    wa_message_id: 'wamid.25h.test.ops',
  }, { role: 'owner' }, { aiCaller: mockAiUnsupported });

  executeMod.executeStaffAskLunaQuestion = origExecute;
  delete require.cache[require.resolve('./lib/luna-owner-whatsapp-inbound')];

  if (registryCalled && ranOps.askResult.intent === 'operations.today') {
    pass('E5', 'registry fallback when planner unsupported');
  } else fail('E5', 'registry fallback not used');

  section('F. Guest path + dry-run + integrations');

  const guestDraftSrc = readOrEmpty(GUEST_DRAFT);
  if (!guestDraftSrc.includes('owner_sql_plan') && !guestDraftSrc.includes('planAndExecuteOwnerSqlQuestion')) {
    pass('F1', 'guest reply draft unchanged');
  } else fail('F1', 'guest draft touched');

  const processSrc = readOrEmpty(PROCESS);
  if (processSrc.includes('processOwnerWhatsAppCommandCenterInbound')) {
    pass('F2', 'inbound process still routes owner branch');
  } else fail('F2', 'inbound owner branch missing');

  if (ownerSrc.includes('evaluateGuestReplySendRouteWithPause')) {
    pass('F3', 'owner send path still uses dry-run send evaluator');
  } else fail('F3', 'send evaluator missing');

  if (!/require\s*\([^)]*(stripe|n8n)/i.test(ownerSrc + answerSrc)
    && !ownerSrc.includes('buildInboundBookingWritePreview')) {
    pass('F4', 'no Stripe/n8n runtime imports in 25h modules');
  } else fail('F4', 'forbidden integration in 25h modules');

  section('G. Docs + npm script');

  if (fs.existsSync(DOC)) pass('G1', 'PHASE-25h doc exists');
  else fail('G1', 'doc missing');

  const pkg = JSON.parse(readOrEmpty(PKG) || '{}');
  if (pkg.scripts && pkg.scripts['verify:luna-agent-phase25-owner-command-center-answer']) {
    pass('G2', 'npm script registered');
  } else fail('G2', 'npm script missing');

  section('H. Downstream listed (not run)');
  for (const s of DOWNSTREAM) {
    if (pkg.scripts && pkg.scripts[s]) pass('H', `downstream registered: ${s}`);
    else fail('H', `missing downstream: ${s}`);
  }

  console.log('\n' + '─'.repeat(60));
  if (failures === 0) {
    console.log(`PASS  (${passes} checks)\n`);
    process.exit(0);
  }
  console.log(`FAIL  (${passes} passed, ${failures} failed)\n`);
  process.exit(1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}
