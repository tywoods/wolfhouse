/**
 * Phase 24d — Verifier for Luna AI provider diagnostics hardening.
 *
 * Usage:
 *   npm run verify:luna-ai-provider-diagnostics
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROVIDER_FILE  = path.join(__dirname, 'lib', 'luna-ai-provider.js');
const INTENT_FILE    = path.join(__dirname, 'lib', 'staff-ask-luna-ai-intent.js');
const FORMATTER_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-ai-answer-format.js');
const PLANNER_FILE   = path.join(__dirname, 'lib', 'staff-ask-luna-multi-tool-planner.js');
const API_FILE       = path.join(__dirname, 'staff-query-api.js');
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

console.log('\nverify-luna-ai-provider-diagnostics.js  (Phase 24d)\n');

for (const f of [PROVIDER_FILE, INTENT_FILE, FORMATTER_FILE, PLANNER_FILE, API_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

try {
  execSync(`node --check "${PROVIDER_FILE}"`, { stdio: 'ignore' });
  ok('luna-ai-provider.js passes node --check');
} catch (_) {
  fail('luna-ai-provider.js passes node --check');
}

const intentSrc = fs.readFileSync(INTENT_FILE, 'utf8');
const fmtSrc = fs.readFileSync(FORMATTER_FILE, 'utf8');
const plSrc = fs.readFileSync(PLANNER_FILE, 'utf8');
const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

check(
  pkg.scripts && pkg.scripts['verify:luna-ai-provider-diagnostics']
    === 'node scripts/verify-luna-ai-provider-diagnostics.js',
  'package.json verify:luna-ai-provider-diagnostics script',
);

console.log('\nA. call_label wiring');

check(intentSrc.includes("call_label: 'classifier'"), 'classifier passes call_label=classifier');
check(fmtSrc.includes("call_label: 'answer_formatter'"), 'formatter passes call_label=answer_formatter');
check(plSrc.includes("call_label: 'multi_tool_planner'"), 'planner passes call_label=multi_tool_planner');

console.log('\nB. ai-status route (read-only, no network)');

check(apiSrc.includes('resolveLunaAiDiagnostics'), 'staff-query-api imports resolveLunaAiDiagnostics');
check(apiSrc.includes("pathname === '/staff/ask-luna/ai-status'"), 'ai-status route registered');
check(apiSrc.includes('handleAskLunaAiStatus'), 'handleAskLunaAiStatus handler present');
check(apiSrc.includes("requireAuth(req, res, 'viewer')"), 'ai-status uses viewer+ session auth');
check(!apiSrc.includes('callLunaAiJsonChat'), 'staff-query-api does not call OpenAI directly');

console.log('\nC. Guest path untouched');

for (const f of GUEST_UNTOUCHED) {
  const src = fs.readFileSync(f, 'utf8');
  check(!src.includes('luna-ai-provider'), `${path.basename(f)} has no luna-ai-provider import`);
}

console.log('\nD. Key precedence + trimming');

const {
  resolveLunaAiProvider,
  resolveLunaAiDiagnostics,
  hashKeyFingerprint,
  callLunaAiJsonChat,
  buildLunaAiHttpError,
} = require('./lib/luna-ai-provider');

function env(overrides) {
  return Object.assign({}, overrides);
}

const primaryKey = resolveLunaAiProvider(env({
  OPENAI_API_KEY: 'sk-primary',
  STAFF_ASK_LUNA_OPENAI_API_KEY: 'sk-staff',
}));
check(primaryKey.key_source === 'OPENAI_API_KEY', 'OPENAI_API_KEY wins over STAFF_ASK_LUNA_OPENAI_API_KEY');
check(primaryKey.apiKey === 'sk-primary', 'primary OpenAI key value selected internally');

const staffFallback = resolveLunaAiProvider(env({
  OPENAI_API_KEY: '   ',
  STAFF_ASK_LUNA_OPENAI_API_KEY: 'sk-staff-fallback',
}));
check(staffFallback.enabled === true, 'whitespace-only OPENAI_API_KEY treated as missing');
check(staffFallback.key_source === 'STAFF_ASK_LUNA_OPENAI_API_KEY', 'staff OpenAI alias used when generic absent');

const anthPrimary = resolveLunaAiProvider(env({
  LUNA_AI_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'sk-ant-primary',
  STAFF_ASK_LUNA_ANTHROPIC_API_KEY: 'sk-ant-staff',
}));
check(anthPrimary.key_source === 'ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY wins over staff alias');

const lunaModelWins = resolveLunaAiProvider(env({
  OPENAI_API_KEY: 'sk-test',
  LUNA_AI_MODEL: 'gpt-luna',
  STAFF_ASK_LUNA_AI_MODEL: 'gpt-staff',
  OPENAI_MODEL: 'gpt-openai-env',
}));
check(lunaModelWins.model === 'gpt-luna', 'LUNA_AI_MODEL wins over STAFF_ASK_LUNA_AI_MODEL');
check(lunaModelWins.model_source === 'LUNA_AI_MODEL', 'LUNA_AI_MODEL source recorded');

const lunaProviderWins = resolveLunaAiProvider(env({
  LUNA_AI_PROVIDER: 'openai',
  STAFF_ASK_LUNA_AI_PROVIDER: 'anthropic',
  OPENAI_API_KEY: 'sk-test',
  ANTHROPIC_API_KEY: 'sk-ant',
}));
check(lunaProviderWins.provider === 'openai', 'LUNA_AI_PROVIDER wins over STAFF_ASK_LUNA_AI_PROVIDER');
check(lunaProviderWins.provider_source === 'LUNA_AI_PROVIDER', 'LUNA_AI_PROVIDER source recorded');

const trimmedKey = resolveLunaAiProvider(env({
  OPENAI_API_KEY: '  sk-trimmed  ',
}));
check(trimmedKey.apiKey === 'sk-trimmed', 'API key trimmed before use');

const noKeys = resolveLunaAiProvider(env({}));
check(noKeys.enabled === false && noKeys.key_present === false, 'no keys → disabled with key_present false');

console.log('\nE. Diagnostic metadata (no secret leakage)');

const diag = resolveLunaAiDiagnostics(env({
  OPENAI_API_KEY: 'sk-diag-test-key',
  LUNA_AI_PROVIDER: 'openai',
  LUNA_AI_MODEL: 'gpt-4o-mini',
}));
check(diag.enabled === true, 'diagnostics enabled when configured');
check(diag.provider === 'openai' && diag.model === 'gpt-4o-mini', 'diagnostics include provider/model');
check(diag.key_present === true && diag.key_source === 'OPENAI_API_KEY', 'diagnostics include key_source');
check(diag.key_length === 'sk-diag-test-key'.length, 'diagnostics include key_length');
check(diag.key_fingerprint === hashKeyFingerprint('sk-diag-test-key'), 'diagnostics include key_fingerprint');
check(!JSON.stringify(diag).includes('sk-diag-test-key'), 'diagnostics JSON does not include raw key');

console.log('\nF. HTTP error shape + fallback (mocked)');

(async function runAsyncTests() {
  let capturedAuth = '';
  const cfgEnv = env({ OPENAI_API_KEY: 'sk-test-error', LUNA_AI_MODEL: 'gpt-4o-mini' });

  try {
    await callLunaAiJsonChat({
      env: cfgEnv,
      system: 'sys',
      user: 'test',
      call_label: 'classifier',
      fetchImpl: async (_url, init) => {
        capturedAuth = init.headers.Authorization;
        return {
          ok: false,
          status: 401,
          text: async () => JSON.stringify({
            error: { type: 'invalid_request_error', message: 'Incorrect API key provided' },
          }),
        };
      },
    });
    fail('mock OpenAI 401 should throw');
  } catch (err) {
    check(err.name === 'LunaAiHttpError', '401 throws LunaAiHttpError');
    check(err.message.includes('OpenAI HTTP 401'), 'error message includes status');
    check(err.message.includes('call_label=classifier'), 'error message includes call_label');
    check(err.message.includes('provider=openai'), 'error message includes provider');
    check(err.message.includes('model=gpt-4o-mini'), 'error message includes model');
    check(err.message.includes('key_source=OPENAI_API_KEY'), 'error message includes key_source');
    check(err.message.includes('key_fingerprint='), 'error message includes key_fingerprint');
    check(err.message.includes('type=invalid_request_error'), 'error message includes OpenAI error type');
    check(!err.message.includes('sk-test-error'), 'error message excludes raw key');
    check(err.lunaAi && err.lunaAi.status === 401, 'error object includes lunaAi.status');
    check(capturedAuth === 'Bearer sk-test-error', 'Authorization uses trimmed resolved key');
  }

  const manualErr = buildLunaAiHttpError('OpenAI', 401, resolveLunaAiProvider(cfgEnv), 'answer_formatter', '{"error":{"type":"auth","message":"bad"}}');
  check(manualErr.message.includes('call_label=answer_formatter'), 'buildLunaAiHttpError includes call_label');

  const { classifyAskLunaIntentWithAi } = require('./lib/staff-ask-luna-ai-intent');
  const { formatBalanceDueAnswerNatural } = require('./lib/staff-ask-luna-ai-answer-format');
  const { classifyOpsPlannerWithAi } = require('./lib/staff-ask-luna-multi-tool-planner');

  const sampleRows = [{
    guest_name: 'Jimmy',
    booking_code: 'DEMO-R1',
    check_in: '2026-06-19',
    check_out: '2026-06-25',
    bed_summary: 'DEMO-R1',
    balance_due_cents: 30000,
    payment_state_label: 'Deposit paid / Link sent',
  }];

  const mock401Provider = async () => {
    throw buildLunaAiHttpError(
      'OpenAI',
      401,
      resolveLunaAiProvider(cfgEnv),
      'answer_formatter',
      '{"error":{"type":"invalid_request_error","message":"Incorrect API key provided"}}',
    );
  };

  const fmtFallback = await formatBalanceDueAnswerNatural(sampleRows, { provider: mock401Provider });
  check(fmtFallback.answer_format_source === 'deterministic', 'formatter 401 → deterministic fallback');

  const plannerFallback = await classifyOpsPlannerWithAi('What should I prepare for tomorrow?', {
    when: 'tomorrow',
    provider: async () => {
      throw buildLunaAiHttpError(
        'OpenAI',
        401,
        resolveLunaAiProvider(cfgEnv),
        'multi_tool_planner',
        '{"error":{"type":"invalid_request_error","message":"Incorrect API key provided"}}',
      );
    },
  });
  check(plannerFallback === null, 'planner 401 → null fallback');

  const classifierFallback = await classifyAskLunaIntentWithAi('Who has not settled up yet?', {
    provider: async () => {
      throw buildLunaAiHttpError(
        'OpenAI',
        401,
        resolveLunaAiProvider(cfgEnv),
        'classifier',
        '{"error":{"type":"invalid_request_error","message":"Incorrect API key provided"}}',
      );
    },
  });
  check(classifierFallback === null, 'classifier 401 → null fallback');

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  fail(`async tests: ${err.message}`);
  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(1);
});
