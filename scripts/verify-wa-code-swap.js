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
    LUNA_STAGING_WHATSAPP_NUMBER_E164: '+15550000001',
    LUNA_STAGING_WHATSAPP_NUMBER_DISPLAY: '+1-555-000-0001',
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
  LUNA_STAGING_WHATSAPP_NUMBER_E164: '+15550000091',
  LUNA_STAGING_WHATSAPP_NUMBER_DISPLAY: '+1-555-000-0091',
}));
assert.notEqual(first.phoneNumberId, second.phoneNumberId);
assert.equal(first.numberE164, '+15550000001');
assert.equal(first.numberDisplay, '+1-555-000-0001');
assert.equal(second.numberE164, '+15550000091');
assert.equal(second.numberDisplay, '+1-555-000-0091');
assert.notEqual(first.numberDisplay, 'configured ···0001');
assert.equal(identity.publicSnapshot({}).active, false);
assert.equal(identity.publicSnapshot({}).phoneNumberId, '');
assertClosed(() => identity.resolvePublicIdentity(synthetic({ WA_PHONE_NUMBER_ID: '' })), 'identity_malformed');
assertClosed(() => identity.resolvePublicIdentity(synthetic({ WA_PHONE_NUMBER_ID: 'not-an-id' })), 'identity_malformed');
assertClosed(() => identity.resolvePublicIdentity(synthetic({ WHATSAPP_PHONE_NUMBER_ID: '2000000000000099' })), 'identity_alias_conflict');
assertClosed(() => identity.resolvePublicIdentity(synthetic({ WHATSAPP_CLOUD_APP_ID: '2000000000000099' })), 'identity_alias_conflict');
assertClosed(() => identity.resolvePublicIdentity(synthetic({ WHATSAPP_CLOUD_WABA_ID: '2000000000000099' })), 'identity_alias_conflict');
assertClosed(() => identity.resolveSecrets(synthetic({ WA_ACCESS_TOKEN: 'senti nel' })), 'secret_missing');
assertClosed(() => identity.resolveSecrets(synthetic({ WA_ACCESS_TOKEN: '  sentinel-access-token' })), 'secret_missing');
for (const [label, value] of [
  ['bom-infix', 'sentinel\uFEFFtoken'],
  ['bom-prefix', '\uFEFFsentinel-access-token'],
  ['bom-suffix', 'sentinel-access-token\uFEFF'],
  ['next-line-infix', 'sentinel\u0085token'],
  ['next-line-prefix', '\u0085sentinel-access-token'],
  ['next-line-suffix', 'sentinel-access-token\u0085'],
]) {
  for (const key of ['WA_ACCESS_TOKEN', 'WA_APP_SECRET']) {
    assertClosed(() => identity.resolveSecrets(synthetic({ [key]: value })), 'secret_missing');
    const lunaEnvRejected = synthetic({
      [key]: value,
      WHATSAPP_CLOUD_ACCESS_TOKEN: 'stale-token',
      WHATSAPP_CLOUD_APP_SECRET: 'stale-secret',
    });
    assertClosed(() => identity.applyLunaProcessEnv(lunaEnvRejected), 'secret_missing');
    assert.equal(lunaEnvRejected.WHATSAPP_CLOUD_ACCESS_TOKEN, 'stale-token', `${key}:${label}:luna`);
    assert.equal(lunaEnvRejected.WHATSAPP_CLOUD_APP_SECRET, 'stale-secret', `${key}:${label}:luna`);
    const staffEnvRejected = synthetic({
      [key]: value,
      WHATSAPP_CLOUD_ACCESS_TOKEN: 'stale-token',
      META_APP_SECRET: 'stale-secret',
    });
    assertClosed(() => identity.applyStaffProcessEnv(staffEnvRejected), 'secret_missing');
    assert.equal(staffEnvRejected.WHATSAPP_CLOUD_ACCESS_TOKEN, 'stale-token', `${key}:${label}:staff`);
    assert.equal(staffEnvRejected.META_APP_SECRET, 'stale-secret', `${key}:${label}:staff`);
  }
}
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

function signedProof(number, phone, key, now) {
  const value = {
    number_e164: number,
    phone_number_id: phone,
    path: controller.EXACT_PATH,
    environment: 'staging',
    upstream: controller.TARGETS.sunset,
    observed_at_ms: now,
  };
  value.signature = crypto.createHmac('sha256', key).update([
    value.number_e164, value.phone_number_id, value.path, value.environment, value.upstream, String(now),
  ].join('\n')).digest('hex');
  return value;
}
const proofKey = 'synthetic-proof-key-32-bytes-min';
const proofNow = 1800000000000;
const legacy = identity.UNSELECTED_LEGACY;
const legacyProof = signedProof(legacy.numberE164, legacy.phoneNumberId, proofKey, proofNow);
const emptyProof = signedProof('', '', proofKey, proofNow);
assert.equal(controller.verifyIngressProof(legacyProof, 'sunset', proofKey, proofNow, {}), true, 'unselected legacy proof');
assert.equal(controller.verifyIngressProof(emptyProof, 'sunset', proofKey, proofNow, {}), false, 'unselected blank proof');
assert.equal(controller.verifyIngressProof(legacyProof, 'sunset', proofKey, proofNow, synthetic()), false, 'selected must not accept old proof');
assert.equal(controller.verifyIngressProof(emptyProof, 'sunset', proofKey, proofNow, synthetic()), false, 'selected blank proof');
assert.equal(identity.proofExpectation(synthetic({ LUNA_STAGING_WHATSAPP_NUMBER_E164: '' })).reject, true);
assert.equal(identity.publicSnapshot(synthetic({ LUNA_STAGING_WHATSAPP_NUMBER_E164: '' })).numberDisplay, identity.UNAVAILABLE);
assert.notEqual(identity.publicSnapshot(synthetic()).numberE164, legacy.numberE164);

const routeEnv = {
  CROWSNEST_ENVIRONMENT: 'staging',
  CROWSNEST_LUNA_ROUTING_CONTROLLER_URL: 'https://controller.example.invalid/_internal/luna-routing/v1/routes/meta-whatsapp-verified-webhook',
  CROWSNEST_LUNA_ROUTING_CONTROLLER_HMAC_KEY: proofKey,
  CROWSNEST_COMMS_DATABASE_URL: 'postgres://unused-fixture',
};
const activeRoute = { target_luna: 'wolfhouse', revision: 'a'.repeat(64), upstream: controller.TARGETS.wolfhouse, exact_path: controller.EXACT_PATH };
const activeRead = await routing.readLunaNumberRoute({
  env: { ...routeEnv, ...synthetic() },
  transport: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, route: activeRoute }) }),
  auditStore: { latest: async () => null },
});
assert.equal(activeRead.routing_delivery, 'active');
assert.equal(activeRead.routing_policy, 'off');
assert.notEqual(activeRead.routing_delivery, 'off');
const failedRead = await routing.readLunaNumberRoute({
  env: { ...routeEnv, ...synthetic() },
  transport: async () => ({ ok: false, status: 503, json: async () => ({ ok: false, code: 'route_readback_failed' }) }),
  auditStore: { latest: async () => null },
});
assert.equal(failedRead.code, 'route_readback_failed');
assert.notEqual(failedRead.routing_delivery, 'off');
const absentRead = await routing.readLunaNumberRoute({
  env: { ...routeEnv, ...synthetic() },
  transport: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, route: {} }) }),
  auditStore: { latest: async () => null },
});
assert.equal(absentRead.routing_delivery, 'unavailable');
assert.notEqual(absentRead.routing_delivery, 'off');
const unselectedRead = await routing.readLunaNumberRoute({
  env: routeEnv,
  transport: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, route: activeRoute }) }),
  auditStore: { latest: async () => null },
});
assert.equal(unselectedRead.phone_number_id, legacy.phoneNumberId);
assert.equal(unselectedRead.number_e164, legacy.numberE164);

const actor = { account_id: 'earthling', username: 'offline-operator' };
const operationId = '12345678-1234-4234-8234-123456789abc';
const identityA = synthetic();
const identityB = synthetic({
  WA_PHONE_NUMBER_ID: '2000000000000091',
  LUNA_STAGING_WHATSAPP_NUMBER_E164: '+15550000091',
  LUNA_STAGING_WHATSAPP_NUMBER_DISPLAY: '+1-555-000-0091',
});
let forwarded = 0;
const stale = await routing.flipLunaNumberRoute({
  operation_id: operationId,
  expected_revision: 'a'.repeat(64),
  number_id: identityA.WA_PHONE_NUMBER_ID,
  phone_number_id: identityA.WA_PHONE_NUMBER_ID,
  number_e164: identityA.LUNA_STAGING_WHATSAPP_NUMBER_E164,
}, actor, {
  env: { ...routeEnv, ...identityB },
  auditStore: { begin: async () => { throw new Error('audit must not start'); }, complete: async () => { throw new Error('audit must not complete'); } },
  transport: async () => { forwarded += 1; throw new Error('controller must not be called'); },
});
assert.equal(stale.code, 'stale_identity');
assert.equal(forwarded, 0);
const retry = await routing.flipLunaNumberRoute({
  operation_id: operationId,
  expected_revision: 'a'.repeat(64),
  number_id: identityA.WA_PHONE_NUMBER_ID,
}, actor, {
  env: { ...routeEnv, ...identityB },
  auditStore: { begin: async () => { throw new Error('retry audit must not start'); } },
  transport: async () => { forwarded += 1; throw new Error('retry must not call controller'); },
});
assert.equal(retry.code, 'stale_identity');
assert.equal(forwarded, 0);
assert.equal(routing.identityConfirmationError({
  number_id: identityA.WA_PHONE_NUMBER_ID,
}, { ...routeEnv, ...identityA }), 'stale_identity');
let sparseCalls = 0;
const driftedE164 = '+15550000002';
const sparseDrift = await routing.rollbackLunaNumberRoute({
  operation_id: operationId,
  expected_revision: 'a'.repeat(64),
  number_id: identityA.WA_PHONE_NUMBER_ID,
}, actor, {
  env: {
    ...routeEnv,
    ...identityA,
    LUNA_STAGING_WHATSAPP_NUMBER_E164: driftedE164,
    LUNA_STAGING_WHATSAPP_NUMBER_DISPLAY: '+1-555-000-0002',
  },
  auditStore: {
    begin: async () => ({ replay: true, response: { ok: true, idempotent: true }, state: 'succeeded' }),
  },
  transport: async () => { sparseCalls += 1; throw new Error('sparse retry must not call controller'); },
});
assert.equal(sparseDrift.code, 'stale_identity');
assert.notEqual(sparseDrift.ok, true);
assert.equal(sparseCalls, 0);
let matchedBody = null;
const matched = await routing.flipLunaNumberRoute({
  operation_id: '12345678-1234-4234-8234-123456789abd',
  expected_revision: 'b'.repeat(64),
  number_id: identityA.WA_PHONE_NUMBER_ID,
  phone_number_id: identityA.WA_PHONE_NUMBER_ID,
  number_e164: identityA.LUNA_STAGING_WHATSAPP_NUMBER_E164,
}, actor, {
  env: { ...routeEnv, ...identityA },
  auditStore: { begin: async () => ({}), complete: async () => {} },
  transport: async (_url, opts) => {
    matchedBody = JSON.parse(opts.body);
    return { ok: false, status: 403, json: async () => ({ ok: false, code: 'mutations_disabled' }) };
  },
});
assert.equal(matchedBody.number_id, identityA.WA_PHONE_NUMBER_ID);
assert.equal(matchedBody.number_e164, identityA.LUNA_STAGING_WHATSAPP_NUMBER_E164);
assert.equal(matched.code, 'mutations_disabled');
let ioCalls = 0;
const blocked = () => { ioCalls += 1; throw new Error('unexpected IO'); };
const offController = controller.createController({
  env: { ...identityB },
  mutationsEnabled: false,
  fetch: blocked,
  exec: blocked,
  fs: new Proxy({}, { get: () => blocked }),
});
const offGuard = await offController.mutate({
  action: 'flip_to_sunset',
  operation_id: operationId,
  expected_revision: 'a'.repeat(64),
  actor_account_id: 'earthling',
  number_id: identityA.WA_PHONE_NUMBER_ID,
});
assert.equal(offGuard.status, 403);
assert.equal(offGuard.body.code, 'mutations_disabled');
assert.equal(ioCalls, 0);
const onController = controller.createController({
  env: { ...identityB },
  mutationsEnabled: true,
  fetch: blocked,
  exec: blocked,
  fs: new Proxy({}, { get: () => blocked }),
});
const drift = await onController.mutate({
  action: 'flip_to_sunset',
  operation_id: operationId,
  expected_revision: 'a'.repeat(64),
  actor_account_id: 'earthling',
  number_id: identityA.WA_PHONE_NUMBER_ID,
  phone_number_id: identityA.WA_PHONE_NUMBER_ID,
  number_e164: identityA.LUNA_STAGING_WHATSAPP_NUMBER_E164,
});
assert.equal(drift.status, 422);
assert.equal(drift.body.code, 'stale_identity');
assert.equal(ioCalls, 0);

const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-empty-present-'));
const emptyPersisted = spawnSync('bash', ['-c', `
  set -eu
  sed -n '/^write_luna_env()/,/^}/p' docker/hermes-staging/bootstrap.sh > "$1/fn.sh"
  . "$1/fn.sh"
  write_luna_env
`, 'bash', emptyHome], {
  cwd: root,
  env: {
    PATH: process.env.PATH,
    HERMES_HOME: emptyHome,
    HERMES_ROLE: 'luna',
    WA_PHONE_NUMBER_ID: '',
    WA_BUSINESS_ACCOUNT_ID: '',
    WA_APP_ID: '',
    WA_ACCESS_TOKEN: '',
    WA_APP_SECRET: '',
    WHATSAPP_CLOUD_ACCESS_TOKEN: 'stale-token-sentinel',
    WHATSAPP_CLOUD_APP_SECRET: 'stale-secret-sentinel',
    WHATSAPP_CLOUD_PHONE_NUMBER_ID: '1999999999999999',
    WHATSAPP_CLOUD_VERIFY_TOKEN: 'verify-token-ok',
  },
  encoding: 'utf8',
});
assert.equal(emptyPersisted.status, 0, emptyPersisted.stderr);
const emptyWritten = fs.readFileSync(path.join(emptyHome, '.env'), 'utf8');
assert.equal(emptyWritten.includes('stale-token-sentinel'), false);
assert.equal(emptyWritten.includes('stale-secret-sentinel'), false);
assert.equal(emptyWritten.includes('1999999999999999'), false);
fs.rmSync(emptyHome, { recursive: true, force: true });

const simEmpty = spawnSync('python3', ['-c', `
import os
os.environ['WA_PHONE_NUMBER_ID'] = ''
os.environ['WHATSAPP_CLOUD_PHONE_NUMBER_ID'] = '1999999999999999'
from wolfhouse.simulate_core import build_meta_webhook_payload
try:
    build_meta_webhook_payload(digits='15550001111', text='hello')
except RuntimeError as exc:
    if '1999999999999999' in str(exc):
        raise SystemExit('sentinel')
    print('CLOSED')
else:
    raise SystemExit('fell-through')
`], { cwd: path.join(root, 'docker/hermes-staging'), env: { PATH: process.env.PATH, PYTHONPATH: path.join(root, 'docker/hermes-staging') }, encoding: 'utf8' });
assert.equal(simEmpty.status, 0, simEmpty.stderr);
assert.match(simEmpty.stdout, /CLOSED/);

const rollbackScript = fs.readFileSync(path.join(root, 'deploy/luna-routing/r4/run-luna-routing-r4.sh'), 'utf8');
assert.match(rollbackScript, /\/opt\/luna-routing\/lib\/whatsapp-runtime-identity\.js/);
const rollbackHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-rollback-'));
const rollback = spawnSync('python3', ['-c', `
import os, re, subprocess
from pathlib import Path
script = Path(${JSON.stringify(path.join(root, 'deploy/luna-routing/r4/run-luna-routing-r4.sh'))}).read_text()
fn = script[script.index('backup_controller(){'):script.index('rollback_controller(){')]
paths = re.search(r'for p in (.*); do', fn).group(1).split()
restore = next(line.strip() for line in script.splitlines() if 'done <"$BACKUP/controller/manifest"' in line)
module = '/opt/luna-routing/lib/whatsapp-runtime-identity.js'
controller_path = '/opt/luna-routing/luna-number-routing-controller.js'
home = Path(${JSON.stringify(rollbackHome)})
out = {}
for prior in (False, True):
    case = home / ('existing' if prior else 'first')
    root = case / 'fixture-root'
    backup = case / 'backup'
    root.mkdir(parents=True)
    for name in paths:
        if (not prior) and name == module:
            continue
        p = root / name.lstrip('/')
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text('before\\n')
    mod = root / module.lstrip('/')
    mod.parent.mkdir(parents=True, exist_ok=True)
    if prior:
        mod.write_text('before-module\\n')
    remapped = fn
    for name in paths:
        remapped = remapped.replace(name, str(root / name.lstrip('/')))
    env = {'PATH': '/usr/bin:/bin', 'BACKUP': str(backup)}
    subprocess.run(['bash', '-c', 'set -eu\\n' + remapped + '\\nbackup_controller\\n'], env=env, check=True)
    manifest = (backup / 'controller/manifest').read_text()
    (root / controller_path.lstrip('/')).write_text('after-controller\\n')
    mod.write_text('after-module\\n')
    subprocess.run(['bash', '-c', 'set -eu\\nrestore_once() {\\n' + restore + '\\n}\\nrestore_once\\n'], env=env, check=True)
    out['existing' if prior else 'first'] = {
        'inventoried': module in manifest,
        'controller_restored': (root / controller_path.lstrip('/')).read_text() == 'before\\n',
        'module_exists': mod.exists(),
        'module_text': mod.read_text() if mod.exists() else '',
    }
first, existing = out['first'], out['existing']
assert first['inventoried'] and first['controller_restored'] and not first['module_exists']
assert existing['inventoried'] and existing['controller_restored'] and existing['module_text'] == 'before-module\\n'
print('ROLLBACK_OK')
`], { encoding: 'utf8' });
assert.equal(rollback.status, 0, rollback.stderr);
assert.match(rollback.stdout, /ROLLBACK_OK/);
fs.rmSync(rollbackHome, { recursive: true, force: true });

console.log('PASS verify:wa-code-swap');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
