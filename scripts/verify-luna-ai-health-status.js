/**
 * Phase 24e — Verifier for Luna AI health/status visibility.
 *
 * Usage:
 *   npm run verify:luna-ai-health-status
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROVIDER_FILE = path.join(__dirname, 'lib', 'luna-ai-provider.js');
const API_FILE      = path.join(__dirname, 'staff-query-api.js');
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

console.log('\nverify-luna-ai-health-status.js  (Phase 24e)\n');

for (const f of [PROVIDER_FILE, API_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

try {
  execSync(`node --check "${PROVIDER_FILE}"`, { stdio: 'ignore' });
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('provider + staff-query-api pass node --check');
} catch (_) {
  fail('provider + staff-query-api pass node --check');
}

check(
  pkg.scripts && pkg.scripts['verify:luna-ai-health-status']
    === 'node scripts/verify-luna-ai-health-status.js',
  'package.json verify:luna-ai-health-status script',
);

console.log('\nA. /healthz wiring');

check(apiSrc.includes('resolveLunaAiHealthSummary'), 'staff-query-api imports resolveLunaAiHealthSummary');
check(apiSrc.includes('luna_ai:      resolveLunaAiHealthSummary(process.env)'), '/healthz includes luna_ai summary');
check(!apiSrc.includes('callLunaAiJsonChat'), 'healthz path does not call OpenAI');

console.log('\nB. ai-status auth preserved');

check(apiSrc.includes("pathname === '/staff/ask-luna/ai-status'"), 'ai-status route still registered');
check(apiSrc.includes("requireAuth(req, res, 'viewer')"), 'ai-status still requires viewer+ session auth');
check(apiSrc.includes('handleAskLunaAiStatus'), 'handleAskLunaAiStatus handler preserved');

console.log('\nC. Guest path untouched');

for (const f of GUEST_UNTOUCHED) {
  const src = fs.readFileSync(f, 'utf8');
  check(!src.includes('luna-ai-provider'), `${path.basename(f)} has no luna-ai-provider import`);
}

console.log('\nD. Health summary shape (no secrets)');

const {
  resolveLunaAiHealthSummary,
  resolveLunaAiDiagnostics,
  hashKeyFingerprint,
} = require('./lib/luna-ai-provider');

const TEST_KEY = 'sk-test-health-summary-key-24e';

const summary = resolveLunaAiHealthSummary({
  OPENAI_API_KEY: TEST_KEY,
  LUNA_AI_PROVIDER: 'openai',
  LUNA_AI_MODEL: 'gpt-4o-mini',
});

check(summary.configured === true, 'luna_ai.configured true when key exists');
check(summary.provider === 'openai', 'provider shown');
check(summary.model === 'gpt-4o-mini', 'model shown');
check(summary.key_present === true, 'key_present shown');
check(summary.key_source === 'OPENAI_API_KEY', 'key_source shown');
check(summary.key_fingerprint === hashKeyFingerprint(TEST_KEY), 'key_fingerprint shown');
check(summary.key_fingerprint && summary.key_fingerprint.length === 8, 'key_fingerprint is 8 chars only');
check(summary.key_length === undefined, 'key_length omitted from public health summary');

const json = JSON.stringify(summary);
check(!json.includes(TEST_KEY), 'raw key value not present in health summary JSON');
check(!json.includes(TEST_KEY.slice(0, 10)), 'key prefix not present');
check(!json.includes(TEST_KEY.slice(-8)), 'key suffix not present');

const disabled = resolveLunaAiHealthSummary({});
check(disabled.configured === false && disabled.key_present === false, 'configured false when no key');

const rich = resolveLunaAiDiagnostics({
  OPENAI_API_KEY: TEST_KEY,
  LUNA_AI_PROVIDER: 'openai',
});
check(rich.key_length === TEST_KEY.length, 'authenticated diagnostics still include key_length');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
