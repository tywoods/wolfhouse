/**
 * Phase 25f — Verifier for owner AI SQL planner (dry-run).
 *
 * Usage:
 *   npm run verify:luna-agent-phase25-owner-sql-planner
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PLANNER = path.join(__dirname, 'lib', 'owner-sql-planner.js');
const READONLY = path.join(__dirname, 'lib', 'owner-readonly-sql.js');
const API = path.join(__dirname, 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-25f-OWNER-SQL-PLANNER.md');
const PKG = path.join(ROOT, 'package.json');

const CLIENT = 'wolfhouse-somo';

const UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-owner-whatsapp-inbound.js'),
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-webhook.js'),
  path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'),
];

const DOWNSTREAM = [
  'verify:luna-agent-phase25-owner-data-catalog',
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

console.log('\nverify-luna-agent-phase25-owner-sql-planner.js  (Phase 25f)\n');

try {
  execSync(`node --check "${PLANNER}"`, { stdio: 'pipe' });
  pass('0', 'owner-sql-planner.js passes node --check');
} catch {
  fail('0', 'syntax check failed');
}

const planner = require('./lib/owner-sql-planner');
const { validateOwnerReadOnlySql } = require('./lib/owner-readonly-sql');
const plannerSrc = readOrEmpty(PLANNER);
const readonlySrc = readOrEmpty(READONLY);
const apiSrc = readOrEmpty(API);

section('A. Module exports + wiring');

const exportsNeeded = [
  'planOwnerSqlQuestion',
  'buildOwnerSqlPlannerPrompt',
  'validateOwnerSqlPlan',
];
for (const name of exportsNeeded) {
  if (typeof planner[name] === 'function') pass(`A.${name}`, `${name} exported`);
  else fail(`A.${name}`, `${name} missing`);
}

if (plannerSrc.includes('describeOwnerCatalogForAi') && plannerSrc.includes('getOwnerApprovedQueryTemplates')) {
  pass('A.catalog', 'planner imports catalog helpers');
} else fail('A.catalog', 'catalog imports missing');

if (plannerSrc.includes('validateOwnerReadOnlySql')) {
  pass('A.validator', 'planner calls validateOwnerReadOnlySql');
} else fail('A.validator', 'validator import missing');

if (!plannerSrc.includes('executeOwnerReadOnlySql')) {
  pass('A.no_execute', 'planner does NOT import executeOwnerReadOnlySql');
} else fail('A.no_execute', 'executeOwnerReadOnlySql must not be imported');

if (plannerSrc.includes('callLunaAiJsonChat') && plannerSrc.includes('luna-ai-provider')) {
  pass('A.ai', 'planner uses luna-ai-provider for AI path');
} else fail('A.ai', 'AI provider wiring missing');

if (!/require\s*\([^)]*(stripe|whatsapp|n8n|meta-whatsapp)/i.test(plannerSrc)
  && !plannerSrc.includes('sendWhatsApp')) {
  pass('A.integrations', 'no Stripe/WhatsApp/Meta/n8n runtime imports in planner');
} else fail('A.integrations', 'forbidden integration import in planner');

section('B. Template matching (no AI)');

const templateCases = [
  ['B1', 'Who owes money?', 'outstanding_balances'],
  ['B2', "Who hasn't settled up?", 'outstanding_balances'],
  ['B3', 'How much revenue this month?', 'revenue_summary_by_month'],
  ['B4', 'Who arrives tomorrow?', 'arrivals_tomorrow'],
  ['B5', 'Which package is most popular?', 'package_popularity'],
];

(async () => {
  for (const [id, question, expectedId] of templateCases) {
    const r = await planner.planOwnerSqlQuestion({
      client_slug: CLIENT,
      question,
      env: {},
    });
    if (r.planner_source === 'template_match'
      && r.plan?.template_id === expectedId
      && r.validation?.valid === true
      && r.no_query_executed === true
      && r.execute_ready === true) {
      pass(id, `"${question}" → ${expectedId}`);
    } else {
      fail(id, `"${question}" — source=${r.planner_source} id=${r.plan?.template_id} valid=${r.validation?.valid}`);
    }
  }

  section('C. Validation blocking (no execute)');

  const badPayload = planner.validateOwnerSqlPlan({
    mode: 'sql',
    template_id: null,
    sql: 'SELECT id, raw_payload FROM guest_message_events WHERE client_slug = $1 LIMIT 5',
    params: [CLIENT],
    explanation: 'test',
    expected_result: '',
    confidence: 0.5,
  }, { client_slug: CLIENT });
  if (!badPayload.valid && badPayload.blocked_reason === 'sensitive_column_blocked') {
    pass('C1', 'raw_payload SQL blocked');
  } else fail('C1', `raw_payload not blocked: ${badPayload.blocked_reason}`);

  const badStar = planner.validateOwnerSqlPlan({
    mode: 'sql',
    sql: 'SELECT * FROM guest_message_events WHERE client_slug = $1 LIMIT 5',
    params: [CLIENT],
  }, { client_slug: CLIENT });
  if (!badStar.valid && badStar.blocked_reason === 'select_star_blocked') {
    pass('C2', 'SELECT * blocked');
  } else fail('C2', 'SELECT * not blocked');

  const badSlug = validateOwnerReadOnlySql({
    sql: 'SELECT id FROM guest_message_events LIMIT 5',
    client_slug: CLIENT,
  });
  if (!badSlug.ok && badSlug.error === 'client_slug_filter_missing') {
    pass('C3', 'missing client_slug blocked');
  } else fail('C3', 'missing client_slug not blocked');

  const goodPlan = planner.buildPlanFromTemplate('package_popularity', CLIENT);
  const goodVal = planner.validateOwnerSqlPlan(goodPlan, { client_slug: CLIENT });
  if (goodVal.valid) pass('C4', 'valid template SQL passes validation');
  else fail('C4', `valid template failed: ${goodVal.blocked_reason}`);

  section('D. AI path (mocked — no real OpenAI)');

  const mockAi = async () => JSON.stringify({
    mode: 'sql',
    template_id: null,
    sql: 'SELECT id, raw_payload FROM guest_message_events WHERE client_slug = $1 LIMIT 5',
    params: [CLIENT],
    explanation: 'bad ai sql',
    expected_result: 'rows',
    confidence: 0.6,
  });

  const aiBlocked = await planner.planOwnerSqlQuestion({
    client_slug: CLIENT,
    question: 'Show me something obscure about webhook internals',
    env: { OPENAI_API_KEY: 'sk-test-mock', LUNA_AI_PROVIDER: 'openai' },
    aiCaller: mockAi,
  });
  if (aiBlocked.planner_source === 'ai'
    && aiBlocked.validation?.valid === false
    && aiBlocked.no_query_executed === true
    && aiBlocked.execute_ready === false) {
    pass('D1', 'mock AI bad SQL blocked, not executed');
  } else fail('D1', 'mock AI block path failed');

  const mockAiGood = async () => JSON.stringify({
    mode: 'template',
    template_id: 'addon_revenue',
    sql: '',
    params: [CLIENT],
    explanation: 'addon revenue',
    expected_result: 'service_type, paid_cents',
    confidence: 0.88,
  });

  const aiGood = await planner.planOwnerSqlQuestion({
    client_slug: CLIENT,
    question: 'Break down paid service type totals from structured records',
    env: { OPENAI_API_KEY: 'sk-test-mock', LUNA_AI_PROVIDER: 'openai' },
    aiCaller: mockAiGood,
  });
  if (aiGood.planner_source === 'ai'
    && aiGood.plan?.template_id === 'addon_revenue'
    && aiGood.validation?.valid === true
    && aiGood.no_query_executed === true) {
    pass('D2', 'mock AI template selection validates, not executed');
  } else fail('D2', 'mock AI good path failed');

  section('E. Prompt + route');

  const prompt = planner.buildOwnerSqlPlannerPrompt({
    client_slug: CLIENT,
    question: 'Revenue this month?',
  });
  if (prompt.system.includes('JSON only')
    && prompt.system.includes('raw_payload')
    && prompt.system.includes('client_slug = $1')
    && prompt.catalog.includes('outstanding_balances')) {
    pass('E1', 'planner prompt includes catalog + safety rules');
  } else fail('E1', 'planner prompt incomplete');

  if (apiSrc.includes('/staff/owner/sql/plan') && apiSrc.includes('handleOwnerSqlPlan')) {
    pass('E2', 'staff API exposes /staff/owner/sql/plan');
  } else fail('E2', 'plan route missing');

  const planHandler = apiSrc.slice(
    apiSrc.indexOf('async function handleOwnerSqlPlan'),
    apiSrc.indexOf('async function handleOwnerSqlValidate'),
  );
  if (planHandler.includes('planOwnerSqlQuestion') && !planHandler.includes('executeOwnerReadOnlySql')) {
    pass('E3', 'plan handler does not execute SQL');
  } else fail('E3', 'plan handler must not execute SQL');

  const planRouter = apiSrc.slice(
    apiSrc.indexOf('/staff/owner/sql/plan'),
    apiSrc.indexOf('/staff/owner/sql/plan') + 400,
  );
  if (/requireAuth\(req, res, 'operator'\)/.test(planRouter)) {
    pass('E4', 'plan route requires operator+ auth');
  } else fail('E4', 'plan route auth missing');

  section('F. Untouched guest WhatsApp modules');

  for (const f of UNTOUCHED) {
    const base = path.basename(f);
    const src = readOrEmpty(f);
    if (src && !src.includes('owner-sql-planner')) {
      pass(`F.${base}`, `${base} unchanged by 25f`);
    } else if (!src) {
      pass(`F.${base}`, `${base} not present (skip)`);
    } else {
      fail(`F.${base}`, `${base} touched unexpectedly`);
    }
  }

  section('G. Docs + npm script');

  if (fs.existsSync(DOC)) pass('G1', 'PHASE-25f-OWNER-SQL-PLANNER.md exists');
  else fail('G1', 'doc missing');

  const doc = readOrEmpty(DOC);
  if (/dry-run|no execution|25g|no WhatsApp/i.test(doc)) {
    pass('G2', 'doc covers dry-run, 25g, no WhatsApp');
  } else fail('G2', 'doc incomplete');

  const pkg = JSON.parse(readOrEmpty(PKG) || '{}');
  if (pkg.scripts && pkg.scripts['verify:luna-agent-phase25-owner-sql-planner']) {
    pass('G3', 'npm script registered');
  } else fail('G3', 'npm script missing');

  section('H. Downstream scripts listed (not run)');

  for (const s of DOWNSTREAM) {
    if (pkg.scripts && pkg.scripts[s]) pass('H', `downstream registered: ${s}`);
    else fail('H', `downstream missing: ${s}`);
  }

  console.log(`\n${'─'.repeat(60)}`);
  if (failures === 0) {
    console.log(`PASS  (${passes} checks)`);
    process.exit(0);
  }
  console.error(`FAIL  (${failures} failed, ${passes} passed)`);
  process.exit(1);
})().catch((err) => {
  console.error('Verifier runtime error:', err);
  process.exit(1);
});
