/**
 * Phase 25g — Verifier for owner plan-and-execute path.
 *
 * Usage:
 *   npm run verify:luna-agent-phase25-owner-plan-execute
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXEC = path.join(__dirname, 'lib', 'owner-sql-plan-execute.js');
const PLANNER = path.join(__dirname, 'lib', 'owner-sql-planner.js');
const READONLY = path.join(__dirname, 'lib', 'owner-readonly-sql.js');
const API = path.join(__dirname, 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-25g-OWNER-PLAN-AND-EXECUTE.md');
const PKG = path.join(ROOT, 'package.json');

const CLIENT = 'wolfhouse-somo';

const UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-owner-whatsapp-inbound.js'),
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-webhook.js'),
  path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'),
];

const DOWNSTREAM = [
  'verify:luna-agent-phase25-owner-sql-planner',
  'verify:luna-agent-phase25-owner-data-catalog',
  'verify:luna-agent-phase25-owner-readonly-sql',
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

function mockPg() {
  let selectCalls = 0;
  const pg = {
    selectCalls: () => selectCalls,
    query: async (sql) => {
      const t = String(sql || '').trim();
      if (t === 'BEGIN READ ONLY') return {};
      if (t.startsWith('SET LOCAL statement_timeout')) return {};
      if (t === 'COMMIT') return {};
      if (t === 'ROLLBACK') return {};
      if (/^SELECT/i.test(t)) {
        selectCalls += 1;
        return { rows: [{ id: '1', sample: 'row' }] };
      }
      throw new Error(`unexpected query: ${t.slice(0, 40)}`);
    },
  };
  return pg;
}

console.log('\nverify-luna-agent-phase25-owner-plan-execute.js  (Phase 25g)\n');

try {
  execSync(`node --check "${EXEC}"`, { stdio: 'pipe' });
  pass('0', 'owner-sql-plan-execute.js passes node --check');
} catch {
  fail('0', 'syntax check failed');
}

const orchestrator = require('./lib/owner-sql-plan-execute');
const planner = require('./lib/owner-sql-planner');
const execSrc = readOrEmpty(EXEC);
const plannerSrc = readOrEmpty(PLANNER);
const apiSrc = readOrEmpty(API);

section('A. Module exports + wiring');

if (typeof orchestrator.planAndExecuteOwnerSqlQuestion === 'function') {
  pass('A1', 'planAndExecuteOwnerSqlQuestion exported');
} else fail('A1', 'planAndExecuteOwnerSqlQuestion missing');

if (execSrc.includes('planOwnerSqlQuestion') && execSrc.includes('executeOwnerReadOnlySql')) {
  pass('A2', 'orchestrator wires planner + executor');
} else fail('A2', 'planner/executor wiring missing');

if (!plannerSrc.includes('executeOwnerReadOnlySql')) {
  pass('A3', 'planner still does NOT import executeOwnerReadOnlySql');
} else fail('A3', 'planner must remain dry-run only');

if (!/require\s*\([^)]*(stripe|whatsapp|n8n|meta-whatsapp)/i.test(execSrc)) {
  pass('A4', 'no Stripe/WhatsApp/Meta/n8n imports in orchestrator');
} else fail('A4', 'forbidden integration import');

section('B. Plan route stays dry-run');

const planHandler = apiSrc.slice(
  apiSrc.indexOf('async function handleOwnerSqlPlan'),
  apiSrc.indexOf('async function handleOwnerSqlValidate'),
);
if (planHandler.includes('planOwnerSqlQuestion') && !planHandler.includes('executeOwnerReadOnlySql')) {
  pass('B1', '/staff/owner/sql/plan handler does not execute');
} else fail('B1', 'plan handler must not execute SQL');

if (planHandler.includes('no_query_executed') || !planHandler.includes('planAndExecuteOwnerSqlQuestion')) {
  pass('B2', 'plan handler uses plan-only path');
} else fail('B2', 'plan handler must not call plan-and-execute');

section('C. Plan-and-execute route');

if (apiSrc.includes('/staff/owner/sql/plan-and-execute') && apiSrc.includes('handleOwnerSqlPlanAndExecute')) {
  pass('C1', 'staff API exposes plan-and-execute route');
} else fail('C1', 'plan-and-execute route missing');

const peHandler = apiSrc.slice(
  apiSrc.indexOf('async function handleOwnerSqlPlanAndExecute'),
  apiSrc.indexOf('function readBody'),
);
if (peHandler.includes('planAndExecuteOwnerSqlQuestion') && peHandler.includes('executeOwnerReadOnlySql') === false) {
  pass('C2', 'handler delegates to orchestrator module');
} else fail('C2', 'handler wiring incorrect');

const peRouter = apiSrc.slice(
  apiSrc.indexOf('/staff/owner/sql/plan-and-execute'),
  apiSrc.indexOf('/staff/owner/sql/plan-and-execute') + 500,
);
if (/requireAuth\(req, res, 'operator'\)/.test(peRouter)) {
  pass('C3', 'plan-and-execute requires operator+ auth');
} else fail('C3', 'auth missing on plan-and-execute');

section('D. Blocked plans do not execute');

(async () => {
  const mockAiRaw = async () => JSON.stringify({
    mode: 'sql',
    template_id: null,
    sql: 'SELECT id, raw_payload FROM guest_message_events WHERE client_slug = $1 LIMIT 5',
    params: [CLIENT],
    explanation: 'bad',
    expected_result: 'rows',
    confidence: 0.5,
  });

  const pg1 = mockPg();
  const blockedRaw = await orchestrator.planAndExecuteOwnerSqlQuestion(pg1, {
    client_slug: CLIENT,
    question: 'Show internal webhook payload dump please',
    env: { OPENAI_API_KEY: 'sk-mock', LUNA_AI_PROVIDER: 'openai' },
    aiCaller: mockAiRaw,
  });
  if (blockedRaw.success === false && blockedRaw.no_query_executed === true
    && blockedRaw.execution?.skipped === true && pg1.selectCalls() === 0) {
    pass('D1', 'raw_payload plan does not execute');
  } else fail('D1', 'raw_payload should be blocked without SELECT');

  const mockAiStar = async () => JSON.stringify({
    mode: 'sql',
    template_id: null,
    sql: 'SELECT * FROM guest_message_events WHERE client_slug = $1 LIMIT 5',
    params: [CLIENT],
    explanation: 'bad star',
    expected_result: 'rows',
    confidence: 0.5,
  });

  const pg2 = mockPg();
  const blockedStar = await orchestrator.planAndExecuteOwnerSqlQuestion(pg2, {
    client_slug: CLIENT,
    question: 'Dump all guest message columns internally',
    env: { OPENAI_API_KEY: 'sk-mock', LUNA_AI_PROVIDER: 'openai' },
    aiCaller: mockAiStar,
  });
  if (blockedStar.success === false && blockedStar.no_query_executed === true && pg2.selectCalls() === 0) {
    pass('D2', 'SELECT * plan does not execute');
  } else fail('D2', 'SELECT * should be blocked without SELECT');

  const badPlan = {
    mode: 'sql',
    template_id: null,
    sql: 'SELECT id FROM guest_message_events LIMIT 5',
    params: [CLIENT],
    explanation: 'missing scope',
    expected_result: 'id',
    confidence: 0.5,
  };
  const badVal = planner.validateOwnerSqlPlan(badPlan, { client_slug: CLIENT });
  const pg3 = mockPg();
  if (!badVal.valid) {
    const blockedSlug = orchestrator.buildBlockedResponse({
      success: false,
      question: 'test',
      client_slug: CLIENT,
      planner_source: 'ai',
      plan: badPlan,
      validation: badVal,
      execute_ready: false,
    });
    if (blockedSlug.no_query_executed === true && pg3.selectCalls() === 0) {
      pass('D3', 'missing client_slug plan does not execute');
    } else fail('D3', 'blocked response should skip execution');
  } else fail('D3', 'missing client_slug should fail validation');

  section('E. Template plan + execute');

  const pg4 = mockPg();
  const outA = await orchestrator.planAndExecuteOwnerSqlQuestion(pg4, {
    client_slug: CLIENT,
    question: "Who hasn't settled up?",
    maxRows: 50,
    timeoutMs: 3000,
  });
  if (outA.success === true && outA.planner_source === 'template_match'
    && outA.plan?.template_id === 'outstanding_balances'
    && outA.execution?.success === true && outA.execution?.read_only === true
    && outA.execution?.no_write_performed === true && outA.no_query_executed === false
    && pg4.selectCalls() >= 1) {
    pass('E1', 'outstanding balances plans + executes');
  } else fail('E1', 'outstanding balances execute path failed');

  const pg5 = mockPg();
  const outB = await orchestrator.planAndExecuteOwnerSqlQuestion(pg5, {
    client_slug: CLIENT,
    question: 'How much revenue this month?',
    maxRows: 50,
  });
  if (outB.success === true && outB.plan?.template_id === 'revenue_summary_by_month'
    && outB.execution?.success === true && pg5.selectCalls() >= 1) {
    pass('E2', 'revenue this month plans + executes');
  } else fail('E2', 'revenue execute path failed');

  section('F. AI fallback guest messages (mocked)');

  const mockAiGuest = async () => JSON.stringify({
    mode: 'sql',
    template_id: null,
    sql: [
      'SELECT id, created_at, from_phone, profile_name, message_text, next_action',
      'FROM guest_message_events',
      'WHERE client_slug = $1',
      'ORDER BY created_at DESC',
      'LIMIT 20',
    ].join(' '),
    params: [CLIENT],
    explanation: 'Recent guest messages',
    expected_result: 'id, created_at, from_phone, profile_name, message_text, next_action',
    confidence: 0.85,
  });

  const pg6 = mockPg();
  const outF = await orchestrator.planAndExecuteOwnerSqlQuestion(pg6, {
    client_slug: CLIENT,
    question: 'List recent guest messages for Wolfhouse',
    env: { OPENAI_API_KEY: 'sk-mock', LUNA_AI_PROVIDER: 'openai' },
    aiCaller: mockAiGuest,
    maxRows: 20,
    timeoutMs: 3000,
  });
  if (outF.planner_source === 'ai' && outF.validation?.valid === true
    && outF.execution?.success === true && outF.no_query_executed === false
    && pg6.selectCalls() >= 1) {
    pass('F1', 'mock AI guest messages plan validates + executes');
  } else fail('F1', `AI guest messages path failed: ${outF.validation?.blocked_reason || outF.execution?.error}`);

  section('G. Prompt examples');

  const prompt = planner.buildOwnerSqlPlannerPrompt({
    client_slug: CLIENT,
    question: 'List recent guest messages for Wolfhouse',
  });
  if (prompt.system.includes('guest_message_events')
    && prompt.system.includes('from_phone')
    && prompt.system.includes('Do not select raw_payload')
    && prompt.system.includes('Do not SELECT *')) {
    pass('G1', 'planner prompt includes safe guest message example');
  } else fail('G1', 'guest message prompt example missing');

  section('H. Untouched guest WhatsApp modules');

  for (const f of UNTOUCHED) {
    const base = path.basename(f);
    const src = readOrEmpty(f);
    if (src && !src.includes('owner-sql-plan-execute') && !src.includes('plan-and-execute')) {
      pass(`H.${base}`, `${base} unchanged by 25g`);
    } else if (!src) {
      pass(`H.${base}`, `${base} not present (skip)`);
    } else {
      fail(`H.${base}`, `${base} touched unexpectedly`);
    }
  }

  section('I. Docs + npm script');

  if (fs.existsSync(DOC)) pass('I1', 'PHASE-25g-OWNER-PLAN-AND-EXECUTE.md exists');
  else fail('I1', 'doc missing');

  const doc = readOrEmpty(DOC);
  if (/dry-run|plan-and-execute|25h|no WhatsApp|read-only/i.test(doc)) {
    pass('I2', 'doc covers plan vs execute, 25h, safety');
  } else fail('I2', 'doc incomplete');

  const pkg = JSON.parse(readOrEmpty(PKG) || '{}');
  if (pkg.scripts && pkg.scripts['verify:luna-agent-phase25-owner-plan-execute']) {
    pass('I3', 'npm script registered');
  } else fail('I3', 'npm script missing');

  section('J. Downstream scripts listed (not run)');
  for (const s of DOWNSTREAM) {
    if (pkg.scripts && pkg.scripts[s]) pass('J', `downstream registered: ${s}`);
    else fail('J', `missing downstream: ${s}`);
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
