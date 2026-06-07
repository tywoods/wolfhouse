/**
 * Phase 24a/24b — Verifier for scripts/lib/luna-ai-provider.js and Ask Luna module wiring.
 *
 * Usage:
 *   npm run verify:luna-ai-provider
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROVIDER_FILE  = path.join(__dirname, 'lib', 'luna-ai-provider.js');
const INTENT_FILE    = path.join(__dirname, 'lib', 'staff-ask-luna-ai-intent.js');
const FORMATTER_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-ai-answer-format.js');
const PLANNER_FILE   = path.join(__dirname, 'lib', 'staff-ask-luna-multi-tool-planner.js');
const PKG_FILE       = path.join(__dirname, '..', 'package.json');

const GUEST_UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'),
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-guest-message-intake.js'),
];

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

console.log('\nverify-luna-ai-provider.js  (Phase 24a/24b)\n');

for (const f of [PROVIDER_FILE, INTENT_FILE, FORMATTER_FILE, PLANNER_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

try {
  execSync(`node --check "${PROVIDER_FILE}"`, { stdio: 'ignore' });
  execSync(`node --check "${INTENT_FILE}"`, { stdio: 'ignore' });
  execSync(`node --check "${FORMATTER_FILE}"`, { stdio: 'ignore' });
  execSync(`node --check "${PLANNER_FILE}"`, { stdio: 'ignore' });
  ok('provider + Ask Luna AI modules pass node --check');
} catch (_) {
  fail('provider + Ask Luna AI modules pass node --check');
}

const intentSrc = fs.readFileSync(INTENT_FILE, 'utf8');
const fmtSrc = fs.readFileSync(FORMATTER_FILE, 'utf8');
const plSrc = fs.readFileSync(PLANNER_FILE, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

check(
  pkg.scripts && pkg.scripts['verify:luna-ai-provider'] === 'node scripts/verify-luna-ai-provider.js',
  'package.json verify:luna-ai-provider script',
);

console.log('\nA. Intent wiring');

check(intentSrc.includes("require('./luna-ai-provider')"), 'staff-ask-luna-ai-intent imports luna-ai-provider');
check(intentSrc.includes('callLunaAiJsonChat'), 'intent uses callLunaAiJsonChat');
check(intentSrc.includes("call_label: 'classifier'"), 'intent passes call_label=classifier');
check(!intentSrc.includes('api.openai.com/v1/chat/completions'), 'intent no longer inlines OpenAI URL');
check(!intentSrc.includes('api.anthropic.com/v1/messages'), 'intent no longer inlines Anthropic URL');

console.log('\nA2. Answer formatter wiring (24b)');

check(fmtSrc.includes("require('./luna-ai-provider')"), 'answer formatter imports luna-ai-provider');
check(fmtSrc.includes('callLunaAiJsonChat'), 'answer formatter uses callLunaAiJsonChat');
check(fmtSrc.includes("call_label: 'answer_formatter'"), 'formatter passes call_label=answer_formatter');
check(!fmtSrc.includes('callOpenAiFormatter'), 'callOpenAiFormatter removed');
check(!fmtSrc.includes('callAnthropicFormatter'), 'callAnthropicFormatter removed');
check(!fmtSrc.includes('api.openai.com/v1/chat/completions'), 'formatter no longer inlines OpenAI URL');
check(!fmtSrc.includes('api.anthropic.com/v1/messages'), 'formatter no longer inlines Anthropic URL');
check(fmtSrc.includes('buildBalanceDueFormatterSystemPrompt'), 'formatter prompt preserved');
check(fmtSrc.includes('validateBalanceDueFormatterOutput'), 'formatter validation preserved');

console.log('\nA3. Multi-tool planner wiring (24b)');

check(plSrc.includes("require('./luna-ai-provider')"), 'multi-tool planner imports luna-ai-provider');
check(plSrc.includes('callLunaAiJsonChat'), 'multi-tool planner uses callLunaAiJsonChat');
check(plSrc.includes("call_label: 'multi_tool_planner'"), 'planner passes call_label=multi_tool_planner');
check(!plSrc.includes('callOpenAiPlanner'), 'callOpenAiPlanner removed');
check(!plSrc.includes('callAnthropicPlanner'), 'callAnthropicPlanner removed');
check(!plSrc.includes('api.openai.com/v1/chat/completions'), 'planner no longer inlines OpenAI URL');
check(!plSrc.includes('api.anthropic.com/v1/messages'), 'planner no longer inlines Anthropic URL');
check(plSrc.includes('parseAndValidatePlannerOutput'), 'planner validation preserved');
check(plSrc.includes('buildPlannerSystemPrompt'), 'planner prompt preserved');

console.log('\nB. Guest path untouched');

for (const f of GUEST_UNTOUCHED) {
  const src = fs.readFileSync(f, 'utf8');
  check(!src.includes('luna-ai-provider'), `${path.basename(f)} has no luna-ai-provider import`);
}

const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
check(
  apiSrc.includes('resolveLunaAiDiagnostics') && !apiSrc.includes('callLunaAiJsonChat'),
  'staff-query-api imports Luna AI diagnostics only (no direct AI calls)',
);
check(!/luna-guest-reply-draft[\s\S]{0,200}luna-ai-provider/.test(apiSrc), 'guest reply path unchanged');

console.log('\nC. Provider resolution');

const {
  resolveLunaAiProvider,
  resolveLunaAiDiagnostics,
  callLunaAiJsonChat,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_ANTHROPIC_MODEL,
  OPENAI_CHAT_URL,
  ANTHROPIC_MESSAGES_URL,
} = require('./lib/luna-ai-provider');

function env(overrides) {
  return Object.assign({}, overrides);
}

const openaiOnly = resolveLunaAiProvider(env({
  OPENAI_API_KEY: 'sk-test-openai',
}));
check(openaiOnly.enabled === true && openaiOnly.provider === 'openai', 'OpenAI default when OpenAI key exists');
check(openaiOnly.model === DEFAULT_OPENAI_MODEL, 'OpenAI default model when unset');

const bothKeys = resolveLunaAiProvider(env({
  OPENAI_API_KEY: 'sk-test-openai',
  ANTHROPIC_API_KEY: 'sk-ant-test',
}));
check(bothKeys.provider === 'openai', 'OpenAI default when both keys exist and no provider set');

const anthropicExplicit = resolveLunaAiProvider(env({
  LUNA_AI_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  OPENAI_API_KEY: 'sk-test-openai',
}));
check(
  anthropicExplicit.provider === 'anthropic' && anthropicExplicit.enabled,
  'Anthropic when LUNA_AI_PROVIDER=anthropic',
);

const staffAlias = resolveLunaAiProvider(env({
  STAFF_ASK_LUNA_AI_PROVIDER: 'anthropic',
  STAFF_ASK_LUNA_ANTHROPIC_API_KEY: 'sk-ant-alias',
}));
check(staffAlias.provider === 'anthropic' && staffAlias.enabled, 'STAFF_ASK_LUNA_* provider alias works');

const modelOverride = resolveLunaAiProvider(env({
  OPENAI_API_KEY: 'sk-test',
  LUNA_AI_MODEL: 'gpt-4o',
}));
check(modelOverride.model === 'gpt-4o', 'LUNA_AI_MODEL overrides default');

const staffModel = resolveLunaAiProvider(env({
  OPENAI_API_KEY: 'sk-test',
  STAFF_ASK_LUNA_AI_MODEL: 'gpt-test-staff',
}));
check(staffModel.model === 'gpt-test-staff', 'STAFF_ASK_LUNA_AI_MODEL fallback works');

const lunaModelWins = resolveLunaAiProvider(env({
  OPENAI_API_KEY: 'sk-test',
  LUNA_AI_MODEL: 'gpt-luna',
  STAFF_ASK_LUNA_AI_MODEL: 'gpt-test-staff',
}));
check(lunaModelWins.model === 'gpt-luna', 'LUNA_AI_MODEL wins over STAFF_ASK_LUNA_AI_MODEL');

const openaiModelEnv = resolveLunaAiProvider(env({
  OPENAI_API_KEY: 'sk-test',
  OPENAI_MODEL: 'gpt-from-openai-env',
}));
check(openaiModelEnv.model === 'gpt-from-openai-env', 'OPENAI_MODEL fallback works');

const noKeys = resolveLunaAiProvider(env({}));
check(noKeys.enabled === false && noKeys.provider === null, 'disabled gracefully when no keys');

const lunaWins = resolveLunaAiProvider(env({
  LUNA_AI_PROVIDER: 'openai',
  STAFF_ASK_LUNA_AI_PROVIDER: 'anthropic',
  OPENAI_API_KEY: 'sk-test',
  ANTHROPIC_API_KEY: 'sk-ant',
}));
check(lunaWins.provider === 'openai', 'LUNA_AI_PROVIDER wins over STAFF_ASK_LUNA_AI_PROVIDER');

console.log('\nD. HTTP endpoints (mocked fetch)');

(async function runFetchTests() {
  let lastUrl = '';
  let lastBody = null;

  async function mockFetch(url, init) {
    lastUrl = url;
    lastBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => {
        if (url.includes('openai.com')) {
          return { choices: [{ message: { content: '{"intent":"payments.balance_due","confidence":0.9,"reason":"ok"}' } }] };
        }
        return { content: [{ type: 'text', text: '{"intent":"payments.balance_due","confidence":0.9,"reason":"ok"}' }] };
      },
      text: async () => '',
    };
  }

  await callLunaAiJsonChat({
    env: env({ OPENAI_API_KEY: 'sk-test' }),
    system: 'sys',
    user: 'who owes money',
    jsonObject: true,
    fetchImpl: mockFetch,
  });
  check(lastUrl === OPENAI_CHAT_URL, 'OpenAI call uses /v1/chat/completions');
  check(lastBody && lastBody.response_format && lastBody.response_format.type === 'json_object', 'OpenAI json_object mode');

  await callLunaAiJsonChat({
    env: env({ LUNA_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant' }),
    system: 'sys',
    user: 'test',
    fetchImpl: mockFetch,
  });
  check(lastUrl === ANTHROPIC_MESSAGES_URL, 'Anthropic call uses /v1/messages');

  const disabled = await callLunaAiJsonChat({
    env: env({}),
    system: 'sys',
    user: 'test',
    fetchImpl: mockFetch,
  });
  check(disabled === null, 'no network when provider disabled');

  console.log('\nE. Auto-enable intent when key present');

  const { isAskLunaAiEnabled } = require('./lib/staff-ask-luna-ai-intent');
  const prev = {
    STAFF_ASK_LUNA_AI_ENABLED: process.env.STAFF_ASK_LUNA_AI_ENABLED,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  delete process.env.STAFF_ASK_LUNA_AI_ENABLED;
  process.env.OPENAI_API_KEY = 'sk-test-auto';
  check(isAskLunaAiEnabled(), 'Ask Luna AI enabled when OPENAI_API_KEY set and flag unset');
  process.env.STAFF_ASK_LUNA_AI_ENABLED = 'false';
  check(!isAskLunaAiEnabled(), 'STAFF_ASK_LUNA_AI_ENABLED=false still disables');
  if (prev.STAFF_ASK_LUNA_AI_ENABLED != null) process.env.STAFF_ASK_LUNA_AI_ENABLED = prev.STAFF_ASK_LUNA_AI_ENABLED;
  else delete process.env.STAFF_ASK_LUNA_AI_ENABLED;
  if (prev.OPENAI_API_KEY != null) process.env.OPENAI_API_KEY = prev.OPENAI_API_KEY;
  else delete process.env.OPENAI_API_KEY;

  console.log('\nF. Answer formatter + planner via shared provider (mocked)');

  const {
    buildBalanceDueFormatterSummary,
    formatBalanceDueAnswerNatural,
  } = require('./lib/staff-ask-luna-ai-answer-format');
  const {
    OPS_PLANNER_TOOL_ALLOWLIST,
    classifyOpsPlannerWithAi,
    parseAndValidatePlannerOutput,
  } = require('./lib/staff-ask-luna-multi-tool-planner');

  const sampleRows = [{
    guest_name: 'Jimmy',
    booking_code: 'DEMO-R1',
    check_in: '2026-06-19',
    check_out: '2026-06-25',
    bed_summary: 'DEMO-R1',
    balance_due_cents: 30000,
    payment_state_label: 'Deposit paid / Link sent',
  }];
  const summary = buildBalanceDueFormatterSummary(sampleRows);
  const mockFmtAnswer = [
    'There is 1 active booking with money still owed.',
    '',
    'Jimmy still owes €300 for Jun 19–25 in DEMO-R1. Deposit paid / Link sent.',
    '',
    'Total outstanding: €300.',
  ].join('\n');

  const fmtViaProvider = await callLunaAiJsonChat({
    env: env({ OPENAI_API_KEY: 'sk-test' }),
    system: 'format test',
    user: JSON.stringify(summary),
    temperature: 0.2,
    maxTokens: 512,
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: mockFmtAnswer } }] }),
      text: async () => '',
    }),
  });
  check(fmtViaProvider === mockFmtAnswer, 'formatter OpenAI mocked through shared provider');

  let plannerFetchUrl = '';
  const plannerJson = JSON.stringify({
    tool_intents: ['bookings.arrivals_today', 'payments.balance_due'],
    confidence: 0.92,
    reason: 'Today ops summary.',
  });
  const plannerRaw = await callLunaAiJsonChat({
    env: env({ LUNA_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant' }),
    system: 'planner test',
    user: 'What should I prepare for today?',
    jsonObject: true,
    fetchImpl: async (url, init) => {
      plannerFetchUrl = url;
      return {
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: plannerJson }] }),
        text: async () => '',
      };
    },
  });
  check(plannerFetchUrl === ANTHROPIC_MESSAGES_URL, 'planner Anthropic path via shared provider');
  const parsedPlanner = parseAndValidatePlannerOutput(plannerRaw, OPS_PLANNER_TOOL_ALLOWLIST);
  check(
    parsedPlanner && parsedPlanner.tool_intents.length === 2 && parsedPlanner.confidence === 0.92,
    'planner output shape compatible after shared provider',
  );

  process.env.STAFF_ASK_LUNA_AI_ENABLED = 'false';
  const fmtDisabled = await formatBalanceDueAnswerNatural(sampleRows);
  check(fmtDisabled.answer_format_source === 'deterministic', 'formatter disabled → deterministic fallback');
  const plannerDisabled = await classifyOpsPlannerWithAi('Give me today\'s ops summary', { when: 'today' });
  check(plannerDisabled === null, 'planner disabled → null fallback');
  delete process.env.STAFF_ASK_LUNA_AI_ENABLED;

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  fail(`async tests: ${err.message}`);
  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(1);
});
