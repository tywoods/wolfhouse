'use strict';

/**
 * Hostile-path gate for delegated grant read-health (refresh/CAS + Graph count).
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createFakeEmailGrantEnvelopeProvider,
  fakeSealRefreshToken,
} = require('./lib/email-grant-envelope-fake-provider');
const {
  createDelegatedGrantReadHealthService,
  FAILURE_CODE,
  SUNSET_DEPLOYMENT,
  STATUS_HEALTHY,
  STATUS_UNCERTAIN,
  STATUS_REAUTH,
} = require('./lib/email-delegated-grant-read-health');

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const APP_ID = '12345678-1234-4234-8234-123456789abc';
const OLD_RT = 'rt-old-NEVER_LEAK';
const NEW_RT = 'rt-new-NEVER_LEAK';
const ACCESS = 'at-NEVER_LEAK-access';
const SECRET = 'app-secret-NEVER_LEAK';
const PLANTED = 'planted-NEVER_LEAK-subject';

function noLeak(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return !text.includes('NEVER_LEAK')
    && !text.includes(OLD_RT)
    && !text.includes(NEW_RT)
    && !text.includes(ACCESS)
    && !text.includes(SECRET)
    && !text.includes(PLANTED);
}

function rows(row) {
  return { rows: row == null ? [] : [row], rowCount: row == null ? 0 : 1 };
}
function empty() { return { rows: [], rowCount: 0 }; }

function createMockPg(handlers) {
  return {
    async query(text, params) {
      const t = String(text);
      for (const h of handlers) {
        if (h.match(t, params)) return h.run(t, params);
      }
      throw new Error(`unmatched_sql:${t.slice(0, 80)}`);
    },
  };
}

function frozenMethod(name, fn) { return Object.freeze({ [name]: fn }); }

function successTransport() {
  return frozenMethod('postTokenForm', async () => Object.freeze({
    statusCode: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: ACCESS,
      refresh_token: NEW_RT,
      scope: 'openid profile User.Read Mail.ReadBasic',
    }),
  }));
}

function mockLifecycle({ sealed, opId }) {
  let leaseTok = null;
  return createMockPg([
    {
      match: (t) => /FROM tenant_email_delegated_grants/i.test(t)
        && !/FOR UPDATE/i.test(t) && !/UPDATE/i.test(t),
      run: () => rows({
        client_id: CLIENT, endpoint_id: ENDPOINT,
        grant_generation: 1, grant_status: 'active', reconcile_state: 'clean',
        grant_lease_token: null,
      }),
    },
    {
      match: (t) => /FOR UPDATE OF g/i.test(t) || (/SELECT g\.\*/i.test(t) && /FOR UPDATE/i.test(t)),
      run: () => rows({
        client_id: CLIENT, endpoint_id: ENDPOINT,
        grant_generation: 1, grant_status: 'active', reconcile_state: 'clean',
        grant_lease_token: null, last_operation_id: opId,
        envelope_version: sealed.envelope_version, aead_alg: sealed.aead_alg,
        kek_wrap_alg: sealed.kek_wrap_alg, kek_key_name: sealed.kek_key_name,
        kek_key_version: sealed.kek_key_version, nonce: sealed.nonce,
        ciphertext: sealed.ciphertext, auth_tag: sealed.auth_tag,
        wrapped_dek: sealed.wrapped_dek, endpoint_binding_status: 'verified',
      }),
    },
    {
      match: (t) => /SET grant_status='lease_held'/i.test(t),
      run: (_t, p) => {
        leaseTok = p[3];
        return rows({
          client_id: CLIENT, endpoint_id: ENDPOINT,
          grant_generation: 1, grant_status: 'lease_held',
          grant_lease_token: leaseTok,
          grant_lease_until: new Date(Date.now() + 60000).toISOString(),
          last_operation_id: opId,
        });
      },
    },
    {
      match: (t) => /grant_lease_token/i.test(t) && /FOR UPDATE/i.test(t) && /envelope_version/i.test(t),
      run: () => rows({
        client_id: CLIENT, endpoint_id: ENDPOINT,
        grant_generation: 1, grant_status: 'lease_held',
        grant_lease_token: leaseTok,
        grant_lease_until: new Date(Date.now() + 60000).toISOString(),
        last_operation_id: opId,
        envelope_version: sealed.envelope_version, aead_alg: sealed.aead_alg,
        kek_wrap_alg: sealed.kek_wrap_alg, kek_key_name: sealed.kek_key_name,
        kek_key_version: sealed.kek_key_version, nonce: sealed.nonce,
        ciphertext: sealed.ciphertext, auth_tag: sealed.auth_tag,
        wrapped_dek: sealed.wrapped_dek,
      }),
    },
    {
      match: (t) => /SET grant_generation=/i.test(t) && /grant_status='active'/i.test(t),
      run: (_t, p) => rows({
        client_id: CLIENT, endpoint_id: ENDPOINT,
        grant_generation: Number(p[2]), grant_status: 'active',
        reconcile_state: 'clean',
      }),
    },
    {
      match: (t) => /SET reconcile_state=/i.test(t),
      run: () => rows({
        client_id: CLIENT, endpoint_id: ENDPOINT,
        grant_generation: 1, grant_status: 'lease_held',
        reconcile_state: 'ms_response_uncertain',
      }),
    },
    {
      match: (t) => /SET grant_status='active'/i.test(t) && /grant_lease_owner=NULL/i.test(t),
      run: () => rows({
        client_id: CLIENT, endpoint_id: ENDPOINT,
        grant_generation: 1, grant_status: 'active',
        reconcile_state: 'ms_response_uncertain',
      }),
    },
    {
      match: (t) => /reauthorization_required/i.test(t),
      run: () => rows({ grant_generation: 1, grant_status: 'reauthorization_required' }),
    },
    {
      match: (t) => /UPDATE tenant_channel_endpoints/i.test(t),
      run: () => rows({ id: ENDPOINT }),
    },
    { match: () => true, run: () => empty() },
  ]);
}

async function main() {
  const logged = [];
  const log = console.log;
  const error = console.error;
  console.log = console.error = (...v) => logged.push(v);
  try {
    const fake = createFakeEmailGrantEnvelopeProvider();
    const op = crypto.randomUUID();
    const sealed = await fakeSealRefreshToken(fake, {
      refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
      grantGeneration: 1, operationId: op,
    });

    let graphCalls = 0;
    let seenAccessDuringCall = null;
    let capturedGraphInput = null;
    const graphOk = frozenMethod('listMessageEnvelopeCount', async (input) => {
      graphCalls += 1;
      capturedGraphInput = input;
      seenAccessDuringCall = input.accessToken;
      assert.equal(Object.isFrozen(input), false, 'graph input must remain mutable for cleanup');
      return Object.freeze({ message_count_bounded: 2, graph_stage: 'success' });
    });

    const healthy = await createDelegatedGrantReadHealthService(Object.freeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId: APP_ID,
      client: mockLifecycle({ sealed, opId: op }),
      envelopeProvider: fake,
      secretProvider: frozenMethod('getClientSecret', async () => SECRET),
      transport: successTransport(),
      graphMessages: graphOk,
    })).runReadHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));

    assert.equal(healthy.status, STATUS_HEALTHY);
    assert.equal(healthy.grant_generation, 2);
    assert.equal(healthy.graph_reachable, true);
    assert.equal(healthy.message_count_bounded, 2);
    assert.equal(healthy.graph_stage, 'success');
    assert.equal(graphCalls, 1);
    assert.equal(seenAccessDuringCall, ACCESS);
    assert.ok(capturedGraphInput);
    assert.equal(capturedGraphInput.accessToken, null, 'access token cleared after Graph success');
    assert.equal(noLeak(healthy), true);
    assert.deepEqual(Reflect.ownKeys(healthy), [
      'status', 'grant_generation', 'graph_reachable', 'message_count_bounded', 'graph_stage',
    ]);

    // Graph failure after CAS → uncertain, generation advanced, token cleared, stage propagated.
    const fake2 = createFakeEmailGrantEnvelopeProvider();
    const op2 = crypto.randomUUID();
    const sealed2 = await fakeSealRefreshToken(fake2, {
      refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
      grantGeneration: 1, operationId: op2,
    });
    let failInput = null;
    const graphFail = frozenMethod('listMessageEnvelopeCount', async (input) => {
      failInput = input;
      const err = new Error(PLANTED);
      err.graph_stage = 'http_status_not_200';
      throw err;
    });
    const uncertain = await createDelegatedGrantReadHealthService(Object.freeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId: APP_ID,
      client: mockLifecycle({ sealed: sealed2, opId: op2 }),
      envelopeProvider: fake2,
      secretProvider: frozenMethod('getClientSecret', async () => SECRET),
      transport: successTransport(),
      graphMessages: graphFail,
    })).runReadHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
    assert.equal(uncertain.status, STATUS_UNCERTAIN);
    assert.equal(uncertain.grant_generation, 2);
    assert.equal(uncertain.graph_reachable, false);
    assert.equal(uncertain.message_count_bounded, null);
    assert.equal(uncertain.graph_stage, 'http_status_not_200');
    assert.ok(failInput);
    assert.equal(failInput.accessToken, null, 'access token cleared after Graph throw');
    assert.equal(noLeak(uncertain), true);

    // Graph soft-failure (bad shape) also clears token; no invented stage.
    const fake2b = createFakeEmailGrantEnvelopeProvider();
    const op2b = crypto.randomUUID();
    const sealed2b = await fakeSealRefreshToken(fake2b, {
      refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
      grantGeneration: 1, operationId: op2b,
    });
    let softInput = null;
    const graphSoft = frozenMethod('listMessageEnvelopeCount', async (input) => {
      softInput = input;
      return Object.freeze({ message_count_bounded: 99, graph_stage: 'success' });
    });
    const soft = await createDelegatedGrantReadHealthService(Object.freeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId: APP_ID,
      client: mockLifecycle({ sealed: sealed2b, opId: op2b }),
      envelopeProvider: fake2b,
      secretProvider: frozenMethod('getClientSecret', async () => SECRET),
      transport: successTransport(),
      graphMessages: graphSoft,
    })).runReadHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
    assert.equal(soft.status, STATUS_UNCERTAIN);
    assert.equal(soft.graph_reachable, false);
    assert.equal(soft.graph_stage, null);
    assert.ok(softInput);
    assert.equal(softInput.accessToken, null, 'access token cleared after Graph soft-failure');
    assert.equal(noLeak(soft), true);

    // Hostile planted stage string on throw is dropped (not allowlisted).
    const fake2c = createFakeEmailGrantEnvelopeProvider();
    const op2c = crypto.randomUUID();
    const sealed2c = await fakeSealRefreshToken(fake2c, {
      refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
      grantGeneration: 1, operationId: op2c,
    });
    const graphHostileStage = frozenMethod('listMessageEnvelopeCount', async () => {
      const err = new Error(PLANTED);
      err.graph_stage = PLANTED;
      throw err;
    });
    const hostileStage = await createDelegatedGrantReadHealthService(Object.freeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId: APP_ID,
      client: mockLifecycle({ sealed: sealed2c, opId: op2c }),
      envelopeProvider: fake2c,
      secretProvider: frozenMethod('getClientSecret', async () => SECRET),
      transport: successTransport(),
      graphMessages: graphHostileStage,
    })).runReadHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
    assert.equal(hostileStage.status, STATUS_UNCERTAIN);
    assert.equal(hostileStage.grant_generation, 2);
    assert.equal(hostileStage.graph_stage, null);
    assert.equal(noLeak(hostileStage), true);

    // invalid_grant → reauth, Graph never called.
    const fake3 = createFakeEmailGrantEnvelopeProvider();
    const op3 = crypto.randomUUID();
    const sealed3 = await fakeSealRefreshToken(fake3, {
      refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
      grantGeneration: 1, operationId: op3,
    });
    let graphAfterReauth = 0;
    const reauth = await createDelegatedGrantReadHealthService(Object.freeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId: APP_ID,
      client: mockLifecycle({ sealed: sealed3, opId: op3 }),
      envelopeProvider: fake3,
      secretProvider: frozenMethod('getClientSecret', async () => SECRET),
      transport: frozenMethod('postTokenForm', async () => Object.freeze({
        statusCode: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'invalid_grant', error_description: PLANTED }),
      })),
      graphMessages: frozenMethod('listMessageEnvelopeCount', async () => {
        graphAfterReauth += 1;
        return Object.freeze({ message_count_bounded: 0, graph_stage: 'success' });
      }),
    })).runReadHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
    assert.equal(reauth.status, STATUS_REAUTH);
    assert.equal(reauth.graph_reachable, false);
    assert.equal(reauth.graph_stage, null);
    assert.equal(graphAfterReauth, 0);
    assert.equal(noLeak(reauth), true);

    assert.throws(
      () => createDelegatedGrantReadHealthService(null),
      (e) => e.code === FAILURE_CODE && noLeak(e),
    );
    assert.deepEqual(logged, []);
  } finally {
    console.log = log;
    console.error = error;
  }
  log('verify:email-delegated-grant-read-health: ok');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
