/**
 * Phase 24a — Verifier for scripts/lib/luna-ai-provider.js
 *
 * Usage:
 *   npm run verify:luna-ai-provider
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROVIDER_FILE = path.join(__dirname, 'lib', 'luna-ai-provider.js');
const INTENT_FILE   = path.join(__dirname, 'lib', 'staff-ask-luna-ai-intent.js');
const PKG_FILE      = path.join(__dirname, '..', 'package.json');

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

console.log('\nverify-luna-ai-provider.js  (Phase 24a)\n');

for (const f of [PROVIDER_FILE, INTENT_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

try {
  execSync(`node --check "${PROVIDER_FILE}"`, { stdio: 'ignore' });
  execSync(`node --check "${INTENT_FILE}"`, { stdio: 'ignore' });
  ok('provider + intent pass node --check');
} catch (_) {
  fail('provider + intent pass node --check');
}

const intentSrc = fs.readFileSync(INTENT_FILE, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

check(
  pkg.scripts && pkg.scripts['verify:luna-ai-provider'] === 'node scripts/verify-luna-ai-provider.js',
  'package.json verify:luna-ai-provider script',
);

console.log('\nA. Intent wiring');

check(intentSrc.includes("require('./luna-ai-provider')"), 'staff-ask-luna-ai-intent imports luna-ai-provider');
check(intentSrc.includes('callLunaAiJsonChat'), 'intent uses callLunaAiJsonChat');
check(!intentSrc.includes('api.openai.com/v1/chat/completions'), 'intent no longer inlines OpenAI URL');
check(!intentSrc.includes('api.anthropic.com/v1/messages'), 'intent no longer inlines Anthropic URL');

console.log('\nB. Guest path untouched');

for (const f of GUEST_UNTOUCHED) {
  const src = fs.readFileSync(f, 'utf8');
  check(!src.includes('luna-ai-provider'), `${path.basename(f)} has no luna-ai-provider import`);
}

const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
check(!apiSrc.includes('luna-ai-provider'), 'staff-query-api.js does not import luna-ai-provider directly');
check(!/luna-guest-reply-draft[\s\S]{0,200}luna-ai-provider/.test(apiSrc), 'guest reply path unchanged');

console.log('\nC. Provider resolution');

const {
  resolveLunaAiProvider,
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

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  fail(`async tests: ${err.message}`);
  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(1);
});
