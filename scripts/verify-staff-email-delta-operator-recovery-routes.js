'use strict';

/**
 * Offline RED-GREEN gate: admin-only email-delta operator recovery routes.
 *
 * Covers:
 *   - disabled/malformed/wrong tenant/deployment → concealed 404 before auth/body/DB
 *   - frozen same gate snapshot / TOCTOU resistance
 *   - exact own-data bodies; reject extras/provider/client fields
 *   - strict JSON (duplicate keys / Unicode-escape aliases) at raw-body boundary
 *   - exact request Content-Type (application/json + optional charset=utf-8)
 *   - status query via raw URLSearchParams (exactly one location_id + endpoint_id)
 *   - Real Staff API HTTP/router boundary in fresh process (full enabled gate):
 *     enabled success/status/restart/reconcile, unauthenticated, viewer/operator
 *     rejection, content-type/body/query adversarial, cross-tenant, zero DB where
 *     expected. Does not rely on extracted handlers/source strings for those proofs.
 *   - ordinary startup (module load with gate off does not listen unless main)
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
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

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const LOCATION_UUID = '22222222-2222-4222-8222-222222222222';
const ENDPOINT_ID = '33333333-3333-4333-8333-333333333333';
const LOCATION_SLUG = 'sunset-somo';
const OP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TARGET_OP_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ADMIN_STAFF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN_SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESSION_ADMIN = 'operator-recovery-admin-session';
const SESSION_VIEWER = 'operator-recovery-viewer-session';
const SESSION_OPERATOR = 'operator-recovery-operator-session';
const SESSION_OTHER = 'operator-recovery-other-tenant-session';

const {
  createStaffEmailDeltaOperatorRecoveryRoutes,
  RECOVERY_STATUS_PATH,
  RECOVERY_RESTART_PATH,
  RECOVERY_RECONCILE_PATH,
  RESTART_BODY_KEYS,
  RECONCILE_BODY_KEYS,
  RECOVERY_BODY_MAX_BYTES,
  UNSUPPORTED_MEDIA_TYPE_ERROR,
  snapshotOperatorRecoveryGateEnv,
  snapshotRestartBody,
  snapshotReconcileBody,
  snapshotStatusQuery,
  validateOperatorRecoveryJsonContentType,
  parseStrictJsonNoDuplicateKeys,
  parseOperatorRecoveryStatusQueryFromRequest,
  isExactRequestApplicationJsonContentType,
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
    staff_user_id: ADMIN_STAFF,
    session_id: ADMIN_SESSION,
    role: 'admin',
    status: 'active',
    email: 'admin@sunset.test',
    ...overrides,
  };
}

function restartBody() {
  return {
    operation_id: OP_ID,
    location_id: LOCATION_SLUG,
    endpoint_id: ENDPOINT_ID,
    expected_generation: 1,
    expected_state_version: 1,
  };
}

function restartBodyJson() {
  return JSON.stringify(restartBody());
}

function reconcileBodyJson() {
  return JSON.stringify({
    ...restartBody(),
    target_operation_id: TARGET_OP_ID,
  });
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

  for (const [name, method, args] of [
    ['status', 'handleStatus', [{ location_id: LOCATION_SLUG, endpoint_id: ENDPOINT_ID }, {}, {}, adminUser()]],
    ['restart', 'handleRestartGeneration', [restartBody(), {}, {}, adminUser()]],
    ['reconcile', 'handleReconcile', [{ ...restartBody(), target_operation_id: TARGET_OP_ID }, {}, {}, adminUser()]],
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
    Object.assign(Object.create(null), enabledEnv(), { LUNA_DEPLOYMENT: 'production' }),
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

  // ── Auth unit ───────────────────────────────────────────────────────────
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
    { client_slug: 'other', staff_user_id: ADMIN_STAFF, session_id: ADMIN_SESSION },
    enabledEnv(),
  );
  assert.equal(sendForbidden.calls[0].status, 403);
  assert.equal(dbHits, 0);
  console.log('  PASS  cross-tenant forbidden before DB');

  // ── Body validation unit ────────────────────────────────────────────────
  assert.equal(snapshotRestartBody(restartBody()) != null, true);
  assert.equal(snapshotRestartBody({ ...restartBody(), extra: 1 }), null);
  assert.equal(snapshotRestartBody({
    location_id: LOCATION_SLUG,
    endpoint_id: ENDPOINT_ID,
    operation_id: OP_ID,
    expected_generation: 1,
    expected_state_version: 1,
  }), null, 'wrong key order rejected');
  assert.equal(snapshotReconcileBody({
    ...restartBody(),
    target_operation_id: TARGET_OP_ID,
  }) != null, true);
  console.log('  PASS  exact own-data body validation');

  // ── Content-Type unit ───────────────────────────────────────────────────
  assert.equal(isExactRequestApplicationJsonContentType('application/json'), true);
  assert.equal(isExactRequestApplicationJsonContentType('application/json; charset=utf-8'), true);
  assert.equal(isExactRequestApplicationJsonContentType('application/json;charset=utf-8'), true);
  assert.equal(isExactRequestApplicationJsonContentType('APPLICATION/JSON'), true);
  assert.equal(isExactRequestApplicationJsonContentType('application/json; charset=UTF-8'), true);
  for (const bad of [
    '',
    'text/plain',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'application/vnd.api+json',
    'application/json; charset=iso-8859-1',
    'application/json; charset="utf-8"',
    'application/json; charset=utf-8; boundary=x',
    'application/json,',
    'application/json; charset=utf-8\n',
    'application/jsonn',
  ]) {
    assert.equal(
      isExactRequestApplicationJsonContentType(bad),
      false,
      `ct reject ${JSON.stringify(bad)}`,
    );
  }
  {
    const okCt = validateOperatorRecoveryJsonContentType({
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(okCt.ok, true);
    const missing = validateOperatorRecoveryJsonContentType({ headers: {} });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 415);
    assert.deepEqual(missing.body, { success: false, error: UNSUPPORTED_MEDIA_TYPE_ERROR });
    const dup = validateOperatorRecoveryJsonContentType({
      headers: {
        'Content-Type': 'application/json',
        'content-type': 'text/plain',
      },
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.status, 415);
    assert.equal(String(JSON.stringify(dup.body)).includes('text/plain'), false);
  }
  console.log('  PASS  content-type exact JSON media type');

  // ── Strict JSON unit (duplicate keys + escape aliases) ──────────────────
  assert.deepEqual(parseStrictJsonNoDuplicateKeys('{"a":1}'), Object.assign(Object.create(null), { a: 1 }));
  assert.throws(() => parseStrictJsonNoDuplicateKeys('{"a":1,"a":2}'));
  assert.throws(() => parseStrictJsonNoDuplicateKeys('{"a":1,"\\u0061":2}'));
  assert.throws(() => parseStrictJsonNoDuplicateKeys('{"x":{"a":1,"a":2}}'));
  assert.throws(() => parseStrictJsonNoDuplicateKeys('{"x":{"a":1,"\\u0061":2}}'));
  assert.throws(() => parseStrictJsonNoDuplicateKeys('{"__proto__":1}'));
  assert.throws(() => parseStrictJsonNoDuplicateKeys('{"a":01}'));
  assert.throws(() => parseStrictJsonNoDuplicateKeys('{"a":NaN}'));
  assert.throws(() => parseStrictJsonNoDuplicateKeys('{"a":1} trailing'));
  // Valid nested non-duplicate
  const nested = parseStrictJsonNoDuplicateKeys('{"a":{"b":1},"c":[1,2]}');
  assert.equal(nested.a.b, 1);
  console.log('  PASS  strict JSON duplicate-key / escape-alias rejection');

  // ── Status query unit ───────────────────────────────────────────────────
  {
    const good = parseOperatorRecoveryStatusQueryFromRequest({
      url: `${RECOVERY_STATUS_PATH}?location_id=${LOCATION_SLUG}&endpoint_id=${ENDPOINT_ID}`,
    });
    assert.equal(good.ok, true);
    assert.deepEqual(good.query, { location_id: LOCATION_SLUG, endpoint_id: ENDPOINT_ID });

    const dupKey = parseOperatorRecoveryStatusQueryFromRequest({
      url: `${RECOVERY_STATUS_PATH}?location_id=${LOCATION_SLUG}&location_id=other&endpoint_id=${ENDPOINT_ID}`,
    });
    assert.equal(dupKey.ok, false);
    assert.equal(dupKey.status, 400);

    const extra = parseOperatorRecoveryStatusQueryFromRequest({
      url: `${RECOVERY_STATUS_PATH}?location_id=${LOCATION_SLUG}&endpoint_id=${ENDPOINT_ID}&client_id=${CLIENT_ID}`,
    });
    assert.equal(extra.ok, false);

    const upperUuid = parseOperatorRecoveryStatusQueryFromRequest({
      url: `${RECOVERY_STATUS_PATH}?location_id=${LOCATION_SLUG}&endpoint_id=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA`,
    });
    assert.equal(upperUuid.ok, false, 'uppercase UUID rejected');

    const frag = parseOperatorRecoveryStatusQueryFromRequest({
      url: `${RECOVERY_STATUS_PATH}?location_id=${LOCATION_SLUG}&endpoint_id=${ENDPOINT_ID}#x`,
    });
    assert.equal(frag.ok, false);

    const userinfo = parseOperatorRecoveryStatusQueryFromRequest({
      url: `http://user:pass@host${RECOVERY_STATUS_PATH}?location_id=${LOCATION_SLUG}&endpoint_id=${ENDPOINT_ID}`,
    });
    assert.equal(userinfo.ok, false);

    const badPct = parseOperatorRecoveryStatusQueryFromRequest({
      url: `${RECOVERY_STATUS_PATH}?location_id=%ZZ&endpoint_id=${ENDPOINT_ID}`,
    });
    assert.equal(badPct.ok, false);

    assert.equal(snapshotStatusQuery({
      location_id: LOCATION_SLUG,
      endpoint_id: ENDPOINT_ID,
      extra: 'no',
    }), null);
    assert.equal(snapshotStatusQuery({
      location_id: LOCATION_SLUG,
      endpoint_id: ENDPOINT_ID,
    }) != null, true);
  }
  console.log('  PASS  status query exact surface / raw URLSearchParams');

  // ── Empty resolve → endpoint_not_found ──────────────────────────────────
  {
    const sendEmpty = captureSend();
    const routesEmpty = createStaffEmailDeltaOperatorRecoveryRoutes({
      runtimeEnv: enabledEnv(),
      sendJSON: sendEmpty.sendJSON,
      assertStaffClientAccess: () => true,
      authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
      withPgClient: async (fn) => fn({
        async query() { return { rows: [] }; },
      }),
    });
    await routesEmpty.handleRestartGeneration(
      restartBody(), {}, {}, adminUser(), enabledEnv(),
    );
    assert.equal(sendEmpty.calls[0].status, 404);
    assert.deepEqual(sendEmpty.calls[0].body, { success: false, error: 'endpoint_not_found' });
    console.log('  PASS  unresolved endpoint 404');
  }

  // ── Source / staff / docs / package structural contracts ────────────────
  {
    const routesSrc = fs.readFileSync(ROUTES_PATH, 'utf8');
    const staffSrc = fs.readFileSync(STAFF_PATH, 'utf8');
    const doc = fs.readFileSync(DOC_PATH, 'utf8');
    const pkg = fs.readFileSync(PKG_PATH, 'utf8');
    assert.match(routesSrc, /validateOperatorRecoveryJsonContentType/);
    assert.match(routesSrc, /parseStrictJsonNoDuplicateKeys/);
    assert.match(routesSrc, /parseOperatorRecoveryStatusQueryFromRequest/);
    assert.match(routesSrc, /unsupported_media_type/);
    assert.equal(/\bgetPool\s*\(|\bclosePgPool\s*\(|\.release\s*\(\s*true\s*\)/.test(routesSrc), false);
    assert.equal(/setInterval\s*\(|node-cron|scheduler\.start/.test(routesSrc), false);
    assert.match(staffSrc, /validateOperatorRecoveryJsonContentType/);
    assert.match(staffSrc, /readOperatorRecoveryStrictJsonBody/);
    assert.match(staffSrc, /parseOperatorRecoveryStatusQueryFromRequest/);
    // Gate before requireAuth on the route handler block.
    const statusHandlerIdx = staffSrc.indexOf('pathname === RECOVERY_STATUS_PATH');
    assert.ok(statusHandlerIdx > 0, 'status route mounted');
    const statusBlock = staffSrc.slice(statusHandlerIdx, statusHandlerIdx + 1200);
    assert.ok(
      statusBlock.indexOf('isEmailDeltaOperatorRecoveryEnabled')
        < statusBlock.indexOf('requireAuth'),
      'gate before requireAuth on status',
    );
    const restartIdx = staffSrc.indexOf('pathname === RECOVERY_RESTART_PATH');
    const restartBlock = staffSrc.slice(restartIdx, restartIdx + 1400);
    assert.ok(
      restartBlock.indexOf('validateOperatorRecoveryJsonContentType')
        < restartBlock.indexOf('readOperatorRecoveryStrictJsonBody'),
      'content-type before body read on restart',
    );
    assert.equal(/JSON\.parse\(\(await readBody/.test(restartBlock), false);
    assert.match(doc, /LUNA_EMAIL_DELTA_OPERATOR_RECOVERY_ENABLED/);
    assert.match(pkg, /verify:staff-email-delta-operator-recovery-routes/);
    console.log('  PASS  source/staff/docs/package contracts');
  }

  // ── Gate env snapshot ───────────────────────────────────────────────────
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

  // ── Real Staff API HTTP/router boundary (fresh process) ─────────────────
  await assertHttpRouterBoundaryFreshProcess();
  console.log('  PASS  fresh-process Staff API HTTP/router boundary');

  // ── Ordinary startup: require staff-query-api with gate off does not throw ─
  {
    const probe = `
      process.env.NODE_ENV = 'test';
      process.env.STAFF_RUNTIME_PROFILE = 'test';
      process.env.STAFF_AUTH_REQUIRED = 'true';
      process.env.STAFF_AUTH_HTTPS = 'false';
      process.env.STAFF_QUERY_API_HOST = '127.0.0.1';
      delete process.env.LUNA_EMAIL_DELTA_OPERATOR_RECOVERY_ENABLED;
      delete process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER;
      const api = require(${JSON.stringify(STAFF_PATH)});
      if (typeof api.createStaffQueryApiHttpServer !== 'function'
          && require.main === module) process.exit(2);
      // Module load succeeded without throwing (ordinary import path).
      console.log('startup_ok');
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
    assert.match(out.stdout, /startup_ok/);
    console.log('  PASS  ordinary startup (gate off import)');
  }

  console.log('\nverify:staff-email-delta-operator-recovery-routes OK');
}

/**
 * Fresh-process proofs against the real staff-query-api HTTP router.
 * Full enabled gate; fortress offline seams for session + PG only.
 */
async function assertHttpRouterBoundaryFreshProcess() {
  const script = `
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

const ROOT = ${JSON.stringify(ROOT)};
const STAFF_PATH = ${JSON.stringify(STAFF_PATH)};
const RECOVERY_STATUS_PATH = ${JSON.stringify(RECOVERY_STATUS_PATH)};
const RECOVERY_RESTART_PATH = ${JSON.stringify(RECOVERY_RESTART_PATH)};
const RECOVERY_RECONCILE_PATH = ${JSON.stringify(RECOVERY_RECONCILE_PATH)};
const HOST = ${JSON.stringify(HOST)};
const KID = ${JSON.stringify(KID)};
const CLIENT_ID = ${JSON.stringify(CLIENT_ID)};
const LOCATION_UUID = ${JSON.stringify(LOCATION_UUID)};
const ENDPOINT_ID = ${JSON.stringify(ENDPOINT_ID)};
const LOCATION_SLUG = ${JSON.stringify(LOCATION_SLUG)};
const OP_ID = ${JSON.stringify(OP_ID)};
const TARGET_OP_ID = ${JSON.stringify(TARGET_OP_ID)};
const ADMIN_STAFF = ${JSON.stringify(ADMIN_STAFF)};
const ADMIN_SESSION = ${JSON.stringify(ADMIN_SESSION)};
const SESSION_ADMIN = ${JSON.stringify(SESSION_ADMIN)};
const SESSION_VIEWER = ${JSON.stringify(SESSION_VIEWER)};
const SESSION_OPERATOR = ${JSON.stringify(SESSION_OPERATOR)};
const SESSION_OTHER = ${JSON.stringify(SESSION_OTHER)};
const RECOVERY_BODY_MAX_BYTES = ${JSON.stringify(RECOVERY_BODY_MAX_BYTES)};

// Resolve dotenv if present (staff-query-api may require it).
try { require.resolve('dotenv'); } catch {
  const candidates = [
    path.join(ROOT, 'node_modules'),
    path.join(ROOT, '..', 'wolfhouse-agent', 'node_modules'),
    '/opt/data/wolfhouse-agent/node_modules',
  ];
  const found = candidates.find((c) => fs.existsSync(path.join(c, 'dotenv')));
  if (found) {
    const prev = process.env.NODE_PATH || '';
    process.env.NODE_PATH = prev ? found + path.delimiter + prev : found;
    Module._initPaths();
  }
}

function applyEnabledEnv() {
  process.env.LUNA_EMAIL_DELTA_OPERATOR_RECOVERY_ENABLED = 'true';
  process.env.LUNA_EMAIL_DELTA_RUNTIME_COMPOSITION_ENABLED = 'true';
  process.env.LUNA_EMAIL_DELTA_ADMIN_ENABLED = 'true';
  process.env.LUNA_EMAIL_DELTA_WORKER_ENABLED = 'false';
  process.env.LUNA_DEPLOYMENT = 'sunset-staging';
  process.env.DEFAULT_CLIENT_SLUG = 'sunset';
  process.env.EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED = 'true';
  process.env.EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST = HOST;
  process.env.EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID = KID;
}

function clearStaffApiCache() {
  for (const key of Object.keys(require.cache)) {
    if (/staff-query-api\\.js$/.test(key)
        || /staff-auth-config\\.js$/.test(key)
        || /staff-portal-clients\\.js$/.test(key)
        || /pg-connect\\.js$/.test(key)
        || /staff-email-delta-operator-recovery-routes\\.js$/.test(key)
        || /email-delta-operator-recovery/.test(key)) {
      delete require.cache[key];
    }
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.on('error', reject);
  });
}
function closeServer(server) {
  return new Promise((resolve) => { server.close(() => resolve()); });
}

function request(port, { method, path: p, headers, body }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body);
    const hdrs = { ...(headers || {}) };
    if (payload) hdrs['content-length'] = payload.length;
    const req = http.request({
      hostname: '127.0.0.1', port, path: p, method, headers: hdrs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const SESSION_USERS = {
  [SESSION_ADMIN]: {
    staff_user_id: ADMIN_STAFF,
    email: 'recovery.admin@sunset.test',
    role: 'admin',
    status: 'active',
    display_name: 'Recovery Admin',
    client_id: CLIENT_ID,
    client_slug: 'sunset',
    session_id: ADMIN_SESSION,
  },
  [SESSION_VIEWER]: {
    staff_user_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    email: 'recovery.viewer@sunset.test',
    role: 'viewer',
    status: 'active',
    display_name: 'Viewer',
    client_id: CLIENT_ID,
    client_slug: 'sunset',
    session_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  },
  [SESSION_OPERATOR]: {
    staff_user_id: '99999999-9999-4999-8999-999999999999',
    email: 'recovery.operator@sunset.test',
    role: 'operator',
    status: 'active',
    display_name: 'Operator',
    client_id: CLIENT_ID,
    client_slug: 'sunset',
    session_id: '88888888-8888-4888-8888-888888888888',
  },
  [SESSION_OTHER]: {
    staff_user_id: ADMIN_STAFF,
    email: 'recovery.other@wolfhouse.test',
    role: 'admin',
    status: 'active',
    display_name: 'Other',
    client_id: '77777777-7777-4777-8777-777777777777',
    client_slug: 'wolfhouse',
    session_id: ADMIN_SESSION,
  },
};

function cookie(token) {
  return 'luna_staff_session=' + encodeURIComponent(token);
}

function restartJson() {
  return JSON.stringify({
    operation_id: OP_ID,
    location_id: LOCATION_SLUG,
    endpoint_id: ENDPOINT_ID,
    expected_generation: 1,
    expected_state_version: 1,
  });
}
function reconcileJson() {
  return JSON.stringify({
    operation_id: OP_ID,
    location_id: LOCATION_SLUG,
    endpoint_id: ENDPOINT_ID,
    expected_generation: 1,
    expected_state_version: 1,
    target_operation_id: TARGET_OP_ID,
  });
}

function statusPath(qs) {
  return RECOVERY_STATUS_PATH + '?' + qs;
}

async function withServer(envMode, pgFactory, work) {
  process.env.NODE_ENV = 'test';
  process.env.STAFF_RUNTIME_PROFILE = 'test';
  process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER = '1';
  process.env.STAFF_AUTH_REQUIRED = 'true';
  process.env.STAFF_AUTH_HTTPS = 'false';
  process.env.STAFF_QUERY_API_HOST = '127.0.0.1';
  process.env.LUNA_BOT_INTERNAL_TOKEN = 'operator_recovery_router_offline_token_01';

  if (envMode === 'enabled') {
    applyEnabledEnv();
  } else if (envMode === 'disabled') {
    delete process.env.LUNA_EMAIL_DELTA_OPERATOR_RECOVERY_ENABLED;
    process.env.LUNA_DEPLOYMENT = 'sunset-staging';
    process.env.DEFAULT_CLIENT_SLUG = 'sunset';
  } else if (envMode === 'wrong_deploy') {
    applyEnabledEnv();
    process.env.LUNA_DEPLOYMENT = 'production';
  }

  clearStaffApiCache();
  const api = require(STAFF_PATH);
  assert.equal(typeof api.createStaffQueryApiHttpServer, 'function');

  let dbCalls = 0;
  const withPgClient = async (fn) => {
    dbCalls += 1;
    const pg = pgFactory ? pgFactory() : {
      async query() { throw new Error('unexpected_db'); },
    };
    return fn(pg);
  };

  api.setFortress15j3OfflineSeams({
    withPgClient,
    canAccessClient(user, slug) {
      if (!user) return false;
      if (user.client_slug === 'sunset' && slug === 'sunset') return true;
      return false;
    },
    resolveSessionUser(req) {
      const raw = String((req.headers && req.headers.cookie) || '');
      const parts = raw.split(';');
      for (const part of parts) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const name = part.slice(0, eq).trim();
        const val = decodeURIComponent(part.slice(eq + 1).trim());
        if (name === (api.COOKIE_NAME || 'luna_staff_session') && SESSION_USERS[val]) {
          return { ...SESSION_USERS[val] };
        }
      }
      return null;
    },
  });

  const server = api.createStaffQueryApiHttpServer();
  const port = await listen(server);
  try {
    await work({ port, api, getDbCalls: () => dbCalls });
  } finally {
    await closeServer(server);
    api.setFortress15j3OfflineSeams(null);
    clearStaffApiCache();
  }
}

function resolveRowPg() {
  let calls = 0;
  return {
    async query(sql) {
      calls += 1;
      const q = String(sql || '');
      // Operator recovery binding resolve
      if (/FROM clients c/i.test(q) && /tenant_channel_endpoints/i.test(q)) {
        return {
          rows: [{
            client_id: CLIENT_ID,
            location_id: LOCATION_UUID,
            endpoint_id: ENDPOINT_ID,
          }],
        };
      }
      // getRecoveryStatus public status — empty → state_present false success
      if (/tenant_email_inbound_delta_states/i.test(q) || /ingestion_generation/i.test(q)) {
        return { rows: [] };
      }
      // Authority / other — empty
      return { rows: [] };
    },
    getCalls() { return calls; },
  };
}

(async () => {
  // 1) Disabled → 404 before auth/body/DB
  await withServer('disabled', null, async ({ port, getDbCalls }) => {
    const res = await request(port, {
      method: 'POST',
      path: RECOVERY_RESTART_PATH,
      headers: {
        'content-type': 'application/json',
        cookie: cookie(SESSION_ADMIN),
      },
      body: restartJson(),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { success: false, error: 'not_found' });
    assert.equal(getDbCalls(), 0);
    assert.equal(String(res.raw).includes('Authentication required'), false);
  });

  // 2) Wrong deployment still 404
  await withServer('wrong_deploy', null, async ({ port, getDbCalls }) => {
    const res = await request(port, {
      method: 'GET',
      path: statusPath('location_id=' + LOCATION_SLUG + '&endpoint_id=' + ENDPOINT_ID),
      headers: { cookie: cookie(SESSION_ADMIN) },
    });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { success: false, error: 'not_found' });
    assert.equal(getDbCalls(), 0);
  });

  // 3) Unauthenticated established status → 401, zero DB
  await withServer('enabled', null, async ({ port, getDbCalls }) => {
    const res = await request(port, {
      method: 'GET',
      path: statusPath('location_id=' + LOCATION_SLUG + '&endpoint_id=' + ENDPOINT_ID),
      headers: {},
    });
    assert.equal(res.status, 401);
    assert.equal(getDbCalls(), 0);
  });

  // 4) Viewer / operator rejection → 403, zero DB
  await withServer('enabled', null, async ({ port, getDbCalls }) => {
    for (const tok of [SESSION_VIEWER, SESSION_OPERATOR]) {
      const res = await request(port, {
        method: 'POST',
        path: RECOVERY_RESTART_PATH,
        headers: {
          'content-type': 'application/json',
          cookie: cookie(tok),
        },
        body: restartJson(),
      });
      assert.equal(res.status, 403, 'role ' + tok);
      assert.equal(getDbCalls(), 0);
    }
  });

  // 5) Content-type missing / wrong / malformed / duplicate → 415 before body/DB
  await withServer('enabled', null, async ({ port, getDbCalls }) => {
    const cases = [
      { name: 'missing', headers: { cookie: cookie(SESSION_ADMIN) } },
      { name: 'text/plain', headers: { cookie: cookie(SESSION_ADMIN), 'content-type': 'text/plain' } },
      { name: 'form', headers: { cookie: cookie(SESSION_ADMIN), 'content-type': 'application/x-www-form-urlencoded' } },
      { name: 'vendor', headers: { cookie: cookie(SESSION_ADMIN), 'content-type': 'application/vnd.api+json' } },
      { name: 'malformed', headers: { cookie: cookie(SESSION_ADMIN), 'content-type': 'application/json;' } },
      { name: 'charset-latin', headers: { cookie: cookie(SESSION_ADMIN), 'content-type': 'application/json; charset=iso-8859-1' } },
    ];
    for (const c of cases) {
      const res = await request(port, {
        method: 'POST',
        path: RECOVERY_RESTART_PATH,
        headers: c.headers,
        body: restartJson(),
      });
      assert.equal(res.status, 415, c.name);
      assert.deepEqual(res.body, { success: false, error: 'unsupported_media_type' });
      // Never echo hostile content-type values
      assert.equal(String(res.raw).includes('text/plain'), false);
      assert.equal(String(res.raw).includes('iso-8859-1'), false);
      assert.equal(String(res.raw).includes('vnd.api'), false);
    }
    assert.equal(getDbCalls(), 0);
  });

  // 6) Duplicate raw JSON keys + Unicode-escape aliases → 400, zero DB
  await withServer('enabled', null, async ({ port, getDbCalls }) => {
    const bodies = [
      '{"operation_id":"' + OP_ID + '","operation_id":"' + OP_ID + '","location_id":"' + LOCATION_SLUG + '","endpoint_id":"' + ENDPOINT_ID + '","expected_generation":1,"expected_state_version":1}',
      '{"operation_id":"' + OP_ID + '","\\u006fperation_id":"' + OP_ID + '","location_id":"' + LOCATION_SLUG + '","endpoint_id":"' + ENDPOINT_ID + '","expected_generation":1,"expected_state_version":1}',
      '{"outer":{"a":1,"a":2},"operation_id":"' + OP_ID + '","location_id":"' + LOCATION_SLUG + '","endpoint_id":"' + ENDPOINT_ID + '","expected_generation":1,"expected_state_version":1}',
    ];
    for (const body of bodies) {
      const res = await request(port, {
        method: 'POST',
        path: RECOVERY_RESTART_PATH,
        headers: {
          'content-type': 'application/json',
          cookie: cookie(SESSION_ADMIN),
        },
        body,
      });
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { success: false, error: 'invalid_request' });
      // Never leak raw body
      assert.equal(String(res.raw).includes('operation_id'), false);
    }
    assert.equal(getDbCalls(), 0);
  });

  // 7) Oversized body → 400, zero DB
  await withServer('enabled', null, async ({ port, getDbCalls }) => {
    const huge = '{"x":"' + 'a'.repeat(RECOVERY_BODY_MAX_BYTES + 64) + '"}';
    const res = await request(port, {
      method: 'POST',
      path: RECOVERY_RESTART_PATH,
      headers: {
        'content-type': 'application/json',
        cookie: cookie(SESSION_ADMIN),
      },
      body: huge,
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { success: false, error: 'invalid_request' });
    assert.equal(getDbCalls(), 0);
  });

  // 8) Duplicate / extraneous query keys → 400, zero DB
  await withServer('enabled', null, async ({ port, getDbCalls }) => {
    const badQs = [
      'location_id=' + LOCATION_SLUG + '&location_id=other&endpoint_id=' + ENDPOINT_ID,
      'location_id=' + LOCATION_SLUG + '&endpoint_id=' + ENDPOINT_ID + '&client_id=' + CLIENT_ID,
      'location_id=' + LOCATION_SLUG + '&endpoint_id=' + ENDPOINT_ID + '&endpoint_id=' + ENDPOINT_ID,
      'endpoint_id=' + ENDPOINT_ID,
      'location_id=' + LOCATION_SLUG + '&endpoint_id=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    ];
    for (const qs of badQs) {
      const res = await request(port, {
        method: 'GET',
        path: statusPath(qs),
        headers: { cookie: cookie(SESSION_ADMIN) },
      });
      assert.equal(res.status, 400, qs);
      assert.deepEqual(res.body, { success: false, error: 'invalid_request' });
    }
    assert.equal(getDbCalls(), 0);
  });

  // 9) Cross-tenant admin session → 403 before DB
  await withServer('enabled', null, async ({ port, getDbCalls }) => {
    const res = await request(port, {
      method: 'POST',
      path: RECOVERY_RESTART_PATH,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        cookie: cookie(SESSION_OTHER),
      },
      body: restartJson(),
    });
    assert.equal(res.status, 403);
    assert.equal(getDbCalls(), 0);
  });

  // 10) Enabled status success (resolve row + empty delta state)
  await withServer('enabled', resolveRowPg, async ({ port, getDbCalls }) => {
    const res = await request(port, {
      method: 'GET',
      path: statusPath('location_id=' + LOCATION_SLUG + '&endpoint_id=' + ENDPOINT_ID),
      headers: { cookie: cookie(SESSION_ADMIN) },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(res.body.state_present, false);
    assert.equal(typeof res.body.recovery_blocked, 'boolean');
    assert.ok(getDbCalls() >= 1);
  });

  // 11) Enabled restart/reconcile with unresolved endpoint → 404 after auth/body
  await withServer('enabled', () => ({
    async query() { return { rows: [] }; },
  }), async ({ port, getDbCalls }) => {
    const r1 = await request(port, {
      method: 'POST',
      path: RECOVERY_RESTART_PATH,
      headers: {
        'content-type': 'application/json',
        cookie: cookie(SESSION_ADMIN),
      },
      body: restartJson(),
    });
    assert.equal(r1.status, 404);
    assert.deepEqual(r1.body, { success: false, error: 'endpoint_not_found' });

    const r2 = await request(port, {
      method: 'POST',
      path: RECOVERY_RECONCILE_PATH,
      headers: {
        'content-type': 'APPLICATION/JSON; charset=UTF-8',
        cookie: cookie(SESSION_ADMIN),
      },
      body: reconcileJson(),
    });
    assert.equal(r2.status, 404);
    assert.deepEqual(r2.body, { success: false, error: 'endpoint_not_found' });
    assert.ok(getDbCalls() >= 2);
  });

  // 12) charset=utf-8 accepted on restart (valid media type)
  await withServer('enabled', () => ({
    async query() { return { rows: [] }; },
  }), async ({ port }) => {
    const res = await request(port, {
      method: 'POST',
      path: RECOVERY_RESTART_PATH,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        cookie: cookie(SESSION_ADMIN),
      },
      body: restartJson(),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { success: false, error: 'endpoint_not_found' });
  });

  console.log('http_boundary_ok');
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
`;

  const out = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_PATH: process.env.NODE_PATH || '/opt/data/wolfhouse-agent/node_modules',
    },
    timeout: 120000,
  });
  assert.equal(out.status, 0, (out.stderr || '') + '\n' + (out.stdout || ''));
  assert.match(out.stdout, /http_boundary_ok/);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
