'use strict';

/**
 * Fixture-only verifier for Sunset Hermes Crowsnest AI-usage identity (Slice B1).
 * Pure offline checks — no network, DB, Azure, provider, or ledger writes.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'crowsnest-sunset-ai-usage-identity');
const MODULE_REL = 'scripts/lib/crowsnest/crowsnest-sunset-ai-usage-identity.js';
const MODULE_PATH = path.join(ROOT, MODULE_REL);
const CONTRACT_REL = 'scripts/lib/crowsnest/crowsnest-ai-usage-contract.js';
const CONTRACT_PATH = path.join(ROOT, CONTRACT_REL);
const ARCH_DOC = path.join(ROOT, 'docs', 'architecture', 'crowsnest-ai-usage-runtime-attribution.md');
const COMPOSE_PATH = path.join(ROOT, 'docker', 'hermes-sunset', 'docker-compose.vm.yml');
const BOOTSTRAP_STAGING = path.join(ROOT, 'docker', 'hermes-staging', 'bootstrap.sh');
const BOOTSTRAP_SUNSET = path.join(ROOT, 'docker', 'hermes-sunset', 'bootstrap.sh');
const PKG_PATH = path.join(ROOT, 'package.json');
const VERIFY_SCRIPT_REL = 'scripts/verify-crowsnest-sunset-ai-usage-identity.js';
const PATCH_PATH = path.join(ROOT, 'docker', 'hermes-staging', 'apply_gateway_patches.py');
const REPORTER_PATH = path.join(ROOT, 'docker', 'hermes-staging', 'wolfhouse', 'crowsnest_ai_usage_reporter.py');
const AI_USAGE_ENV_NAMES = [
  'CROWSNEST_AI_USAGE_INGEST_URL',
  'CROWSNEST_AI_USAGE_INGEST_TOKEN',
  'CROWSNEST_AI_USAGE_CLIENT_SLUG',
  'CROWSNEST_AI_USAGE_TENANT_ID',
  'CROWSNEST_AI_USAGE_SOURCE_SERVICE',
];

const {
  ENV_CLIENT_SLUG,
  ENV_TENANT_ID,
  FORBIDDEN_LOGICAL_SLUG,
  SAFE_ID_RE,
  resolveSunsetHermesAiUsageIdentity,
} = require('./lib/crowsnest/crowsnest-sunset-ai-usage-identity');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail ? `— ${detail}` : '');
  }
}

function readJson(abs) {
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

function listFixtures() {
  return fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json')).sort();
}

function collectStringLeaves(node, out = []) {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStringLeaves(item, out);
    return out;
  }
  if (node != null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      out.push(key);
      collectStringLeaves(value, out);
    }
  }
  return out;
}

function resultMentionsIdentityValues(result, env) {
  const leaves = collectStringLeaves(result);
  const watched = [
    env[ENV_CLIENT_SLUG],
    env[ENV_TENANT_ID],
  ].filter((v) => typeof v === 'string' && v.trim() !== '');
  for (const value of watched) {
    if (result.ok === true) {
      // Success result intentionally carries the validated identity fields.
      continue;
    }
    if (leaves.some((leaf) => leaf.includes(value))) return true;
  }
  if (result.ok === false) {
    const reason = String(result.reason || '');
    for (const value of watched) {
      if (value && reason.includes(value)) return true;
    }
  }
  return false;
}

console.log('\nverify:crowsnest-sunset-ai-usage-identity — Slice B1\n');

console.log('[1] module exports + contract alignment');
ok('module file exists', fs.existsSync(MODULE_PATH));
ok('env client key name', ENV_CLIENT_SLUG === 'CROWSNEST_AI_USAGE_CLIENT_SLUG');
ok('env tenant key name', ENV_TENANT_ID === 'CROWSNEST_AI_USAGE_TENANT_ID');
ok('forbidden logical slug is sunset', FORBIDDEN_LOGICAL_SLUG === 'sunset');
ok('SAFE_ID_RE matches contract opaque rule', SAFE_ID_RE.source === '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
ok('resolver is a function', typeof resolveSunsetHermesAiUsageIdentity === 'function');

const moduleSrc = fs.readFileSync(MODULE_PATH, 'utf8');
for (const banned of [
  'fetch(',
  'require(\'pg\')',
  'require("pg")',
  'azure',
  'WOLFHOUSE_DATABASE_URL',
  'DATABASE_URL',
  'console.log',
  'console.info',
  'console.warn',
  'console.error',
  'DEFAULT_CLIENT_SLUG',
  'LUNA_CLIENT_SLUG',
  'LUNA_TENANT_ID',
  'recordCrowsnestAiUsageEvent',
  'validateCrowsnestAiUsageEvent',
  'adaptCrowsnestAiUsage',
]) {
  ok(`module source has no ${banned}`, !moduleSrc.includes(banned));
}

console.log('\n[2] fixture matrix');
const fixtures = listFixtures();
ok('fixture directory non-empty', fixtures.length >= 10, `count=${fixtures.length}`);

for (const name of fixtures) {
  const fixture = readJson(path.join(FIXTURE_DIR, name));
  const result = resolveSunsetHermesAiUsageIdentity({ env: fixture.env || {} });
  const expectOk = Boolean(fixture.expect && fixture.expect.ok);
  ok(`${name} ok===${expectOk}`, result.ok === expectOk, JSON.stringify(result));
  if (fixture.expect && fixture.expect.reason) {
    ok(
      `${name} reason`,
      result.ok === false && result.reason === fixture.expect.reason,
      `got ${result.reason}`,
    );
  }
  if (result.ok) {
    ok(
      `${name} frozen closed identity`,
      Object.isFrozen(result)
        && result.client_slug === fixture.env[ENV_CLIENT_SLUG]
        && result.tenant_id === fixture.env[ENV_TENANT_ID]
        && Object.keys(result).sort().join(',') === 'client_slug,ok,tenant_id',
    );
  } else {
    ok(
      `${name} safe unavailable shape`,
      Object.isFrozen(result)
        && result.ok === false
        && typeof result.reason === 'string'
        && result.reason.length > 0
        && !Object.prototype.hasOwnProperty.call(result, 'client_slug')
        && !Object.prototype.hasOwnProperty.call(result, 'tenant_id'),
    );
    ok(
      `${name} no identity values in safe output`,
      !resultMentionsIdentityValues(result, fixture.env || {}),
    );
  }
}

console.log('\n[3] no fallback to untrusted sources');
const poisonedOnly = resolveSunsetHermesAiUsageIdentity({
  env: {
    DEFAULT_CLIENT_SLUG: 'sunset',
    LUNA_CLIENT_SLUG: 'sunset',
    LUNA_TENANT_ID: 'sunset',
    GUEST_PHONE: '+34600111222',
    REQUEST_URL: 'https://example.invalid/whatsapp',
    GUEST_MESSAGE: 'hola',
    PROVIDER_USAGE: '{"total_tokens":1}',
  },
});
ok('untrusted-only env fails closed', poisonedOnly.ok === false);

const withOverride = resolveSunsetHermesAiUsageIdentity({
  env: {
    [ENV_CLIENT_SLUG]: 'cn_fixture_client_alpha',
    [ENV_TENANT_ID]: 'tn_fixture_tenant_beta',
  },
  client_slug: 'sunset',
  tenant_id: 'sunset',
  phone: '+34600111222',
});
ok('extra option keys rejected', withOverride.ok === false && withOverride.reason === 'untrusted_input_rejected');

const noOptions = resolveSunsetHermesAiUsageIdentity();
ok('missing options unavailable', noOptions.ok === false);

const emptyEnv = resolveSunsetHermesAiUsageIdentity({ env: {} });
ok('empty env unavailable', emptyEnv.ok === false && emptyEnv.reason === 'missing_client_slug');

const processEnvBackup = {
  [ENV_CLIENT_SLUG]: process.env[ENV_CLIENT_SLUG],
  [ENV_TENANT_ID]: process.env[ENV_TENANT_ID],
  DEFAULT_CLIENT_SLUG: process.env.DEFAULT_CLIENT_SLUG,
  LUNA_CLIENT_SLUG: process.env.LUNA_CLIENT_SLUG,
};
process.env.DEFAULT_CLIENT_SLUG = 'sunset';
process.env.LUNA_CLIENT_SLUG = 'sunset';
process.env[ENV_CLIENT_SLUG] = 'cn_should_not_be_read_from_process';
process.env[ENV_TENANT_ID] = 'tn_should_not_be_read_from_process';
const ignoresProcess = resolveSunsetHermesAiUsageIdentity({ env: {} });
ok(
  'does not read process.env when injected env empty',
  ignoresProcess.ok === false && ignoresProcess.reason === 'missing_client_slug',
);
if (processEnvBackup[ENV_CLIENT_SLUG] === undefined) delete process.env[ENV_CLIENT_SLUG];
else process.env[ENV_CLIENT_SLUG] = processEnvBackup[ENV_CLIENT_SLUG];
if (processEnvBackup[ENV_TENANT_ID] === undefined) delete process.env[ENV_TENANT_ID];
else process.env[ENV_TENANT_ID] = processEnvBackup[ENV_TENANT_ID];
if (processEnvBackup.DEFAULT_CLIENT_SLUG === undefined) delete process.env.DEFAULT_CLIENT_SLUG;
else process.env.DEFAULT_CLIENT_SLUG = processEnvBackup.DEFAULT_CLIENT_SLUG;
if (processEnvBackup.LUNA_CLIENT_SLUG === undefined) delete process.env.LUNA_CLIENT_SLUG;
else process.env.LUNA_CLIENT_SLUG = processEnvBackup.LUNA_CLIENT_SLUG;

console.log('\n[4] no fetch/pg/Azure/secret output surface');
const sandboxed = vm.runInNewContext(
  `${fs.readFileSync(MODULE_PATH, 'utf8')}\nmodule.exports`,
  {
    module: { exports: {} },
    exports: {},
    require(name) {
      throw new Error(`unexpected_require:${name}`);
    },
    console: {
      log() { throw new Error('console_forbidden'); },
      info() { throw new Error('console_forbidden'); },
      warn() { throw new Error('console_forbidden'); },
      error() { throw new Error('console_forbidden'); },
    },
    Object,
    Array,
    String,
    Boolean,
    RegExp,
    Object: Object,
  },
);
const sandboxResolve = sandboxed.resolveSunsetHermesAiUsageIdentity;
const sandboxOk = sandboxResolve({
  env: {
    [ENV_CLIENT_SLUG]: 'cn_fixture_client_alpha',
    [ENV_TENANT_ID]: 'tn_fixture_tenant_beta',
  },
});
ok('vm sandbox resolve succeeds without require/network', sandboxOk.ok === true);
const sandboxBad = sandboxResolve({
  env: {
    [ENV_CLIENT_SLUG]: 'sunset',
    [ENV_TENANT_ID]: 'tn_fixture_tenant_beta',
  },
});
ok(
  'vm sandbox failure omits values',
  sandboxBad.ok === false
    && !JSON.stringify(sandboxBad).includes('sunset')
    && !JSON.stringify(sandboxBad).includes('tn_fixture_tenant_beta'),
);

console.log('\n[5] deployment name wiring (names only)');
const compose = fs.readFileSync(COMPOSE_PATH, 'utf8');
const bootstrapStaging = fs.readFileSync(BOOTSTRAP_STAGING, 'utf8');
const bootstrapSunset = fs.readFileSync(BOOTSTRAP_SUNSET, 'utf8');
const archDoc = fs.readFileSync(ARCH_DOC, 'utf8');
const pkg = readJson(PKG_PATH);
const patchSrc = fs.readFileSync(PATCH_PATH, 'utf8');
const reporterSrc = fs.readFileSync(REPORTER_PATH, 'utf8');

ok('compose loads protected Sunset container env_file',
  /^\s*env_file:\s*$[\s\S]*?^\s*- \/etc\/hermes-sunset-luna\.env\s*$/m.test(compose));
for (const name of AI_USAGE_ENV_NAMES) {
  ok(`compose has no environment override for ${name}`, !compose.includes(name));
  ok(`staging bootstrap does not persist ${name} in HERMES_HOME`, !bootstrapStaging.includes(name));
  ok(`sunset bootstrap does not persist ${name} in HERMES_HOME`, !bootstrapSunset.includes(name));
}
const reporterEnvTuple = reporterSrc.match(/ENV_NAMES\s*=\s*\(([\s\S]*?)\n\)/);
const reporterNames = reporterEnvTuple
  ? [...reporterEnvTuple[1].matchAll(/"(CROWSNEST_AI_USAGE_[A-Z_]+)"/g)].map((match) => match[1])
  : [];
ok('reporter reads exactly the five authoritative Crowsnest names',
  JSON.stringify(reporterNames) === JSON.stringify(AI_USAGE_ENV_NAMES), JSON.stringify(reporterNames));
ok('compose does not hardcode sunset as AI usage identity value on those keys',
  !/CROWSNEST_AI_USAGE_CLIENT_SLUG:\s*sunset\b/.test(compose)
  && !/CROWSNEST_AI_USAGE_TENANT_ID:\s*sunset\b/.test(compose));
ok('arch doc names CLIENT_SLUG env', archDoc.includes('CROWSNEST_AI_USAGE_CLIENT_SLUG'));
ok('arch doc names TENANT_ID env', archDoc.includes('CROWSNEST_AI_USAGE_TENANT_ID'));
ok('arch doc names resolver owner module', archDoc.includes('crowsnest-sunset-ai-usage-identity'));
ok('arch doc requires Earthling Staff clients.id lookup',
  /Earthling/i.test(archDoc)
  && /public\.clients\.id/i.test(archDoc)
  && /slug=['"]sunset['"]/.test(archDoc));
ok('arch doc does not embed a UUID value assignment for Sunset',
  !/CROWSNEST_AI_USAGE_(CLIENT_SLUG|TENANT_ID)\s*=\s*[0-9a-fA-F]{8}-[0-9a-fA-F]{4}/.test(archDoc));
ok('package.json has verify script',
  pkg.scripts && pkg.scripts['verify:crowsnest-sunset-ai-usage-identity'] === `node ${VERIFY_SCRIPT_REL}`);
ok('B1 does not wire observer into gateway patches',
  !patchSrc.includes('crowsnest-sunset-ai-usage-identity')
  && !patchSrc.includes('resolveSunsetHermesAiUsageIdentity')
  && !patchSrc.includes('CROWSNEST_AI_USAGE_'));
ok('contract module still present', fs.existsSync(CONTRACT_PATH));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('OK verify-crowsnest-sunset-ai-usage-identity');
