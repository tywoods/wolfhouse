'use strict';

/**
 * Offline RED-GREEN gate: admin-only durable inbound-capture route.
 *
 * Hostile coverage:
 *   - pre-auth concealment (flag absent / non-Sunset / production / wolfhouse)
 *   - frozen same gate snapshot / TOCTOU resistance
 *   - exact flag isolation vs diagnostic / read-health / refresh / start
 *   - admin / tenant / authz before DB
 *   - exact JSON / key order / count / max-5 invariant
 *   - durable_identity_count is not newly-inserted vocabulary
 *   - sanitized failures / no PII
 *   - nested transaction capability plumbing (withTransactionClient ≠ outer pg)
 *   - diagnostic / read-health sibling regressions
 *
 * Activation precondition (documented; not applied here): migration 063 ledger
 * + schema for tenant_email_inbound_events.
 *
 * No network, live DB, migration apply, enable, deploy, cron, or poller.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  OAUTH_INBOUND_CAPTURE_PATH,
  OAUTH_INBOUND_DIAGNOSTIC_PATH,
  OAUTH_READ_HEALTH_PATH,
  OAUTH_REFRESH_HEALTH_PATH,
  OAUTH_START_PATH,
  OAUTH_CALLBACK_PATH,
  INBOUND_CAPTURE_SUCCESS_KEYS,
  INBOUND_CAPTURE_BODY_KEYS,
  INBOUND_CAPTURE_ERROR,
  INBOUND_DIAGNOSTIC_SUCCESS_KEYS,
  READ_HEALTH_SUCCESS_KEYS,
  buildInboundCaptureSuccessJson,
  buildInboundDiagnosticSuccessJson,
  snapshotInboundCaptureBody,
  createStaffEmailOAuthRoutes,
  isPrepareEnabled,
} = require('./lib/staff-email-oauth-routes');
const {
  isInboundEventStoreEnabled,
  ENV_DURABLE_INBOUND_CAPTURE_ENABLED,
  INTERNAL_STATUS_SUCCESS,
  INTERNAL_DURABLY_PROCESSED,
  INTERNAL_RESULT_KEYS,
  MAX_COUNT,
} = require('./lib/email-microsoft-delegated-inbound-event-store-sunset-staging-runtime-composition');
const {
  isInboundDiagnosticEnabled,
  ENV_INBOUND_DIAGNOSTIC_ENABLED,
} = require('./lib/email-microsoft-delegated-inbound-diagnostic-sunset-staging-runtime-composition');
const {
  isReadHealthEnabled,
} = require('./lib/email-microsoft-delegated-read-sunset-staging-runtime-composition');
const {
  isRefreshHealthEnabled,
} = require('./lib/email-microsoft-delegated-refresh-sunset-staging-runtime-composition');
const { isStartEnabled, isCallbackEnabled } = require('./lib/email-microsoft-oauth-transaction-service');

const ROOT = path.join(__dirname, '..');
const LOCATION = 'main';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLIENT_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STAFF = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SESSION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PLANTED_SUBJECT = 'SUBJECT_PII_CAPTURE_MUST_NOT_LEAK';
const PLANTED_TOKEN = 'ya29.CAPTURE_TOKEN_LEAK';
const PLANTED_ADDRESS = 'guest-pii@example.com';
const MIG_063 = path.join(ROOT, 'database/migrations/063_tenant_email_inbound_events.sql');
const MANIFEST = path.join(ROOT, 'database/migrations/canonical-manifest.json');
const DOC = path.join(ROOT, 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md');

function captureSend() {
  const calls = [];
  return {
    calls,
    sendJSON(res, status, body) {
      calls.push({ status, body });
      return body;
    },
  };
}

function resolveRowResult() {
  return {
    rows: [
      {
        client_id: CLIENT_UUID,
        location_id: LOCATION_UUID,
        endpoint_id: ENDPOINT,
      },
    ],
  };
}

function enabledCaptureEnv() {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED: 'true',
  };
}

async function main() {
  // ── Path / key isolation (byte-compat with siblings) ────────────────────
  assert.equal(
    OAUTH_INBOUND_CAPTURE_PATH,
    '/staff/admin/email-settings/oauth/microsoft/inbound-capture',
  );
  assert.notEqual(OAUTH_INBOUND_CAPTURE_PATH, OAUTH_INBOUND_DIAGNOSTIC_PATH);
  assert.notEqual(OAUTH_INBOUND_CAPTURE_PATH, OAUTH_READ_HEALTH_PATH);
  assert.notEqual(OAUTH_INBOUND_CAPTURE_PATH, OAUTH_REFRESH_HEALTH_PATH);
  assert.notEqual(OAUTH_INBOUND_CAPTURE_PATH, OAUTH_START_PATH);
  assert.notEqual(OAUTH_INBOUND_CAPTURE_PATH, OAUTH_CALLBACK_PATH);
  assert.equal(
    OAUTH_INBOUND_DIAGNOSTIC_PATH,
    '/staff/admin/email-settings/oauth/microsoft/inbound-diagnostic',
    'diagnostic path byte-compat',
  );
  assert.equal(
    OAUTH_READ_HEALTH_PATH,
    '/staff/admin/email-settings/oauth/microsoft/read-health',
    'read-health path byte-compat',
  );
  assert.deepEqual(
    [...READ_HEALTH_SUCCESS_KEYS],
    ['success', 'status', 'grant_generation', 'graph_reachable', 'message_count_bounded', 'graph_stage'],
    'read-health success keys byte-compat',
  );
  assert.deepEqual(
    [...INBOUND_DIAGNOSTIC_SUCCESS_KEYS],
    ['success', 'status', 'observed_count', 'unique_in_batch_count', 'duplicate_in_batch_count', 'durably_processed'],
    'diagnostic success keys byte-compat',
  );
  assert.deepEqual(
    [...INBOUND_CAPTURE_SUCCESS_KEYS],
    [
      'success',
      'status',
      'observed_count',
      'durable_identity_count',
      'duplicate_in_batch_count',
      'durably_captured',
    ],
  );
  assert.deepEqual(
    [...INTERNAL_RESULT_KEYS],
    ['status', 'durably_processed', 'input_count', 'delivered_count', 'duplicate_count'],
  );
  assert.deepEqual([...INBOUND_CAPTURE_BODY_KEYS], ['location_id', 'endpoint_id']);
  assert.equal(INBOUND_CAPTURE_ERROR, 'inbound_capture_unavailable');
  assert.equal(ENV_DURABLE_INBOUND_CAPTURE_ENABLED, 'LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED');
  assert.equal(INTERNAL_STATUS_SUCCESS, 'success');
  assert.equal(INTERNAL_DURABLY_PROCESSED, true);
  assert.equal(MAX_COUNT, 5);

  // Forbidden public vocabulary / synonyms.
  for (const forbidden of [
    'received_count',
    'accepted_count',
    'discarded_count',
    'unique_count',
    'unique_in_batch_count',
    'newly_inserted_count',
    'inserted_count',
    'processed',
    'delivered_count',
    'input_count',
    'ok',
    'handling',
    'drafting',
    'classification',
    'automation',
  ]) {
    assert.equal(
      INBOUND_CAPTURE_SUCCESS_KEYS.includes(forbidden),
      false,
      `public keys must not include ${forbidden}`,
    );
  }

  // ── Exact flag isolation ────────────────────────────────────────────────
  const offEnv = { LUNA_DEPLOYMENT: 'sunset-staging' };
  assert.equal(isInboundEventStoreEnabled(offEnv), false);

  const enabledOnlyCapture = enabledCaptureEnv();
  assert.equal(isInboundEventStoreEnabled(enabledOnlyCapture), true);
  assert.equal(isInboundDiagnosticEnabled(enabledOnlyCapture), false);
  assert.equal(isReadHealthEnabled(enabledOnlyCapture), false);
  assert.equal(isRefreshHealthEnabled(enabledOnlyCapture), false);
  assert.equal(isStartEnabled(enabledOnlyCapture), false);
  assert.equal(isCallbackEnabled(enabledOnlyCapture), false);
  assert.equal(isPrepareEnabled(enabledOnlyCapture), false);

  // Diagnostic flag must not enable capture.
  const onlyDiagnostic = {
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED: 'true',
  };
  assert.equal(isInboundDiagnosticEnabled(onlyDiagnostic), true);
  assert.equal(isInboundEventStoreEnabled(onlyDiagnostic), false);

  // Case / truthy variants never enable.
  assert.equal(isInboundEventStoreEnabled({
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED: 'TRUE',
  }), false);
  assert.equal(isInboundEventStoreEnabled({
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED: '1',
  }), false);
  assert.equal(isInboundEventStoreEnabled({
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED: 'true ',
  }), false);
  assert.equal(isInboundEventStoreEnabled({
    LUNA_DEPLOYMENT: 'production',
    LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED: 'true',
  }), false);
  assert.equal(isInboundEventStoreEnabled({
    LUNA_DEPLOYMENT: 'wolfhouse',
    LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED: 'true',
  }), false);
  assert.equal(isInboundEventStoreEnabled({
    LUNA_DEPLOYMENT: 'Sunset-Staging',
    LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED: 'true',
  }), false);

  // ── Body snapshot ───────────────────────────────────────────────────────
  assert.deepEqual(
    snapshotInboundCaptureBody({
      location_id: LOCATION,
      endpoint_id: ENDPOINT,
    }),
    Object.freeze({ location_id: LOCATION, endpoint_id: ENDPOINT }),
  );
  assert.equal(snapshotInboundCaptureBody({
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    extra: true,
  }), null, 'hostile extra key');
  assert.equal(snapshotInboundCaptureBody({
    endpoint_id: ENDPOINT,
    location_id: LOCATION,
  }), null, 'wrong key order');
  assert.equal(snapshotInboundCaptureBody({
    location_id: LOCATION,
    endpoint_id: 'not-a-uuid',
  }), null);
  assert.equal(snapshotInboundCaptureBody(null), null);

  // ── Success DTO (exact public vocabulary + key order + JSON) ────────────
  const good = buildInboundCaptureSuccessJson({
    status: 'success',
    durably_processed: true,
    input_count: 3,
    delivered_count: 2,
    duplicate_count: 1,
  });
  assert.deepEqual(Reflect.ownKeys(good), [...INBOUND_CAPTURE_SUCCESS_KEYS]);
  assert.equal(good.success, true);
  assert.equal(good.status, 'durable_capture_completed');
  assert.equal(good.observed_count, 3);
  assert.equal(good.durable_identity_count, 2);
  assert.equal(good.duplicate_in_batch_count, 1);
  assert.equal(good.durably_captured, true);
  const goodJson = JSON.stringify(good);
  assert.equal(
    goodJson,
    '{"success":true,"status":"durable_capture_completed","observed_count":3,"durable_identity_count":2,"duplicate_in_batch_count":1,"durably_captured":true}',
  );
  // Never expose internal / PII / stage / generation / processing vocabulary.
  for (const bad of [
    '"processed"',
    'received_count',
    'accepted_count',
    'discarded_count',
    'unique_count',
    'unique_in_batch_count',
    'newly_inserted',
    'inserted_count',
    'delivered_count',
    'input_count',
    'durably_processed',
    'grant_generation',
    'graph_stage',
    'subject',
    'token',
    'draft',
    'classif',
    'automation',
    PLANTED_SUBJECT,
    PLANTED_TOKEN,
    PLANTED_ADDRESS,
  ]) {
    assert.equal(goodJson.includes(bad), false, `must not leak ${bad}`);
  }

  // Reject non-durable / diagnostic shapes.
  assert.equal(buildInboundCaptureSuccessJson({
    status: 'success',
    durably_processed: false,
    input_count: 1,
    delivered_count: 1,
    duplicate_count: 0,
  }), null, 'durably_processed must be literal true');
  assert.equal(buildInboundCaptureSuccessJson({
    status: 'processed',
    input_count: 1,
    delivered_count: 1,
    duplicate_count: 0,
  }), null, 'authority-bound processed is not durable capture');
  assert.equal(buildInboundCaptureSuccessJson({
    status: 'diagnostic_observed',
    observed_count: 1,
    unique_in_batch_count: 1,
    duplicate_in_batch_count: 0,
    durably_processed: false,
  }), null, 'diagnostic public shape rejected');
  assert.equal(buildInboundCaptureSuccessJson({
    status: 'success',
    durably_processed: true,
    input_count: 6,
    delivered_count: 6,
    duplicate_count: 0,
  }), null, 'max5');
  assert.equal(buildInboundCaptureSuccessJson({
    status: 'success',
    durably_processed: true,
    input_count: 2,
    delivered_count: 1,
    duplicate_count: 0,
  }), null, 'count invariant observed = durable_identity + duplicate');
  // Extras on input ignored; public keys exact ordered only.
  const withExtraInput = buildInboundCaptureSuccessJson({
    status: 'success',
    durably_processed: true,
    input_count: 1,
    delivered_count: 1,
    duplicate_count: 0,
    grant_generation: 2,
    graph_stage: 'success',
    subject: PLANTED_SUBJECT,
    newly_inserted_count: 99,
  });
  assert.ok(withExtraInput);
  assert.deepEqual(Reflect.ownKeys(withExtraInput), [...INBOUND_CAPTURE_SUCCESS_KEYS]);
  assert.equal(withExtraInput.durable_identity_count, 1);
  assert.equal(
    JSON.stringify(withExtraInput).includes('newly_inserted'),
    false,
  );
  assert.equal(JSON.stringify(withExtraInput).includes(PLANTED_SUBJECT), false);

  // Diagnostic builder still non-durable (regression).
  const diag = buildInboundDiagnosticSuccessJson({
    status: 'success',
    durably_processed: false,
    input_count: 1,
    delivered_count: 1,
    duplicate_count: 0,
  });
  assert.equal(diag.durably_processed, false);
  assert.equal(diag.status, 'diagnostic_observed');

  // ── Flag off: concealed 404 before DB ───────────────────────────────────
  let dbHits = 0;
  let txnHits = 0;
  const sendOff = captureSend();
  const routesOff = createStaffEmailOAuthRoutes({
    runtimeEnv: offEnv,
    sendJSON: sendOff.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async () => {
      dbHits += 1;
      throw new Error('should_not_run_db');
    },
    withTransactionClient: async () => {
      txnHits += 1;
      throw new Error('should_not_run_txn');
    },
  });
  await routesOff.handleInboundCapture(
    { location_id: LOCATION, endpoint_id: ENDPOINT },
    {},
    {},
    { client_slug: 'sunset', staff_user_id: STAFF, session_id: SESSION },
  );
  assert.equal(sendOff.calls.length, 1);
  assert.equal(sendOff.calls[0].status, 404);
  assert.deepEqual(sendOff.calls[0].body, { success: false, error: 'not_found' });
  assert.equal(dbHits, 0, 'disabled → no DB');
  assert.equal(txnHits, 0, 'disabled → no txn');

  // Production / wolfhouse / other deployment: concealed 404 before DB.
  for (const deployment of ['production', 'wolfhouse', 'other']) {
    dbHits = 0;
    const send = captureSend();
    const routes = createStaffEmailOAuthRoutes({
      runtimeEnv: {
        LUNA_DEPLOYMENT: deployment,
        LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED: 'true',
      },
      sendJSON: send.sendJSON,
      assertStaffClientAccess: () => true,
      authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
      withPgClient: async () => {
        dbHits += 1;
        throw new Error('should_not_run');
      },
    });
    await routes.handleInboundCapture(
      { location_id: LOCATION, endpoint_id: ENDPOINT },
      {},
      {},
      { client_slug: 'sunset', staff_user_id: STAFF, session_id: SESSION },
    );
    assert.equal(send.calls[0].status, 404, `${deployment} → 404`);
    assert.equal(dbHits, 0, `${deployment} → no DB`);
  }

  // ── Frozen same gate snapshot / TOCTOU resistance ───────────────────────
  // Router-style frozen snapshot stays authoritative even if process.env flips.
  const frozenOn = Object.freeze({
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED: 'true',
  });
  const frozenOff = Object.freeze({
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED: 'false',
  });
  assert.equal(isInboundEventStoreEnabled(frozenOn), true);
  assert.equal(isInboundEventStoreEnabled(frozenOff), false);

  dbHits = 0;
  const sendToctouOff = captureSend();
  const routesToctouOff = createStaffEmailOAuthRoutes({
    // runtimeEnv enabled, but gateEnv snapshot is off → must conceal.
    runtimeEnv: enabledCaptureEnv(),
    sendJSON: sendToctouOff.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async () => {
      dbHits += 1;
      throw new Error('toctou_off_must_not_db');
    },
  });
  await routesToctouOff.handleInboundCapture(
    { location_id: LOCATION, endpoint_id: ENDPOINT },
    {},
    {},
    { client_slug: 'sunset', staff_user_id: STAFF, session_id: SESSION },
    frozenOff,
  );
  assert.equal(sendToctouOff.calls[0].status, 404);
  assert.deepEqual(sendToctouOff.calls[0].body, { success: false, error: 'not_found' });
  assert.equal(dbHits, 0, 'gate snapshot off resists runtimeEnv true');

  // gateEnv on + runtimeEnv off: gate allows past concealment; operation fails
  // closed (503) without claiming success — still no open network claim.
  dbHits = 0;
  txnHits = 0;
  const sendToctouOn = captureSend();
  const routesToctouOn = createStaffEmailOAuthRoutes({
    runtimeEnv: { LUNA_DEPLOYMENT: 'sunset-staging' },
    sendJSON: sendToctouOn.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async (fn) => {
      dbHits += 1;
      return fn({
        query: async () => resolveRowResult(),
      });
    },
    withTransactionClient: async () => {
      txnHits += 1;
      throw new Error('toctou_on_must_not_persist');
    },
  });
  await routesToctouOn.handleInboundCapture(
    { location_id: LOCATION, endpoint_id: ENDPOINT },
    {},
    {},
    { client_slug: 'sunset', staff_user_id: STAFF, session_id: SESSION },
    frozenOn,
  );
  assert.equal(sendToctouOn.calls[0].status, 503);
  assert.deepEqual(sendToctouOn.calls[0].body, {
    success: false,
    error: INBOUND_CAPTURE_ERROR,
  });
  assert.ok(dbHits >= 1, 'gate snapshot on proceeds past concealment');
  assert.equal(txnHits, 0, 'failed composition readiness → no persist txn');

  // ── Auth: Sunset admin before DB ────────────────────────────────────────
  dbHits = 0;
  const sendWolf = captureSend();
  const routesOn = createStaffEmailOAuthRoutes({
    runtimeEnv: enabledCaptureEnv(),
    sendJSON: sendWolf.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async () => {
      dbHits += 1;
      throw new Error('should_not_run');
    },
  });
  await routesOn.handleInboundCapture(
    { location_id: LOCATION, endpoint_id: ENDPOINT },
    {},
    {},
    { client_slug: 'wolfhouse', staff_user_id: STAFF, session_id: SESSION },
  );
  assert.equal(sendWolf.calls[0].status, 403);
  assert.equal(dbHits, 0, 'non-sunset client → no DB');

  dbHits = 0;
  const sendNoStaff = captureSend();
  const routesNoStaff = createStaffEmailOAuthRoutes({
    runtimeEnv: enabledCaptureEnv(),
    sendJSON: sendNoStaff.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async () => {
      dbHits += 1;
      throw new Error('should_not_run');
    },
  });
  await routesNoStaff.handleInboundCapture(
    { location_id: LOCATION, endpoint_id: ENDPOINT },
    {},
    {},
    { client_slug: 'sunset', staff_user_id: 'not-uuid', session_id: SESSION },
  );
  assert.equal(sendNoStaff.calls[0].status, 403);
  assert.equal(dbHits, 0);

  // ACL fail before DB.
  dbHits = 0;
  const sendAcl = captureSend();
  let aclChecked = false;
  const routesAcl = createStaffEmailOAuthRoutes({
    runtimeEnv: enabledCaptureEnv(),
    sendJSON: sendAcl.sendJSON,
    assertStaffClientAccess: (user, slug, res) => {
      aclChecked = true;
      assert.equal(slug, 'sunset');
      sendAcl.sendJSON(res, 403, { success: false, error: 'forbidden' });
      return false;
    },
    authorizeAuthenticatedStaffRoute: () => {
      throw new Error('authz_should_not_run_after_acl_fail');
    },
    withPgClient: async () => {
      dbHits += 1;
      throw new Error('should_not_run');
    },
  });
  await routesAcl.handleInboundCapture(
    { location_id: LOCATION, endpoint_id: ENDPOINT },
    {},
    {},
    { client_slug: 'sunset', staff_user_id: STAFF, session_id: SESSION },
  );
  assert.equal(aclChecked, true);
  assert.equal(sendAcl.calls[0].status, 403);
  assert.equal(dbHits, 0);

  // Authz fail before DB — pathname must be capture path.
  dbHits = 0;
  const sendAuthz = captureSend();
  const routesAuthz = createStaffEmailOAuthRoutes({
    runtimeEnv: enabledCaptureEnv(),
    sendJSON: sendAuthz.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: (args) => {
      assert.equal(args.clientSlug, 'sunset');
      assert.equal(args.method, 'POST');
      assert.equal(args.pathname, OAUTH_INBOUND_CAPTURE_PATH);
      return { ok: false, status: 403, body: { success: false, error: 'forbidden' } };
    },
    withPgClient: async () => {
      dbHits += 1;
      throw new Error('should_not_run');
    },
  });
  await routesAuthz.handleInboundCapture(
    { location_id: LOCATION, endpoint_id: ENDPOINT },
    {},
    {},
    { client_slug: 'sunset', staff_user_id: STAFF, session_id: SESSION },
  );
  assert.equal(sendAuthz.calls[0].status, 403);
  assert.equal(dbHits, 0);

  // ── Hostile body: 400 before DB ─────────────────────────────────────────
  dbHits = 0;
  const sendBadBody = captureSend();
  const routesBadBody = createStaffEmailOAuthRoutes({
    runtimeEnv: enabledCaptureEnv(),
    sendJSON: sendBadBody.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async () => {
      dbHits += 1;
      throw new Error('should_not_run');
    },
  });
  await routesBadBody.handleInboundCapture(
    { location_id: LOCATION, endpoint_id: ENDPOINT, client_id: CLIENT_UUID },
    {},
    {},
    { client_slug: 'sunset', staff_user_id: STAFF, session_id: SESSION },
  );
  assert.equal(sendBadBody.calls[0].status, 400);
  assert.deepEqual(sendBadBody.calls[0].body, { success: false, error: 'invalid_request' });
  assert.equal(dbHits, 0);

  // ── Unresolved binding: 404 ─────────────────────────────────────────────
  const sendEmpty = captureSend();
  let queryParams = null;
  const routesEmpty = createStaffEmailOAuthRoutes({
    runtimeEnv: enabledCaptureEnv(),
    sendJSON: sendEmpty.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async (fn) => fn({
      query: async (sql, params) => {
        queryParams = params;
        assert.match(sql, /slug = 'sunset'/);
        assert.match(sql, /tenant_email_delegated_grants/);
        return { rows: [] };
      },
    }),
    withTransactionClient: async () => {
      throw new Error('empty_binding_must_not_txn');
    },
  });
  await routesEmpty.handleInboundCapture(
    { location_id: LOCATION, endpoint_id: ENDPOINT },
    {},
    {},
    { client_slug: 'sunset', staff_user_id: STAFF, session_id: SESSION },
  );
  assert.equal(sendEmpty.calls[0].status, 404);
  assert.deepEqual(sendEmpty.calls[0].body, { success: false, error: 'endpoint_not_found' });
  assert.deepEqual(queryParams, [LOCATION, ENDPOINT]);

  // ── Operation failure: 503 sanitized (no PII / internal vocab) ──────────
  const sendFail = captureSend();
  const routesFail = createStaffEmailOAuthRoutes({
    runtimeEnv: enabledCaptureEnv(),
    sendJSON: sendFail.sendJSON,
    assertStaffClientAccess: () => true,
    authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
    withPgClient: async (fn) => fn({
      query: async () => resolveRowResult(),
    }),
    withTransactionClient: async () => {
      throw new Error(`planted ${PLANTED_TOKEN} ${PLANTED_SUBJECT} ${PLANTED_ADDRESS}`);
    },
  });
  await routesFail.handleInboundCapture(
    { location_id: LOCATION, endpoint_id: ENDPOINT },
    {},
    {},
    { client_slug: 'sunset', staff_user_id: STAFF, session_id: SESSION },
  );
  assert.equal(sendFail.calls[0].status, 503);
  assert.deepEqual(sendFail.calls[0].body, {
    success: false,
    error: INBOUND_CAPTURE_ERROR,
  });
  const failJson = JSON.stringify(sendFail.calls[0].body);
  assert.equal(failJson.includes(PLANTED_TOKEN), false);
  assert.equal(failJson.includes(PLANTED_SUBJECT), false);
  assert.equal(failJson.includes(PLANTED_ADDRESS), false);
  assert.equal(failJson.includes('"processed"'), false);
  assert.equal(failJson.includes('received_count'), false);
  assert.equal(failJson.includes('stack'), false);

  // ── Nested transaction capability plumbing ──────────────────────────────
  // Prove route factory receives distinct withTransactionClient capability
  // (not the outer resolve pgClient) via Module._load intercept of composition.
  {
    const Module = require('node:module');
    const routesAbs = require.resolve('./lib/staff-email-oauth-routes');
    const compRel = './email-microsoft-delegated-inbound-event-store-sunset-staging-runtime-composition';
    const compAbs = require.resolve(
      './lib/email-microsoft-delegated-inbound-event-store-sunset-staging-runtime-composition',
    );
    const realLoad = Module._load;
    let capturedDeps = null;
    let factoryCalls = 0;
    Module._load = function patchedLoad(request, parent, isMain) {
      const loaded = realLoad.apply(this, arguments);
      try {
        if (parent && parent.filename === routesAbs
            && (request === compRel
              || request === compAbs
              || String(request).endsWith(
                'email-microsoft-delegated-inbound-event-store-sunset-staging-runtime-composition',
              ))) {
          return {
            ...loaded,
            createSunsetStagingMicrosoftDelegatedInboundEventStoreRuntime(deps) {
              factoryCalls += 1;
              capturedDeps = deps;
              return Object.freeze({
                async runInboundEventStore() {
                  // Invoke exclusive loaner once to prove separate client path.
                  await deps.withTransactionClient(async (client) => {
                    assert.ok(client);
                    assert.notEqual(client, deps.pgClient, 'persist client ≠ outer pgClient');
                    assert.equal(client.id, 'exclusive-persist-client');
                    return Object.freeze({ ok: true });
                  });
                  return Object.freeze({
                    status: 'success',
                    durably_processed: true,
                    input_count: 2,
                    delivered_count: 1,
                    duplicate_count: 1,
                  });
                },
              });
            },
          };
        }
      } catch (_) { /* fall through */ }
      return loaded;
    };
    try {
      delete require.cache[routesAbs];
      // Also clear sibling composition caches so re-require binds patched factory.
      delete require.cache[compAbs];
      const {
        createStaffEmailOAuthRoutes: createRoutesPatched,
        buildInboundCaptureSuccessJson: buildCaptureJsonPatched,
        INBOUND_CAPTURE_SUCCESS_KEYS: captureKeysPatched,
      } = require('./lib/staff-email-oauth-routes');
      const outerClient = {
        id: 'outer-resolve-client',
        query: async () => resolveRowResult(),
      };
      const exclusiveLoaner = async (work) => {
        const exclusive = {
          id: 'exclusive-persist-client',
          query: async () => ({ rows: [] }),
        };
        assert.notEqual(exclusive, outerClient);
        return work(exclusive);
      };
      assert.notEqual(exclusiveLoaner, outerClient);
      const sendTxn = captureSend();
      let outerHits = 0;
      const routesTxn = createRoutesPatched({
        runtimeEnv: enabledCaptureEnv(),
        sendJSON: sendTxn.sendJSON,
        assertStaffClientAccess: () => true,
        authorizeAuthenticatedStaffRoute: () => ({ ok: true }),
        withPgClient: async (fn) => {
          outerHits += 1;
          return fn(outerClient);
        },
        withTransactionClient: exclusiveLoaner,
      });
      await routesTxn.handleInboundCapture(
        { location_id: LOCATION, endpoint_id: ENDPOINT },
        {},
        {},
        { client_slug: 'sunset', staff_user_id: STAFF, session_id: SESSION },
      );
      assert.equal(factoryCalls, 1, 'composition factory invoked once');
      assert.ok(capturedDeps, 'composition deps captured');
      assert.equal(capturedDeps.pgClient, outerClient, 'outer loan is pgClient');
      assert.equal(
        capturedDeps.withTransactionClient,
        exclusiveLoaner,
        'withTransactionClient is injected exclusive loaner',
      );
      assert.notEqual(capturedDeps.withTransactionClient, capturedDeps.pgClient);
      assert.ok(outerHits >= 1, 'outer withPgClient used for resolve');
      assert.equal(sendTxn.calls[0].status, 200);
      assert.deepEqual(Reflect.ownKeys(sendTxn.calls[0].body), [...captureKeysPatched]);
      assert.equal(sendTxn.calls[0].body.status, 'durable_capture_completed');
      assert.equal(sendTxn.calls[0].body.observed_count, 2);
      assert.equal(sendTxn.calls[0].body.durable_identity_count, 1);
      assert.equal(sendTxn.calls[0].body.duplicate_in_batch_count, 1);
      assert.equal(sendTxn.calls[0].body.durably_captured, true);
      assert.equal(
        JSON.stringify(sendTxn.calls[0].body),
        '{"success":true,"status":"durable_capture_completed","observed_count":2,"durable_identity_count":1,"duplicate_in_batch_count":1,"durably_captured":true}',
      );
      // Sanity: patched builder still maps durable_identity (not newly inserted).
      const mapped = buildCaptureJsonPatched({
        status: 'success',
        durably_processed: true,
        input_count: 2,
        delivered_count: 1,
        duplicate_count: 1,
      });
      assert.equal(mapped.durable_identity_count, 1);
    } finally {
      Module._load = realLoad;
      delete require.cache[routesAbs];
      delete require.cache[compAbs];
      // Restore production module bindings for any subsequent requires.
      require('./lib/staff-email-oauth-routes');
    }
  }

  // Source-level: buildInboundCaptureRuntime receives withTransactionClient;
  // handleInboundCapture uses deps.withTransactionClient / withPgClient pair.
  const routesSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/lib/staff-email-oauth-routes.js'),
    'utf8',
  );
  assert.match(routesSrc, /createSunsetStagingMicrosoftDelegatedInboundEventStoreRuntime/);
  assert.match(routesSrc, /handleInboundCapture/);
  assert.match(routesSrc, /withTransactionClient/);
  assert.match(routesSrc, /buildInboundCaptureRuntime/);
  assert.match(routesSrc, /runInboundEventStore/);
  assert.match(routesSrc, /durable_identity_count/);
  assert.match(routesSrc, /durably_captured/);
  assert.match(routesSrc, /durable_capture_completed/);
  assert.match(routesSrc, /inbound_capture_unavailable/);
  // Must not claim newly-inserted counts or processing/drafting vocabulary.
  assert.equal(/newly_inserted|inserted_count/.test(routesSrc), false);
  assert.equal(
    /status:\s*['"]ok['"]|received_count|accepted_count|discarded_count/.test(routesSrc),
    false,
  );
  // Diagnostic path/flag untouched.
  assert.match(routesSrc, /OAUTH_INBOUND_DIAGNOSTIC_PATH = '\/staff\/admin\/email-settings\/oauth\/microsoft\/inbound-diagnostic'/);
  assert.match(routesSrc, /isInboundDiagnosticEnabled/);
  assert.match(routesSrc, /OAUTH_READ_HEALTH_PATH = '\/staff\/admin\/email-settings\/oauth\/microsoft\/read-health'/);
  assert.match(routesSrc, /isReadHealthEnabled/);

  // ── staff-query-api wiring ──────────────────────────────────────────────
  const apiSrc = fs.readFileSync(require.resolve('./staff-query-api.js'), 'utf8');
  assert.match(apiSrc, /OAUTH_INBOUND_CAPTURE_PATH/);
  assert.match(apiSrc, /handleInboundCapture/);
  assert.match(
    apiSrc,
    /pathname === OAUTH_INBOUND_CAPTURE_PATH && method === 'POST'/,
  );
  assert.match(apiSrc, /isInboundEventStoreEnabled/);
  assert.match(
    apiSrc,
    /require\('\.\/lib\/email-microsoft-delegated-inbound-event-store-sunset-staging-runtime-composition'\)/,
  );
  assert.match(apiSrc, /withTransactionClient:\s*withPgClient/);
  // Capture block: gate before requireAuth / readBody.
  const blockStart = apiSrc.indexOf(
    "pathname === OAUTH_INBOUND_CAPTURE_PATH && method === 'POST'",
  );
  assert.ok(blockStart > 0);
  const block = apiSrc.slice(blockStart, blockStart + 1600);
  assert.match(block, /const inboundCaptureGateEnv = Object\.freeze/);
  assert.match(block, /LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED/);
  assert.match(block, /handleInboundCapture\([\s\S]*inboundCaptureGateEnv/);
  const iGate = block.indexOf('isInboundEventStoreEnabled');
  const iAuth = block.indexOf('requireAuth');
  const iBody = block.indexOf('readBody');
  assert.ok(iGate >= 0 && iAuth > iGate && iBody > iAuth,
    'router dual-gate must precede requireAuth and readBody');
  assert.match(block, /error:\s*['"]not_found['"]/);
  assert.equal(/cron|setInterval|poller/i.test(block), false);
  // Diagnostic block still present and independent.
  assert.match(apiSrc, /pathname === OAUTH_INBOUND_DIAGNOSTIC_PATH && method === 'POST'/);
  assert.match(apiSrc, /pathname === OAUTH_READ_HEALTH_PATH && method === 'POST'/);

  // package script
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['verify:staff-email-oauth-inbound-capture-routes'],
    'node scripts/verify-staff-email-oauth-inbound-capture-routes.js',
  );

  // ── Migration 063 ledger + schema activation precondition ───────────────
  assert.equal(fs.existsSync(MIG_063), true, '063 up migration present');
  const migSrc = fs.readFileSync(MIG_063, 'utf8');
  assert.match(migSrc, /CREATE TABLE tenant_email_inbound_events/);
  assert.match(migSrc, /ON CONFLICT|provider_message_id|provider_mailbox_id/i);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const entries = Array.isArray(manifest)
    ? manifest
    : (manifest.migrations || manifest.entries || manifest.files || []);
  const has063 = JSON.stringify(manifest).includes('063_tenant_email_inbound_events');
  assert.equal(has063, true, '063 registered in canonical migration ledger/manifest');
  void entries;
  const doc = fs.readFileSync(DOC, 'utf8');
  assert.match(doc, /inbound-capture/);
  assert.match(doc, /LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED/);
  assert.match(doc, /activation precondition|Activation precondition/i);
  assert.match(doc, /063/);
  assert.match(doc, /tenant_email_inbound_events/);
  assert.match(doc, /durable_identity_count/);
  assert.match(doc, /durably_captured/);
  // Flag still not in defaults/manifests.
  const defaultsHit = fs.readFileSync(
    path.join(ROOT, 'config/clients/sunset.baseline.json'),
    'utf8',
  );
  assert.equal(defaultsHit.includes('LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED'), false);

  // Diagnostic sibling still maps non-durable (regression via exported builder).
  assert.equal(
    ENV_INBOUND_DIAGNOSTIC_ENABLED,
    'LUNA_EMAIL_OAUTH_INBOUND_DIAGNOSTIC_ENABLED',
  );

  // ── Router-level adversarial: dual-gate before auth/body/DB/runtime ─────
  await assertRouterDualGateBeforeSideEffects();

  console.log('verify:staff-email-oauth-inbound-capture-routes: ok');
}

/**
 * Real-listener proofs: disabled / wolfhouse / prod unauth + malformed-body
 * requests still exact 404 not_found with zero auth-session / body-read / DB
 * side effects (gate is pre-requireAuth).
 */
async function assertRouterDualGateBeforeSideEffects() {
  const http = require('node:http');
  const Module = require('node:module');

  try {
    require.resolve('dotenv');
  } catch {
    const candidates = [
      path.join(ROOT, 'node_modules'),
      path.join(ROOT, '..', 'wolfhouse-agent', 'node_modules'),
      '/opt/data/wolfhouse-agent/node_modules',
    ];
    const found = candidates.find((c) => fs.existsSync(path.join(c, 'dotenv')));
    if (found) {
      const prev = process.env.NODE_PATH || '';
      process.env.NODE_PATH = prev ? `${found}${path.delimiter}${prev}` : found;
      Module._initPaths();
    }
  }

  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    STAFF_API_FORTRESS_OFFLINE_LISTENER: process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER,
    STAFF_AUTH_REQUIRED: process.env.STAFF_AUTH_REQUIRED,
    STAFF_AUTH_HTTPS: process.env.STAFF_AUTH_HTTPS,
    STAFF_RUNTIME_PROFILE: process.env.STAFF_RUNTIME_PROFILE,
    STAFF_QUERY_API_HOST: process.env.STAFF_QUERY_API_HOST,
    LUNA_BOT_INTERNAL_TOKEN: process.env.LUNA_BOT_INTERNAL_TOKEN,
    LUNA_DEPLOYMENT: process.env.LUNA_DEPLOYMENT,
    LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED:
      process.env.LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED,
  };

  function clearStaffApiCache() {
    for (const key of Object.keys(require.cache)) {
      if (/staff-query-api\.js$/.test(key)
          || /staff-auth-config\.js$/.test(key)
          || /staff-portal-clients\.js$/.test(key)
          || /pg-connect\.js$/.test(key)
          || /staff-email-oauth-routes\.js$/.test(key)) {
        delete require.cache[key];
      }
    }
  }

  function listen(server) {
    return new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(addr.port);
      });
      server.on('error', reject);
    });
  }

  function closeServer(server) {
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  function post(port, body, headers) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: OAUTH_INBOUND_CAPTURE_PATH,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...(headers || {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
          resolve({ status: res.statusCode, body: parsed, raw });
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  process.env.NODE_ENV = 'test';
  process.env.STAFF_RUNTIME_PROFILE = 'test';
  process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER = '1';
  process.env.STAFF_AUTH_REQUIRED = 'true';
  process.env.STAFF_AUTH_HTTPS = 'false';
  process.env.STAFF_QUERY_API_HOST = '127.0.0.1';
  process.env.LUNA_BOT_INTERNAL_TOKEN = 'inbound_capture_router_offline_token_01';

  const cases = [
    {
      name: 'flag_absent_unauth',
      env: { LUNA_DEPLOYMENT: 'sunset-staging' },
      body: '{"location_id":"main","endpoint_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}',
    },
    {
      name: 'flag_false_malformed_json',
      env: {
        LUNA_DEPLOYMENT: 'sunset-staging',
        LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED: 'false',
      },
      body: '{not-json',
    },
    {
      name: 'production_flag_true_unauth',
      env: {
        LUNA_DEPLOYMENT: 'production',
        LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED: 'true',
      },
      body: '{"location_id":"main","endpoint_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}',
    },
    {
      name: 'wolfhouse_flag_true_malformed',
      env: {
        LUNA_DEPLOYMENT: 'wolfhouse',
        LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED: 'true',
      },
      body: '[[[',
    },
    {
      name: 'flag_TRUE_case_unauth',
      env: {
        LUNA_DEPLOYMENT: 'sunset-staging',
        LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED: 'TRUE',
      },
      body: '{"location_id":"main","endpoint_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}',
    },
  ];

  try {
    for (const c of cases) {
      delete process.env.LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED;
      process.env.LUNA_DEPLOYMENT = c.env.LUNA_DEPLOYMENT;
      if (c.env.LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED != null) {
        process.env.LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED =
          c.env.LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED;
      }

      assert.equal(
        isInboundEventStoreEnabled(process.env),
        false,
        `${c.name}: dual gate closed`,
      );

      clearStaffApiCache();
      const api = require('./staff-query-api');
      assert.equal(typeof api.createStaffQueryApiHttpServer, 'function');

      let dbCalls = 0;
      api.setFortress15j3OfflineSeams({
        withPgClient: async () => {
          dbCalls += 1;
          throw new Error('router_gate_must_not_reach_db');
        },
      });

      const server = api.createStaffQueryApiHttpServer();
      const port = await listen(server);
      try {
        const res = await post(port, c.body);
        assert.equal(res.status, 404, `${c.name}: status`);
        assert.deepEqual(
          res.body,
          { success: false, error: 'not_found' },
          `${c.name}: body`,
        );
        assert.notEqual(res.status, 401, `${c.name}: must not hit requireAuth`);
        assert.notEqual(res.status, 400, `${c.name}: must not hit body parse`);
        assert.equal(dbCalls, 0, `${c.name}: zero DB`);
        assert.equal(String(res.raw).includes('Authentication required'), false);
        assert.equal(String(res.raw).includes('invalid_request'), false);
        assert.equal(String(res.raw).includes(PLANTED_TOKEN), false);
      } finally {
        await closeServer(server);
        api.setFortress15j3OfflineSeams(null);
        clearStaffApiCache();
      }
    }

    // TOCTOU: freeze gate values by source contract — after enable snapshot the
    // handler must receive the same frozen object identity from router code path.
    // Source-level: Object.freeze + pass same var (already asserted above).
    // Additional: mutate process.env between gate evaluation proof and next call.
    process.env.LUNA_DEPLOYMENT = 'sunset-staging';
    process.env.LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED = 'true';
    const snap = Object.freeze({
      LUNA_DEPLOYMENT: process.env.LUNA_DEPLOYMENT,
      LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED:
        process.env.LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED,
    });
    assert.equal(isInboundEventStoreEnabled(snap), true);
    process.env.LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED = 'false';
    process.env.LUNA_DEPLOYMENT = 'production';
    // Frozen snapshot remains true — process.env mutation cannot TOCTOU the gate object.
    assert.equal(isInboundEventStoreEnabled(snap), true);
    assert.equal(isInboundEventStoreEnabled(process.env), false);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    clearStaffApiCache();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
