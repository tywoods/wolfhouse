'use strict';

(async () => {
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const identity = require('./lib/whatsapp-runtime-identity');
const controller = require('./luna-number-routing-controller');
const routing = require('./lib/crowsnest/crowsnest-luna-number-routing');

function needle(parts) {
  return parts.join('');
}

const FORBIDDEN = [
  needle(['1152', '900101', '233109']),
  needle(['1373', '022359', '228551']),
  needle(['9938', '566837', '22384']),
  needle(['4434', '602943', '461887']),
  needle(['staging-es-', '34663439419']),
  needle(['+34 663', ' 43 94 19']),
  needle(['+346', '****9419']),
  needle(['wa-luna-ar-', 'access-token']),
  needle(['wa-luna-ar-', 'app-secret']),
];

const PRODUCT_FILES = [
  'scripts/luna-number-routing-controller.js',
  'scripts/lib/crowsnest/crowsnest-luna-number-routing.js',
  'scripts/lib/crowsnest/crowsnest-page.js',
  'scripts/crowsnest-api.js',
  'scripts/lib/whatsapp-runtime-identity.js',
  'scripts/lib/whatsapp-runtime-bootstrap.mjs',
  'docker/hermes-staging/wolfhouse/simulate_core.py',
  'docker/hermes-staging/wolfhouse/whatsapp_runtime_config.py',
  'docker/hermes-staging/apply_whatsapp_runtime_config.py',
  'docker/hermes-staging/bootstrap.sh',
  'docker/hermes-staging/Dockerfile',
  'deploy/luna-routing/validate-controller-env.js',
  'deploy/luna-routing/install-luna-routing.sh',
  'deploy/luna-routing/controller.france.env.example',
  'deploy/luna-routing/README.md',
  'docs/WA-CODE-SWAP.md',
];

function synthetic(overrides = {}) {
  return {
    WA_PHONE_NUMBER_ID: '2000000000000001',
    WA_BUSINESS_ACCOUNT_ID: '2000000000000002',
    WA_APP_ID: '2000000000000003',
    WA_ACCESS_TOKEN: 'sentinel-access-token',
    WA_APP_SECRET: 'sentinel-app-secret',
    ...overrides,
  };
}

function assertClosed(fn, code) {
  assert.throws(fn, (error) => error && error.code === code);
}

const first = identity.publicSnapshot(synthetic());
const second = identity.publicSnapshot(synthetic({
  WA_PHONE_NUMBER_ID: '2000000000000091',
  WA_BUSINESS_ACCOUNT_ID: '2000000000000092',
  WA_APP_ID: '2000000000000093',
}));
assert.notEqual(first.phoneNumberId, second.phoneNumberId);
assert.equal(first.numberDisplay, 'configured ···0001');
assert.equal(second.numberDisplay, 'configured ···0091');
assert.equal(identity.publicSnapshot({}).active, false);
assert.equal(identity.publicSnapshot({}).phoneNumberId, '');
assertClosed(() => identity.resolvePublicIdentity(synthetic({ WA_PHONE_NUMBER_ID: '' })), 'identity_malformed');
assertClosed(() => identity.resolvePublicIdentity(synthetic({ WA_PHONE_NUMBER_ID: 'not-an-id' })), 'identity_malformed');
assertClosed(() => identity.resolvePublicIdentity(synthetic({ WHATSAPP_PHONE_NUMBER_ID: '2000000000000099' })), 'identity_alias_conflict');
assertClosed(() => identity.resolveSecrets(synthetic({ WA_ACCESS_TOKEN: '  sentinel-access-token' })), 'secret_missing');
assert.equal(identity.applyLunaProcessEnv(synthetic({ WHATSAPP_CLOUD_ACCESS_TOKEN: 'stale-token' })).applied, true);
const lunaEnv = synthetic({ WHATSAPP_CLOUD_ACCESS_TOKEN: 'stale-token', GUEST_PHONE: '+15550001111' });
identity.applyLunaProcessEnv(lunaEnv);
assert.equal(lunaEnv.WHATSAPP_CLOUD_ACCESS_TOKEN, 'sentinel-access-token');
assert.equal(lunaEnv.WHATSAPP_CLOUD_PHONE_NUMBER_ID, '2000000000000001');
assert.equal(lunaEnv.GUEST_PHONE, '+15550001111');
const staffEnv = synthetic({ OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: '2000000000000001' });
identity.applyStaffProcessEnv(staffEnv);
assert.equal(staffEnv.WHATSAPP_PHONE_NUMBER_ID, '2000000000000001');
assert.equal(staffEnv.META_APP_SECRET, 'sentinel-app-secret');
assert.equal(staffEnv.WHATSAPP_CLOUD_ACCESS_TOKEN, 'sentinel-access-token');
assertClosed(() => identity.applyStaffProcessEnv(synthetic({ OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID: '2000000000000099' })), 'identity_alias_conflict');

for (const file of PRODUCT_FILES) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  for (const value of FORBIDDEN) assert.equal(text.includes(value), false, `${file} embeds a forbidden identity`);
  assert.equal(/@azure\/keyvault|graph\.facebook\.com\/v[0-9].*\/register/.test(text), false, file);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(pkg.scripts['staff:api'], 'node scripts/staff-query-api.js');
assert.match(pkg.scripts['staff:api:selected-whatsapp'], /whatsapp-runtime-bootstrap\.mjs/);
assert.equal(pkg.dependencies['@azure/keyvault-secrets'], undefined);

const child = spawnSync(process.execPath, ['--import', './scripts/lib/whatsapp-runtime-bootstrap.mjs', '-e', `
  const token = process.env.WHATSAPP_CLOUD_ACCESS_TOKEN;
  const secret = process.env.META_APP_SECRET;
  const phone = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (token !== process.env.WA_ACCESS_TOKEN || secret !== process.env.WA_APP_SECRET || phone !== process.env.WA_PHONE_NUMBER_ID) {
    console.log('MISMATCH');
    process.exit(2);
  }
  console.log('MAPPED');
`], {
  cwd: root,
  env: { ...synthetic(), PATH: process.env.PATH },
  encoding: 'utf8',
});
assert.equal(child.status, 0, child.stderr);
assert.match(child.stdout, /MAPPED/);
assert.equal(child.stdout.includes('sentinel-access-token'), false);
assert.equal(child.stdout.includes('sentinel-app-secret'), false);
assert.equal(child.stderr.includes('sentinel-access-token'), false);
assert.equal(child.stderr.includes('sentinel-app-secret'), false);

const missing = spawnSync(process.execPath, ['--import', './scripts/lib/whatsapp-runtime-bootstrap.mjs', '-e', 'console.log("SHOULD_NOT_RUN")'], {
  cwd: root,
  env: { ...synthetic({ WA_ACCESS_TOKEN: '' }), PATH: process.env.PATH },
  encoding: 'utf8',
});
assert.notEqual(missing.status, 0);
assert.match(missing.stderr, /whatsapp_runtime_bootstrap_failed:secret_missing/);
assert.equal(missing.stderr.includes('sentinel-app-secret'), false);
assert.equal(missing.stdout.includes('SHOULD_NOT_RUN'), false);

const absent = spawnSync(process.execPath, ['--import', './scripts/lib/whatsapp-runtime-bootstrap.mjs', '-e', 'console.log(process.env.WHATSAPP_PHONE_NUMBER_ID || "UNCHANGED")'], {
  cwd: root,
  env: { PATH: process.env.PATH, WHATSAPP_PHONE_NUMBER_ID: 'other-role' },
  encoding: 'utf8',
});
assert.equal(absent.status, 0);
assert.match(absent.stdout, /other-role/);

const key = 'proof-key-proof-key-proof-key-proof';
const expected = identity.proofExpectation(synthetic());
const goodProof = {
  number_e164: expected.numberE164,
  phone_number_id: expected.phoneNumberId,
  path: controller.EXACT_PATH,
  environment: 'staging',
  upstream: controller.TARGETS.sunset,
  observed_at_ms: Date.now(),
};
goodProof.signature = crypto.createHmac('sha256', key).update([
  goodProof.number_e164, goodProof.phone_number_id, goodProof.path, goodProof.environment, goodProof.upstream, String(goodProof.observed_at_ms),
].join('\n')).digest('hex');
assert.equal(controller.verifyIngressProof(goodProof, 'sunset', key, Date.now(), synthetic()), true);
const sunsetSrc = fs.readFileSync(path.join(root, 'docker/hermes-staging/sunset_ingress_proof.py'), 'utf8');
const sunsetPhone = sunsetSrc.match(/PHONE_NUMBER_ID = "([0-9]+)"/)[1];
const sunsetProof = { ...goodProof, phone_number_id: sunsetPhone, number_e164: '+1', signature: '00' };
assert.equal(controller.verifyIngressProof(sunsetProof, 'sunset', key, Date.now(), synthetic()), false);
assert.equal(controller.PHONE_NUMBER_ID, routing.PHONE_NUMBER_ID);

let fetched = 0;
const off = controller.createController({
  mutationsEnabled: false,
  env: synthetic(),
  fetch: async () => { fetched += 1; return { json: async () => goodProof }; },
});
const offResult = await off.mutate({ action: 'flip_to_sunset', operation_id: 'op', expected_revision: 'abc', nonce: 'n' });
assert.equal(offResult.status, 403);
assert.equal(offResult.body.code, 'mutations_disabled');
assert.equal(fetched, 0);

const notifications = fs.readFileSync(path.join(root, 'scripts/lib/staff-whatsapp-notifications.js'), 'utf8');
assert.match(notifications, /WHATSAPP_DRY_RUN: 'false'/);
assert.doesNotMatch(fs.readFileSync(path.join(root, 'scripts/lib/whatsapp-runtime-bootstrap.mjs'), 'utf8'), /WHATSAPP_DRY_RUN/);
assert.doesNotMatch(fs.readFileSync(path.join(root, 'scripts/lib/whatsapp-runtime-identity.js'), 'utf8'), /require\(['"]https?['"]\)|from ['"]http/);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-code-swap-'));
const persisted = spawnSync('bash', ['-c', `
  set -eu
  sed -n '/^write_luna_env()/,/^}/p' docker/hermes-staging/bootstrap.sh > "$1/fn.sh"
  # shellcheck disable=SC1091
  . "$1/fn.sh"
  write_luna_env
`, 'bash', home], {
  cwd: root,
  env: {
    PATH: process.env.PATH,
    HERMES_HOME: home,
    HERMES_ROLE: 'luna',
    WA_PHONE_NUMBER_ID: '2000000000000001',
    WA_ACCESS_TOKEN: 'sentinel-access-token',
    WA_APP_SECRET: 'sentinel-app-secret',
    WHATSAPP_CLOUD_ACCESS_TOKEN: 'sentinel-access-token',
    WHATSAPP_CLOUD_APP_SECRET: 'sentinel-app-secret',
    WHATSAPP_CLOUD_PHONE_NUMBER_ID: '2000000000000001',
    WHATSAPP_CLOUD_VERIFY_TOKEN: 'verify-token-ok',
  },
  encoding: 'utf8',
});
assert.equal(persisted.status, 0, persisted.stderr);
const written = fs.readFileSync(path.join(home, '.env'), 'utf8');
assert.match(written, /WHATSAPP_CLOUD_VERIFY_TOKEN=verify-token-ok/);
assert.equal(written.includes('sentinel-access-token'), false);
assert.equal(written.includes('sentinel-app-secret'), false);
assert.equal(written.includes('2000000000000001'), false);
assert.equal(written.includes('WA_ACCESS_TOKEN'), false);
fs.rmSync(home, { recursive: true, force: true });

const sim = spawnSync('python3', ['-c', `
import os
os.environ['WA_PHONE_NUMBER_ID'] = '2000000000000001'
os.environ['WHATSAPP_CLOUD_PHONE_NUMBER_ID'] = '2000000000000001'
from wolfhouse.simulate_core import build_meta_webhook_payload
payload = build_meta_webhook_payload(digits='15550001111', text='hello')
business = payload['entry'][0]['changes'][0]['value']['metadata']['phone_number_id']
guest = payload['entry'][0]['changes'][0]['value']['contacts'][0]['wa_id']
if business != '2000000000000001' or guest != '15550001111':
    raise SystemExit('mismatch')
print('AGREE')
try:
    os.environ.pop('WA_PHONE_NUMBER_ID')
    os.environ.pop('WHATSAPP_CLOUD_PHONE_NUMBER_ID')
    build_meta_webhook_payload(digits='15550001111', text='hello')
except RuntimeError as exc:
    if str(exc) != 'whatsapp_phone_id_unconfigured':
        raise
    print('UNCONFIGURED')
else:
    raise SystemExit('fallback')
`], { cwd: path.join(root, 'docker/hermes-staging'), env: { ...process.env, PYTHONPATH: path.join(root, 'docker/hermes-staging') }, encoding: 'utf8' });
assert.equal(sim.status, 0, sim.stderr);
assert.match(sim.stdout, /AGREE/);
assert.match(sim.stdout, /UNCONFIGURED/);
assert.equal(sim.stdout.includes('2000000000000001'), false);

console.log('PASS verify:wa-code-swap');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
