'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const rel = (...parts) => path.join(root, ...parts);
const read = file => fs.readFileSync(file, 'utf8');
const IMAGE_RE = /^[^\s@:]+(?:\/[^\s@:]+)*@sha256:[a-f0-9]{64}$/;
const REQUIRED_FLAGS = {
  STRIPE_MODE: 'test',
  WHATSAPP_DRY_RUN: 'true',
  LUNA_AUTO_SEND_ENABLED: 'false',
  CUSTOMER_OUTREACH_WHATSAPP_ENABLED: 'false',
};
const SERVICE_CONTRACT = {
  postgres: { container: 'wolfhouse-prod-postgres', memory: 1024 * 1024 * 1024, manifest: ['runtimeImages', 'postgres'] },
  'staff-api': { container: 'wolfhouse-prod-staff-api', memory: 768 * 1024 * 1024, manifest: ['build', 'staffApiImage'], flags: REQUIRED_FLAGS },
  luna: { container: 'wolfhouse-prod-luna', memory: 1536 * 1024 * 1024, manifest: ['build', 'lunaImage'], flags: {
    WHATSAPP_DRY_RUN: 'true',
    LUNA_AUTO_SEND_ENABLED: 'false',
    CUSTOMER_OUTREACH_WHATSAPP_ENABLED: 'false',
  } },
  ingress: { container: 'wolfhouse-prod-ingress', memory: 128 * 1024 * 1024, manifest: ['runtimeImages', 'nginx'] },
};
const ALLOWED_SERVICES = new Set(Object.keys(SERVICE_CONTRACT));
const ALLOWED_FIELDS = new Set([
  'STRIPE_MODE',
  'WHATSAPP_DRY_RUN',
  'LUNA_AUTO_SEND_ENABLED',
  'CUSTOMER_OUTREACH_WHATSAPP_ENABLED',
  'container_name',
  'image',
  'mem_limit',
  'memswap_limit',
  'SOURCE_SHA',
  'STAFF_API_IMAGE',
  'LUNA_IMAGE',
  'POSTGRES_IMAGE',
  'NGINX_IMAGE',
  'name',
  'network',
  'ports',
]);

class GateError extends Error {
  constructor(code, extras) {
    super(code);
    this.name = 'GateError';
    this.code = code;
    const extra = extras || {};
    this.service = ALLOWED_SERVICES.has(extra.service) ? extra.service : undefined;
    this.field = ALLOWED_FIELDS.has(extra.field) ? extra.field : undefined;
  }
}

function fail(code, extras) {
  throw new GateError(code, extras);
}

function formatGateFailure(error) {
  if (!(error instanceof GateError)) return 'FAIL Wolfhouse production release gate: GATE_INTERNAL';
  const parts = ['FAIL Wolfhouse production release gate:', error.code];
  if (error.service) parts.push(`service=${error.service}`);
  if (error.field) parts.push(`field=${error.field}`);
  return parts.join(' ');
}

function parseEnv(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at <= 0) fail('RELEASE_ENV_INVALID_LINE');
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[key] = value;
  }
  return env;
}

function manifestValue(manifest, keys) {
  return keys.reduce((value, key) => value && value[key], manifest);
}

function normalizedEnvironment(value) {
  if (!value) return {};
  if (!Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, String(val)]));
  return Object.fromEntries(value.map(item => {
    const at = item.indexOf('=');
    return [item.slice(0, at), item.slice(at + 1)];
  }));
}

function validateRelease({ config, releaseEnv, manifest }) {
  if (config.name !== 'wolfhouse-prod') fail('PROJECT_NAME_MISMATCH', { field: 'name' });
  if (releaseEnv.SOURCE_SHA !== manifest.sourceSha) fail('SOURCE_SHA_MISMATCH', { field: 'SOURCE_SHA' });
  const services = config.services || {};

  for (const [name, contract] of Object.entries(SERVICE_CONTRACT)) {
    const service = services[name];
    if (!service) fail('SERVICE_MISSING', { service: name });
    if (service.container_name !== contract.container) fail('CONTAINER_NAME_MISMATCH', { service: name, field: 'container_name' });
    const expectedImage = manifestValue(manifest, contract.manifest);
    if (!IMAGE_RE.test(String(expectedImage || ''))) fail('MANIFEST_IMAGE_NOT_PINNED', { service: name, field: 'image' });
    if (!IMAGE_RE.test(String(service.image || ''))) fail('RESOLVED_IMAGE_NOT_PINNED', { service: name, field: 'image' });
    if (service.image !== expectedImage) fail('IMAGE_MANIFEST_MISMATCH', { service: name, field: 'image' });
    if (Number(service.mem_limit) !== contract.memory) fail('MEM_LIMIT_MISMATCH', { service: name, field: 'mem_limit' });
    if (Number(service.memswap_limit) !== contract.memory) fail('MEMSWAP_LIMIT_MISMATCH', { service: name, field: 'memswap_limit' });
    if (contract.flags) {
      const environment = normalizedEnvironment(service.environment);
      for (const [key, expected] of Object.entries(contract.flags)) {
        if (!Object.prototype.hasOwnProperty.call(environment, key)) fail('FLAG_MISSING', { service: name, field: key });
        if (environment[key] !== expected) fail('FLAG_NOT_FAIL_CLOSED', { service: name, field: key });
      }
    }
  }

  if (releaseEnv.STAFF_API_IMAGE !== manifest.build.staffApiImage) fail('RELEASE_ENV_IMAGE_MISMATCH', { field: 'STAFF_API_IMAGE' });
  if (releaseEnv.LUNA_IMAGE !== manifest.build.lunaImage) fail('RELEASE_ENV_IMAGE_MISMATCH', { field: 'LUNA_IMAGE' });
  if (releaseEnv.POSTGRES_IMAGE !== manifest.runtimeImages.postgres) fail('RELEASE_ENV_IMAGE_MISMATCH', { field: 'POSTGRES_IMAGE' });
  if (releaseEnv.NGINX_IMAGE !== manifest.runtimeImages.nginx) fail('RELEASE_ENV_IMAGE_MISMATCH', { field: 'NGINX_IMAGE' });

  const networks = config.networks || {};
  const privateNetwork = networks.wolfhouse_prod_private || networks['wolfhouse-prod-private'];
  if (!(privateNetwork && privateNetwork.internal === true)) fail('NETWORK_NOT_INTERNAL', { field: 'network' });
  const ports = services.ingress.ports || [];
  const renderedPorts = JSON.stringify(ports);
  if (!/127\.0\.0\.1/.test(renderedPorts) || /0\.0\.0\.0/.test(renderedPorts)) fail('INGRESS_NOT_LOOPBACK', { service: 'ingress', field: 'ports' });
}

function renderCompose({ composeFile, releaseEnvFile, composeCommand = process.env.DOCKER_COMPOSE_COMMAND || 'docker' }) {
  const commandParts = composeCommand.split(/\s+/).filter(Boolean);
  const executable = commandParts.shift();
  const prefix = executable === 'docker' && commandParts.length === 0 ? ['compose'] : commandParts;
  const result = spawnSync(executable, [...prefix, '--env-file', releaseEnvFile, '-f', composeFile, 'config', '--format', 'json'], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) fail('COMPOSE_RENDER_FAILED');
  try { return JSON.parse(result.stdout); }
  catch { fail('COMPOSE_RENDER_INVALID_JSON'); }
}

function runGate({ composeFile, releaseEnvFile, manifestFile, composeCommand }) {
  const releaseEnv = parseEnv(read(releaseEnvFile));
  const manifest = JSON.parse(read(manifestFile));
  const config = renderCompose({ composeFile, releaseEnvFile, composeCommand });
  validateRelease({ config, releaseEnv, manifest });
}

function fixture() {
  const manifest = JSON.parse(read(rel('deploy', 'wolfhouse-prod', 'release-manifest.json')));
  const releaseEnv = {
    SOURCE_SHA: manifest.sourceSha,
    STAFF_API_IMAGE: manifest.build.staffApiImage,
    LUNA_IMAGE: manifest.build.lunaImage,
    POSTGRES_IMAGE: manifest.runtimeImages.postgres,
    NGINX_IMAGE: manifest.runtimeImages.nginx,
  };
  const service = (container_name, image, memory, environment) => ({ container_name, image, mem_limit: memory, memswap_limit: memory, environment });
  const config = {
    name: 'wolfhouse-prod',
    services: {
      postgres: service('wolfhouse-prod-postgres', manifest.runtimeImages.postgres, 1073741824),
      'staff-api': service('wolfhouse-prod-staff-api', manifest.build.staffApiImage, 805306368, REQUIRED_FLAGS),
      luna: service('wolfhouse-prod-luna', manifest.build.lunaImage, 1610612736, {
        WHATSAPP_DRY_RUN: 'true', LUNA_AUTO_SEND_ENABLED: 'false', CUSTOMER_OUTREACH_WHATSAPP_ENABLED: 'false',
      }),
      ingress: { ...service('wolfhouse-prod-ingress', manifest.runtimeImages.nginx, 134217728), ports: [{ host_ip: '127.0.0.1', published: '18080', target: 8080 }] },
    },
    networks: { wolfhouse_prod_private: { internal: true } },
  };
  return { manifest, releaseEnv, config };
}

function expectReject(name, mutate, code) {
  const data = fixture();
  mutate(data);
  let thrown;
  try { validateRelease(data); } catch (error) { thrown = error; }
  if (!(thrown instanceof GateError) || thrown.code !== code) fail('SELF_TEST_EXPECTED_REJECT');
  console.log(`PASS negative: ${name}`);
}

function staticContractChecks() {
  const compose = read(rel('deploy', 'wolfhouse-prod', 'compose.yaml'));
  const ingress = read(rel('deploy', 'wolfhouse-prod', 'ingress.conf'));
  const manifest = JSON.parse(read(rel('deploy', 'wolfhouse-prod', 'release-manifest.json')));
  const runbook = read(rel('deploy', 'wolfhouse-prod', 'runbooks.md'));
  const evidence = read(rel('docs', 'prod', 'wolfhouse-release-evidence.md'));
  const checks = [
    ['isolated project and owned resources', () => {
      assert.match(compose, /^name: wolfhouse-prod$/m);
      for (const value of ['wolfhouse-prod-postgres', 'wolfhouse-prod-staff-api', 'wolfhouse-prod-luna', 'wolfhouse-prod-ingress', 'wolfhouse-prod-private', 'wolfhouse-prod-postgres-data', 'wolfhouse-prod-luna-data']) assert.ok(compose.includes(value), value);
    }],
    ['required memory caps and no extra swap', () => {
      assert.match(compose, /luna:[\s\S]*?mem_limit: 1536m[\s\S]*?memswap_limit: 1536m/);
      assert.match(compose, /staff-api:[\s\S]*?mem_limit: 768m[\s\S]*?memswap_limit: 768m/);
      assert.match(compose, /postgres:[\s\S]*?mem_limit: 1024m[\s\S]*?memswap_limit: 1024m/);
    }],
    ['private ingress and network', () => {
      assert.match(compose, /127\.0\.0\.1:\$\{WOLFHOUSE_PROD_INGRESS_PORT:-18080\}:8080/);
      assert.match(compose, /wolfhouse_prod_private:[\s\S]*?internal: true/);
    }],
    ['immutable image variables', () => {
      for (const key of ['STAFF_API_IMAGE', 'LUNA_IMAGE', 'POSTGRES_IMAGE', 'NGINX_IMAGE']) assert.ok(compose.includes(`\${${key}:?`));
      assert.doesNotMatch(compose, /image:\s*[^\n]*:latest/);
    }],
    ['Classic-only and outbound fail closed', () => {
      assert.doesNotMatch(compose + runbook, /crowsnest/i);
      for (const text of ["WHATSAPP_DRY_RUN: 'true'", "LUNA_AUTO_SEND_ENABLED: 'false'", "CUSTOMER_OUTREACH_WHATSAPP_ENABLED: 'false'", 'STRIPE_MODE: test']) assert.ok(compose.includes(text), text);
    }],
    ['approved hostnames only', () => {
      assert.match(ingress, /server_name admin\.wolf-house\.com wh\.lunafrontdesk\.com;/);
      assert.doesNotMatch(ingress, /staff\.lunafrontdesk\.com/);
      assert.equal(manifest.hostnames.primary, 'admin.wolf-house.com');
    }],
    ['accepted source and honest pending evidence', () => {
      assert.equal(manifest.sourceSha, '577a15e3726d40a5294ab65c4b427b62afbd38c4');
      assert.equal(manifest.hostLanding.status, 'not-started-captain-pass-required');
      assert.match(evidence, /independently re-verified/);
      assert.match(evidence, /BUILD_RC=0/);
      assert.doesNotMatch(evidence, /digest pending/);
    }],
    ['prohibited actions and secret-safe gate documented', () => {
      for (const term of ['No DNS edit', 'gateway restart', 'swap change', 'prune', 'outbound send', 'Oracle mutation']) assert.ok(evidence.includes(term), term);
      assert.match(runbook, /No host landing before exact-head Captain PASS/);
      assert.doesNotMatch(runbook, /docker compose --env-file[^\n]* config(?:\s|`)/);
      assert.match(runbook, /withholds raw stdout\/stderr/i);
    }],
  ];
  for (const [name, check] of checks) { check(); console.log(`PASS ${name}`); }
  return checks.length;
}

function writeComposeStub(dir, { stdout, stderr, status }) {
  const script = path.join(dir, 'compose-stub.js');
  fs.writeFileSync(script, [
    '#!/usr/bin/env node',
    `if (${JSON.stringify(stderr || '')}) process.stderr.write(${JSON.stringify(stderr || '')});`,
    `if (${JSON.stringify(stdout || '')}) process.stdout.write(${JSON.stringify(stdout || '')});`,
    `process.exit(${Number(status) || 0});`,
    '',
  ].join('\n'), { mode: 0o700 });
  return script;
}

function runRealCli({ composeCommand, releaseEnv, extraEnvLines }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-prod-gate-cli-'));
  const envFile = path.join(dir, 'release.env');
  const lines = Object.entries(releaseEnv).map(([k, v]) => `${k}=${v}`);
  if (extraEnvLines) lines.push(...extraEnvLines);
  fs.writeFileSync(envFile, lines.join('\n'));
  const result = spawnSync(process.execPath, [
    __filename,
    '--compose-file', rel('deploy', 'wolfhouse-prod', 'compose.yaml'),
    '--release-env', envFile,
    '--manifest', rel('deploy', 'wolfhouse-prod', 'release-manifest.json'),
    '--compose-command', composeCommand,
  ], { encoding: 'utf8', cwd: root });
  return { dir, result, combined: `${result.stdout || ''}\n${result.stderr || ''}` };
}

function cliCanaryTests() {
  const canary = 'SYNTHETIC_CANARY_DO_NOT_LEAK_7ec3';
  const data = fixture();

  const cases = [
    {
      name: 'cli valid model withholds canary in secret-bearing env',
      status: 0,
      stdout: JSON.stringify({
        ...data.config,
        services: {
          ...data.config.services,
          'staff-api': {
            ...data.config.services['staff-api'],
            environment: { ...REQUIRED_FLAGS, DATABASE_URL: canary },
          },
        },
      }),
      stderr: '',
      expectExit: 0,
      expectPass: true,
    },
    {
      name: 'cli invalid resolved flag withholds canary',
      status: 0,
      stdout: JSON.stringify({
        ...data.config,
        services: {
          ...data.config.services,
          luna: {
            ...data.config.services.luna,
            environment: {
              WHATSAPP_DRY_RUN: 'true',
              LUNA_AUTO_SEND_ENABLED: canary,
              CUSTOMER_OUTREACH_WHATSAPP_ENABLED: 'false',
            },
          },
        },
      }),
      stderr: '',
      expectExit: 1,
      expectPass: false,
      expectCode: 'FLAG_NOT_FAIL_CLOSED',
    },
    {
      name: 'cli renderer failure withholds canary',
      status: 1,
      stdout: '',
      stderr: `${canary}\n`,
      expectExit: 1,
      expectPass: false,
      expectCode: 'COMPOSE_RENDER_FAILED',
    },
    {
      name: 'cli invalid JSON withholds canary',
      status: 0,
      stdout: `{${canary}`,
      stderr: '',
      expectExit: 1,
      expectPass: false,
      expectCode: 'COMPOSE_RENDER_INVALID_JSON',
    },
  ];

  for (const spec of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-prod-gate-cli-'));
    try {
      const stub = writeComposeStub(dir, spec);
      const { result, combined } = runRealCli({ composeCommand: stub, releaseEnv: data.releaseEnv });
      if (combined.includes(canary)) fail('SELF_TEST_CANARY_DISCLOSED');
      if ((result.status || 0) !== spec.expectExit) fail('SELF_TEST_CLI_EXIT');
      if (spec.expectPass) {
        if (!/^PASS /m.test(result.stdout || '')) fail('SELF_TEST_CLI_PASS_MISSING');
      } else {
        const failLine = String(result.stderr || '');
        if (!failLine.includes(`FAIL Wolfhouse production release gate: ${spec.expectCode}`)) fail('SELF_TEST_CLI_CODE');
        if (failLine.includes('actual') && failLine.includes('expected')) fail('SELF_TEST_ASSERT_DIFF');
      }
      console.log(`PASS ${spec.name}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  return cases.length;
}

function runSelfTest() {
  const staticCount = staticContractChecks();
  validateRelease(fixture());
  console.log('PASS resolved release matches manifest, caps, and fail-closed flags');
  expectReject('manifest/image mismatch', data => { data.config.services.luna.image = data.manifest.build.staffApiImage; }, 'IMAGE_MANIFEST_MISMATCH');
  expectReject('missing Luna send-off flag', data => { delete data.config.services.luna.environment.LUNA_AUTO_SEND_ENABLED; }, 'FLAG_MISSING');
  expectReject('floating image override', data => { data.config.services['staff-api'].image = 'luna-local/wh-staff-api:latest'; }, 'RESOLVED_IMAGE_NOT_PINNED');
  expectReject('memory cap drift', data => { data.config.services.luna.mem_limit = 1; }, 'MEM_LIMIT_MISMATCH');
  expectReject('swap drift', data => { data.config.services.luna.memswap_limit = 1; }, 'MEMSWAP_LIMIT_MISMATCH');

  const secret = 'SYNTHETIC_SECRET_DO_NOT_LEAK_9f4d';
  for (const mode of ['success', 'error']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-prod-gate-'));
    try {
      const output = mode === 'success' ? JSON.stringify(fixture().config) : '';
      const stub = writeComposeStub(dir, {
        stdout: output,
        stderr: `${secret}\n`,
        status: mode === 'success' ? 0 : 1,
      });
      const data = fixture();
      const envFile = path.join(dir, 'release.env');
      fs.writeFileSync(envFile, Object.entries(data.releaseEnv).map(([k, v]) => `${k}=${v}`).join('\n'));
      let receipt = '';
      try {
        const config = renderCompose({ composeFile: rel('deploy', 'wolfhouse-prod', 'compose.yaml'), releaseEnvFile: envFile, composeCommand: stub });
        validateRelease({ config, releaseEnv: data.releaseEnv, manifest: data.manifest });
        receipt = 'PASS release gate';
      } catch (error) { receipt = formatGateFailure(error); }
      if (receipt.includes(secret)) fail('SELF_TEST_CANARY_DISCLOSED');
      if (mode === 'success') {
        if (!/^PASS /.test(receipt)) fail('SELF_TEST_CLI_PASS_MISSING');
      } else if (!receipt.includes('COMPOSE_RENDER_FAILED')) fail('SELF_TEST_CLI_CODE');
      console.log(`PASS ${mode} receipt withholds synthetic secret`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  const cliCount = cliCanaryTests();
  const total = staticCount + 6 + cliCount;
  console.log(`\nRESULT: ${staticCount + 6}/${staticCount + 6} checks passed`);
  console.log(`RESULT_CLI: ${cliCount}/${cliCount} real-CLI canary checks passed`);
  console.log(`RESULT_ALL: ${total}/${total} checks passed`);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--self-test') options.selfTest = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[++i];
      if (value === undefined) fail('UNKNOWN_ARGUMENT');
      options[key] = value;
    } else fail('UNKNOWN_ARGUMENT');
  }
  return options;
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.selfTest) runSelfTest();
    else {
      runGate({
        composeFile: args['compose-file'] || rel('deploy', 'wolfhouse-prod', 'compose.yaml'),
        releaseEnvFile: args['release-env'] || '/etc/wolfhouse-prod/release.env',
        manifestFile: args.manifest || rel('deploy', 'wolfhouse-prod', 'release-manifest.json'),
        composeCommand: args['compose-command'],
      });
      console.log('PASS exact resolved Wolfhouse production release gate');
    }
  } catch (error) {
    console.error(formatGateFailure(error));
    process.exitCode = 1;
  }
}

module.exports = { parseEnv, renderCompose, validateRelease, GateError, formatGateFailure };
