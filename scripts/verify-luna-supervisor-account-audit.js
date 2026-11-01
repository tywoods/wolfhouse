'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const audit = require('./lib/luna-supervisor-audit');
const provisioner = require('./lib/luna-supervisor-account-provisioner');

const tests = [];
let passed = 0;
function test(name, fn) {
  tests.push({ name, fn });
}
async function run() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`PASS ${name}`);
    } catch (error) {
      console.error(`FAIL ${name}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (!process.exitCode) console.log(`\n${passed} checks passed`);
}

const SUPERVISOR_ID = '11111111-1111-4111-8111-111111111111';
const INCIDENT_ID = '22222222-2222-4222-8222-222222222222';

function actor(overrides = {}) {
  return {
    staff_user_id: SUPERVISOR_ID,
    client_slug: 'wolfhouse',
    role: 'admin',
    ...overrides,
  };
}

test('business audit tags only the configured supervisor account', () => {
  const entry = audit.buildSupervisorBusinessAuditEntry({
    actor: actor(),
    supervisorStaffUserId: SUPERVISOR_ID,
    action: 'guest_message_send',
    incidentId: INCIDENT_ID,
    conversationId: '33333333-3333-4333-8333-333333333333',
  });
  assert.deepEqual(entry, {
    intent: 'action:supervisor:guest_message_send',
    category: 'luna_supervisor',
    supervisor: true,
    staff_user_id: SUPERVISOR_ID,
    client_slug: 'wolfhouse',
    incident_id: INCIDENT_ID,
    conversation_id: '33333333-3333-4333-8333-333333333333',
  });
});

test('business audit refuses an unpinned actor, non-admin actor, and unknown action', () => {
  const base = { supervisorStaffUserId: SUPERVISOR_ID, action: 'guest_message_send' };
  assert.throws(() => audit.buildSupervisorBusinessAuditEntry({ ...base, actor: actor({ staff_user_id: '44444444-4444-4444-8444-444444444444' }) }), /supervisor_actor_mismatch/);
  assert.throws(() => audit.buildSupervisorBusinessAuditEntry({ ...base, actor: actor({ role: 'operator' }) }), /supervisor_actor_not_admin/);
  assert.throws(() => audit.buildSupervisorBusinessAuditEntry({ ...base, actor: actor(), action: 'free_form' }), /supervisor_business_action_invalid/);
});

test('lifecycle audit is separately tagged and cannot be labelled as business work', () => {
  const entry = audit.buildSupervisorLifecycleAuditEntry({
    actor: actor(), supervisorStaffUserId: SUPERVISOR_ID,
    lifecycle: 'stopped_halted', eventId: INCIDENT_ID,
  });
  assert.deepEqual(entry, {
    intent: 'lifecycle:supervisor:stopped_halted',
    category: 'luna_supervisor_lifecycle',
    supervisor: true,
    lifecycle: true,
    staff_user_id: SUPERVISOR_ID,
    client_slug: 'wolfhouse',
    event_id: INCIDENT_ID,
  });
  assert.throws(() => audit.buildSupervisorLifecycleAuditEntry({ actor: actor(), supervisorStaffUserId: SUPERVISOR_ID, lifecycle: 'booking_create' }), /supervisor_lifecycle_invalid/);
});

test('append helpers only pass normalized allowlisted audit fields', () => {
  const entries = [];
  audit.appendSupervisorBusinessAuditLog({
    appendAuditLog: (entry) => entries.push(entry), actor: actor(), supervisorStaffUserId: SUPERVISOR_ID,
    action: 'booking_create', incidentId: INCIDENT_ID, bookingRef: 'WH-42', extra: { guest_text: 'must not enter audit' },
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].booking_ref, 'WH-42');
  assert.equal(Object.hasOwn(entries[0], 'extra'), false);
  assert.equal(Object.hasOwn(entries[0], 'guest_text'), false);
});

test('staging provisioner rejects other environments and produces a non-printed secure credential record', () => {
  assert.throws(() => provisioner.validateProvisioningInput({ environment: 'prod', clientSlug: 'wolfhouse', credentialFile: '/root/.luna-supervisor/wolfhouse.env' }), /staging_only/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-supervisor-'));
  const credentialFile = path.join(dir, 'supervisor.env');
  const password = provisioner.generatePassword(() => Buffer.alloc(48, 7));
  assert.equal(password.length >= 32, true);
  const hash = provisioner.hashPassword(password, () => Buffer.alloc(16, 9));
  assert.equal(provisioner.verifyPassword(password, hash), true);
  assert.equal(provisioner.verifyPassword('wrong password', hash), false);
  const contents = provisioner.renderCredentialFile({ staffUserId: SUPERVISOR_ID, password, clientSlug: 'wolfhouse', environment: 'staging' });
  provisioner.writeCredentialFileAtomically(credentialFile, contents, { fs, randomBytes: crypto.randomBytes });
  assert.equal(fs.readFileSync(credentialFile, 'utf8'), contents);
  assert.equal(fs.statSync(credentialFile).mode & 0o777, 0o600);
  assert.equal(contents.includes('LUNA_SUPERVISOR_PASSWORD='), true);
  assert.throws(() => provisioner.writeCredentialFileAtomically(credentialFile, 'replacement', { fs, randomBytes: crypto.randomBytes }), /credential_file_already_exists/);
  assert.equal(fs.readFileSync(credentialFile, 'utf8'), contents);
});

test('provisioning rolls back and leaves no credential when commit fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-supervisor-rollback-'));
  const credentialFile = '/root/.luna-supervisor/luna-supervisor-unit-test.env';
  const map = (file) => String(file) === '/root/.luna-supervisor'
    ? dir
    : String(file).startsWith('/root/.luna-supervisor/')
      ? path.join(dir, path.basename(file)) : file;
  const fileSystem = {
    mkdirSync: (file, options) => fs.mkdirSync(map(file), options),
    chmodSync: (file, mode) => fs.chmodSync(map(file), mode),
    openSync: (file, flags, mode) => fs.openSync(map(file), flags, mode),
    writeFileSync: (...args) => fs.writeFileSync(...args), fsyncSync: (fd) => fs.fsyncSync(fd), closeSync: (fd) => fs.closeSync(fd),
    linkSync: (from, to) => fs.linkSync(map(from), map(to)), unlinkSync: (file) => fs.unlinkSync(map(file)),
  };
  const queries = [];
  const pgClient = { query: async (sql) => {
    queries.push(sql);
    if (sql === 'COMMIT') throw new Error('commit_failed');
    if (/FROM clients/.test(sql)) return { rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] };
    if (/FROM staff_users/.test(sql)) return { rows: [] };
    if (/INSERT INTO staff_users/.test(sql)) return { rows: [{ id: SUPERVISOR_ID }] };
    return { rows: [] };
  }};
  await assert.rejects(() => provisioner.provisionSupervisorAccount({ pgClient, environment: 'staging', clientSlug: 'wolfhouse', credentialFile, randomBytes: () => Buffer.alloc(48, 7), fileSystem }), /commit_failed/);
  assert.equal(queries.includes('ROLLBACK'), true);
  assert.equal(fs.existsSync(map(credentialFile)), false);
});

run();
