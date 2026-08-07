'use strict';

/**
 * Hostile-path gate for delegated grant read-health (refresh/CAS + Graph count).
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
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
const {
  createMicrosoftGraphDelegatedMessagesTransport,
  readTrustedGraphStage,
  GRAPH_STAGES,
} = require('./lib/email-microsoft-graph-delegated-messages-transport');

const ROOT = path.join(__dirname, '..');
const RH_SRC = path.join(ROOT, 'scripts/lib/email-delegated-grant-read-health.js');

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

    // Graph failure after CAS with forged allowlisted own stage → uncertain, stage null.
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
    assert.equal(uncertain.graph_stage, null, 'forged own graph_stage must not be trusted');
    assert.ok(failInput);
    assert.equal(failInput.accessToken, null, 'access token cleared after Graph throw');
    assert.equal(noLeak(uncertain), true);

    // Inherited allowlisted stage must not be trusted.
    const fake2i = createFakeEmailGrantEnvelopeProvider();
    const op2i = crypto.randomUUID();
    const sealed2i = await fakeSealRefreshToken(fake2i, {
      refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
      grantGeneration: 1, operationId: op2i,
    });
    const inherited = await createDelegatedGrantReadHealthService(Object.freeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId: APP_ID,
      client: mockLifecycle({ sealed: sealed2i, opId: op2i }),
      envelopeProvider: fake2i,
      secretProvider: frozenMethod('getClientSecret', async () => SECRET),
      transport: successTransport(),
      graphMessages: frozenMethod('listMessageEnvelopeCount', async () => {
        const proto = { graph_stage: 'timeout' };
        const err = Object.create(proto);
        err.message = PLANTED;
        throw err;
      }),
    })).runReadHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
    assert.equal(inherited.status, STATUS_UNCERTAIN);
    assert.equal(inherited.grant_generation, 2);
    assert.equal(inherited.graph_stage, null, 'inherited graph_stage must not be trusted');
    assert.equal(noLeak(inherited), true);

    // Accessor that throws must not alter post-CAS result beyond sanitized uncertain.
    const fake2a = createFakeEmailGrantEnvelopeProvider();
    const op2a = crypto.randomUUID();
    const sealed2a = await fakeSealRefreshToken(fake2a, {
      refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
      grantGeneration: 1, operationId: op2a,
    });
    let accessorHits = 0;
    const accessorFail = await createDelegatedGrantReadHealthService(Object.freeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId: APP_ID,
      client: mockLifecycle({ sealed: sealed2a, opId: op2a }),
      envelopeProvider: fake2a,
      secretProvider: frozenMethod('getClientSecret', async () => SECRET),
      transport: successTransport(),
      graphMessages: frozenMethod('listMessageEnvelopeCount', async () => {
        const err = new Error(PLANTED);
        Object.defineProperty(err, 'graph_stage', {
          enumerable: true,
          configurable: true,
          get() {
            accessorHits += 1;
            throw new Error(`accessor-${PLANTED}`);
          },
        });
        throw err;
      }),
    })).runReadHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
    assert.equal(accessorFail.status, STATUS_UNCERTAIN);
    assert.equal(accessorFail.grant_generation, 2);
    assert.equal(accessorFail.graph_reachable, false);
    assert.equal(accessorFail.message_count_bounded, null);
    assert.equal(accessorFail.graph_stage, null);
    assert.equal(accessorHits, 0, 'trusted reader must not invoke graph_stage accessor');
    assert.equal(noLeak(accessorFail), true);

    // Proxy with hostile traps must not leak stage or execute traps via trusted lookup.
    const fake2p = createFakeEmailGrantEnvelopeProvider();
    const op2p = crypto.randomUUID();
    const sealed2p = await fakeSealRefreshToken(fake2p, {
      refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
      grantGeneration: 1, operationId: op2p,
    });
    const trapHits = [];
    const proxyFail = await createDelegatedGrantReadHealthService(Object.freeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId: APP_ID,
      client: mockLifecycle({ sealed: sealed2p, opId: op2p }),
      envelopeProvider: fake2p,
      secretProvider: frozenMethod('getClientSecret', async () => SECRET),
      transport: successTransport(),
      graphMessages: frozenMethod('listMessageEnvelopeCount', async () => {
        const target = { graph_stage: 'json_invalid', message: PLANTED };
        throw new Proxy(target, {
          get(t, prop, receiver) {
            trapHits.push(['get', String(prop)]);
            return Reflect.get(t, prop, receiver);
          },
          getOwnPropertyDescriptor(t, prop) {
            trapHits.push(['getOwnPropertyDescriptor', String(prop)]);
            return Reflect.getOwnPropertyDescriptor(t, prop);
          },
          ownKeys(t) {
            trapHits.push(['ownKeys']);
            return Reflect.ownKeys(t);
          },
        });
      }),
    })).runReadHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
    assert.equal(proxyFail.status, STATUS_UNCERTAIN);
    assert.equal(proxyFail.grant_generation, 2);
    assert.equal(proxyFail.graph_stage, null);
    assert.deepEqual(trapHits, [], 'WeakMap brand lookup must not execute proxy traps');
    assert.equal(noLeak(proxyFail), true);

    // Frozen lookalike error with allowlisted own stage is still untrusted.
    const fake2f = createFakeEmailGrantEnvelopeProvider();
    const op2f = crypto.randomUUID();
    const sealed2f = await fakeSealRefreshToken(fake2f, {
      refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
      grantGeneration: 1, operationId: op2f,
    });
    const lookalike = await createDelegatedGrantReadHealthService(Object.freeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId: APP_ID,
      client: mockLifecycle({ sealed: sealed2f, opId: op2f }),
      envelopeProvider: fake2f,
      secretProvider: frozenMethod('getClientSecret', async () => SECRET),
      transport: successTransport(),
      graphMessages: frozenMethod('listMessageEnvelopeCount', async () => {
        const err = new Error('Microsoft Graph delegated messages request failed.');
        Object.defineProperty(err, 'name', { value: 'MicrosoftGraphDelegatedMessagesError' });
        Object.defineProperty(err, 'code', {
          value: 'microsoft_graph_delegated_messages_failed',
          enumerable: true,
        });
        Object.defineProperty(err, 'graph_stage', {
          value: 'content_type_invalid',
          enumerable: true,
        });
        throw Object.freeze(err);
      }),
    })).runReadHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
    assert.equal(lookalike.status, STATUS_UNCERTAIN);
    assert.equal(lookalike.grant_generation, 2);
    assert.equal(lookalike.graph_stage, null, 'frozen lookalike must not be trusted');
    assert.equal(noLeak(lookalike), true);

    // Genuine internally branded transport failure propagates trusted stage.
    const fake2g = createFakeEmailGrantEnvelopeProvider();
    const op2g = crypto.randomUUID();
    const sealed2g = await fakeSealRefreshToken(fake2g, {
      refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
      grantGeneration: 1, operationId: op2g,
    });
    const brandedTransport = createMicrosoftGraphDelegatedMessagesTransport({
      httpsImpl: function request(_opts, onResponse) {
        const response = new (require('node:events').EventEmitter)();
        response.statusCode = 401;
        Object.defineProperty(response, 'headers', {
          value: { 'content-type': 'application/json' },
          enumerable: true,
          configurable: true,
        });
        const req = new (require('node:events').EventEmitter)();
        req.destroy = () => {};
        response.destroy = () => {};
        req.end = () => {
          queueMicrotask(() => {
            onResponse(response);
            response.emit('data', Buffer.from(JSON.stringify({ error: { message: PLANTED } })));
            response.emit('end');
          });
        };
        return req;
      },
      timers: { setTimeout, clearTimeout },
    });
    const genuine = await createDelegatedGrantReadHealthService(Object.freeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId: APP_ID,
      client: mockLifecycle({ sealed: sealed2g, opId: op2g }),
      envelopeProvider: fake2g,
      secretProvider: frozenMethod('getClientSecret', async () => SECRET),
      transport: successTransport(),
      graphMessages: brandedTransport,
    })).runReadHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
    assert.equal(genuine.status, STATUS_UNCERTAIN);
    assert.equal(genuine.grant_generation, 2);
    assert.equal(genuine.graph_reachable, false);
    assert.equal(genuine.message_count_bounded, null);
    assert.equal(genuine.graph_stage, 'http_status_not_200');
    assert.equal(noLeak(genuine), true);
    assert.equal(
      readTrustedGraphStage({ graph_stage: 'http_status_not_200' }),
      null,
      'reader rejects arbitrary objects',
    );
    assert.equal(readTrustedGraphStage(null), null);
    assert.equal(readTrustedGraphStage('timeout'), null);
    assert.ok(Object.isFrozen(GRAPH_STAGES));
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        require('./lib/email-microsoft-graph-delegated-messages-transport'),
        'STAGED_FAILURES',
      ),
      false,
    );

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

    // Hostile planted stage string on throw is dropped.
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

    // Lifetime/source: session callback holds accessTokenOwner as nullable let
    // and releases it in finally after graphInput scrub (reference nulling only).
    // Pre-input soft-fail still hits finally and nulls the local owner.
    {
      const src = fs.readFileSync(RH_SRC, 'utf8');
      assert.match(src, /let\s+accessTokenOwner\s*=\s*null/);
      assert.match(src, /accessTokenOwner\s*=\s*null/);
      assert.doesNotMatch(src, /const\s+accessToken\s*=\s*loan/);
      const finIdx = src.lastIndexOf('} finally {');
      assert.ok(finIdx > 0, 'callback finally present');
      const finBody = src.slice(finIdx, finIdx + 450);
      const graphScrubIdx = finBody.search(/graphInput\.accessToken\s*=\s*null/);
      const ownerNullIdx = finBody.search(/accessTokenOwner\s*=\s*null/);
      const loanScrubIdx = finBody.search(/loan\.accessToken\s*=\s*null/);
      assert.ok(graphScrubIdx >= 0, 'graphInput scrub in finally');
      assert.ok(ownerNullIdx >= 0, 'accessTokenOwner null in finally');
      assert.ok(loanScrubIdx >= 0, 'loan scrub independent in finally');
      assert.ok(graphScrubIdx < ownerNullIdx, 'owner released after graphInput scrub');
      assert.doesNotMatch(src, /zero[\s-]?fill|fill\(0\)|\.fill\(|string\.length\s*=\s*0/i);
    }

    assert.deepEqual(logged, []);
  } finally {
    console.log = log;
    console.error = error;
  }
  log('verify:email-delegated-grant-read-health: ok');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
