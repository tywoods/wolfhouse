'use strict';

/**
 * Hostile-path gate for delegated grant refresh-health rotation.
 * Proves lease → open → MS classify → reseal → CAS, plus abort/reauth/uncertain
 * paths, with zero token/envelope/planted-error leakage in public results.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createFakeEmailGrantEnvelopeProvider,
  fakeSealRefreshToken,
} = require('./lib/email-grant-envelope-fake-provider');
const {
  createDelegatedGrantRefreshRotationService,
  FAILURE_CODE,
  SUNSET_DEPLOYMENT,
  STATUS_HEALTHY,
  STATUS_REAUTH,
  STATUS_UNCERTAIN,
  STATUS_UNAVAILABLE,
} = require('./lib/email-delegated-grant-refresh-rotation');

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const APP_ID = '12345678-1234-4234-8234-123456789abc';
const OLD_RT = 'rt-old-NEVER_LEAK';
const NEW_RT = 'rt-new-NEVER_LEAK';
const PLANTED = 'planted-NEVER_LEAK-secret';
const SECRET = 'app-secret-NEVER_LEAK';

function noLeak(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return !text.includes('NEVER_LEAK')
    && !text.includes(OLD_RT)
    && !text.includes(NEW_RT)
    && !text.includes(SECRET)
    && !text.includes(PLANTED);
}

function rows(row) {
  return { rows: row == null ? [] : [row], rowCount: row == null ? 0 : 1 };
}
function empty() { return { rows: [], rowCount: 0 }; }

function createMockPg(handlers) {
  const client = {
    async query(text, params) {
      const t = String(text);
      for (const h of handlers) {
        if (h.match(t, params)) return h.run(t, params);
      }
      throw new Error(`unmatched_sql:${t.slice(0, 80)}`);
    },
  };
  return client;
}

function frozenMethod(name, fn) { return Object.freeze({ [name]: fn }); }

const PHASE_A_TOKEN_SCOPE = 'openid profile User.Read Mail.ReadWrite Mail.Send';
const PHASE_B_TOKEN_SCOPE = 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send';
const LEGACY_READBASIC_SCOPE = 'openid profile User.Read Mail.ReadBasic';

function successTransport(bodyPatch = {}) {
  return frozenMethod('postTokenForm', async () => Object.freeze({
    statusCode: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: 'at-NEVER_LEAK',
      refresh_token: NEW_RT,
      scope: PHASE_A_TOKEN_SCOPE,
      ...bodyPatch,
    }),
  }));
}

function phaseBSuccessTransport(bodyPatch = {}) {
  return successTransport({ scope: PHASE_B_TOKEN_SCOPE, ...bodyPatch });
}

function legacyReadBasicTransport() {
  return successTransport({ scope: LEGACY_READBASIC_SCOPE });
}

function omitRefreshTransport() {
  return frozenMethod('postTokenForm', async () => Object.freeze({
    statusCode: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: 'at-NEVER_LEAK',
      scope: PHASE_A_TOKEN_SCOPE,
    }),
  }));
}

function emptyRefreshTransport() {
  return frozenMethod('postTokenForm', async () => Object.freeze({
    statusCode: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: 'at-NEVER_LEAK',
      refresh_token: '',
      scope: PHASE_A_TOKEN_SCOPE,
    }),
  }));
}

/** Mock PG that supports status → acquire → open → commit (+ optional reconcile/abort). */
function mockGrantLifecycle({ sealed, opId, onCommit, failCommit, scopeVersion }) {
  let leaseTok = null;
  const scopeVer = scopeVersion === undefined ? 'phase_a_v2' : scopeVersion;
  return createMockPg([
    {
      match: (t) => /FROM tenant_email_delegated_grants/i.test(t)
        && !/FOR UPDATE/i.test(t) && !/UPDATE/i.test(t) && !/INSERT/i.test(t),
      run: () => rows({
        client_id: CLIENT, endpoint_id: ENDPOINT,
        grant_generation: 1, grant_status: 'active', reconcile_state: 'clean',
        grant_lease_token: null,
        scope_version: scopeVer,
      }),
    },
    {
      match: (t) => /FOR UPDATE OF g/i.test(t) || (/SELECT g\.\*/i.test(t) && /FOR UPDATE/i.test(t)),
      run: () => rows({
        client_id: CLIENT, endpoint_id: ENDPOINT,
        grant_generation: 1, grant_status: 'active', reconcile_state: 'clean',
        grant_lease_token: null, grant_lease_until: null,
        last_operation_id: opId,
        scope_version: scopeVer,
        envelope_version: sealed.envelope_version, aead_alg: sealed.aead_alg,
        kek_wrap_alg: sealed.kek_wrap_alg, kek_key_name: sealed.kek_key_name,
        kek_key_version: sealed.kek_key_version, nonce: sealed.nonce,
        ciphertext: sealed.ciphertext, auth_tag: sealed.auth_tag,
        wrapped_dek: sealed.wrapped_dek,
        endpoint_binding_status: 'verified',
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
          scope_version: scopeVer,
        });
      },
    },
    {
      match: (t) => /grant_lease_token/i.test(t) && /FOR UPDATE/i.test(t)
        && /envelope_version/i.test(t),
      run: () => rows({
        client_id: CLIENT, endpoint_id: ENDPOINT,
        grant_generation: 1, grant_status: 'lease_held',
        grant_lease_token: leaseTok,
        grant_lease_until: new Date(Date.now() + 60000).toISOString(),
        last_operation_id: opId,
        scope_version: scopeVer,
        envelope_version: sealed.envelope_version, aead_alg: sealed.aead_alg,
        kek_wrap_alg: sealed.kek_wrap_alg, kek_key_name: sealed.kek_key_name,
        kek_key_version: sealed.kek_key_version, nonce: sealed.nonce,
        ciphertext: sealed.ciphertext, auth_tag: sealed.auth_tag,
        wrapped_dek: sealed.wrapped_dek,
      }),
    },
    {
      match: (t) => /SET grant_generation=/i.test(t) && /grant_status='active'/i.test(t),
      run: (_t, p) => {
        if (failCommit) return empty();
        if (typeof onCommit === 'function') onCommit(Number(p[2]));
        return rows({
          client_id: CLIENT, endpoint_id: ENDPOINT,
          grant_generation: Number(p[2]), grant_status: 'active',
          reconcile_state: 'clean',
          scope_version: scopeVer,
        });
      },
    },
    {
      match: (t) => /SET reconcile_state=/i.test(t),
      run: () => rows({
        client_id: CLIENT, endpoint_id: ENDPOINT,
        grant_generation: 1, grant_status: 'lease_held',
        reconcile_state: 'ms_response_uncertain',
        scope_version: scopeVer,
      }),
    },
    {
      match: (t) => /SET grant_status='active'/i.test(t) && /grant_lease_owner=NULL/i.test(t),
      run: () => rows({
        client_id: CLIENT, endpoint_id: ENDPOINT,
        grant_generation: 1, grant_status: 'active',
        reconcile_state: 'ms_response_uncertain',
        scope_version: scopeVer,
      }),
    },
    { match: () => true, run: () => empty() },
  ]);
}

function wrapSealSpy(provider) {
  const sealedTokens = [];
  return {
    provider: Object.freeze({
      sealGrantPayload: async (input) => {
        sealedTokens.push(input && input.refresh_token);
        return provider.sealGrantPayload(input);
      },
      openGrantPayload: (...a) => provider.openGrantPayload(...a),
      rewrapGrantDek: (...a) => provider.rewrapGrantDek(...a),
    }),
    sealedTokens,
  };
}

function invalidGrantTransport() {
  return frozenMethod('postTokenForm', async () => Object.freeze({
    statusCode: 400,
    contentType: 'application/json',
    body: JSON.stringify({
      error: 'invalid_grant',
      error_description: PLANTED,
    }),
  }));
}

function uncertainTransport() {
  return frozenMethod('postTokenForm', async () => Object.freeze({
    statusCode: 503,
    contentType: 'text/plain',
    body: PLANTED,
  }));
}

async function main() {
  const logged = [];
  const log = console.log;
  const error = console.error;
  console.log = console.error = (...v) => logged.push(v);
  try {
    const fake = createFakeEmailGrantEnvelopeProvider();
    const op1 = crypto.randomUUID();
    const sealed1 = await fakeSealRefreshToken(fake, {
      refreshToken: OLD_RT,
      clientId: CLIENT,
      endpointId: ENDPOINT,
      grantGeneration: 1,
      operationId: op1,
    });

    // ── happy path: lease → open → refresh → seal → CAS ─────────────
    {
      let leaseTok = null;
      let committedGen = null;
      const client = createMockPg([
        {
          match: (t) => /FROM tenant_email_delegated_grants/i.test(t)
            && !/FOR UPDATE/i.test(t) && !/UPDATE/i.test(t) && !/INSERT/i.test(t),
          run: () => rows({
            client_id: CLIENT, endpoint_id: ENDPOINT,
            grant_generation: 1, grant_status: 'active', reconcile_state: 'clean',
            grant_lease_token: null,
            scope_version: 'phase_a_v2',
          }),
        },
        {
          match: (t) => /FOR UPDATE OF g/i.test(t) || (/SELECT g\.\*/i.test(t) && /FOR UPDATE/i.test(t)),
          run: () => rows({
            client_id: CLIENT, endpoint_id: ENDPOINT,
            grant_generation: 1, grant_status: 'active', reconcile_state: 'clean',
            grant_lease_token: null, grant_lease_until: null,
            last_operation_id: op1,
            scope_version: 'phase_a_v2',
            envelope_version: sealed1.envelope_version, aead_alg: sealed1.aead_alg,
            kek_wrap_alg: sealed1.kek_wrap_alg, kek_key_name: sealed1.kek_key_name,
            kek_key_version: sealed1.kek_key_version, nonce: sealed1.nonce,
            ciphertext: sealed1.ciphertext, auth_tag: sealed1.auth_tag,
            wrapped_dek: sealed1.wrapped_dek,
            endpoint_binding_status: 'verified',
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
              last_operation_id: op1,
              scope_version: 'phase_a_v2',
            });
          },
        },
        {
          match: (t) => /grant_lease_token/i.test(t) && /FOR UPDATE/i.test(t)
            && /envelope_version/i.test(t),
          run: () => rows({
            client_id: CLIENT, endpoint_id: ENDPOINT,
            grant_generation: 1, grant_status: 'lease_held',
            grant_lease_token: leaseTok,
            grant_lease_until: new Date(Date.now() + 60000).toISOString(),
            last_operation_id: op1,
            scope_version: 'phase_a_v2',
            envelope_version: sealed1.envelope_version, aead_alg: sealed1.aead_alg,
            kek_wrap_alg: sealed1.kek_wrap_alg, kek_key_name: sealed1.kek_key_name,
            kek_key_version: sealed1.kek_key_version, nonce: sealed1.nonce,
            ciphertext: sealed1.ciphertext, auth_tag: sealed1.auth_tag,
            wrapped_dek: sealed1.wrapped_dek,
          }),
        },
        {
          match: (t) => /SET grant_generation=/i.test(t) && /grant_status='active'/i.test(t),
          run: (_t, p) => {
            committedGen = Number(p[2]);
            return rows({
              client_id: CLIENT, endpoint_id: ENDPOINT,
              grant_generation: committedGen, grant_status: 'active',
              reconcile_state: 'clean',
              scope_version: 'phase_a_v2',
            });
          },
        },
        { match: () => true, run: () => empty() },
      ]);

      const service = createDelegatedGrantRefreshRotationService(Object.freeze({
        deployment: SUNSET_DEPLOYMENT,
        applicationClientId: APP_ID,
        client,
        envelopeProvider: fake,
        secretProvider: frozenMethod('getClientSecret', async () => SECRET),
        transport: successTransport(),
      }));
      const result = await service.runRefreshHealth(Object.freeze({
        clientId: CLIENT,
        endpointId: ENDPOINT,
      }));
      assert.equal(result.status, STATUS_HEALTHY);
      assert.equal(result.grant_generation, 2);
      assert.equal(result.grant_status, 'active');
      assert.equal(result.reconcile_state, 'clean');
      assert.equal(result.reauthorization_required, false);
      assert.equal(noLeak(result), true);
      assert.deepEqual(Reflect.ownKeys(result), [
        'status', 'grant_generation', 'grant_status', 'reconcile_state', 'reauthorization_required',
      ]);
    }

    // ── omission: 200 without refresh_token reseals opened token + CAS ─
    {
      const fakeOmit = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fakeOmit, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      const spy = wrapSealSpy(fakeOmit);
      let committedGen = null;
      const result = await createDelegatedGrantRefreshRotationService(Object.freeze({
        deployment: SUNSET_DEPLOYMENT,
        applicationClientId: APP_ID,
        client: mockGrantLifecycle({
          sealed, opId: op, onCommit: (g) => { committedGen = g; },
        }),
        envelopeProvider: spy.provider,
        secretProvider: frozenMethod('getClientSecret', async () => SECRET),
        transport: omitRefreshTransport(),
      })).runRefreshHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
      assert.equal(result.status, STATUS_HEALTHY);
      assert.equal(result.grant_generation, 2);
      assert.equal(committedGen, 2);
      assert.equal(spy.sealedTokens.length, 1);
      assert.equal(spy.sealedTokens[0], OLD_RT, 'omission must reseal the opened prior token');
      assert.equal(noLeak(result), true);
    }

    // ── present rotation uses the new token (not the opened prior) ───
    {
      const fakeRot = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fakeRot, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      const spy = wrapSealSpy(fakeRot);
      const result = await createDelegatedGrantRefreshRotationService(Object.freeze({
        deployment: SUNSET_DEPLOYMENT,
        applicationClientId: APP_ID,
        client: mockGrantLifecycle({ sealed, opId: op }),
        envelopeProvider: spy.provider,
        secretProvider: frozenMethod('getClientSecret', async () => SECRET),
        transport: successTransport(),
      })).runRefreshHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
      assert.equal(result.status, STATUS_HEALTHY);
      assert.equal(spy.sealedTokens.length, 1);
      assert.equal(spy.sealedTokens[0], NEW_RT, 'rotated response must reseal the new token');
      assert.notEqual(spy.sealedTokens[0], OLD_RT);
      assert.equal(noLeak(result), true);
    }

    // ── present empty/malformed refresh_token never falls back ───────
    {
      const fakeBad = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fakeBad, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      const spy = wrapSealSpy(fakeBad);
      let aborted = false;
      const client = mockGrantLifecycle({ sealed, opId: op });
      // Intercept abort to prove release after uncertain.
      const origQuery = client.query.bind(client);
      client.query = async (text, params) => {
        if (/SET grant_status='active'/i.test(String(text)) && /grant_lease_owner=NULL/i.test(String(text))) {
          aborted = true;
        }
        return origQuery(text, params);
      };
      const result = await createDelegatedGrantRefreshRotationService(Object.freeze({
        deployment: SUNSET_DEPLOYMENT,
        applicationClientId: APP_ID,
        client,
        envelopeProvider: spy.provider,
        secretProvider: frozenMethod('getClientSecret', async () => SECRET),
        transport: emptyRefreshTransport(),
      })).runRefreshHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
      assert.equal(result.status, STATUS_UNCERTAIN);
      assert.equal(result.reconcile_state, 'ms_response_uncertain');
      assert.equal(spy.sealedTokens.length, 0, 'hostile present refresh must never reseal/fallback');
      assert.equal(aborted, true);
      assert.equal(noLeak(result), true);
    }

    // ── omission reseal failure → uncertain + abort (no CAS advance) ─
    {
      const fakeFail = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fakeFail, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      const failingProvider = Object.freeze({
        sealGrantPayload: async () => { throw new Error(PLANTED); },
        openGrantPayload: (...a) => fakeFail.openGrantPayload(...a),
        rewrapGrantDek: (...a) => fakeFail.rewrapGrantDek(...a),
      });
      let commitSeen = false;
      const client = mockGrantLifecycle({
        sealed,
        opId: op,
        onCommit: () => { commitSeen = true; },
      });
      const result = await createDelegatedGrantRefreshRotationService(Object.freeze({
        deployment: SUNSET_DEPLOYMENT,
        applicationClientId: APP_ID,
        client,
        envelopeProvider: failingProvider,
        secretProvider: frozenMethod('getClientSecret', async () => SECRET),
        transport: omitRefreshTransport(),
      })).runRefreshHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
      assert.equal(result.status, STATUS_UNCERTAIN);
      assert.equal(result.grant_generation, 1);
      assert.equal(commitSeen, false, 'seal failure must not CAS-advance');
      assert.equal(noLeak(result), true);
      assert.equal(JSON.stringify(result).includes(PLANTED), false);
    }

    // ── omission CAS loser → uncertain (generation conflict) ─────────
    {
      const fakeCas = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fakeCas, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      const result = await createDelegatedGrantRefreshRotationService(Object.freeze({
        deployment: SUNSET_DEPLOYMENT,
        applicationClientId: APP_ID,
        client: mockGrantLifecycle({ sealed, opId: op, failCommit: true }),
        envelopeProvider: fakeCas,
        secretProvider: frozenMethod('getClientSecret', async () => SECRET),
        transport: omitRefreshTransport(),
      })).runRefreshHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
      assert.equal(result.status, STATUS_UNCERTAIN);
      assert.equal(result.reauthorization_required, false);
      assert.equal(noLeak(result), true);
    }

    // ── invalid_grant → reauthorization_required ────────────────────
    {
      const fake2 = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fake2, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      let leaseTok = null;
      let markedReauth = false;
      const client = createMockPg([
        {
          match: (t) => /FROM tenant_email_delegated_grants/i.test(t)
            && !/FOR UPDATE/i.test(t) && !/UPDATE/i.test(t),
          run: () => rows({
            client_id: CLIENT, endpoint_id: ENDPOINT,
            grant_generation: 1, grant_status: 'active', reconcile_state: 'clean',
            grant_lease_token: null,
            scope_version: 'phase_a_v2',
          }),
        },
        {
          match: (t) => /FOR UPDATE OF g/i.test(t) || (/SELECT g\.\*/i.test(t) && /FOR UPDATE/i.test(t)),
          run: () => rows({
            client_id: CLIENT, endpoint_id: ENDPOINT,
            grant_generation: 1, grant_status: 'active', reconcile_state: 'clean',
            grant_lease_token: null, last_operation_id: op,
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
              last_operation_id: op,
              scope_version: 'phase_a_v2',
            });
          },
        },
        {
          match: (t) => /grant_lease_token/i.test(t) && /FOR UPDATE/i.test(t)
            && /envelope_version/i.test(t),
          run: () => rows({
            client_id: CLIENT, endpoint_id: ENDPOINT,
            grant_generation: 1, grant_status: 'lease_held',
            grant_lease_token: leaseTok,
            grant_lease_until: new Date(Date.now() + 60000).toISOString(),
            last_operation_id: op,
            scope_version: 'phase_a_v2',
            envelope_version: sealed.envelope_version, aead_alg: sealed.aead_alg,
            kek_wrap_alg: sealed.kek_wrap_alg, kek_key_name: sealed.kek_key_name,
            kek_key_version: sealed.kek_key_version, nonce: sealed.nonce,
            ciphertext: sealed.ciphertext, auth_tag: sealed.auth_tag,
            wrapped_dek: sealed.wrapped_dek,
          }),
        },
        {
          match: (t) => /reauthorization_required/i.test(t) && /UPDATE tenant_email_delegated_grants/i.test(t),
          run: () => {
            markedReauth = true;
            return rows({ grant_generation: 1, grant_status: 'reauthorization_required' });
          },
        },
        {
          match: (t) => /UPDATE tenant_channel_endpoints/i.test(t),
          run: () => rows({ id: ENDPOINT }),
        },
        { match: () => true, run: () => empty() },
      ]);
      const result = await createDelegatedGrantRefreshRotationService(Object.freeze({
        deployment: SUNSET_DEPLOYMENT,
        applicationClientId: APP_ID,
        client,
        envelopeProvider: fake2,
        secretProvider: frozenMethod('getClientSecret', async () => SECRET),
        transport: invalidGrantTransport(),
      })).runRefreshHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
      assert.equal(result.status, STATUS_REAUTH);
      assert.equal(result.reauthorization_required, true);
      assert.equal(result.grant_status, 'reauthorization_required');
      assert.equal(markedReauth, true);
      assert.equal(noLeak(result), true);
    }

    // ── uncertain MS response → reconcile + abort ───────────────────
    {
      const fake3 = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fake3, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      let leaseTok = null;
      let reconciled = false;
      let aborted = false;
      const client = createMockPg([
        {
          match: (t) => /FROM tenant_email_delegated_grants/i.test(t)
            && !/FOR UPDATE/i.test(t) && !/UPDATE/i.test(t),
          run: () => rows({
            client_id: CLIENT, endpoint_id: ENDPOINT,
            grant_generation: 1, grant_status: 'active', reconcile_state: 'clean',
            grant_lease_token: null,
            scope_version: 'phase_a_v2',
          }),
        },
        {
          match: (t) => /FOR UPDATE OF g/i.test(t) || (/SELECT g\.\*/i.test(t) && /FOR UPDATE/i.test(t)),
          run: () => rows({
            client_id: CLIENT, endpoint_id: ENDPOINT,
            grant_generation: 1, grant_status: 'active', reconcile_state: 'clean',
            grant_lease_token: null, last_operation_id: op,
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
              last_operation_id: op,
              scope_version: 'phase_a_v2',
            });
          },
        },
        {
          match: (t) => /grant_lease_token/i.test(t) && /FOR UPDATE/i.test(t)
            && /envelope_version/i.test(t),
          run: () => rows({
            client_id: CLIENT, endpoint_id: ENDPOINT,
            grant_generation: 1, grant_status: 'lease_held',
            grant_lease_token: leaseTok,
            grant_lease_until: new Date(Date.now() + 60000).toISOString(),
            last_operation_id: op,
            scope_version: 'phase_a_v2',
            envelope_version: sealed.envelope_version, aead_alg: sealed.aead_alg,
            kek_wrap_alg: sealed.kek_wrap_alg, kek_key_name: sealed.kek_key_name,
            kek_key_version: sealed.kek_key_version, nonce: sealed.nonce,
            ciphertext: sealed.ciphertext, auth_tag: sealed.auth_tag,
            wrapped_dek: sealed.wrapped_dek,
          }),
        },
        {
          match: (t) => /SET reconcile_state=/i.test(t),
          run: () => {
            reconciled = true;
            return rows({
              client_id: CLIENT, endpoint_id: ENDPOINT,
              grant_generation: 1, grant_status: 'lease_held',
              reconcile_state: 'ms_response_uncertain',
            });
          },
        },
        {
          match: (t) => /SET grant_status='active'/i.test(t)
            && /grant_lease_owner=NULL/i.test(t),
          run: () => {
            aborted = true;
            return rows({
              client_id: CLIENT, endpoint_id: ENDPOINT,
              grant_generation: 1, grant_status: 'active',
              reconcile_state: 'ms_response_uncertain',
            });
          },
        },
        { match: () => true, run: () => empty() },
      ]);
      const result = await createDelegatedGrantRefreshRotationService(Object.freeze({
        deployment: SUNSET_DEPLOYMENT,
        applicationClientId: APP_ID,
        client,
        envelopeProvider: fake3,
        secretProvider: frozenMethod('getClientSecret', async () => SECRET),
        transport: uncertainTransport(),
      })).runRefreshHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
      assert.equal(result.status, STATUS_UNCERTAIN);
      assert.equal(result.reconcile_state, 'ms_response_uncertain');
      assert.equal(result.reauthorization_required, false);
      assert.equal(reconciled, true);
      assert.equal(aborted, true);
      assert.equal(noLeak(result), true);
    }

    // ── lease held by other → unavailable (no MS call) ──────────────
    {
      let msCalls = 0;
      const client = createMockPg([
        {
          match: (t) => /FROM tenant_email_delegated_grants/i.test(t) && !/FOR UPDATE/i.test(t),
          run: () => rows({
            client_id: CLIENT, endpoint_id: ENDPOINT,
            grant_generation: 3, grant_status: 'lease_held', reconcile_state: 'clean',
            grant_lease_token: crypto.randomUUID(),
          }),
        },
        {
          match: (t) => /FOR UPDATE OF g/i.test(t) || (/SELECT g\.\*/i.test(t) && /FOR UPDATE/i.test(t)),
          run: () => rows({
            client_id: CLIENT, endpoint_id: ENDPOINT,
            grant_generation: 3, grant_status: 'lease_held', reconcile_state: 'clean',
            grant_lease_token: crypto.randomUUID(),
            grant_lease_until: new Date(Date.now() + 60000).toISOString(),
            last_operation_id: crypto.randomUUID(),
            endpoint_binding_status: 'verified',
          }),
        },
        {
          match: (t) => /grant_lease_until IS NOT NULL/i.test(t),
          run: () => rows({ expired: false }),
        },
        { match: () => true, run: () => empty() },
      ]);
      const result = await createDelegatedGrantRefreshRotationService(Object.freeze({
        deployment: SUNSET_DEPLOYMENT,
        applicationClientId: APP_ID,
        client,
        envelopeProvider: createFakeEmailGrantEnvelopeProvider(),
        secretProvider: frozenMethod('getClientSecret', async () => SECRET),
        transport: frozenMethod('postTokenForm', async () => { msCalls += 1; return null; }),
      })).runRefreshHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
      assert.equal(result.status, STATUS_UNAVAILABLE);
      assert.equal(msCalls, 0);
      assert.equal(noLeak(result), true);
    }

    // ── already reauth → short-circuit ──────────────────────────────
    {
      let msCalls = 0;
      const client = createMockPg([
        {
          match: (t) => /FROM tenant_email_delegated_grants/i.test(t),
          run: () => rows({
            client_id: CLIENT, endpoint_id: ENDPOINT,
            grant_generation: 4, grant_status: 'reauthorization_required',
            reconcile_state: 'needs_operator', grant_lease_token: null,
          }),
        },
      ]);
      const result = await createDelegatedGrantRefreshRotationService(Object.freeze({
        deployment: SUNSET_DEPLOYMENT,
        applicationClientId: APP_ID,
        client,
        envelopeProvider: createFakeEmailGrantEnvelopeProvider(),
        secretProvider: frozenMethod('getClientSecret', async () => SECRET),
        transport: frozenMethod('postTokenForm', async () => { msCalls += 1; return null; }),
      })).runRefreshHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
      assert.equal(result.status, STATUS_REAUTH);
      assert.equal(result.reauthorization_required, true);
      assert.equal(msCalls, 0);
      assert.equal(noLeak(result), true);
    }

    // ── hostile factory / single-use ────────────────────────────────
    assert.throws(
      () => createDelegatedGrantRefreshRotationService(null),
      (e) => e.code === FAILURE_CODE && noLeak(e),
    );
    assert.throws(
      () => createDelegatedGrantRefreshRotationService(Object.freeze({
        deployment: 'production',
        applicationClientId: APP_ID,
        client: createMockPg([]),
        envelopeProvider: createFakeEmailGrantEnvelopeProvider(),
        secretProvider: frozenMethod('getClientSecret', async () => SECRET),
        transport: successTransport(),
      })),
      (e) => e.code === FAILURE_CODE,
    );

    const once = createDelegatedGrantRefreshRotationService(Object.freeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId: APP_ID,
      client: createMockPg([{
        match: () => true,
        run: () => rows({
          client_id: CLIENT, endpoint_id: ENDPOINT,
          grant_generation: 1, grant_status: 'reauthorization_required',
          reconcile_state: 'needs_operator', grant_lease_token: null,
        }),
      }]),
      envelopeProvider: createFakeEmailGrantEnvelopeProvider(),
      secretProvider: frozenMethod('getClientSecret', async () => SECRET),
      transport: successTransport(),
    }));
    await once.runRefreshHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
    await assert.rejects(
      () => once.runRefreshHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT })),
      (e) => e.code === FAILURE_CODE,
    );

    // ── Phase B grant + Phase B MS 200 → healthy (refresh-health honesty) ─
    {
      const fakeB = createFakeEmailGrantEnvelopeProvider();
      const opB = crypto.randomUUID();
      const sealedB = await fakeSealRefreshToken(fakeB, {
        refreshToken: OLD_RT,
        clientId: CLIENT,
        endpointId: ENDPOINT,
        grantGeneration: 1,
        operationId: opB,
      });
      const result = await createDelegatedGrantRefreshRotationService(Object.freeze({
        deployment: SUNSET_DEPLOYMENT,
        applicationClientId: APP_ID,
        client: mockGrantLifecycle({ sealed: sealedB, opId: opB, scopeVersion: 'phase_b_v1' }),
        envelopeProvider: fakeB,
        secretProvider: frozenMethod('getClientSecret', async () => SECRET),
        transport: phaseBSuccessTransport(),
      })).runRefreshHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
      assert.equal(result.status, STATUS_HEALTHY,
        'Phase B grant refresh-health must not stay ms_response_uncertain');
      assert.equal(result.grant_generation, 2);
      assert.equal(result.reauthorization_required, false);
      assert.equal(noLeak(result), true);
    }

    // Phase A grant + legacy ReadBasic stays uncertain (do not accept Mail.ReadBasic).
    {
      const fakeA = createFakeEmailGrantEnvelopeProvider();
      const opA = crypto.randomUUID();
      const sealedA = await fakeSealRefreshToken(fakeA, {
        refreshToken: OLD_RT,
        clientId: CLIENT,
        endpointId: ENDPOINT,
        grantGeneration: 1,
        operationId: opA,
      });
      const result = await createDelegatedGrantRefreshRotationService(Object.freeze({
        deployment: SUNSET_DEPLOYMENT,
        applicationClientId: APP_ID,
        client: mockGrantLifecycle({ sealed: sealedA, opId: opA, scopeVersion: 'phase_a_v2' }),
        envelopeProvider: fakeA,
        secretProvider: frozenMethod('getClientSecret', async () => SECRET),
        transport: legacyReadBasicTransport(),
      })).runRefreshHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
      assert.equal(result.status, STATUS_UNCERTAIN);
      assert.equal(result.reconcile_state, 'ms_response_uncertain');
      assert.equal(noLeak(result), true);
    }

    // Unknown scope_version fails closed.
    {
      const fakeU = createFakeEmailGrantEnvelopeProvider();
      const opU = crypto.randomUUID();
      const sealedU = await fakeSealRefreshToken(fakeU, {
        refreshToken: OLD_RT,
        clientId: CLIENT,
        endpointId: ENDPOINT,
        grantGeneration: 1,
        operationId: opU,
      });
      const result = await createDelegatedGrantRefreshRotationService(Object.freeze({
        deployment: SUNSET_DEPLOYMENT,
        applicationClientId: APP_ID,
        client: mockGrantLifecycle({ sealed: sealedU, opId: opU, scopeVersion: 'phase_b_v2' }),
        envelopeProvider: fakeU,
        secretProvider: frozenMethod('getClientSecret', async () => SECRET),
        transport: phaseBSuccessTransport(),
      })).runRefreshHealth(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }));
      assert.equal(result.status, STATUS_UNCERTAIN);
      assert.equal(noLeak(result), true);
    }

    assert.deepEqual(
      logged.filter((entry) => !String(entry).includes('NO_COLOR')),
      [],
    );
  } finally {
    console.log = log;
    console.error = error;
  }
  log('verify:email-delegated-grant-refresh-rotation: ok');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
