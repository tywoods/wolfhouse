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

function parseEnv(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    assert.ok(at > 0, 'release.env contains an invalid selector line');
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
  assert.equal(config.name, 'wolfhouse-prod', 'resolved project name must be wolfhouse-prod');
  assert.equal(releaseEnv.SOURCE_SHA, manifest.sourceSha, 'release SOURCE_SHA must match the frozen manifest sourceSha');
  const services = config.services || {};

  for (const [name, contract] of Object.entries(SERVICE_CONTRACT)) {
    const service = services[name];
    assert.ok(service, `resolved release is missing service ${name}`);
    assert.equal(service.container_name, contract.container, `${name} container_name mismatch`);
    const expectedImage = manifestValue(manifest, contract.manifest);
    assert.match(expectedImage, IMAGE_RE, `${name} manifest image must be digest pinned`);
    assert.match(service.image || '', IMAGE_RE, `${name} resolved image must be digest pinned`);
    assert.equal(service.image, expectedImage, `${name} resolved image must match release-manifest.json`);
    assert.equal(Number(service.mem_limit), contract.memory, `${name} mem_limit mismatch`);
    assert.equal(Number(service.memswap_limit), contract.memory, `${name} memswap_limit must equal mem_limit`);
    if (contract.flags) {
      const environment = normalizedEnvironment(service.environment);
      for (const [key, expected] of Object.entries(contract.flags)) {
        assert.ok(Object.prototype.hasOwnProperty.call(environment, key), `${name} resolved environment is missing ${key}`);
        assert.equal(environment[key], expected, `${name} ${key} must fail closed`);
      }
    }
  }

  assert.equal(releaseEnv.STAFF_API_IMAGE, manifest.build.staffApiImage, 'release.env Staff image mismatch');
  assert.equal(releaseEnv.LUNA_IMAGE, manifest.build.lunaImage, 'release.env Luna image mismatch');
  assert.equal(releaseEnv.POSTGRES_IMAGE, manifest.runtimeImages.postgres, 'release.env Postgres image mismatch');
  assert.equal(releaseEnv.NGINX_IMAGE, manifest.runtimeImages.nginx, 'release.env nginx image mismatch');

  const networks = config.networks || {};
  const privateNetwork = networks.wolfhouse_prod_private || networks['wolfhouse-prod-private'];
  assert.ok(privateNetwork && privateNetwork.internal === true, 'resolved network must be internal');
  const ports = services.ingress.ports || [];
  const renderedPorts = JSON.stringify(ports);
  assert.match(renderedPorts, /127\.0\.0\.1/);
  assert.doesNotMatch(renderedPorts, /0\.0\.0\.0/);
}

function renderCompose({ composeFile, releaseEnvFile, composeCommand = process.env.DOCKER_COMPOSE_COMMAND || 'docker' }) {
  const commandParts = composeCommand.split(/\s+/).filter(Boolean);
  const executable = commandParts.shift();
  const prefix = executable === 'docker' && commandParts.length === 0 ? ['compose'] : commandParts;
  const result = spawnSync(executable, [...prefix, '--env-file', releaseEnvFile, '-f', composeFile, 'config', '--format', 'json'], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('compose render failed; raw output withheld because it may contain expanded secrets');
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('compose render returned invalid JSON; raw output withheld because it may contain expanded secrets'); }
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

function expectReject(name, mutate, pattern) {
  const data = fixture();
  mutate(data);
  assert.throws(() => validateRelease(data), pattern);
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

function runSelfTest() {
  const staticCount = staticContractChecks();
  validateRelease(fixture());
  console.log('PASS resolved release matches manifest, caps, and fail-closed flags');
  expectReject('manifest/image mismatch', data => { data.config.services.luna.image = data.manifest.build.staffApiImage; }, /must match release-manifest/);
  expectReject('missing Luna send-off flag', data => { delete data.config.services.luna.environment.LUNA_AUTO_SEND_ENABLED; }, /missing LUNA_AUTO_SEND_ENABLED/);
  expectReject('floating image override', data => { data.config.services['staff-api'].image = 'luna-local/wh-staff-api:latest'; }, /digest pinned/);

  const secret = 'SYNTHETIC_SECRET_DO_NOT_LEAK_9f4d';
  for (const mode of ['success', 'error']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-prod-gate-'));
    try {
      const script = path.join(dir, 'compose-stub.js');
      const data = fixture();
      const output = mode === 'success' ? JSON.stringify(data.config) : '';
      fs.writeFileSync(script, `#!/usr/bin/env node\nprocess.stderr.write('${secret}\\n');\nprocess.stdout.write(${JSON.stringify(output)});\nprocess.exit(${mode === 'success' ? 0 : 1});\n`, { mode: 0o700 });
      const envFile = path.join(dir, 'release.env');
      fs.writeFileSync(envFile, Object.entries(data.releaseEnv).map(([k, v]) => `${k}=${v}`).join('\n'));
      let receipt = '';
      try {
        const config = renderCompose({ composeFile: rel('deploy', 'wolfhouse-prod', 'compose.yaml'), releaseEnvFile: envFile, composeCommand: script });
        validateRelease({ config, releaseEnv: data.releaseEnv, manifest: data.manifest });
        receipt = 'PASS release gate';
      } catch (error) { receipt = `FAIL ${error.message}`; }
      assert.doesNotMatch(receipt, new RegExp(secret));
      assert.match(receipt, mode === 'success' ? /^PASS/ : /^FAIL compose render failed/);
      console.log(`PASS ${mode} receipt withholds synthetic secret`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  console.log(`\nRESULT: ${staticCount + 6}/${staticCount + 6} checks passed`);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--self-test') options.selfTest = true;
    else if (arg.startsWith('--')) options[arg.slice(2)] = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
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
    console.error(`FAIL Wolfhouse production release gate: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { parseEnv, renderCompose, validateRelease };
