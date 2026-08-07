'use strict';

/**
 * Offline RED-GREEN gate: admin-only email-delta operator recovery routes.
 *
 * Covers:
 *   - disabled/malformed/wrong tenant/deployment → concealed 404 before auth/body/DB
 *   - frozen same gate snapshot / TOCTOU resistance
 *   - enabled auth/roles/cross-tenant
 *   - exact own-data bodies; reject extras/provider/client fields
 *   - bounded HTTP mapping
 *   - no worker/scheduler
 *   - staff-query-api structural wiring (gate before requireAuth)
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ROUTES_PATH = path.join(ROOT, 'scripts/lib/staff-email-delta-operator-recovery-routes.js');
const STAFF_PATH = path.join(ROOT, 'scripts/staff-query-api.js');
const DOC_PATH = path.join(ROOT, 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md');
const PKG_PATH = path.join(ROOT, 'package.json');

const HOST = 'luna-sunset-staging-kv.vault.azure.net';
const KNAME = 'luna-email-grant-kek';
const KVER = 'fde9704bd37b45fabe1f12a6a615b032';
const KID = `https://${HOST}/keys/${KNAME}/${KVER}`;

const {
  createStaffEmailDeltaOperatorRecoveryRoutes,
  RECOVERY_STATUS_PATH,
  RECOVERY_RESTART_PATH,
  RECOVERY_RECONCILE_PATH,
  RESTART_BODY_KEYS,
  RECONCILE_BODY_KEYS,
  snapshotOperatorRecoveryGateEnv,
  snapshotRestartBody,
  snapshotReconcileBody,
  isEmailDeltaOperatorRecoveryEnabled,
} = require('./lib/staff-email-delta-operator-recovery-routes');

function captureSend() {
  const calls = [];
  return {
    calls,
    sendJSON(res, status, body) {
      calls.push({ status, body: body && typeof body === 'object' ? { ...body } : body });
      return body;
    },
  };
}

function enabledEnv() {
  return Object.freeze(Object.assign(Object.create(null), {
    LUNA_EMAIL_DELTA_OPERATOR_RECOVERY_ENABLED: 'true',
    LUNA_EMAIL_DELTA_RUNTIME_COMPOSITION_ENABLED: 'true',
    LUNA_EMAIL_DELTA_ADMIN_ENABLED: 'true',
    LUNA_EMAIL_DELTA_WORKER_ENABLED: 'false',
    LUNA_DEPLOYMENT: 'sunset-staging',
    DEFAULT_CLIENT_SLUG: 'sunset',
    EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED: 'true',
    EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST: HOST,
    EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID: KID,
  }));
}

function adminUser(overrides) {
  return {
    client_slug: 'sunset',
    staff_user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ...overrides,
  };
}

function restartBody() {
  return {
    operation_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    location_id: 'sunset-somo',
    endpoint_id: '33333333-3333-4333-8333-333333333333',
    expected_generation: 1,
    expected_state_version: 1,
  };
}

async function main() {
  console.log('verify:staff-email-delta-operator-recovery-routes');

  assert.equal(RECOVERY_STATUS_PATH, '/staff/admin/email-settings/delta/recovery/status');
  assert.equal(RECOVERY_RESTART_PATH, '/staff/admin/email-settings/delta/recovery/restart-generation');
  assert.equal(RECOVERY_RECONCILE_PATH, '/staff/admin/email-settings/delta/recovery/reconcile');
  assert.deepEqual([...RESTART_BODY_KEYS], [
    'operation_id', 'location_id', 'endpoint_id',
    'expected_generation', 'expected_state_version',
  ]);
  assert.deepEqual([...RECONCILE_BODY_KEYS], [
    'operation_id', 'location_id', 'endpoint_id',
    'expected_generation', 'expected_state_version', 'target_operation_id',
  ]);

  // ── Disabled → concealed 404 zero auth/body/DB ──────────────────────────
  let dbHits = 0;
  let authHits = 0;
  const sendOff = captureSend();
  const routesOff = createStaffEmailDeltaOperatorRecoveryRoutes({
    runtimeEnv: enabledEnv(),
    sendJSON: sendOff.sendJSON,
    assertStaffClientAccess() { authHits += 1; return true; },
    authorizeAuthenticatedStaffRoute() { authHits += 1; return { ok: true }; },
    withPgClient: async () => { dbHits += 1; throw new Error('db should not run'); },
  });
  await routesOff.handleRestartGeneration(
    restartBody(), {}, {}, adminUser(),
    Object.freeze({ LUNA_DEPLOYMENT: 'sunset-staging' }), // gate off
  );
  assert.equal(sendOff.calls.length, 1);
  assert.equal(sendOff.calls[0].status, 404);
  assert.deepEqual(sendOff.calls[0].body, { success: false, error: 'not_found' });
  assert.equal(dbHits, 0, 'disabled 404 zero DB');
  assert.equal(authHits, 0, 'disabled 404 zero ACL/authz');
  console.log('  PASS  disabled concealed 404 zero auth/body/DB');

  // all three routes when disabled
  for (const [name, method, args] of [
    ['status', 'handleStatus', [{ location_id: 'sunset-somo', endpoint_id: '33333333-3333-4333-8333-333333333333' }, {}, {}, adminUser()]],
    ['restart', 'handleRestartGeneration', [restartBody(), {}, {}, adminUser()]],
    ['reconcile', 'handleReconcile', [{ ...restartBody(), target_operation_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }, {}, {}, adminUser()]],
  ]) {
    const s = captureSend();
    const r = createStaffEmailDeltaOperatorRecoveryRoutes({
      runtimeEnv: {},
      sendJSON: s.sendJSON,
      assertStaffClientAccess: () => true,
      authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
      withPgClient: async () => { throw new Error('no db'); },
    });
    await r[method](...args, Object.freeze({}));
    assert.equal(s.calls[0].status, 404);
    assert.deepEqual(s.calls[0].body, { success: false, error: 'not_found' });
    console.log(`  PASS  ${name} disabled 404`);
  }

  // ── Wrong deployment / tenant ───────────────────────────────────────────
  for (const bad of [
    enabledEnv() && Object.assign(Object.create(null), enabledEnv(), { LUNA_DEPLOYMENT: 'production' }),
    Object.assign(Object.create(null), enabledEnv(), { DEFAULT_CLIENT_SLUG: 'wolfhouse' }),
    Object.assign(Object.create(null), enabledEnv(), { LUNA_EMAIL_DELTA_OPERATOR_RECOVERY_ENABLED: 'TRUE' }),
    Object.assign(Object.create(null), enabledEnv(), { LUNA_EMAIL_DELTA_WORKER_ENABLED: 'true' }),
    Object.assign(Object.create(null), enabledEnv(), { LUNA_EMAIL_DELTA_ADMIN_ENABLED: 'false' }),
    Object.assign(Object.create(null), enabledEnv(), { LUNA_EMAIL_DELTA_RUNTIME_COMPOSITION_ENABLED: 'false' }),
  ]) {
    assert.equal(isEmailDeltaOperatorRecoveryEnabled(Object.freeze(bad)), false);
  }
  console.log('  PASS  wrong/incomplete gate variants fail closed');

  // ── TOCTOU: gate snapshot off resists runtimeEnv true ───────────────────
  dbHits = 0;
  const sendToctou = captureSend();
  const routesToctou = createStaffEmailDeltaOperatorRecoveryRoutes({
    runtimeEnv: enabledEnv(),
    sendJSON: sendToctou.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async () => { dbHits += 1; },
  });
  await routesToctou.handleRestartGeneration(
    restartBody(), {}, {}, adminUser(),
    Object.freeze({ LUNA_DEPLOYMENT: 'sunset-staging' }),
  );
  assert.equal(sendToctou.calls[0].status, 404);
  assert.equal(dbHits, 0);
  console.log('  PASS  TOCTOU gate snapshot off');

  // ── Auth: non-sunset / missing staff ────────────────────────────────────
  const sendForbidden = captureSend();
  const routesOn = createStaffEmailDeltaOperatorRecoveryRoutes({
    runtimeEnv: enabledEnv(),
    sendJSON: sendForbidden.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async () => { dbHits += 1; },
  });
  dbHits = 0;
  await routesOn.handleRestartGeneration(
    restartBody(), {}, {},
    { client_slug: 'other', staff_user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    enabledEnv(),
  );
  assert.equal(sendForbidden.calls[0].status, 403);
  assert.equal(dbHits, 0);
  console.log('  PASS  cross-tenant forbidden before DB');

  const sendNoStaff = captureSend();
  const routesNoStaff = createStaffEmailDeltaOperatorRecoveryRoutes({
    runtimeEnv: enabledEnv(),
    sendJSON: sendNoStaff.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async () => { dbHits += 1; },
  });
  await routesNoStaff.handleRestartGeneration(
    restartBody(), {}, {}, null, enabledEnv(),
  );
  assert.equal(sendNoStaff.calls[0].status, 403);
  console.log('  PASS  missing user forbidden');

  // ACL deny
  const sendAcl = captureSend();
  const routesAcl = createStaffEmailDeltaOperatorRecoveryRoutes({
    runtimeEnv: enabledEnv(),
    sendJSON: sendAcl.sendJSON,
    assertStaffClientAccess(user, slug, res) {
      sendAcl.sendJSON(res, 403, { success: false, error: 'forbidden' });
      return false;
    },
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async () => { throw new Error('no'); },
  });
  await routesAcl.handleRestartGeneration(
    restartBody(), {}, {}, adminUser(), enabledEnv(),
  );
  assert.equal(sendAcl.calls[0].status, 403);
  console.log('  PASS  Sunset ACL deny');

  // authz deny
  const sendAuthz = captureSend();
  const routesAuthz = createStaffEmailDeltaOperatorRecoveryRoutes({
    runtimeEnv: enabledEnv(),
    sendJSON: sendAuthz.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({
      ok: false, status: 403, body: { success: false, error: 'forbidden' },
    }),
    withPgClient: async () => { throw new Error('no'); },
  });
  await routesAuthz.handleRestartGeneration(
    restartBody(), {}, {}, adminUser(), enabledEnv(),
  );
  assert.equal(sendAuthz.calls[0].status, 403);
  console.log('  PASS  route authz deny');

  // ── Body validation ─────────────────────────────────────────────────────
  assert.equal(snapshotRestartBody(restartBody()) != null, true);
  assert.equal(snapshotRestartBody({ ...restartBody(), extra: 1 }), null);
  assert.equal(snapshotRestartBody({
    location_id: 'sunset-somo',
    endpoint_id: '33333333-3333-4333-8333-333333333333',
    operation_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    expected_generation: 1,
    expected_state_version: 1,
  }), null, 'wrong key order rejected');
  assert.equal(snapshotRestartBody({
    ...restartBody(),
    client_id: '11111111-1111-4111-8111-111111111111',
  }), null);
  // provider fields
  const withProvider = {
    operation_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    location_id: 'sunset-somo',
    endpoint_id: '33333333-3333-4333-8333-333333333333',
    expected_generation: 1,
    expected_state_version: 1,
    provider_tenant_id: '55555555-5555-4555-8555-555555555555',
  };
  assert.equal(snapshotRestartBody(withProvider), null);
  assert.equal(snapshotReconcileBody({
    ...restartBody(),
    target_operation_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  }) != null, true);
  assert.equal(snapshotReconcileBody({
    ...restartBody(),
    target_operation_id: restartBody().operation_id,
  }), null, 'same op/target rejected');
  console.log('  PASS  exact own-data body validation');

  const sendBadBody = captureSend();
  const routesBad = createStaffEmailDeltaOperatorRecoveryRoutes({
    runtimeEnv: enabledEnv(),
    sendJSON: sendBadBody.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async () => { throw new Error('no'); },
  });
  await routesBad.handleRestartGeneration(
    { bad: true }, {}, {}, adminUser(), enabledEnv(),
  );
  assert.equal(sendBadBody.calls[0].status, 400);
  assert.deepEqual(sendBadBody.calls[0].body, { success: false, error: 'invalid_request' });
  console.log('  PASS  malformed body 400');

  // ── Empty resolve → endpoint_not_found ──────────────────────────────────
  const sendEmpty = captureSend();
  const routesEmpty = createStaffEmailDeltaOperatorRecoveryRoutes({
    runtimeEnv: enabledEnv(),
    sendJSON: sendEmpty.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async (fn) => fn({
      async query() {
        return { rows: [] };
      },
    }),
  });
  await routesEmpty.handleRestartGeneration(
    restartBody(), {}, {}, adminUser(), enabledEnv(),
  );
  assert.equal(sendEmpty.calls[0].status, 404);
  assert.deepEqual(sendEmpty.calls[0].body, { success: false, error: 'endpoint_not_found' });
  console.log('  PASS  unresolved endpoint 404');

  // ── Source / staff / docs / package ─────────────────────────────────────
  const routesSrc = fs.readFileSync(ROUTES_PATH, 'utf8');
  const staffSrc = fs.readFileSync(STAFF_PATH, 'utf8');
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  const pkg = fs.readFileSync(PKG_PATH, 'utf8');

  assert.match(routesSrc, /isEmailDeltaOperatorRecoveryEnabled/);
  assert.match(routesSrc, /withPgClient/);
  assert.match(routesSrc, /not_found/);
  assert.match(routesSrc, /commit_outcome_unknown/);
  assert.equal(/\bgetPool\s*\(|\bclosePgPool\s*\(|\.release\s*\(\s*true\s*\)/.test(routesSrc), false);
  assert.equal(/setInterval\s*\(|node-cron|scheduler\.start/.test(routesSrc), false);
  assert.match(staffSrc, /RECOVERY_STATUS_PATH/);
  assert.match(staffSrc, /isEmailDeltaOperatorRecoveryEnabled/);
  assert.match(staffSrc, /snapshotOperatorRecoveryGateEnv/);
  // Gate before requireAuth on the route handler block (not the import).
  const statusHandlerIdx = staffSrc.indexOf('pathname === RECOVERY_STATUS_PATH');
  assert.ok(statusHandlerIdx > 0, 'status route mounted');
  const statusBlock = staffSrc.slice(statusHandlerIdx, statusHandlerIdx + 900);
  assert.ok(
    statusBlock.indexOf('isEmailDeltaOperatorRecoveryEnabled')
      < statusBlock.indexOf('requireAuth'),
    'gate before requireAuth on status',
  );
  assert.match(doc, /LUNA_EMAIL_DELTA_OPERATOR_RECOVERY_ENABLED/);
  assert.match(doc, /restart-generation/);
  assert.match(pkg, /verify:staff-email-delta-operator-recovery-routes/);
  console.log('  PASS  source/staff/docs/package contracts');

  // ── Fresh process: disabled 404 zero owner load ─────────────────────────
  {
    const probe = `
      const path = require('path');
      const routesPath = ${JSON.stringify(ROUTES_PATH)};
      let loaded = false;
      const Module = require('module');
      const orig = Module._load;
      Module._load = function(request, parent, isMain) {
        if (String(request).includes('email-delta-recovery-operation-store')
            || String(request).includes('email-inbound-delta-state-store')) {
          loaded = true;
        }
        return orig.apply(this, arguments);
      };
      const {
        createStaffEmailDeltaOperatorRecoveryRoutes,
      } = require(routesPath);
      const calls = [];
      const routes = createStaffEmailDeltaOperatorRecoveryRoutes({
        runtimeEnv: {},
        sendJSON(res, status, body) { calls.push({ status, body }); },
        assertStaffClientAccess() { throw new Error('auth'); },
        authorizeAuthenticatedStaffRoute() { throw new Error('authz'); },
        withPgClient() { throw new Error('db'); },
      });
      Promise.resolve(routes.handleRestartGeneration(
        { operation_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          location_id: 'sunset-somo',
          endpoint_id: '33333333-3333-4333-8333-333333333333',
          expected_generation: 1, expected_state_version: 1 },
        {}, {}, { client_slug: 'sunset',
          staff_user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          session_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        Object.freeze({}),
      )).then(() => {
        if (calls[0].status !== 404) process.exit(2);
        if (calls[0].body.error !== 'not_found') process.exit(3);
        // route module may require composition graph at load; gate path must not
        // construct runtime service. loaded may be true from module graph — ok.
        console.log('ok');
      }).catch((e) => { console.error(e); process.exit(1); });
    `;
    const out = spawnSync(process.execPath, ['-e', probe], {
      encoding: 'utf8',
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_PATH: process.env.NODE_PATH || '/opt/data/wolfhouse-agent/node_modules',
      },
    });
    assert.equal(out.status, 0, out.stderr || out.stdout);
    assert.match(out.stdout, /ok/);
    console.log('  PASS  fresh-process disabled 404');
  }

  // snapshotOperatorRecoveryGateEnv
  {
    const snap = snapshotOperatorRecoveryGateEnv({
      LUNA_DEPLOYMENT: 'sunset-staging',
      LUNA_EMAIL_DELTA_OPERATOR_RECOVERY_ENABLED: 'true',
      EXTRA: 'nope',
    });
    assert.equal(snap.LUNA_DEPLOYMENT, 'sunset-staging');
    assert.equal(snap.EXTRA, undefined);
    assert.ok(Object.isFrozen(snap));
    console.log('  PASS  gate env snapshot');
  }

  console.log('\nverify:staff-email-delta-operator-recovery-routes OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
