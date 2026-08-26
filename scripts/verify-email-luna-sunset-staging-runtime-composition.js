'use strict';
/** Slice 4.4 RED: default-off Sunset-staging Luna email-author composition. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const {
  SUNSET_DEPLOYMENT,
  SUNSET_LOCATION_KEY,
  ENV_RUNTIME_ENABLED,
  isEmailLunaDraftRuntimeEnabled,
  createEmailLunaSunsetStagingRuntimeComposition,
} = require('./lib/email-luna-sunset-staging-runtime-composition');

const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const OTHER = '66666666-6666-4666-8666-666666666666';
const authority = Object.freeze({ client_id: C, location_id: L, location_key: 'sunset-somo' });
function env(patch = {}) { return { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true', ...patch }; }
function gate(patch = {}) { return Object.freeze({ client_id: C, location_id: L, location_key: 'sunset-somo', draft_enabled: true, ...patch }); }
function enabledInput(patch = {}) { return { env: env(), authority, tenant_location_gate: gate(), ...patch }; }

console.log('Slice 4.4 email Luna Sunset-staging runtime composition verifier');
assert.equal(SUNSET_DEPLOYMENT, 'sunset-staging');
assert.equal(SUNSET_LOCATION_KEY, 'sunset-somo');
assert.equal(ENV_RUNTIME_ENABLED, 'EMAIL_LUNA_DRAFT_RUNTIME_ENABLED');
assert.equal(isEmailLunaDraftRuntimeEnabled(enabledInput()), true);
for (const [label, input] of [
  ['default off', enabledInput({ env: {} })],
  ['wrong deployment', enabledInput({ env: env({ LUNA_DEPLOYMENT: 'sunset-production' }) })],
  ['near-match deployment', enabledInput({ env: env({ LUNA_DEPLOYMENT: 'Sunset-staging' }) })],
  ['near-match flag', enabledInput({ env: env({ EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'TRUE' }) })],
  ['Wolfhouse location', enabledInput({ authority: Object.freeze({ ...authority, location_key: 'wolfhouse-somo' }) })],
  ['gate off', enabledInput({ tenant_location_gate: gate({ draft_enabled: false }) })],
  ['tenant mismatch', enabledInput({ tenant_location_gate: gate({ client_id: OTHER }) })],
  ['location mismatch', enabledInput({ tenant_location_gate: gate({ location_id: OTHER }) })],
  ['location-key mismatch', enabledInput({ tenant_location_gate: gate({ location_key: 'sunset-other' }) })],
]) {
  assert.equal(isEmailLunaDraftRuntimeEnabled(input), false, label);
}
console.log('  PASS  exact Sunset-staging + dedicated flag + exact tenant/location gate are all required');

const originalCreate = Object.create;
let hostileCreateCalls = 0;
try {
  Object.create = function hostileCreate() {
    hostileCreateCalls += 1;
    const admitted = {
      env: { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true' },
      authority: { client_id: C, location_id: L, location_key: 'sunset-somo' },
      tenant_location_gate: { client_id: C, location_id: L, location_key: 'sunset-somo', draft_enabled: true },
      LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
      client_id: C, location_id: L, location_key: 'sunset-somo', draft_enabled: true,
    };
    return new Proxy(admitted, { set() { return true; } });
  };
  const hostileOutcomes = [
    ['hostile create cannot bypass production deployment', enabledInput({ env: env({ LUNA_DEPLOYMENT: 'sunset-production' }) })],
    ['hostile create cannot bypass false runtime flag', enabledInput({ env: env({ EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'false' }) })],
    ['hostile create cannot bypass wrong location', enabledInput({ authority: Object.freeze({ ...authority, location_key: 'wolfhouse-somo' }) })],
    ['hostile create cannot bypass disabled tenant gate', enabledInput({ tenant_location_gate: gate({ draft_enabled: false }) })],
    ['hostile create cannot jointly bypass all activation prerequisites', enabledInput({
      env: env({ LUNA_DEPLOYMENT: 'sunset-production', EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'false' }),
      authority: Object.freeze({ ...authority, location_key: 'wolfhouse-somo' }),
      tenant_location_gate: gate({ location_key: 'wolfhouse-somo', draft_enabled: false }),
    })],
  ].map(([label, input]) => [label, isEmailLunaDraftRuntimeEnabled(input)]);
  assert.deepEqual(hostileOutcomes, [
    ['hostile create cannot bypass production deployment', false],
    ['hostile create cannot bypass false runtime flag', false],
    ['hostile create cannot bypass wrong location', false],
    ['hostile create cannot bypass disabled tenant gate', false],
    ['hostile create cannot jointly bypass all activation prerequisites', false],
  ]);
} finally { Object.create = originalCreate; }
assert.equal(hostileCreateCalls, 0, 'post-import Object.create must never be invoked');
console.log('  PASS  captured Object.create cannot be replaced to bypass activation prerequisites');

const composition = createEmailLunaSunsetStagingRuntimeComposition({
  ...enabledInput(),
  callModel: async () => JSON.stringify({ subject: 'Hello', body: 'Hello there.', language: 'en' }),
});
assert.deepEqual(Object.keys(composition), ['authorDraft', 'authorNaturalGuestReply']);
assert.equal(typeof composition.authorDraft, 'function');
assert.equal(typeof composition.authorNaturalGuestReply, 'function');
assert.equal(Object.isFrozen(composition), true);
for (const disabled of [
  enabledInput({ env: {} }),
  enabledInput({ tenant_location_gate: gate({ draft_enabled: false }) }),
  enabledInput({ authority: Object.freeze({ ...authority, location_id: OTHER }) }),
]) {
  assert.throws(() => createEmailLunaSunsetStagingRuntimeComposition({ ...disabled, callModel: async () => '{}' }), (error) => {
    assert.equal(error && error.code, 'EMAIL_LUNA_DRAFT_RUNTIME_DISABLED'); return true;
  });
}
console.log('  PASS  factory is fail-closed and exposes draft-only author methods after exact gates');

const originalSome = Array.prototype.some;
try {
  Array.prototype.some = function ambientAlwaysFalseSome() { return false; };
  assert.throws(() => createEmailLunaSunsetStagingRuntimeComposition({
    ...enabledInput(), callModel: async () => '{}', send: () => {},
  }), (error) => error && error.code === 'EMAIL_LUNA_DRAFT_RUNTIME_DISABLED');
} finally { Array.prototype.some = originalSome; }
console.log('  PASS  post-import Array.prototype.some mutation cannot admit extra runtime capabilities');

const modulePath = path.join(__dirname, 'lib/email-luna-sunset-staging-runtime-composition.js');
const child = spawnSync(process.execPath, ['-e', `
  const Module = require('node:module');
  const original = Module._load;
  const forbidden = /email-outbound|microsoft-graph|nodemailer|smtp|transport|staff-query-api/;
  Module._load = function(request, parent, isMain) {
    if (forbidden.test(String(request))) throw new Error('forbidden import: ' + request);
    return original.call(this, request, parent, isMain);
  };
  require(${JSON.stringify(modulePath)});
  process.stdout.write('IMPORT_INERT');
`], { encoding: 'utf8', timeout: 3000 });
assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, 'IMPORT_INERT');

const source = fs.readFileSync(modulePath, 'utf8');
assert.doesNotMatch(source, /email-outbound|microsoft-graph|nodemailer|smtp|dispatchApprovedOutbound|recipient|approval|sendMail|staff-query-api/);
assert.deepEqual(Object.keys(require('./lib/email-luna-sunset-staging-runtime-composition')).sort(), [
  'ENV_RUNTIME_ENABLED', 'SUNSET_DEPLOYMENT', 'SUNSET_LOCATION_KEY',
  'createEmailLunaSunsetStagingRuntimeComposition', 'isEmailLunaDraftRuntimeEnabled',
]);
console.log('  PASS  import is inert; no route/write/send/provider transport/outbound owner or capability is imported/exposed');

const originalLoad = Module._load;
const loaded = [];
try {
  delete require.cache[require.resolve('./lib/email-luna-sunset-staging-runtime-composition')];
  Module._load = function tracked(request, parent, isMain) { loaded.push(String(request)); return originalLoad.call(this, request, parent, isMain); };
  require('./lib/email-luna-sunset-staging-runtime-composition');
} finally { Module._load = originalLoad; }
assert.equal(loaded.some((name) => /email-outbound|microsoft-graph|nodemailer|smtp|staff-query-api/.test(name)), false);
console.log('ALL OK — Slice 4.4 email Luna Sunset-staging runtime composition');
